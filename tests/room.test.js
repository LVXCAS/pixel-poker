/* Tests for PP.Room — HostRoom + ClientRoom over the Loopback transport. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'room: ' + name, fn });
  const Net = PP.Net;
  const Room = PP.Room;
  const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

  /* ------------------------------------------------------------ helpers */

  function within(promise, ms, label) {
    let timer;
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('deadlock / timeout: ' + label)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  async function makeEnv(o) {
    const opts = o || {};
    const clock = Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    const ep = await Net.createHost({ hub, clock, code: 'RMS22' });
    const room = new Room.HostRoom({
      endpoint: ep, hostName: opts.hostName || 'host', hostAvatar: 'a3', clock,
      settings: { turnSeconds: 0, ...(opts.settings || {}) }, rng: PP.Cards.seededRng(opts.seed || 11),
      handGapMs: opts.gap == null ? 0 : opts.gap, customStacks: !!opts.custom,
    });
    const env = { clock, hub, ep, room, clients: [] };
    env.join = async (name, extra) => {
      const c = await Room.joinRoom({ code: 'RMS22', name, avatar: 'a1', hub, clock, ...(extra || {}) });
      env.clients.push(c);
      return c;
    };
    env.flush = async (n) => {
      for (let i = 0; i < (n || 1); i++) await hub.flush();
    };
    env.close = () => {
      room.close();
      env.clients.forEach((c) => c.close());
    };
    return env;
  }

  /** Flush until cond() holds; optionally nudges the manual clock forward between tries. */
  async function until(env, cond, label, stepMs) {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await env.hub.flush();
      if (cond()) return;
      if (stepMs) await env.clock.advance(stepMs);
    }
    throw new Error('condition never met: ' + label);
  }

  function randomAction(legal, rng, opts) {
    const allinP = (opts && opts.allinP) || 0;
    const r = rng();
    const raise = legal.canBet || legal.canRaise;
    if (raise && r < allinP) return { type: 'allin' };
    if (raise && r < 0.12) {
      const span = Math.max(0, Math.min(100, legal.maxRaiseTo - legal.minRaiseTo));
      return { type: legal.canBet ? 'bet' : 'raise', amount: legal.minRaiseTo + Math.floor(rng() * (span + 1)) };
    }
    if (legal.canCheck) return { type: 'check' };
    return r < 0.2 ? { type: 'fold' } : { type: 'call' };
  }

  const sumStacks = (engine) => engine.players.reduce((s, p) => s + p.stack, 0);
  const toClient = (env, client) => env.hub.log.filter((e) => e.to === client.endpoint.peerId).map((e) => e.msg);

  function walk(v, fn) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
    else if (v && typeof v === 'object') {
      fn(v);
      Object.keys(v).forEach((k) => walk(v[k], fn));
    }
  }

  /** Asserts no message to `peerId` carries a hole card that is not the recipient's or already revealed. */
  function scanLeaks(log, peerId, seatId) {
    let revealed = new Set();
    let ownSeen = 0;
    log.forEach((entry) => {
      if (entry.to !== peerId) return;
      const msg = entry.msg;
      if (msg.t === 'ev' && msg.name === 'handStart') revealed = new Set();
      if (msg.t === 'ev' && msg.name === 'showdown') msg.payload.reveals.forEach((r) => revealed.add(r.playerId));
      walk(msg, (obj) => {
        if (!Array.isArray(obj.hole) || obj.hole.length === 0) return;
        const owner = obj.id !== undefined ? obj.id : obj.playerId;
        if (owner === seatId) {
          ownSeen += 1;
          return;
        }
        assert.ok(revealed.has(owner), 'LEAK: ' + msg.t + '/' + (msg.name || '') + ' shows ' + owner + ' hole to ' + seatId);
      });
    });
    return ownSeen;
  }

  const stripHoles = (view) => JSON.stringify({ ...view, players: view.players.map((p) => ({ ...p, hole: null })) });

  /* ------------------------------------------------------------ lobby */

  t('lobby: host + 2 joins -> seats hero,h1,h2; duplicate names get " 2"; tokens issued', async () => {
    const env = await makeEnv();
    const lobbies = [];
    env.room.on('lobby', (l) => lobbies.push(l));
    const a = await env.join('max');
    const b = await env.join('MAX');
    await env.flush();
    assert.deepEqual(env.room.lobbyState().seats.map((s) => s.id), ['hero', 'h1', 'h2']);
    assert.deepEqual(env.room.lobbyState().seats.map((s) => s.name), ['host', 'max', 'MAX 2']);
    assert.equal(a.selfId, 'h1');
    assert.equal(a.role, 'player');
    assert.ok(/^[0-9a-f]{32}$/.test(a.token));
    assert.notEqual(a.token, b.token);
    const mine = b.lobby.seats.find((s) => s.isYou);
    assert.equal(mine.id, 'hero');
    assert.equal(b.lobby.seats.find((s) => s.kind === 'host').id, 'h2');
    assert.ok(lobbies.length >= 2);
    assert.ok(!JSON.stringify(env.hub.log).includes(a.token) || toClient(env, a).some((m) => m.t === 'welcome'));
    const leakedToken = env.hub.log.some((e) => e.to !== a.endpoint.peerId && JSON.stringify(e.msg).includes(a.token));
    assert.equal(leakedToken, false, 'a token must only ever be sent to its owner');
    env.close();
  });

  t('sanitizeName strips control / zero-width / bidi chars and caps at 12', () => {
    assert.equal(Room.sanitizeName('  bo\u0000b‮​  the\tbuilder!!  '), 'bo b the bui');
    assert.equal(Room.sanitizeName('<script>x'), 'scriptx');
    assert.equal(Room.sanitizeName(''), 'player');
    assert.equal(Room.sanitizeName(null), 'player');
    assert.equal(Room.sanitizeName('⁦⁩'), 'player');
    assert.equal(Room.sanitizeName('Zoë-o\'neil?'), 'Zoë-o\'neil?');
    assert.equal(Room.sanitizeName('abcdefghijkl', ['abcdefghijkl']), 'abcdefghij 2');
    assert.equal(Room.sanitizeChat('  hi‮  there\u0007 '), 'hi there');
    assert.equal(Room.sanitizeChat('x'.repeat(300)).length, 140);
    assert.equal(Room.sanitizeChat(42), '');
  });

  t('lobby: addBot -> b1 with rating clamped 1..5; full room -> spectator; locked -> reject locked', async () => {
    const env = await makeEnv({ settings: { maxSeats: 3 } });
    assert.equal(env.room.addBot(9), 'b1');
    assert.equal(env.room.addBot(-3, 'robo'), 'b2');
    assert.equal(env.room.addBot(3), null);
    const seats = env.room.lobbyState().seats;
    assert.deepEqual(seats.map((s) => [s.id, s.rating]), [['hero', 0], ['b1', 5], ['b2', 1]]);
    assert.equal(seats[2].name, 'robo');
    assert.ok(env.room.setBotRating('b2', 4));
    assert.ok(env.room.removeSeat('b2'));
    assert.equal(env.room.removeSeat('hero'), false);
    env.room.addBot(2);
    const spec = await env.join('late');
    assert.equal(spec.role, 'spectator');
    assert.equal(spec.selfId, null);
    env.room.updateSettings({ locked: true });
    await assert.rejects(env.join('nope'), (err) => err.name === 'NetError' && err.code === 'locked');
    env.close();
  });

  t('lobby: updateSettings clamps to option lists; clients cannot change settings', async () => {
    const env = await makeEnv();
    const s = env.room.updateSettings({ mode: 'cash', startingStack: 777, sb: 3, bb: 7, maxSeats: 40, turnSeconds: 45,
      disconnectPolicy: 'nuke', coachAllowed: false, locked: 'yes' });
    assert.equal(s.startingStack, 1000);
    assert.deepEqual([s.sb, s.bb], [10, 20]);
    assert.equal(s.maxSeats, 9);
    assert.equal(s.turnSeconds, 30);
    assert.equal(s.disconnectPolicy, 'autofold');
    assert.equal(s.coachAllowed, false);
    assert.equal(s.locked, false);
    const sng = env.room.updateSettings({ mode: 'sng', startingStack: 3000, sngPreset: 'turbo' });
    assert.equal(sng.startingStack, 3000);
    assert.ok(sng.sb >= 1 && sng.bb === 2 * sng.sb);
    const c = await env.join('hacker');
    c.endpoint.send({ v: 1, t: 'settings', settings: { startingStack: 5000, locked: true } });
    c.endpoint.send({ v: 1, t: 'updateSettings', patch: { mode: 'cash' } });
    await env.flush();
    assert.equal(env.room.settings.mode, 'sng');
    assert.equal(env.room.settings.startingStack, 3000);
    env.close();
  });

  t('hello: version mismatch rejected; no hello within 10 s -> kicked no-hello', async () => {
    const env = await makeEnv();
    const raw = await env.hub.connect('RMS22');
    const got = [];
    raw.onData((m) => got.push(m));
    raw.send({ v: 2, t: 'hello', name: 'old' });
    await env.flush();
    assert.equal(got[0].t, 'reject');
    assert.equal(got[0].code, 'version-mismatch');
    const silent = await env.hub.connect('RMS22');
    const got2 = [];
    silent.onData((m) => got2.push(m));
    silent.send({ v: 1, t: 'chat', text: 'before hello' });
    await env.flush();
    await env.clock.advance(10001);
    await env.flush();
    assert.deepEqual(got2.filter((m) => m.t === 'kicked').map((m) => m.reason), ['no-hello']);
    assert.ok(!got2.some((m) => m.t === 'chat'));
    env.close();
  });

  t('spam: > 20 msgs/s dropped; 50 strikes -> kicked spam', async () => {
    const env = await makeEnv();
    const c = await env.join('spammer');
    const chats = [];
    env.room.on('chat', (m) => chats.push(m));
    const got = [];
    c.endpoint.onMessage((m) => got.push(m));
    for (let i = 0; i < 30; i++) c.endpoint.send({ v: 1, t: 'emote', id: 'nope' });
    await env.flush();
    assert.ok(!got.some((m) => m.t === 'kicked'));
    for (let i = 0; i < 25; i++) c.endpoint.send({ v: 1, t: 'bogus' });
    await env.flush();
    assert.ok(got.some((m) => m.t === 'kicked' && m.reason === 'spam'));
    env.close();
  });

  /* ------------------------------------------------------------ the big soak */

  t('soak: host + 3 clients + 2 bots, 200+ hands, random legal actions: no leaks, chips conserved, consistent', async () => {
    const env = await makeEnv({ settings: { mode: 'cash', startingStack: 5000, sb: 10, bb: 20, rebuys: true, maxSeats: 6 } });
    const rng = PP.Cards.seededRng(99);
    const clients = [await env.join('ann'), await env.join('bob'), await env.join('cy')];
    env.room.addBot(1);
    env.room.addBot(3);
    clients.forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = (player, view, legal) => {
        assert.equal(player.id, 'hero');
        assert.equal(view.toActId, 'hero');
        return randomAction(legal, rng);
      };
    }));
    env.room.setLocalActionProvider((player, view, legal) => (player.id === 'hero'
      ? randomAction(legal, rng)
      : env.room.bots[player.id].decide(view, legal, view.players.find((p) => p.id === player.id))));
    const spec = env.room.start();
    assert.equal(spec.isHost, true);
    assert.equal(spec.heroId, 'hero');
    const engine = env.room.engine;
    assert.equal(sumStacks(engine), 6 * 5000);
    let added = 0; // chips that entered through rebuys
    const addChips = engine.addChips.bind(engine);
    engine.addChips = (id, n) => {
      const ok = addChips(id, n);
      if (ok) added += n;
      return ok;
    };
    let hands = 0;
    engine.on('handEnd', () => {
      hands += 1;
      assert.equal(sumStacks(engine), 6 * 5000 + added, 'chips conserved after hand ' + hands);
    });
    env.room.on('handGap', () => {
      if (engine.handNumber >= 200) env.room.endGame();
      else engine.players.filter((p) => p.stack === 0).forEach((p) => env.room.requestRebuy(p.id));
    });
    const results = await within(env.room.run(), 30000, 'soak run');
    await env.flush(3);
    assert.ok(hands >= 200, 'played ' + hands + ' hands');
    assert.equal(results.reason, 'host-ended');
    assert.equal(results.standings.length, 6);
    assert.equal(results.standings.reduce((s, x) => s + x.stack, 0), 6 * 5000 + added);
    // hidden information: scan every message each client received
    clients.forEach((c) => {
      const own = scanLeaks(env.hub.log, c.endpoint.peerId, c.selfId);
      assert.ok(own > 100, 'client saw its own hole cards (' + own + ')');
    });
    // public state consistency: every client got the same public view for event n
    const byN = new Map();
    clients.forEach((c) => toClient(env, c).filter((m) => m.t === 'ev').forEach((m) => {
      const key = stripHoles(m.view);
      if (!byN.has(m.n)) byN.set(m.n, key);
      else assert.equal(byN.get(m.n), key, 'public view differs at event ' + m.n);
    }));
    assert.ok(byN.size > 1000);
    // each client's mirror ended on the host's stacks
    const hostStacks = {};
    env.room.engine.players.forEach((p) => {
      hostStacks[p.id] = p.stack;
    });
    clients.forEach((c) => {
      c.engine.publicView().players.forEach((p) => assert.equal(p.stack, hostStacks[c.engine.toWireId(p.id)]));
      assert.equal(c.engine.isGameOver(), true);
      assert.equal(c.results.reason, 'host-ended');
    });
    env.close();
  });

  t('spectator never receives any unrevealed hole card', async () => {
    const env = await makeEnv({ settings: { startingStack: 1000 } });
    const rng = PP.Cards.seededRng(5);
    const a = await env.join('ann');
    a.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => randomAction(legal, rng, { allinP: 0.05 });
    });
    env.room.addBot(2);
    env.room.start();
    const spec = await env.join('watcher');
    assert.equal(spec.role, 'spectator');
    env.room.on('handGap', () => {
      if (env.room.engine.handNumber >= 20) env.room.endGame();
    });
    await within(env.room.run(), 15000, 'spectator run');
    await env.flush(2);
    assert.equal(scanLeaks(env.hub.log, spec.endpoint.peerId, null), 0);
    const kinds = new Set(toClient(env, spec).map((m) => m.t));
    ['welcome', 'start', 'sync', 'ev', 'end'].forEach((k) => assert.ok(kinds.has(k), k));
    assert.ok(!kinds.has('act'));
    env.close();
  });

  /* ------------------------------------------------------------ action validation */

  async function pendingOnClient(o) {
    const env = await makeEnv(o);
    const a = await env.join('ann');
    const b = await env.join('bob');
    const holds = {};
    [a, b].forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = () => new Promise((resolve) => {
        holds[c.selfId] = resolve;
      });
    }));
    env.room.start();
    env.acts = [];
    env.room.engine.on('action', (x) => env.acts.push({ playerId: x.playerId, type: x.type, amount: x.amount }));
    const done = env.room.run();
    await until(env, () => env.room.pending && env.room.pending.seatId !== 'hero', 'a client turn', o && o.step);
    const actor = [a, b].find((c) => c.selfId === env.room.pending.seatId);
    const other = actor === a ? b : a;
    return { env, a, b, actor, other, holds, done };
  }

  t('action validation: wrong peer / seq / type / amount / shape / oversize are ignored; out-of-range raise clamped', async () => {
    const { env, actor, other } = await pendingOnClient({ settings: { turnSeconds: 0 } });
    const seq = env.room.pending.seq;
    const hist = () => env.acts.length;
    const before = hist();
    const bad = [
      [other, { v: 1, t: 'action', seq, action: { type: 'call' } }],
      [actor, { v: 1, t: 'action', seq: seq + 1, action: { type: 'call' } }],
      [actor, { v: 1, t: 'action', seq: String(seq), action: { type: 'call' } }],
      [actor, { v: 1, t: 'action', seq, action: { type: 'steal' } }],
      [actor, { v: 1, t: 'action', seq, action: { type: 'raise', amount: NaN } }],
      [actor, { v: 1, t: 'action', seq, action: { type: 'raise', amount: -50 } }],
      [actor, { v: 1, t: 'action', seq, action: { type: 'raise', amount: '500' } }],
      [actor, { v: 1, t: 'action', seq, action: ['call'] }],
      [actor, { v: 1, t: 'action', seq }],
      [actor, { v: 1, t: 'action', seq, action: { type: 'call' }, pad: 'z'.repeat(3000) }],
      [actor, { v: 1, t: 'chat', text: 'y'.repeat(600) }],
    ];
    for (const [c, msg] of bad) {
      c.endpoint.send(msg);
      await env.flush();
      assert.equal(env.room.pending && env.room.pending.seq, seq, 'still pending after ' + JSON.stringify(msg).slice(0, 80));
      assert.equal(hist(), before);
    }
    const legal = env.room.pending.legal;
    const stack = env.room.pending.player.stack + env.room.pending.player.bet;
    actor.endpoint.send({ v: 1, t: 'action', seq, action: { type: 'raise', amount: 1e9 } });
    await env.flush();
    const last = env.acts[before];
    assert.equal(last.playerId, actor.selfId);
    if (legal.canRaise || legal.canBet) {
      assert.ok(['raise', 'bet', 'allin'].includes(last.type), last.type);
      assert.ok(last.amount <= legal.maxRaiseTo && last.amount <= stack);
    }
    // a duplicate (now stale) submission changes nothing for that seat
    const mine = () => env.acts.filter((h) => h.playerId === actor.selfId).length;
    const m0 = mine();
    actor.endpoint.send({ v: 1, t: 'action', seq, action: { type: 'fold' } });
    await env.flush();
    assert.equal(mine(), m0);
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ timers & sit-out */

  t('turn timer: 30 s auto check/fold + actCancel + timer broadcast; 2 timeouts -> sitting out; sitOut off clears', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 30 } });
    const seat = actor.selfId;
    const cancelled = [];
    actor.on('turnCancelled', (x) => cancelled.push(x));
    const timers = [];
    actor.on('timer', (x) => timers.push(x));
    const p = env.room.pending;
    const legal = p.legal;
    const histLen = env.acts.length;
    await env.clock.advance(29000);
    await env.flush();
    assert.equal(env.room.pending, p);
    await env.clock.advance(1001);
    await env.flush();
    const auto = env.acts[histLen];
    assert.equal(auto.playerId, seat);
    assert.equal(auto.type, legal.canCheck ? 'check' : 'fold');
    const msgs = toClient(env, actor);
    assert.ok(msgs.some((m) => m.t === 'timer' && m.playerId === seat && m.ms === 30000));
    assert.ok(msgs.some((m) => m.t === 'actCancel' && m.seq === p.seq && m.reason === 'timeout'));
    assert.deepEqual(cancelled, [{ playerId: 'hero', reason: 'timeout' }]);
    assert.ok(timers.length >= 1);
    // second consecutive timeout -> sitting out
    await until(env, () => env.room.pending && env.room.pending.seatId === seat, 'second turn', 1000);
    await env.clock.advance(30001);
    await env.flush();
    await until(env, () => env.room.seat(seat).sittingOut, 'sitting out', 500);
    const seatsMsgs = toClient(env, actor).filter((m) => m.t === 'seats');
    assert.ok(seatsMsgs.some((m) => m.seats.find((s) => s.id === seat).sittingOut === true));
    actor.setSittingOut(false);
    await env.flush();
    assert.equal(env.room.seat(seat).sittingOut, false);
    env.room.endGame();
    env.close();
  });

  t('sitOut on: pending turn resolved immediately; sitting-out seat auto-acts after 600 ms', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 0 } });
    const seat = actor.selfId;
    const n = env.acts.length;
    actor.setSittingOut(true);
    await env.flush();
    assert.equal(env.acts[n].playerId, seat);
    assert.ok(toClient(env, actor).some((m) => m.t === 'actCancel' && m.reason === 'sitout'));
    // later turns for that seat need only the 600 ms absent delay
    const count = () => env.acts.filter((h) => h.playerId === seat).length;
    const c0 = count();
    await until(env, () => count() > c0, 'absent auto action', 700);
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ disconnects */

  t('disconnect mid-turn (autofold): immediate check/fold, turnCancelled disconnect, seat offline', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 30 } });
    const seat = actor.selfId;
    const legal = env.room.pending.legal;
    const n = env.acts.length;
    const cancelled = [];
    env.room.on('turnCancelled', (x) => cancelled.push(x));
    actor.close();
    await env.flush();
    const h = env.acts[n];
    assert.equal(h.playerId, seat);
    assert.equal(h.type, legal.canCheck ? 'check' : 'fold');
    assert.deepEqual(cancelled, [{ playerId: seat, reason: 'disconnect' }]);
    assert.equal(env.room.seat(seat).conn, 'offline');
    env.room.endGame();
    env.close();
  });

  t('disconnect mid-turn (policy bot): takeover bot plays a legal action and keeps playing', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 30, disconnectPolicy: 'bot' } });
    const seat = actor.selfId;
    const total = sumStacks(env.room.engine) + env.room.engine.players.reduce((s, p) => s + p.totalBet, 0);
    const n = env.acts.length;
    env.hub.drop(actor.endpoint.peerId);
    actor.close();
    await env.flush();
    const h = env.acts[n];
    assert.equal(h.playerId, seat);
    assert.ok(ACTION_TYPES.includes(h.type));
    assert.ok(env.room.takeover[seat]);
    const before = env.acts.filter((x) => x.playerId === seat).length;
    await until(env, () => env.acts.filter((x) => x.playerId === seat).length > before + 1
      || env.room.engine.handNumber > 3, 'bot keeps acting', 1000);
    env.room.endGame();
    await env.flush();
    assert.equal(env.room.results.standings.reduce((s, x) => s + x.stack, 0), total);
    env.close();
  });

  /* ------------------------------------------------------------ rejoin */

  t('rejoin with token while it is your turn: same seat, old peer replaced, pending act re-sent with same seq', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 30 } });
    const seat = actor.selfId;
    const seq = env.room.pending.seq;
    const oldMsgs = [];
    actor.endpoint.onMessage((m) => oldMsgs.push(m));
    const again = await env.join('whoever', { token: actor.token });
    await env.flush();
    assert.equal(again.selfId, seat);
    assert.equal(again.role, 'player');
    assert.equal(env.room.seat(seat).conn, 'online');
    assert.equal(env.room.seat(seat).peerId, again.endpoint.peerId);
    assert.ok(oldMsgs.some((m) => m.t === 'kicked' && m.reason === 'replaced'));
    const msgs = toClient(env, again);
    const kinds = msgs.map((m) => m.t);
    assert.ok(kinds.indexOf('welcome') < kinds.indexOf('start') && kinds.indexOf('start') < kinds.indexOf('sync'));
    const sync = msgs.find((m) => m.t === 'sync');
    assert.equal(sync.pendingAct.seq, seq);
    assert.ok(sync.pendingAct.timeMs > 0 && sync.pendingAct.timeMs <= 30000);
    // no provider wired yet (table not built): the turn waits instead of auto-folding
    assert.equal(env.room.pending && env.room.pending.seq, seq);
    let asked = 0;
    again.engine.actionProvider = (p, v, legal) => {
      asked += 1;
      return legal.canCheck ? { type: 'check' } : { type: 'call' };
    };
    await until(env, () => !env.room.pending || env.room.pending.seq !== seq, 'rejoined action accepted');
    assert.equal(asked, 1);
    assert.ok(env.acts.some((h) => h.playerId === seat));
    env.room.endGame();
    env.close();
  });

  t('reconnect after a dropped connection: hello with token restores seat, start + sync received', async () => {
    const { env, actor } = await pendingOnClient({ settings: { turnSeconds: 0 } });
    const seat = actor.selfId;
    const status = [];
    actor.on('status', (s) => status.push(s));
    const mark = env.hub.log.length;
    env.hub.drop(actor.endpoint.peerId);
    await env.flush();
    assert.equal(env.room.seat(seat).conn, 'offline');
    await env.clock.advance(1000);
    await env.flush(2);
    assert.deepEqual(status.slice(0, 2), ['reconnecting', 'open']);
    assert.equal(env.room.seat(seat).conn, 'online');
    assert.equal(actor.selfId, seat);
    const after = env.hub.log.slice(mark).filter((e) => e.to === actor.endpoint.peerId).map((e) => e.msg.t);
    ['welcome', 'start', 'sync'].forEach((k) => assert.ok(after.includes(k), k));
    env.room.endGame();
    env.close();
  });

  t('wrong / absent token during play -> spectator with a hole-free view', async () => {
    const { env } = await pendingOnClient({ settings: { turnSeconds: 0 } });
    const s1 = await env.join('guess', { token: 'f'.repeat(32) });
    const s2 = await env.join('nobody');
    await env.flush();
    [s1, s2].forEach((s) => {
      assert.equal(s.role, 'spectator');
      assert.equal(s.selfId, null);
      const sync = toClient(env, s).find((m) => m.t === 'sync');
      assert.ok(sync.view.players.every((p) => p.hole === null));
      assert.equal(sync.pendingAct, null);
    });
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ chat & emotes */

  t('chat: 141+ chars truncated to 140, empty dropped, 6th in 10 s dropped, sender identity from the seat', async () => {
    const env = await makeEnv();
    const a = await env.join('ann');
    const b = await env.join('bob');
    const seen = [];
    b.on('chat', (m) => seen.push(m));
    a.sendChat('x'.repeat(200));
    a.sendChat('   ​ ');
    await env.flush();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text.length, 140);
    assert.equal(seen[0].from.name, 'ann');
    assert.equal(seen[0].from.seatId, 'h1');
    seen.length = 0;
    b.endpoint.send({ v: 1, t: 'chat', text: 'i am the host', name: 'host', from: { seatId: 'hero', name: 'host' } });
    for (let i = 0; i < 5; i++) b.sendChat('msg ' + i);
    await env.flush();
    assert.equal(seen.length, 5);
    assert.ok(seen.every((m) => m.from.name === 'bob' && m.from.seatId === 'hero'));
    await env.clock.advance(2000);
    b.sendChat('refilled');
    await env.flush();
    assert.equal(seen[seen.length - 1].text, 'refilled');
    env.close();
  });

  t('emotes: unknown id dropped; 1 per 2 s', async () => {
    const env = await makeEnv();
    const a = await env.join('ann');
    const got = [];
    env.room.on('emote', (e) => got.push(e.id));
    a.endpoint.send({ v: 1, t: 'emote', id: 'rickroll' });
    a.sendEmote('gg');
    a.sendEmote('nh');
    await env.flush();
    assert.deepEqual(got, ['gg']);
    await env.clock.advance(2000);
    a.sendEmote('nh');
    await env.flush();
    assert.deepEqual(got, ['gg', 'nh']);
    assert.equal(env.room.sendEmote('fire'), true);
    assert.equal(env.room.sendChat('  '), false);
    env.close();
  });

  /* ------------------------------------------------------------ rebuy */

  t('rebuy (cash): busted client rebuys and has chips again before the next hand', async () => {
    const env = await makeEnv({ settings: { mode: 'cash', startingStack: 500, sb: 50, bb: 100, rebuys: true }, gap: 1000 });
    const a = await env.join('ann');
    let rebuys = 0;
    a.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => ((legal.canBet || legal.canRaise) ? { type: 'allin' } : { type: 'call' });
      spec.engine.on('handEnd', () => {
        const me = spec.engine.publicView().players.find((p) => p.id === 'hero');
        if (me.stack === 0) {
          rebuys += 1;
          a.requestRebuy();
        }
      });
    });
    env.room.setLocalActionProvider((p, v, legal) => (legal.canCall ? { type: 'call' } : { type: 'check' }));
    env.room.on('handGap', () => {
      if (env.room.stackOf('hero') === 0) env.room.requestRebuy('hero');
    });
    let restoredSeen = false;
    env.room.start();
    env.room.engine.on('handStart', () => {
      if (rebuys > 0 && env.room.stackOf('h1') > 0) restoredSeen = true;
    });
    const done = env.room.run();
    await until(env, () => restoredSeen || env.room.phase !== 'playing', 'client rebuy applied', 1000);
    assert.ok(restoredSeen, 'client stack restored after rebuy');
    env.room.endGame();
    await done;
    env.close();
  });

  t('rebuy is ignored in sng', async () => {
    const env = await makeEnv({ settings: { mode: 'sng', startingStack: 1000, sngPreset: 'turbo' } });
    const a = await env.join('ann');
    env.room.start();
    env.room.engine.players.find((p) => p.id === a.selfId).stack = 0; // simulate a bust between hands
    a.requestRebuy();
    await env.flush();
    assert.equal(env.room.rebuys.size, 0);
    assert.equal(env.room.requestRebuy('hero'), false);
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ offline sng */

  t('offline SNG: endpoint null + 5 bots, turbo, 300 chips -> results with places 1..6 and points', async () => {
    const clock = Net.createManualClock();
    const room = new Room.HostRoom({
      endpoint: null, hostName: 'solo', clock, rng: PP.Cards.seededRng(21), handGapMs: 0, customStacks: true,
      settings: { mode: 'sng', startingStack: 300, sngPreset: 'turbo', turnSeconds: 0 },
    });
    assert.equal(room.code, null);
    for (let i = 0; i < 5; i++) assert.ok(room.addBot(1 + (i % 5)));
    const rng = PP.Cards.seededRng(4);
    room.setLocalActionProvider((player, view, legal) => (player.id === 'hero'
      ? randomAction(legal, rng, { allinP: 0.1 })
      : room.bots[player.id].decide(view, legal, view.players.find((p) => p.id === player.id))));
    const ends = [];
    room.on('end', (r) => ends.push(r));
    const elim = [];
    room.on('eliminated', (e) => elim.push(e));
    room.start();
    assert.ok(room.tournament, 'tournament created');
    const total = sumStacks(room.engine);
    const results = await within(room.run(), 20000, 'offline sng');
    assert.equal(ends.length, 1);
    assert.equal(results.reason, 'complete');
    assert.equal(results.mode, 'sng');
    assert.deepEqual(results.standings.map((s) => s.place), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(results.standings.map((s) => s.points), [50, 30, 20, 0, 0, 0]);
    assert.equal(results.standings.reduce((s, x) => s + x.stack, 0), total);
    assert.equal(elim.length, 5);
    assert.equal(room.phase, 'ended');
    assert.ok(room.backToLobby());
    assert.equal(room.phase, 'lobby');
    room.close();
  });

  /* ------------------------------------------------------------ end / close */

  t('endGame -> clients get end; close -> clients get closed host-ended', async () => {
    const env = await makeEnv();
    const a = await env.join('ann');
    env.room.addBot(1);
    const ends = [];
    const closed = [];
    a.on('end', (r) => ends.push(r));
    a.on('closed', (c) => closed.push(c.reason));
    env.room.start();
    const res = env.room.endGame();
    await env.flush();
    assert.equal(res.reason, 'host-ended');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].standings.find((s) => s.id === 'hero').name, 'ann');
    assert.equal(a.engine.isGameOver(), true);
    env.room.close();
    await env.flush();
    assert.deepEqual(closed, ['host-ended']);
    assert.equal(a.closed, true);
    env.room.close(); // idempotent
  });

  t('host-side events: lobby/seats/timer/handGap fire; tableSpec shape for main.js', async () => {
    const env = await makeEnv({ settings: { turnSeconds: 15 }, gap: 60000 });
    await env.join('ann');
    env.room.addBot(2, 'Robo');
    const timers = [];
    env.room.on('timer', (x) => timers.push(x));
    env.room.setLocalActionProvider((p, v, legal) => (legal.canCheck ? { type: 'check' } : { type: 'call' }));
    const spec = env.room.start();
    await env.flush();
    ['engine', 'heroId', 'players', 'meta', 'names', 'sb', 'bb', 'bots', 'isHost', 'room', 'coachAllowed', 'mode']
      .forEach((k) => assert.ok(k in spec, k));
    assert.equal(spec.meta.b1.kind, 'bot');
    assert.equal(spec.meta.hero.kind, 'host');
    assert.equal(spec.meta.h1.kind, 'human');
    assert.ok(spec.bots.b1 && typeof spec.bots.b1.decide === 'function');
    assert.equal(spec.names.b1, 'Robo');
    const c = env.clients[0];
    const cs = c.tableSpec();
    assert.equal(cs.heroId, 'hero');
    assert.equal(cs.isHost, false);
    assert.equal(cs.names.hero, 'ann');
    assert.equal(cs.names.h1, 'host');
    assert.equal(cs.meta.hero.kind, 'human');
    env.room.run();
    await until(env, () => timers.length > 0, 'timer event', 100);
    assert.ok(timers.every((x) => x.ms === 15000));
    env.room.endGame();
    env.close();
  });

  t('room.js has no eval / Function / innerHTML', () => {
    const src = String(Room.HostRoom) + String(Room.ClientRoom) + String(PP.RemoteEngine);
    assert.ok(!/\beval\(|new Function|innerHTML|insertAdjacentHTML|document\.write/.test(src));
  });
})();
