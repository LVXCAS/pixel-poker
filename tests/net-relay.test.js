/* Tests for js/net-relay.js — relay URL validation/discovery, client fallback, host attaching relay
 * clients to the same core. Uses an in-memory fake of relay/server.js (same frames, same close codes);
 * the real server is covered by `node tests/relay-server.js`. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'net-relay: ' + name, fn });
  const Net = PP.Net;
  const Relay = Net.Relay;
  const URL_OK = 'ws://localhost:9999';

  const tick = () => new Promise((r) => setImmediate(r));
  async function flush() {
    for (let i = 0; i < 12; i++) await tick();
  }

  /** In-memory relay speaking the relay/server.js protocol. */
  function createFakeRelay() {
    const rooms = new Map();
    const relay = { rooms, sockets: [], refuse: false };

    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        relay.sockets.push(this);
        const q = new URL(url.replace(/^ws/, 'http')).searchParams;
        this.q = { role: q.get('role'), room: q.get('room'), id: q.get('id') };
        setImmediate(() => this.accept());
      }
      accept() {
        if (relay.refuse) return this.serverClose(1006);
        this.readyState = 1;
        const { role, room, id } = this.q;
        if (role === 'host') {
          if (rooms.has(room)) return this.serverClose(4409);
          rooms.set(room, { host: this, clients: new Map() });
          return this.deliver({ t: 'ready' });
        }
        const r = rooms.get(room);
        if (!r) return this.serverClose(4404);
        const old = r.clients.get(id);
        r.clients.set(id, this);
        if (old) old.serverClose(4000);
        r.host.deliver({ t: 'join', id });
        this.deliver({ t: 'ready' });
      }
      deliver(frame) {
        if (this.readyState !== 1) return;
        const data = JSON.stringify(frame);
        setImmediate(() => this.readyState === 1 && this.onmessage && this.onmessage({ data }));
      }
      send(json) {
        if (this.readyState !== 1) throw new Error('not open');
        const f = JSON.parse(json);
        this.sent.push(f);
        const r = rooms.get(this.q.room);
        if (!r) return;
        if (this.q.role === 'client') {
          if (r.clients.get(this.q.id) === this) r.host.deliver({ t: 'msg', from: this.q.id, d: f.d });
        } else if (typeof f.kick === 'string') {
          const c = r.clients.get(f.kick);
          if (c) c.serverClose(1000);
        } else if (r.clients.get(f.to)) {
          r.clients.get(f.to).deliver({ d: f.d });
        }
      }
      close() {
        this.serverClose(1000);
      }
      serverClose(code) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const r = rooms.get(this.q.room);
        if (r && r.host === this) {
          rooms.delete(this.q.room);
          r.clients.forEach((c) => c.serverClose(4410));
        } else if (r && r.clients.get(this.q.id) === this) {
          r.clients.delete(this.q.id);
          r.host.deliver({ t: 'leave', id: this.q.id });
        }
        setImmediate(() => this.onclose && this.onclose({ code }));
      }
    }
    relay.WebSocket = FakeWS;
    relay.hostSocket = (room) => rooms.get(room) && rooms.get(room).host;
    return relay;
  }

  const blocked = (code) => async () => { throw Net.netError(code || Net.ERR.NETWORK_BLOCKED); };

  async function hostEnv(extra) {
    const clock = Net.createManualClock();
    const relay = createFakeRelay();
    const hub = Net.Loopback.createHub({ clock });
    const host = await Net.createHost(Object.assign({ hub, clock, code: 'K7QXM', relayUrl: URL_OK,
      WebSocket: relay.WebSocket }, extra || {}));
    await flush();
    const joins = [];
    const msgs = [];
    host.onPeerJoin((id) => joins.push(id));
    host.onMessage((m, id) => msgs.push({ m, id }));
    return { clock, relay, hub, host, joins, msgs };
  }

  const relayJoin = (env, extra) => Net.join('K7QXM', Object.assign({ clock: env.clock, relayUrl: URL_OK,
    WebSocket: env.relay.WebSocket, p2pJoin: blocked() }, extra || {}));

  /* ------------------------------------------------------------ URL rules */

  t('validRelayUrl accepts wss anywhere and ws only on localhost', () => {
    assert.equal(Relay.validRelayUrl('wss://abc-def.trycloudflare.com'), 'wss://abc-def.trycloudflare.com');
    assert.equal(Relay.validRelayUrl('wss://abc.trycloudflare.com/'), 'wss://abc.trycloudflare.com');
    assert.equal(Relay.validRelayUrl('ws://localhost:8787'), 'ws://localhost:8787');
    assert.equal(Relay.validRelayUrl('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787');
    ['ws://evil.example', 'http://localhost:8787', 'https://a.example', 'wss://u:p@a.example',
      'wss://a.example/?x=1', 'wss://a.example/#h', 'javascript:alert(1)', 'wss://' + 'a'.repeat(300) + '.com',
      '', null, 42, {}].forEach((bad) => assert.equal(Relay.validRelayUrl(bad), null, String(bad)));
  });

  t('?relay= and ?forceRelay= are honored on localhost pages only', () => {
    const q = '?room=K7QXM&relay=' + encodeURIComponent('ws://localhost:1234') + '&forceRelay=1';
    const local = Relay.pageOverrides({ location: { hostname: 'localhost', search: q } });
    assert.deepEqual(local, { relayUrl: 'ws://localhost:1234', forceRelay: true });
    const prod = Relay.pageOverrides({ location: { hostname: 'lvxcas.github.io', search: q } });
    assert.deepEqual(prod, { relayUrl: null, forceRelay: false });
    const bad = Relay.pageOverrides({ location: { hostname: 'localhost', search: '?relay=ws%3A%2F%2Fevil.example' } });
    assert.equal(bad.relayUrl, null);
  });

  async function withConfig(cfg, fetchImpl, fn) {
    const prevCfg = Net.config, prevFetch = globalThis.fetch;
    Net.config = cfg; globalThis.fetch = fetchImpl;
    Relay.resetCache();
    try { return await fn(); } finally { Net.config = prevCfg; globalThis.fetch = prevFetch; Relay.resetCache(); }
  }

  t('resolveRelayUrl reads relay.json with a cache-busting ?t= and validates the url', async () => {
    const seen = [];
    const fetchImpl = async (u, init) => {
      seen.push({ u, init });
      return { ok: true, json: async () => ({ url: 'wss://abc.trycloudflare.com', updated: 'x' }) };
    };
    const clock = Net.createManualClock(1234);
    const got = await withConfig({ relayJsonUrl: 'relay.json' }, fetchImpl,
      () => Relay.resolveRelayUrl({ clock, location: { hostname: 'lvxcas.github.io', search: '' } }));
    assert.equal(got, 'wss://abc.trycloudflare.com');
    assert.equal(seen[0].u, 'relay.json?t=1234');
    assert.equal(seen[0].init.credentials, 'omit');
  });

  t('resolveRelayUrl returns null for a bad url, a null url, a 404 or a thrown fetch', async () => {
    const clock = Net.createManualClock();
    const o = { clock, location: { hostname: 'lvxcas.github.io', search: '' } };
    const cases = [
      async () => ({ ok: true, json: async () => ({ url: 'ws://evil.example' }) }),
      async () => ({ ok: true, json: async () => ({ url: null }) }),
      async () => ({ ok: false, json: async () => ({}) }),
      async () => { throw new Error('offline'); },
    ];
    for (const f of cases) {
      assert.equal(await withConfig({ relayJsonUrl: 'relay.json' }, f, () => Relay.resolveRelayUrl(o)), null);
    }
    assert.equal(await withConfig({}, cases[0], () => Relay.resolveRelayUrl(o)), null);
  });

  t('resolveRelayUrl gives up after a timeout instead of hanging', async () => {
    const clock = Net.createManualClock();
    const pending = withConfig({ relayJsonUrl: 'relay.json' }, () => new Promise(() => {}),
      () => Relay.resolveRelayUrl({ clock, location: { hostname: 'x.example', search: '' } }));
    await flush();
    await clock.advance(5000);
    assert.equal(await pending, null);
  });

  /* ---------------------------------------------------------------- host */

  t('host registers the room on the relay and attaches relay clients to the same core (r- ids)', async () => {
    const env = await hostEnv();
    assert.ok(env.relay.hostSocket('K7QXM'), 'room registered on relay');
    const p2p = await Net.join('K7QXM', { hub: env.hub, clock: env.clock });
    const viaRelay = await relayJoin(env);
    await flush();
    assert.equal(viaRelay.transport, 'relay');
    assert.ok(viaRelay.peerId.startsWith(Relay.ID_PREFIX));
    assert.equal(env.joins.length, 2);
    assert.ok(env.joins.includes(viaRelay.peerId));
    assert.ok(env.joins.includes(p2p.peerId));
    assert.ok(!p2p.peerId.startsWith(Relay.ID_PREFIX));
    const got = [];
    viaRelay.onMessage((m) => got.push(m));
    viaRelay.send({ t: 'hello', name: 'r' });
    p2p.send({ t: 'hello', name: 'p' });
    await env.hub.flush();
    await flush();
    assert.deepEqual(env.msgs.map((x) => [x.m.name, x.id]).sort(),
      [['p', p2p.peerId], ['r', viaRelay.peerId]].sort());
    env.host.send(viaRelay.peerId, { t: 'hole', cards: ['As', 'Kd'] });
    env.host.broadcast({ t: 'seats' });
    await flush();
    assert.deepEqual(got.map((m) => m.t), ['hole', 'seats']);
    env.host.close();
    await flush();
    assert.equal(env.relay.hostSocket('K7QXM'), undefined, 'host close unregisters');
  });

  t('relay client frames carry only their own id; a forged peer id cannot impersonate', async () => {
    const env = await hostEnv();
    const a = await relayJoin(env);
    const b = await relayJoin(env);
    await flush();
    assert.notEqual(a.peerId, b.peerId);
    a.send({ t: 'chat', from: b.peerId, text: 'hi' });
    await flush();
    assert.equal(env.msgs[0].id, a.peerId);
    env.host.close();
  });

  t('host kick closes the relay client and leave reaches the host', async () => {
    const env = await hostEnv();
    const leaves = [];
    env.host.onPeerLeave((id) => leaves.push(id));
    const a = await relayJoin(env);
    await flush();
    env.host.kick(a.peerId, 'test');
    await flush();
    assert.deepEqual(leaves, [a.peerId]);
    assert.deepEqual(env.host.peers(), []);
    a.close();
    env.host.close();
  });

  t('relay unavailable: hosting still succeeds P2P-only with no error', async () => {
    const errors = [];
    const env = await hostEnv({ WebSocket: undefined });
    env.host.onError((e) => errors.push(e));
    await flush();
    assert.equal(env.host.code, 'K7QXM');
    assert.deepEqual(errors, []);
    env.host.close();
  });

  t('relay connection drop: host re-registers with backoff and relay clients can return', async () => {
    const env = await hostEnv();
    env.relay.hostSocket('K7QXM').serverClose(1006);
    await flush();
    assert.equal(env.relay.hostSocket('K7QXM'), undefined);
    await env.clock.advance(2000);
    await flush();
    assert.ok(env.relay.hostSocket('K7QXM'), 're-registered after backoff');
    const a = await relayJoin(env);
    await flush();
    assert.ok(env.joins.includes(a.peerId));
    env.host.close();
  });

  t('PeerJS unreachable for the host: room is hosted on the relay alone', async () => {
    const clock = Net.createManualClock();
    const relay = createFakeRelay();
    const host = await Net.createHost({ clock, code: 'K7QXM', relayUrl: URL_OK, WebSocket: relay.WebSocket,
      p2pHost: blocked(Net.ERR.SERVICE_UNREACHABLE) });
    assert.equal(host.transport, 'relay');
    const joins = [];
    host.onPeerJoin((id) => joins.push(id));
    const c = await Net.join('K7QXM', { clock, relayUrl: URL_OK, WebSocket: relay.WebSocket,
      p2pJoin: blocked(Net.ERR.ROOM_NOT_FOUND) });
    await flush();
    assert.deepEqual(joins, [c.peerId]);
    host.close();
  });

  /* -------------------------------------------------------------- client */

  t('client falls back to the relay when PeerJS fails (blocked / unreachable / timeout / unsupported)', async () => {
    const env = await hostEnv();
    for (const code of ['network-blocked', 'service-unreachable', 'timeout', 'browser-unsupported']) {
      const c = await relayJoin(env, { p2pJoin: blocked(code) });
      assert.equal(c.transport, 'relay', code);
      c.close();
    }
    env.host.close();
  });

  t('client does not fall back on non-network errors', async () => {
    const env = await hostEnv();
    await assert.rejects(relayJoin(env, { p2pJoin: blocked(Net.ERR.ROOM_TAKEN) }), (e) => e.code === 'room-taken');
    env.host.close();
  });

  t('relay also failing surfaces the original PeerJS error', async () => {
    const env = await hostEnv();
    env.relay.refuse = true;
    await assert.rejects(relayJoin(env), (e) => e.code === Net.ERR.NETWORK_BLOCKED);
    env.relay.refuse = false;
    await assert.rejects(Net.join('ZZZZZ', { clock: env.clock, relayUrl: URL_OK, WebSocket: env.relay.WebSocket,
      p2pJoin: blocked(Net.ERR.SERVICE_UNREACHABLE) }), (e) => e.code === Net.ERR.ROOM_NOT_FOUND);
    await assert.rejects(Net.join('ZZZZZ', { clock: env.clock, relayUrl: URL_OK, WebSocket: env.relay.WebSocket,
      p2pJoin: blocked(Net.ERR.NETWORK_BLOCKED) }), (e) => e.code === Net.ERR.NETWORK_BLOCKED);
    env.host.close();
  });

  t('no relay configured: the PeerJS error passes through untouched', async () => {
    await withConfig({}, undefined, () => assert.rejects(
      Net.join('K7QXM', { clock: Net.createManualClock(), p2pJoin: blocked(), location: { hostname: 'x.example', search: '' } }),
      (e) => e.code === Net.ERR.NETWORK_BLOCKED));
  });

  t('forceRelay skips PeerJS entirely', async () => {
    const env = await hostEnv();
    let called = false;
    const c = await relayJoin(env, { forceRelay: true, p2pJoin: async () => { called = true; throw new Error('no'); } });
    assert.equal(called, false);
    assert.equal(c.transport, 'relay');
    env.host.close();
  });

  t('relay client reconnects over the relay with the same id after a drop', async () => {
    const env = await hostEnv();
    const c = await relayJoin(env);
    const statuses = [];
    c.onStatus((s) => statuses.push(s));
    await flush();
    const room = env.relay.rooms.get('K7QXM');
    Array.from(room.clients.values())[0].serverClose(1006);
    await flush();
    await env.clock.advance(1000);
    await flush();
    assert.deepEqual(statuses, ['reconnecting', 'open']);
    assert.deepEqual(env.host.peers(), [c.peerId]);
    const got = [];
    c.onMessage((m) => got.push(m));
    env.host.send(c.peerId, { t: 'after' });
    await flush();
    assert.deepEqual(got, [{ t: 'after' }]);
    env.host.close();
  });

  t('host leaving: relay client retries, then reports host-left', async () => {
    const env = await hostEnv();
    const c = await relayJoin(env);
    const errors = [];
    c.onError((e) => errors.push(e.code));
    await flush();
    env.host.close();
    await flush();
    for (let i = 0; i < 6; i++) {
      await env.clock.advance(8000);
      await flush();
    }
    assert.deepEqual(errors, [Net.ERR.HOST_LEFT]);
  });

  /* ---------------------------------------------------------- data probe */

  function fakeConn(answer) {
    const dataFns = [];
    return {
      onData: (fn) => dataFns.push(fn),
      onClose: () => {},
      send: (msg) => {
        if (answer) setImmediate(() => dataFns.forEach((fn) => fn({ t: '_pong', n: msg.n })));
        return true;
      },
    };
  }

  t('probeConn resolves when a _pong comes back', async () => {
    const clock = Net.createManualClock();
    const conn = fakeConn(true);
    assert.equal(await Net._internal.probeConn(conn, clock), conn);
  });

  t('probeConn rejects network-blocked when an open channel never carries data', async () => {
    const clock = Net.createManualClock();
    const p = Net._internal.probeConn(fakeConn(false), clock);
    const result = p.then(() => 'resolved', (e) => e.code);
    await clock.advance(6000);
    assert.equal(await result, Net.ERR.NETWORK_BLOCKED);
  });
})();
