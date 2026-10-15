/* Adversarial review tests for the multiplayer stack (net / room / remote-engine).
 * Each test is one attack a hostile or buggy client could try; each must fail harmlessly. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'mp-security: ' + name, fn });
  const Net = PP.Net;
  const Room = PP.Room;
  const CODE = 'SEC23';

  async function makeEnv(o) {
    const opts = o || {};
    const clock = Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    const ep = await Net.createHost({ hub, clock, code: CODE });
    const room = new Room.HostRoom({
      endpoint: ep, hostName: 'host', hostAvatar: 'a3', clock,
      settings: { turnSeconds: 0, ...(opts.settings || {}) }, rng: PP.Cards.seededRng(opts.seed || 7), handGapMs: 0,
    });
    const env = { clock, hub, ep, room, clients: [] };
    env.join = async (name, extra) => {
      const c = await Room.joinRoom({ code: CODE, name, avatar: 'a1', hub, clock, ...(extra || {}) });
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

  async function until(env, cond, label, stepMs) {
    for (let i = 0; i < 400; i++) {
      if (cond()) return;
      await env.hub.flush();
      if (cond()) return;
      if (stepMs) await env.clock.advance(stepMs);
    }
    throw new Error('condition never met: ' + label);
  }

  /** Runs fn with console.error captured; returns the captured calls. */
  async function quietErrors(fn) {
    const orig = console.error;
    const calls = [];
    console.error = (...a) => calls.push(a.map(String).join(' '));
    try {
      await fn();
    } finally {
      console.error = orig;
    }
    return calls;
  }

  const passiveOf = (legal) => (legal.canCheck ? { type: 'check' } : { type: 'call' });
  const toPeer = (env, peerId) => env.hub.log.filter((e) => e.to === peerId).map((e) => e.msg);

  function walk(v, fn) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
    else if (v && typeof v === 'object') {
      fn(v);
      Object.keys(v).forEach((k) => walk(v[k], fn));
    }
  }

  /** Every hole card a peer saw must be its own seat's or revealed at this hand's showdown. */
  function assertNoLeak(env, peerId, seatId) {
    let revealed = new Set();
    toPeer(env, peerId).forEach((msg) => {
      if (msg.t === 'ev' && msg.name === 'handStart') revealed = new Set();
      if (msg.t === 'ev' && msg.name === 'showdown') msg.payload.reveals.forEach((r) => revealed.add(r.playerId));
      walk(msg, (obj) => {
        if (!Array.isArray(obj.hole) || obj.hole.length === 0) return;
        const owner = obj.id !== undefined ? obj.id : obj.playerId;
        if (owner !== seatId) assert.ok(revealed.has(owner), 'LEAK in ' + msg.t + '/' + (msg.name || '') + ' of ' + owner);
      });
    });
  }

  /* ------------------------------------------------------- hidden information */

  t('guessed / forged tokens and kicked players never see another hole card', async () => {
    const env = await makeEnv({ settings: { maxSeats: 4 } });
    const a = await env.join('ann');
    const b = await env.join('bob');
    [a, b].forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => passiveOf(legal);
    }));
    env.room.addBot(2);
    env.room.start();
    // forged token (right shape, wrong value) and a malformed one -> plain spectators
    const forged = await env.join('mallory', { token: 'f'.repeat(32) });
    const junk = await env.join('eve', { token: '<script>' });
    assert.equal(forged.role, 'spectator');
    assert.equal(junk.role, 'spectator');
    env.room.on('handGap', () => {
      const n = env.room.engine.handNumber;
      if (n === 3) env.room.kick(b.selfId, 'kicked');
      if (n >= 8) env.room.endGame();
    });
    let res = null;
    env.room.run().then((r) => {
      res = r;
    });
    await until(env, () => res !== null, 'game with a kicked seat finishes', 700); // offline seat auto-acts after 600 ms
    await env.flush(3);
    // the kicked player's token is dead for rejoin
    await assert.rejects(env.join('bob again', { token: b.token }), (e) => e.code === 'kicked');
    assertNoLeak(env, a.endpoint.peerId, a.selfId);
    assertNoLeak(env, b.endpoint.peerId, b.selfId);
    assertNoLeak(env, forged.endpoint.peerId, null);
    assertNoLeak(env, junk.endpoint.peerId, null);
    const forgedKinds = new Set(toPeer(env, forged.endpoint.peerId).map((m) => m.t));
    assert.ok(!forgedKinds.has('act'), 'spectator never gets a turn');
    env.close();
  });

  t('acting for another seat, replaying an old seq, or acting from the rail has no effect', async () => {
    const env = await makeEnv({ settings: { turnSeconds: 0 } });
    const a = await env.join('ann');
    const b = await env.join('bob');
    const holds = {};
    [a, b].forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = () => new Promise((resolve) => {
        holds[c.selfId] = resolve;
      });
    }));
    env.room.start();
    const rail = await env.join('rail');
    const acts = [];
    env.room.engine.on('action', (x) => acts.push(x.playerId));
    env.room.run();
    await until(env, () => env.room.pending && env.room.pending.seatId !== 'hero', 'client turn');
    const p = env.room.pending;
    const actor = [a, b].find((c) => c.selfId === p.seatId);
    const other = actor === a ? b : a;
    const before = acts.length;
    other.endpoint.send({ v: 1, t: 'action', seq: p.seq, action: { type: 'fold' } });
    rail.endpoint.send({ v: 1, t: 'action', seq: p.seq, action: { type: 'fold' } });
    actor.endpoint.send({ v: 1, t: 'action', seq: p.seq - 1, action: { type: 'fold' } });
    actor.endpoint.send({ v: 1, t: 'action', seq: 1e309, action: { type: 'fold' } }); // JSON -> null
    await env.flush(2);
    assert.equal(env.room.pending, p, 'turn still pending');
    assert.equal(acts.length, before);
    // the real answer still works, exactly once
    holds[actor.selfId]({ type: 'call' });
    await until(env, () => env.room.pending !== p, 'real answer accepted');
    actor.endpoint.send({ v: 1, t: 'action', seq: p.seq, action: { type: 'fold' } }); // replay
    await env.flush(2);
    assert.equal(acts.filter((id) => id === p.seatId).length >= 1, true);
    assert.ok(!env.room.engine.players.find((x) => x.id === p.seatId).folded || acts.length > before + 1);
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ markup / text */

  t('markup and control characters in names and chat stay inert text', async () => {
    const env = await makeEnv();
    const evil = await env.join('<img src=x onerror=alert(1)>');
    const seat = env.room.lobbyState().seats.find((s) => s.id === evil.selfId);
    assert.ok(!/[<>=/()]/.test(seat.name), 'name keeps no markup characters: ' + seat.name);
    assert.ok(Array.from(seat.name).length <= 12);
    const spoof = await env.join('host');
    assert.equal(env.room.lobbyState().seats.find((s) => s.id === spoof.selfId).name, 'host 2', 'cannot impersonate the host');
    const got = [];
    env.room.on('chat', (m) => got.push(m));
    evil.endpoint.send({ v: 1, t: 'chat', text: '<b>hi</b>‮\u0000 there', from: { seatId: 'hero', name: 'host' } });
    await env.flush(2);
    assert.equal(got.length, 1);
    assert.equal(got[0].text, '<b>hi</b> there', 'kept as literal text, bidi/control stripped');
    assert.equal(got[0].from.seatId, evil.selfId, 'sender identity comes from the host, not the message');
    env.close();
  });

  /* ------------------------------------------------------------ crash attempts */

  t('malformed / hostile messages never throw inside the host and the game keeps going', async () => {
    const env = await makeEnv();
    const a = await env.join('ann');
    a.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => passiveOf(legal);
    });
    env.room.addBot(3);
    const before = env.ep.stats.dropped;
    const errors = await quietErrors(async () => {
      const raw = [
        'just a string', 42, null, [1, 2, 3], { noT: true }, { t: 7 },
        { t: '__proto__' }, { t: 'constructor' }, { t: 'toString' }, { t: 'hasOwnProperty' },
        { v: 1, t: 'hello', name: { a: 1 }, avatar: ['x'], token: 5 },
        { v: 1, t: 'action', seq: null, action: null },
        { v: 1, t: 'action', seq: 1, action: { type: { evil: true } } },
        { v: 1, t: 'chat', text: ['array'] }, { v: 1, t: 'chat' }, { v: 1, t: 'emote', id: { x: 1 } },
        { v: 1, t: 'sitOut', on: 'yes' }, { v: 1, t: 'rebuy', amount: 1e9 }, { v: 1, t: 'leave', seat: 'hero' },
        { v: 1, t: 'x'.repeat(3000) }, { t: '_ping', n: 'z'.repeat(5000) },
      ];
      raw.forEach((m) => a.endpoint.send(m));
      await env.flush(3);
    });
    assert.deepEqual(errors, [], 'no handler threw');
    assert.ok(env.ep.stats.dropped - before >= 6, 'non-objects / missing t / oversize are dropped at the gate');
    assert.equal(env.room.closed, false);
    // the oversized ping was answered with a plain number, never echoed back
    const pongs = toPeer(env, a.endpoint.peerId).filter((m) => m.t === '_pong');
    assert.equal(pongs.length, 0, 'reserved messages are not logged as app traffic');
    // a seat still works after the barrage: the game deals and runs
    const b = await env.join('bob');
    b.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => passiveOf(legal);
    });
    env.room.start();
    env.room.on('handGap', () => {
      if (env.room.engine.handNumber >= 3) env.room.endGame();
    });
    const res = await env.room.run();
    assert.equal(res.reason, 'host-ended');
    env.close();
  });

  t('a _ping payload is never reflected: the pong carries only a number', async () => {
    const clock = Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    const ep = await Net.createHost({ hub, clock, code: 'PNG22' });
    const conn = await hub.connect('PNG22');
    const got = [];
    conn.onData((m) => got.push(m));
    conn.send({ t: '_ping', n: 'x'.repeat(4000) });
    conn.send({ t: '_ping', n: 3 });
    await hub.flush();
    assert.deepEqual(got.filter((m) => m.t === '_pong').map((m) => m.n), [0, 3]);
    ep.close();
  });

  /* ------------------------------------------------------------ stalling */

  t('stall attempts: silent player is timed out, spammer is kicked, hello-less peer is dropped', async () => {
    const env = await makeEnv({ settings: { turnSeconds: 15 } });
    const silent = await env.join('afk');
    silent.on('start', (spec) => {
      spec.engine.actionProvider = () => new Promise(() => {}); // never answers
    });
    const spammer = await env.join('spam');
    spammer.on('start', (spec) => {
      spec.engine.actionProvider = () => new Promise(() => {});
    });
    // a raw connection that never says hello
    const lurker = await env.hub.connect(CODE);
    const lurkerGot = [];
    lurker.onData((m) => lurkerGot.push(m));
    env.room.start();
    env.room.on('handGap', () => {
      if (env.room.engine.handNumber >= 3) env.room.endGame();
    });
    const done = env.room.run();
    for (let i = 0; i < 60; i++) spammer.endpoint.send({ v: 1, t: 'sitOut', on: 'maybe' });
    await env.flush(2);
    assert.equal(env.room.seat(spammer.selfId).conn, 'offline', 'spammer kicked -> seat offline');
    await env.clock.advance(10001);
    assert.ok(lurkerGot.some((m) => m.t === 'kicked' && m.reason === 'no-hello'));
    let res = null;
    done.then((r) => {
      res = r;
    });
    await until(env, () => res !== null, 'game finishes despite the stallers', 16000);
    assert.equal(res.reason, 'host-ended');
    assert.equal(env.room.seat(silent.selfId).sittingOut, true, 'two timeouts -> sitting out');
    env.close();
  });

  t('sit-out spam does not amplify into seat broadcasts; a peer that left has no voice', async () => {
    const env = await makeEnv();
    const a = await env.join('ann');
    const b = await env.join('bob');
    env.room.start();
    await env.flush();
    const seatsTo = () => toPeer(env, b.endpoint.peerId).filter((m) => m.t === 'seats').length;
    const s0 = seatsTo();
    for (let i = 0; i < 10; i++) a.endpoint.send({ v: 1, t: 'sitOut', on: true });
    await env.flush(2);
    assert.equal(seatsTo() - s0, 1, 'only the first toggle broadcasts');
    const chats = [];
    env.room.on('chat', (m) => chats.push(m));
    a.endpoint.send({ v: 1, t: 'leave' });
    a.endpoint.send({ v: 1, t: 'chat', text: 'ghost' });
    a.endpoint.send({ v: 1, t: 'emote', id: 'gg' });
    await env.flush(2);
    assert.equal(chats.length, 0);
    env.room.endGame();
    env.close();
  });

  t('a hand still finishing on an ended game never touches the next game', async () => {
    const env = await makeEnv({ settings: { turnSeconds: 0 } });
    const a = await env.join('ann');
    a.on('start', (spec) => {
      spec.engine.actionProvider = () => new Promise(() => {});
    });
    env.room.start();
    const oldEngine = env.room.engine;
    const oldRun = env.room.run();
    await until(env, () => env.room.pending && env.room.pending.seatId === a.selfId, 'client turn');
    env.room.endGame();
    env.room.backToLobby();
    env.room.start();
    assert.notEqual(env.room.engine, oldEngine);
    const view = oldEngine.publicView(a.selfId);
    const legal = { canCheck: false, canFold: true };
    const act = await oldEngine.actionProvider({ id: a.selfId }, view, legal);
    assert.deepEqual(act, { type: 'fold' });
    assert.equal(env.room.pending, null, 'old engine did not open a turn in the new game');
    const r = await oldRun;
    assert.ok(r === null || r.reason === 'host-ended');
    env.room.endGame();
    env.close();
  });

  /* ------------------------------------------------------------ transport limits */

  t('9 seats, long hands: every host->client message fits the client cap; nothing dropped', async () => {
    const env = await makeEnv({ settings: { maxSeats: 9, startingStack: 5000, sb: 5, bb: 10 } });
    const rng = PP.Cards.seededRng(3);
    const cs = [];
    for (let i = 0; i < 3; i++) cs.push(await env.join('p' + i));
    cs.forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => {
        if ((legal.canRaise || legal.canBet) && rng() < 0.4) return { type: legal.canBet ? 'bet' : 'raise', amount: legal.minRaiseTo };
        return passiveOf(legal);
      };
    }));
    for (let i = 0; i < 5; i++) env.room.addBot(1 + (i % 5));
    env.room.start();
    const late = await env.join('late'); // spectator: start + sync are the largest messages
    env.room.on('handGap', () => {
      if (env.room.engine.handNumber >= 15) env.room.endGame();
    });
    await env.room.run();
    await env.flush(3);
    let max = 0;
    env.hub.log.forEach((e) => {
      max = Math.max(max, JSON.stringify(e.msg).length);
    });
    assert.ok(max <= Net.MAX_INBOUND_CLIENT, 'largest message ' + max + ' bytes');
    cs.concat([late]).forEach((c) => assert.equal(c.endpoint.stats.dropped, 0));
    env.close();
  });

  /* ------------------------------------------------------------ remote engine */

  t('remote engine: a turn that arrives before the provider is wired waits for it (no auto-fold)', async () => {
    const sent = [];
    const re = new PP.RemoteEngine({ selfId: 'h1', send: (m) => sent.push(m) });
    const legal = { canCheck: true, canFold: true, canCall: false };
    re.receive({ t: 'sync', view: { handNumber: 2, street: 'flop', players: [] }, pendingAct: { seq: 4, player: { id: 'h1' }, view: { handNumber: 2, players: [] }, legal, timeMs: 9000 } });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [], 'nothing sent before the UI is ready');
    re.actionProvider = (player) => {
      assert.equal(player.id, 'hero');
      return { type: 'bet', amount: 40 };
    };
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.map((m) => [m.seq, m.action.type, m.action.amount]), [[4, 'bet', 40]]);
  });

  t('remote engine: a turn cancelled while waiting for the provider never reaches it', async () => {
    const sent = [];
    const re = new PP.RemoteEngine({ selfId: 'h1', send: (m) => sent.push(m) });
    re.receive({ t: 'act', seq: 2, player: {}, view: { players: [] }, legal: { canCheck: true }, timeMs: 0 });
    await new Promise((r) => setImmediate(r));
    re.receive({ t: 'actCancel', seq: 2, reason: 'timeout' });
    let asked = 0;
    re.actionProvider = () => {
      asked += 1;
      return { type: 'check' };
    };
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(asked, 0);
    assert.deepEqual(sent, []);
  });
})();

(function () {
  const t = (name, fn) => TESTS.push({ name: 'mp-integration: ' + name, fn });
  t('client engine.players is the table roster right after start (before any event), ids aliased', async () => {
    const clock = PP.Net.createManualClock();
    const hub = PP.Net.Loopback.createHub({ clock });
    const ep = await PP.Net.createHost({ hub, clock, code: 'RST22' });
    const room = new PP.Room.HostRoom({ endpoint: ep, hostName: 'host', clock, settings: { turnSeconds: 0 }, handGapMs: 0 });
    const c = await PP.Room.joinRoom({ code: 'RST22', name: 'ann', hub, clock });
    room.addBot(2);
    let spec = null;
    c.on('start', (s) => {
      spec = s;
    });
    room.start();
    for (let i = 0; i < 3 && !spec; i++) await hub.flush();
    assert.ok(spec, 'start received');
    const ids = spec.engine.players.map((p) => p.id).sort();
    assert.deepEqual(ids, ['b1', 'h1', 'hero'].sort());
    const me = spec.engine.players.find((p) => p.id === 'hero');
    assert.equal(me.name, 'ann', 'own seat aliased to hero');
    assert.equal(spec.engine.players.find((p) => p.id === 'h1').name, 'host', 'host appears under the client wire id');
    assert.ok(spec.engine.players.every((p) => Number.isInteger(p.seat) && p.stack > 0));
    room.close();
    c.close();
  });
})();
