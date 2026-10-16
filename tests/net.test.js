/* Tests for PP.Net — codes, loopback transport, validation, heartbeat, reconnect. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'net: ' + name, fn });
  const Net = PP.Net;

  async function setup(opts) {
    const o = opts || {};
    const clock = o.clock || Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    const host = await Net.createHost({ hub, clock, code: o.code || 'K7QXM' });
    const joins = [];
    host.onPeerJoin((id) => joins.push(id));
    const msgs = [];
    host.onMessage((m, id) => msgs.push({ m, id }));
    return { clock, hub, host, joins, msgs };
  }

  function collect(client) {
    const got = [];
    client.onMessage((m) => got.push(m));
    return got;
  }

  async function withIce(cfg, fetchImpl, fn) {
    const prevCfg = Net.config, prevFetch = globalThis.fetch;
    Net.config = cfg; globalThis.fetch = fetchImpl;
    try { return await fn(); } finally { Net.config = prevCfg; globalThis.fetch = prevFetch; }
  }
  const STUN = [{ urls: 'stun:stun.example:19302' }];
  const okJson = (body) => async () => ({ ok: true, json: async () => body });

  t('resolveIce returns base servers when no relay is configured', async () => {
    const got = await withIce({ iceServers: STUN, turnUrl: null }, undefined,
      () => Net.resolveIce(Net.createManualClock()));
    assert.deepEqual(got, STUN);
  });

  t('resolveIce appends relay servers fetched from turnUrl', async () => {
    const relay = [{ urls: 'turns:relay.example:443?transport=tcp', username: 'u', credential: 'c' }];
    const got = await withIce({ iceServers: STUN, turnUrl: 'https://a.example/1' }, okJson(relay),
      () => Net.resolveIce(Net.createManualClock()));
    assert.deepEqual(got, STUN.concat(relay));
  });

  t('resolveIce ignores a malformed relay response and keeps direct-only', async () => {
    const got = await withIce({ iceServers: STUN, turnUrl: 'https://a.example/2' }, okJson({ error: 'bad key' }),
      () => Net.resolveIce(Net.createManualClock()));
    assert.deepEqual(got, STUN);
  });

  t('resolveIce falls back to direct-only when the relay fetch fails', async () => {
    const got = await withIce({ iceServers: STUN, turnUrl: 'https://a.example/3' },
      async () => { throw new Error('offline'); },
      () => Net.resolveIce(Net.createManualClock()));
    assert.deepEqual(got, STUN);
  });

  t('makeCode yields 5 chars from the alphabet (1000 samples)', () => {
    const rng = PP.Cards.seededRng(7);
    for (let i = 0; i < 1000; i++) {
      const code = Net.makeCode(rng);
      assert.equal(code.length, 5);
      for (const ch of code) assert.ok(Net.CODE_ALPHABET.includes(ch), ch);
    }
    assert.equal(Net.CODE_ALPHABET.length, 31);
  });

  t('normalizeCode trims, uppercases and rejects ambiguous / malformed input', () => {
    assert.equal(Net.normalizeCode(' k7qxm '), 'K7QXM');
    assert.equal(Net.normalizeCode('k7-qx m'), 'K7QXM');
    ['K7QXO', 'K7QXI', 'K7QXL', 'K7QX0', 'K7QX1', 'K7QX', 'K7QXMM', '', null, 12345, {}].forEach((bad) => {
      assert.equal(Net.normalizeCode(bad), null, String(bad));
    });
  });

  t('peerIdFor, inviteUrl (https / file / localhost), codeFromLocation', () => {
    assert.equal(Net.peerIdFor('K7QXM'), 'pxhe-K7QXM');
    const https = { protocol: 'https:', hostname: 'lvxcas.github.io', origin: 'https://lvxcas.github.io', pathname: '/pixel-poker/' };
    assert.equal(Net.inviteUrl('K7QXM', https), 'https://lvxcas.github.io/pixel-poker/?room=K7QXM');
    assert.equal(Net.inviteUrl('K7QXM', { protocol: 'file:', hostname: '', pathname: '/x/index.html' }),
      'https://lvxcas.github.io/pixel-poker/?room=K7QXM');
    assert.equal(Net.inviteUrl('K7QXM', { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8000', pathname: '/' }),
      'https://lvxcas.github.io/pixel-poker/?room=K7QXM');
    assert.equal(Net.codeFromLocation({ search: '?room=k7qxm' }), 'K7QXM');
    assert.equal(Net.codeFromLocation({ search: '?x=1&room=K7QX0' }), null);
    assert.equal(Net.codeFromLocation({ search: '' }), null);
  });

  t('loopback host + 2 clients: joins, send, broadcast(except), per-connection order', async () => {
    const { hub, host, joins, msgs, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    const b = await Net.join('k7qxm', { hub, clock });
    await hub.flush();
    assert.deepEqual(joins.slice().sort(), ['peer-1', 'peer-2']);
    assert.deepEqual(host.peers().sort(), ['peer-1', 'peer-2']);
    const ga = collect(a);
    const gb = collect(b);
    for (let i = 0; i < 20; i++) host.send('peer-1', { t: 'n', i });
    host.broadcast({ t: 'all' }, 'peer-1');
    assert.equal(host.send('nobody', { t: 'x' }), false);
    for (let i = 0; i < 5; i++) a.send({ t: 'up', i });
    await hub.flush();
    assert.deepEqual(ga.map((m) => m.i), Array.from({ length: 20 }, (_, i) => i));
    assert.deepEqual(gb.map((m) => m.t), ['all']);
    assert.deepEqual(msgs.map((x) => x.m.i), [0, 1, 2, 3, 4]);
    assert.ok(msgs.every((x) => x.id === 'peer-1'));
    host.close();
    a.close();
    b.close();
  });

  t('messages are JSON round-tripped (receiver mutation never reaches the sender)', async () => {
    const { hub, host, msgs, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    const original = { t: 'obj', nested: { list: [1, 2, 3] }, when: undefined };
    a.send(original);
    await hub.flush();
    const got = msgs[0].m;
    assert.notEqual(got, original);
    got.nested.list.push(99);
    assert.deepEqual(original.nested.list, [1, 2, 3]);
    assert.ok(!('when' in got));
    host.close();
    a.close();
  });

  t('join to an unknown code rejects room-not-found (NetError with .code)', async () => {
    const hub = Net.Loopback.createHub();
    await assert.rejects(Net.join('ABCDE', { hub }), (err) => err.name === 'NetError' && err.code === 'room-not-found');
    await assert.rejects(Net.join('nope', { hub }), (err) => err.code === 'room-not-found');
  });

  t('host code collision regenerates; 5 failures -> room-taken', async () => {
    const hub = Net.Loopback.createHub();
    const first = await Net.createHost({ hub, code: 'AAAAA' });
    const second = await Net.createHost({ hub, code: 'AAAAA', rng: PP.Cards.seededRng(3) });
    assert.notEqual(second.code, 'AAAAA');
    const stuck = { register: () => false, unregister() {} };
    await assert.rejects(Net.createHost({ hub: stuck }), (err) => err.code === 'room-taken');
    first.close();
    second.close();
  });

  t('oversize / non-object / missing t are dropped and counted; _ping never reaches onMessage', async () => {
    const { hub, host, msgs, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    a.send({ t: 'big', pad: 'x'.repeat(Net.MAX_INBOUND_HOST) });
    a.send('just a string');
    a.send([1, 2]);
    a.send({ nope: true });
    a.send({ t: 5 });
    a.send({ t: '_ping', n: 1 });
    a.send({ t: '_custom' });
    a.send({ t: 'ok' });
    await hub.flush();
    assert.deepEqual(msgs.map((x) => x.m.t), ['ok']);
    assert.equal(host.stats.dropped, 5);
    host.close();
    a.close();
  });

  t('client drops oversize host messages too', async () => {
    const { hub, host, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    const got = collect(a);
    await hub.flush();
    host.send('peer-1', { t: 'huge', pad: 'y'.repeat(Net.MAX_INBOUND_CLIENT) });
    host.send('peer-1', { t: 'fine' });
    await hub.flush();
    assert.deepEqual(got.map((m) => m.t), ['fine']);
    assert.equal(a.stats.dropped, 1);
    host.close();
    a.close();
  });

  t('heartbeat: silent client -> away after 12 s, back online on traffic, timeout leave after 30 s', async () => {
    const { hub, host, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    await hub.flush();
    const status = [];
    const leaves = [];
    host.onPeerStatus((id, s) => status.push(s));
    host.onPeerLeave((id, reason) => leaves.push(reason));
    a.close(); // a clean client close is reported as 'closed'
    await hub.flush();
    assert.deepEqual(leaves, ['closed']);
    // Silent peer: a raw loopback connection that never pings.
    const raw = await hub.connect('K7QXM');
    await hub.flush();
    await clock.advance(11000);
    assert.deepEqual(status, []);
    await clock.advance(2000);
    assert.deepEqual(status, ['away']);
    raw.send({ t: 'hi' });
    await hub.flush();
    assert.deepEqual(status, ['away', 'online']);
    await clock.advance(31000);
    await hub.flush();
    assert.deepEqual(status, ['away', 'online', 'away']);
    assert.deepEqual(leaves, ['closed', 'timeout']);
    assert.deepEqual(host.peers(), []);
    host.close();
  });

  t('heartbeat keeps a live client online indefinitely', async () => {
    const { hub, host, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    await hub.flush();
    const events = [];
    host.onPeerStatus((id, s) => events.push(s));
    host.onPeerLeave(() => events.push('leave'));
    for (let i = 0; i < 12; i++) {
      await clock.advance(5000);
      await hub.flush();
    }
    assert.deepEqual(events, []);
    host.close();
    a.close();
  });

  t('hub.drop: host sees leave closed; client reconnecting -> open with the same peer id', async () => {
    const { hub, host, clock, joins } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    await hub.flush();
    const status = [];
    const leaves = [];
    a.onStatus((s) => status.push(s));
    host.onPeerLeave((id, r) => leaves.push(id + ':' + r));
    hub.drop('peer-1');
    await hub.flush();
    assert.deepEqual(leaves, ['peer-1:closed']);
    assert.deepEqual(status, ['reconnecting']);
    await clock.advance(1000);
    await hub.flush();
    assert.deepEqual(status, ['reconnecting', 'open']);
    assert.deepEqual(joins, ['peer-1', 'peer-1']);
    const got = [];
    host.onMessage((m, id) => got.push(id));
    a.send({ t: 'back' });
    await hub.flush();
    assert.deepEqual(got, ['peer-1']);
    host.close();
    a.close();
  });

  t('hub.dropHost: client retries every delay, then error host-left + status closed', async () => {
    const { hub, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    await hub.flush();
    const status = [];
    const errors = [];
    a.onStatus((s) => status.push(s));
    a.onError((e) => errors.push(e.code));
    hub.dropHost('K7QXM');
    await hub.flush();
    assert.deepEqual(status, ['reconnecting']);
    const total = Net.RECONNECT_DELAYS.reduce((x, y) => x + y, 0);
    await clock.advance(total - 1);
    assert.deepEqual(errors, []);
    await clock.advance(10);
    await hub.flush();
    assert.deepEqual(errors, ['host-left']);
    assert.deepEqual(status, ['reconnecting', 'closed']);
    assert.equal(a.send({ t: 'x' }), false);
  });

  t('client: host silent for 30 s -> connection treated as lost (reconnecting)', async () => {
    const clock = Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    hub.register('ZZZZZ', () => {}, () => {}); // a mute "host": accepts, never sends a byte
    const a = await Net.join('ZZZZZ', { hub, clock });
    const status = [];
    a.onStatus((s) => status.push(s));
    await clock.advance(29000);
    assert.deepEqual(status, []);
    await clock.advance(2000);
    await hub.flush();
    assert.equal(status[0], 'reconnecting');
    a.close();
    assert.equal(status[status.length - 1], 'closed');
  });

  t('kick delivers {t:kicked} then closes; leave reason kicked; close() idempotent', async () => {
    const { hub, host, clock } = await setup();
    const a = await Net.join('K7QXM', { hub, clock });
    const got = collect(a);
    const status = [];
    a.onStatus((s) => status.push(s));
    await hub.flush();
    const leaves = [];
    host.onPeerLeave((id, r) => leaves.push(r));
    host.kick('peer-1', 'spam');
    await hub.flush();
    assert.deepEqual(got, [{ t: 'kicked', reason: 'spam' }]);
    assert.deepEqual(leaves, ['kicked']);
    assert.deepEqual(host.peers(), []);
    a.close(); // app reacts to `kicked` by closing: no reconnect afterwards
    await clock.advance(5000);
    assert.ok(!status.includes('open'));
    host.close();
    host.close();
    a.close();
  });

  t('second connection from the same peer id replaces the first silently', async () => {
    const { hub, host, clock, joins } = await setup();
    const first = await hub.connect('K7QXM', 'peer-9');
    await hub.flush();
    const leaves = [];
    host.onPeerLeave((id, r) => leaves.push(r));
    const second = await hub.connect('K7QXM', 'peer-9');
    await hub.flush();
    assert.deepEqual(joins, ['peer-9']);
    assert.deepEqual(leaves, []);
    assert.equal(first.open, false);
    const got = [];
    second.onData((m) => got.push(m.t));
    host.send('peer-9', { t: 'hello-again' });
    await hub.flush();
    assert.deepEqual(got, ['hello-again']);
    host.close();
    await clock.advance(1);
  });

  t('manual clock runs timers in order and supports clearTimeout', async () => {
    const clock = Net.createManualClock(100);
    const order = [];
    clock.setTimeout(() => order.push('b'), 20);
    clock.setTimeout(() => order.push('a'), 10);
    const h = clock.setTimeout(() => order.push('never'), 15);
    clock.clearTimeout(h);
    await clock.advance(25);
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(clock.now(), 125);
  });

  t('net.js has no eval / Function / innerHTML', () => {
    const src = String(PP.Net.createHost) + String(PP.Net.join) + String(PP.Net.Loopback.createHub);
    assert.ok(!/\beval\(|new Function|innerHTML/.test(src));
  });
})();
