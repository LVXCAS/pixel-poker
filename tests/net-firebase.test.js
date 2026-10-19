/* Tests for js/net-firebase.js (Firebase RTDB relay backend) and the backend selection in
 * js/net-relay.js. Uses tests/firebase-fake.js: an in-memory RTDB + anonymous auth that also
 * enforces a JS mirror of database.rules.json. The real Firebase backend is NOT exercised here. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'net-firebase: ' + name, fn });
  const Net = PP.Net;
  const FB = Net.Firebase;
  const CFG = { apiKey: 'AIzaFake', authDomain: 'demo.firebaseapp.com', projectId: 'demo', appId: '1:1:web:1',
    databaseURL: 'https://demo-default-rtdb.firebaseio.com' };
  const PROD_PAGE = { hostname: 'lvxcas.github.io', search: '' };

  const tick = () => new Promise((r) => setImmediate(r));
  async function flush(n) {
    for (let i = 0; i < (n || 30); i++) await tick();
  }
  const blocked = () => async () => { throw Net.netError(Net.ERR.NETWORK_BLOCKED); };
  const loaderFor = (sdk) => async () => sdk;

  /** One fake Firebase server; tab() = a new browser tab (own uid, own SDK instance). */
  function fbEnv() {
    const clock = Net.createManualClock(1000);
    const fb = PPFakeFirebase.create();
    const tab = (extra) => {
      const sdk = fb.client();
      return { sdk, opts: Object.assign({ clock, firebase: CFG, firebaseSdk: loaderFor(sdk), location: PROD_PAGE }, extra || {}) };
    };
    return { clock, fb, tab };
  }

  async function hostAndClients(n) {
    const env = fbEnv();
    const hostTab = env.tab({ transport: 'relay', code: 'K7QXM' });
    const host = await Net.createHost(hostTab.opts);
    const joins = [];
    const msgs = [];
    const leaves = [];
    host.onPeerJoin((id) => joins.push(id));
    host.onPeerLeave((id, why) => leaves.push({ id, why }));
    host.onMessage((m, id) => msgs.push({ m, id }));
    const clients = [];
    for (let i = 0; i < n; i++) {
      const tab = env.tab({ transport: 'relay' });
      const c = await Net.join('K7QXM', tab.opts);
      const got = [];
      c.onMessage((m) => got.push(m));
      clients.push({ c, tab, got, uid: tab.sdk.__client.uid });
    }
    await flush();
    return Object.assign(env, { hostTab, host, joins, msgs, leaves, clients });
  }

  /* ------------------------------------------------------------ config */

  t('validConfig accepts a web config and rejects junk', () => {
    assert.ok(FB.validConfig(CFG));
    assert.equal(FB.validConfig(null), null);
    assert.equal(FB.validConfig({ apiKey: 'x' }), null);
    assert.equal(FB.validConfig(Object.assign({}, CFG, { databaseURL: 'http://insecure.example' })), null);
    assert.equal(FB.validConfig(Object.assign({}, CFG, { databaseURL: 'https://a.example/?x=1' })), null);
  });

  t('?fakeFirebase=1 is honored on localhost pages only', () => {
    assert.ok(FB.configOf({ location: { hostname: 'localhost', search: '?fakeFirebase=1' } }));
    assert.equal(FB.configOf({ location: { hostname: 'lvxcas.github.io', search: '?fakeFirebase=1' } }), null);
    assert.equal(FB.configOf({ location: PROD_PAGE }), null, 'no config by default');
  });

  /* ------------------------------------------------------------ routing */

  t('host + 2 clients route both ways over Firebase with f- ids', async () => {
    const e = await hostAndClients(2);
    const [a, b] = e.clients;
    assert.equal(a.c.transport, 'relay');
    assert.equal(a.c.relayBackend, 'firebase');
    assert.equal(e.host.relayBackend, 'firebase');
    assert.equal(a.c.peerId, FB.ID_PREFIX + a.uid);
    assert.deepEqual(e.joins.slice().sort(), [a.c.peerId, b.c.peerId].sort());
    a.c.send({ t: 'hi', from: 'a' });
    b.c.send({ t: 'hi', from: 'b' });
    await flush();
    assert.deepEqual(e.msgs.map((x) => x.id + ':' + x.m.from).sort(), [a.c.peerId + ':a', b.c.peerId + ':b'].sort());
    e.host.send(a.c.peerId, { t: 'hole', cards: ['As', 'Kd'] });
    e.host.send(b.c.peerId, { t: 'hole', cards: ['2c', '7h'] });
    e.host.broadcast({ t: 'board' });
    await flush();
    assert.deepEqual(a.got, [{ t: 'hole', cards: ['As', 'Kd'] }, { t: 'board' }]);
    assert.deepEqual(b.got, [{ t: 'hole', cards: ['2c', '7h'] }, { t: 'board' }]);
    // frames are deleted once read: the DB does not grow
    assert.equal(e.fb.read('rooms/K7QXM/down'), null);
    assert.equal(e.fb.read('rooms/K7QXM/up'), null);
    e.host.close();
  });

  t('client A cannot read client B\'s frames (rules) and never receives them', async () => {
    const e = await hostAndClients(2);
    const [a, b] = e.clients;
    const sdk = a.tab.sdk;
    const denied = [];
    const leaked = [];
    sdk.onChildAdded(sdk.ref(sdk.getDatabase(), 'rooms/K7QXM/down/' + b.uid), (s) => leaked.push(s.val()), (err) => denied.push(err.code));
    await assert.rejects(sdk.get(sdk.ref(null, 'rooms/K7QXM/down/' + b.uid)), (err) => err.code === 'PERMISSION_DENIED');
    await assert.rejects(sdk.get(sdk.ref(null, 'rooms/K7QXM/up/' + b.uid)), (err) => err.code === 'PERMISSION_DENIED');
    await assert.rejects(sdk.set(sdk.push(sdk.ref(null, 'rooms/K7QXM/down/' + b.uid)), { d: '{"t":"x"}', ts: 1 }),
      (err) => err.code === 'PERMISSION_DENIED', 'a client cannot forge host frames');
    await assert.rejects(sdk.set(sdk.push(sdk.ref(null, 'rooms/K7QXM/up/' + b.uid)), { d: '{"t":"x"}', ts: 1 }),
      (err) => err.code === 'PERMISSION_DENIED', 'a client cannot impersonate another client');
    await assert.rejects(sdk.remove(sdk.ref(null, 'rooms/K7QXM')), (err) => err.code === 'PERMISSION_DENIED');
    e.host.send(b.c.peerId, { t: 'hole', cards: ['Qs', 'Qh'] });
    await flush();
    assert.deepEqual(denied, ['PERMISSION_DENIED']);
    assert.deepEqual(leaked, []);
    assert.deepEqual(a.got, []);
    assert.deepEqual(b.got, [{ t: 'hole', cards: ['Qs', 'Qh'] }]);
    e.host.close();
  });

  t('room-not-found when no host node exists', async () => {
    const env = fbEnv();
    await assert.rejects(Net.join('ZZZZZ', env.tab({ transport: 'relay' }).opts), (e) => e.code === Net.ERR.ROOM_NOT_FOUND);
  });

  t('room-taken when another uid owns rooms/{CODE}/host; a fresh code is picked', async () => {
    const env = fbEnv();
    const firstTab = env.tab({ transport: 'relay', code: 'K7QXM' });
    const first = await Net.createHost(firstTab.opts);
    assert.equal(first.code, 'K7QXM');
    const second = await Net.createHost(env.tab({ transport: 'relay', code: 'K7QXM' }).opts);
    assert.notEqual(second.code, 'K7QXM');
    assert.equal(env.fb.read('rooms/K7QXM/host/uid'), firstTab.sdk.__client.uid, 'first host keeps the room');
    // a direct set by an intruder is refused by the rules
    const intruder = env.fb.client();
    await intruder.signInAnonymously({});
    await assert.rejects(intruder.set(intruder.ref(null, 'rooms/K7QXM/host'), { uid: intruder.__client.uid, createdAt: 1 }),
      (err) => err.code === 'PERMISSION_DENIED');
    // every code taken -> room-taken
    const busy = fbEnv();
    const claimAll = busy.tab({ transport: 'relay', code: 'AAAAA', rng: () => 0 });
    await Net.createHost(claimAll.opts);
    await assert.rejects(Net.createHost(busy.tab({ transport: 'relay', code: 'AAAAA', rng: () => 0 }).opts),
      (e) => e.code === Net.ERR.ROOM_TAKEN);
    first.close();
    second.close();
  });

  t('host closes: room removed, clients retry then report host-left', async () => {
    const e = await hostAndClients(2);
    const errors = [];
    e.clients.forEach((x) => x.c.onError((err) => errors.push(err.code)));
    e.host.close();
    await flush();
    assert.equal(e.fb.read('rooms/K7QXM'), null);
    for (let i = 0; i < 6; i++) {
      await e.clock.advance(8000);
      await flush();
    }
    assert.deepEqual(errors, [Net.ERR.HOST_LEFT, Net.ERR.HOST_LEFT]);
  });

  t('host tab vanishes: onDisconnect wipes the room, clients get host-left', async () => {
    const e = await hostAndClients(1);
    const errors = [];
    e.clients[0].c.onError((err) => errors.push(err.code));
    e.fb.kill(e.hostTab.sdk);
    await flush();
    assert.equal(e.fb.read('rooms/K7QXM'), null);
    for (let i = 0; i < 6; i++) {
      await e.clock.advance(8000);
      await flush();
    }
    assert.deepEqual(errors, [Net.ERR.HOST_LEFT]);
  });

  t('client tab vanishes: onDisconnect removes its peer entry, host sees leave', async () => {
    const e = await hostAndClients(2);
    const [a] = e.clients;
    e.fb.kill(a.tab.sdk);
    await flush();
    assert.deepEqual(e.leaves.map((l) => l.id), [a.c.peerId]);
    assert.equal(e.fb.read('rooms/K7QXM/peers/' + a.uid), null);
    assert.equal(e.host.peers().length, 1);
    e.host.close();
  });

  t('client reconnects with the same uid after a drop; messages flow again', async () => {
    const e = await hostAndClients(1);
    const [a] = e.clients;
    const statuses = [];
    a.c.onStatus((s) => statuses.push(s));
    e.host.kick(a.c.peerId, 'test'); // host-side close: client conn drops (WS relay kick semantics)
    await flush();
    await e.clock.advance(1000);
    await flush();
    assert.deepEqual(statuses, ['reconnecting', 'open']);
    assert.deepEqual(e.host.peers(), [a.c.peerId], 'same f- id after reconnect');
    a.got.length = 0;
    e.host.send(a.c.peerId, { t: 'after' });
    a.c.send({ t: 'back' });
    await flush();
    assert.deepEqual(a.got, [{ t: 'after' }]);
    assert.deepEqual(e.msgs.map((x) => x.m.t), ['back']);
    e.host.close();
  });

  t('client close removes its peer entry; host gets a leave', async () => {
    const e = await hostAndClients(1);
    e.clients[0].c.close();
    await flush();
    assert.deepEqual(e.leaves.map((l) => l.id), [e.clients[0].c.peerId]);
    assert.equal(e.fb.read('rooms/K7QXM/peers'), null);
    e.host.close();
  });

  t('oversize frames are refused on send and dropped on receive', async () => {
    const e = await hostAndClients(1);
    const [a] = e.clients;
    const big = 'x'.repeat(FB.MAX_FRAME_CHARS);
    assert.equal(e.host.send(a.c.peerId, { t: 'big', s: big }), false);
    assert.equal(a.c.send({ t: 'big', s: big }), false);
    // a hand-written oversize frame never passes the rules, and a malformed one is dropped
    const sdk = a.tab.sdk;
    await assert.rejects(sdk.set(sdk.push(sdk.ref(null, 'rooms/K7QXM/up/' + a.uid)), { d: big + 'xx', ts: 1 }),
      (err) => err.code === 'PERMISSION_DENIED');
    await sdk.set(sdk.push(sdk.ref(null, 'rooms/K7QXM/up/' + a.uid)), { d: '{not json', ts: 1 });
    await sdk.set(sdk.push(sdk.ref(null, 'rooms/K7QXM/up/' + a.uid)), { d: '[1,2]', ts: 1 });
    await flush();
    assert.deepEqual(e.msgs, [], 'malformed / non-object messages never reach the app');
    e.host.close();
  });

  /* ------------------------------------------------------------ auto mode + selection */

  t('auto: PeerJS host also registers on Firebase; a blocked client falls back to it', async () => {
    const env = fbEnv();
    const hub = Net.Loopback.createHub({ clock: env.clock });
    const host = await Net.createHost(Object.assign(env.tab().opts, { hub, code: 'K7QXM' }));
    await flush();
    assert.ok(env.fb.read('rooms/K7QXM/host/uid'), 'room registered alongside PeerJS');
    const c = await Net.join('K7QXM', Object.assign(env.tab().opts, { p2pJoin: blocked() }));
    await flush();
    assert.equal(c.relayBackend, 'firebase');
    assert.deepEqual(host.peers(), [c.peerId]);
    host.close();
    await flush();
    assert.equal(env.fb.read('rooms/K7QXM'), null);
  });

  t('selection: no firebase config -> WS relay.json path; firebase config -> relay.json never fetched', async () => {
    const prevCfg = Net.config;
    const prevFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (u) => { fetched.push(u); return { ok: false }; };
    try {
      Net.config = Object.freeze({ relayJsonUrl: 'relay.json', firebase: null });
      Net.Relay.resetCache();
      await assert.rejects(Net.join('K7QXM', { clock: Net.createManualClock(), transport: 'relay', location: PROD_PAGE }),
        (e) => e.code === Net.ERR.RELAY_OFFLINE);
      assert.equal(fetched.length, 1, 'WS relay path consulted relay.json');
      const env = fbEnv();
      let loads = 0;
      const sdk = env.fb.client();
      Net.config = Object.freeze({ relayJsonUrl: 'relay.json', firebase: CFG });
      Net.Relay.resetCache();
      const host = await Net.createHost({ clock: env.clock, transport: 'relay', code: 'K7QXM', location: PROD_PAGE,
        firebaseSdk: async () => { loads += 1; return sdk; } });
      assert.equal(host.relayBackend, 'firebase');
      assert.equal(loads, 1);
      assert.equal(fetched.length, 1, 'relay.json not fetched when Firebase is configured');
      host.close();
    } finally {
      Net.config = prevCfg;
      globalThis.fetch = prevFetch;
      Net.Relay.resetCache();
    }
  });

  t('direct mode never touches Firebase or relay.json', async () => {
    const prevFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; return { ok: false }; };
    let loads = 0;
    let p2p = 0;
    const o = { clock: Net.createManualClock(), transport: 'direct', firebase: CFG, location: PROD_PAGE,
      firebaseSdk: async () => { loads += 1; throw new Error('should not load'); },
      p2pJoin: async () => { p2p += 1; throw Net.netError(Net.ERR.NETWORK_BLOCKED); },
      p2pHost: async () => { p2p += 1; throw Net.netError(Net.ERR.SERVICE_UNREACHABLE); } };
    try {
      await assert.rejects(Net.join('K7QXM', o), (e) => e.code === Net.ERR.NETWORK_BLOCKED);
      await assert.rejects(Net.createHost(o), (e) => e.code === Net.ERR.SERVICE_UNREACHABLE);
    } finally {
      globalThis.fetch = prevFetch;
    }
    assert.equal(p2p, 2);
    assert.equal(loads, 0);
    assert.equal(fetched, 0);
  });

  t('SDK load failure / sign-in failure -> relay-offline (relay mode); auto keeps the PeerJS error', async () => {
    const clock = Net.createManualClock();
    const failing = async () => { throw new Error('blocked by network'); };
    await assert.rejects(Net.join('K7QXM', { clock, transport: 'relay', firebase: CFG, firebaseSdk: failing }),
      (e) => e.code === Net.ERR.RELAY_OFFLINE);
    await assert.rejects(Net.createHost({ clock, transport: 'relay', firebase: CFG, firebaseSdk: failing }),
      (e) => e.code === Net.ERR.RELAY_OFFLINE);
    const fb = PPFakeFirebase.create();
    fb.failAuth = true;
    const sdk = fb.client();
    await assert.rejects(Net.join('K7QXM', { clock, transport: 'relay', firebase: CFG, firebaseSdk: loaderFor(sdk) }),
      (e) => e.code === Net.ERR.RELAY_OFFLINE);
    await assert.rejects(Net.join('K7QXM', { clock, firebase: CFG, firebaseSdk: failing, p2pJoin: blocked() }),
      (e) => e.code === Net.ERR.NETWORK_BLOCKED);
  });

  t('SDK load that never settles times out to relay-offline', async () => {
    const clock = Net.createManualClock();
    const p = Net.join('K7QXM', { clock, transport: 'relay', firebase: CFG, firebaseSdk: () => new Promise(() => {}) });
    let err = null;
    p.catch((e) => { err = e; });
    await flush(5);
    await clock.advance(16000);
    await flush(5);
    assert.ok(err && err.code === Net.ERR.RELAY_OFFLINE);
  });

  /* ------------------------------------------------------------ rules file */

  t('database.rules.json parses and carries the key rule expressions', () => {
    const text = loadRepoText('database.rules.json');
    const rules = JSON.parse(text).rules;
    assert.equal(rules['.read'], false);
    assert.equal(rules['.write'], false);
    const room = rules.rooms.$code;
    const host = room.host;
    assert.match(host['.write'], /!data\.exists\(\)/);
    assert.match(host['.write'], /auth\.uid/);
    assert.match(room['.write'], /!newData\.exists\(\)/);
    assert.match(room.down.$cid['.read'], /auth\.uid === \$cid/);
    assert.match(room.up.$cid['.read'], /host\/uid/);
    assert.match(room.up.$cid.$fid['.write'], /auth\.uid === \$cid/);
    assert.match(room.peers.$cid['.write'], /auth\.uid === \$cid/);
    assert.match(room.down.$cid.$fid.d['.validate'], /length <= 65536/);
    assert.match(room.up.$cid.$fid.d['.validate'], /length <= 65536/);
    assert.match(JSON.stringify(rules), /\$code\.matches/);
    assert.ok(!/"\.read":\s*true|"\.write":\s*true/.test(text), 'nothing is world-readable/writable');
  });
})();
