/*
 * PIXEL HOLD'EM — PP.Net Firebase relay backend (load after js/net-relay.js, before js/net-config.js).
 * When PP.Net.config.firebase is set, the "relay" role (transport 'relay', and the 'auto' fallback /
 * alongside registration) runs over Firebase Realtime Database instead of the WebSocket relay: no
 * server to keep running, plain HTTPS/WebSocket to *.firebaseio.com. js/net-relay.js picks the
 * backend; this file only provides it (PP.Net.Firebase). Unset config = this file does nothing.
 *
 * The Firebase JS SDK is lazy-loaded (dynamic import of pinned gstatic builds) only when a relay
 * is actually needed. Each tab signs in anonymously (session persistence: one uid per tab, kept
 * across reconnects). Data layout (rules: database.rules.json, setup: relay/FIREBASE.md):
 *
 *   rooms/{CODE}/host                 {uid, createdAt}   the host tab; onDisconnect removes rooms/{CODE}
 *   rooms/{CODE}/peers/{cid}          {joinedAt, s}      one per client tab; s = per-connection nonce
 *   rooms/{CODE}/down/{cid}/{pushId}  {d, ts[, c]}       host -> client frames (readable by cid only)
 *   rooms/{CODE}/up/{cid}/{pushId}    {d, ts}            client -> host frames (readable by host only)
 *
 * d = JSON string of one PP.Net message (<= 65536 chars); c: true = "close this connection" (kick).
 * Readers delete each frame after handling it. Host gone (rooms/{CODE}/host removed or re-owned)
 * = the client connection closes; the client core retries and, finding no room, reports host-left
 * (the WS relay's 4410 semantics). Connection ids are 'f-' + uid (never collide with PeerJS / 'r-').
 *
 * Localhost-only test hook: ?fakeFirebase=1 swaps in tests/firebase-fake.js (shared between tabs
 * through localStorage) so the whole UI path can be exercised without a Firebase project.
 */
(function () {
  'use strict';
  const PP = globalThis.PP;
  if (!PP || !PP.Net || !PP.Net._internal) return;
  const Net = PP.Net;
  const ERR = Net.ERR;
  const { createHostCore, createClientCore } = Net._internal;

  const SDK_VERSION = '10.12.2';
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  const SDK_MODULES = ['firebase-app.js', 'firebase-auth.js', 'firebase-database.js'];
  const ID_PREFIX = 'f-';
  const APP_NAME = 'pixel-holdem';
  const MAX_FRAME_CHARS = 65536;
  const SDK_LOAD_TIMEOUT_MS = 15000;
  const SIGN_IN_TIMEOUT_MS = 10000;
  const OP_TIMEOUT_MS = 10000;
  const HOST_RETRY_MS = [2000, 4000, 8000, 16000, 30000];
  const MAX_CODE_TRIES = 5;
  const NONCE_LENGTH = 12;
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
  const FAKE_SCRIPT = 'tests/firebase-fake.js';
  const FAKE_CONFIG = Object.freeze({ apiKey: 'fake', authDomain: 'fake.local', projectId: 'fake',
    appId: 'fake', databaseURL: 'https://fake.local' });
  const CID_RE = /^[A-Za-z0-9_-]{6,128}$/;

  /* ---------------------------------------------------------------- config */

  /** Public web config -> frozen copy, or null if it is missing / malformed. */
  function validConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    const str = (k) => typeof cfg[k] === 'string' && cfg[k].length > 0 && cfg[k].length <= 200;
    if (!['apiKey', 'projectId', 'appId', 'databaseURL'].every(str)) return null;
    if (!/^https:\/\/[^/?#\s]+\/?$/.test(cfg.databaseURL)) return null;
    const out = { apiKey: cfg.apiKey, projectId: cfg.projectId, appId: cfg.appId, databaseURL: cfg.databaseURL };
    if (str('authDomain')) out.authDomain = cfg.authDomain;
    return Object.freeze(out);
  }

  function fakePage(o) {
    const loc = o.location || globalThis.location || null;
    if (!loc || typeof loc.hostname !== 'string' || !LOCAL_HOSTS.has(loc.hostname)) return false;
    return /[?&]fakeFirebase=1(?:&|#|$)/.test(typeof loc.search === 'string' ? loc.search : '');
  }

  /** The Firebase config this call should use, or null (= use the WebSocket relay path). */
  function configOf(o) {
    const opt = o || {};
    if (opt.firebase !== undefined) return validConfig(opt.firebase);
    if (fakePage(opt)) return FAKE_CONFIG;
    return validConfig((Net.config || {}).firebase);
  }

  /* ---------------------------------------------------------------- SDK + session */

  function withTimeout(promise, clock, ms) {
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = clock.setTimeout(() => rej(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clock.clearTimeout(timer));
  }

  function realLoader() {
    // Dynamic import keeps the SDK (~100 KB) off the page until a relay is actually needed.
    return Promise.all(SDK_MODULES.map((m) => import(SDK_BASE + m))).then((mods) => Object.assign({}, ...mods));
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const doc = globalThis.document;
      if (!doc) return reject(new Error('no document'));
      const s = doc.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('load failed: ' + src));
      doc.head.appendChild(s);
    });
  }

  let fakeSdk = null;
  async function fakeLoader() {
    if (fakeSdk) return fakeSdk;
    if (!globalThis.PPFakeFirebase) await loadScriptOnce(FAKE_SCRIPT);
    const F = globalThis.PPFakeFirebase;
    const fb = F.create({ store: F.localStore(globalThis.localStorage, globalThis) });
    fakeSdk = fb.client();
    globalThis.addEventListener('pagehide', () => fb.kill(fakeSdk));
    return fakeSdk;
  }

  function loaderOf(o) {
    if (typeof o.firebaseSdk === 'function') return o.firebaseSdk;
    if (o.firebase === undefined && fakePage(o)) return fakeLoader;
    return realLoader;
  }

  // loader -> (config JSON -> Promise<session>); a failed session is forgotten so the next try reloads.
  const sessions = new WeakMap();

  async function openSession(cfg, load, clock) {
    const sdk = await withTimeout(Promise.resolve().then(load), clock, SDK_LOAD_TIMEOUT_MS);
    const app = sdk.initializeApp(cfg, APP_NAME);
    const auth = typeof sdk.initializeAuth === 'function' && sdk.browserSessionPersistence
      ? sdk.initializeAuth(app, { persistence: sdk.browserSessionPersistence })
      : sdk.getAuth(app);
    const cred = await withTimeout(sdk.signInAnonymously(auth), clock, SIGN_IN_TIMEOUT_MS);
    const uid = cred && cred.user && cred.user.uid;
    if (typeof uid !== 'string' || !CID_RE.test(uid)) throw new Error('bad anonymous uid');
    return { sdk, db: sdk.getDatabase(app), uid, clock };
  }

  /** Signed-in session for this options bag; any failure = NetError relay-offline. */
  function getSession(o) {
    const cfg = configOf(o);
    if (!cfg) return Promise.reject(Net.netError(ERR.RELAY_OFFLINE));
    const load = loaderOf(o);
    const clock = o.clock || Net.realClock;
    if (!sessions.has(load)) sessions.set(load, new Map());
    const byCfg = sessions.get(load);
    const key = JSON.stringify(cfg);
    if (!byCfg.has(key)) {
      const p = openSession(cfg, load, clock).catch((err) => {
        byCfg.delete(key);
        console.warn('[PP.Net] Firebase relay unavailable:', (err && err.message) || err);
        throw Net.netError(ERR.RELAY_OFFLINE);
      });
      byCfg.set(key, p);
    }
    return byCfg.get(key);
  }

  /* ---------------------------------------------------------------- db helpers */

  const roomPath = (code, ...rest) => ['rooms', code].concat(rest).join('/');
  const refOf = (s, path) => s.sdk.ref(s.db, path);
  const op = (s, promise) => withTimeout(promise, s.clock, OP_TIMEOUT_MS);
  const quiet = (p) => { Promise.resolve(p).catch(() => { /* best-effort cleanup */ }); };

  function randomNonce() {
    return Net.Relay && typeof Net.Relay.randomClientId === 'function'
      ? Net.Relay.randomClientId().slice(0, NONCE_LENGTH) : String(Math.random()).slice(2, 2 + NONCE_LENGTH);
  }

  /** Message -> frame payload string, or null if it can't be encoded within the cap. */
  function encode(msg) {
    let json;
    try {
      json = JSON.stringify(msg);
    } catch (err) {
      return null;
    }
    return typeof json === 'string' && json.length <= MAX_FRAME_CHARS ? json : null;
  }

  /** Stored frame -> { msg } | { close: true } | null (malformed / oversize: dropped). */
  function decode(v) {
    if (!v || typeof v !== 'object' || typeof v.d !== 'string' || v.d.length > MAX_FRAME_CHARS) return null;
    if (v.c === true) return { close: true };
    try {
      return { msg: JSON.parse(v.d) };
    } catch (err) {
      return null;
    }
  }

  function pushFrame(s, path, payload, close) {
    const frame = close ? { d: 'null', ts: s.clock.now(), c: true } : { d: payload, ts: s.clock.now() };
    quiet(s.sdk.set(s.sdk.push(refOf(s, path)), frame));
  }

  /** Read frames at `path` in order, deleting each one once handled. Returns an unsubscribe. */
  function readFrames(s, path, onFrame, onDenied) {
    return s.sdk.onChildAdded(refOf(s, path), (snap) => {
      quiet(s.sdk.remove(snap.ref));
      const f = decode(snap.val());
      if (f) onFrame(f);
    }, () => { if (typeof onDenied === 'function') onDenied(); });
  }

  function makeConnIface(id, st, sendFn, closeFn) {
    const dataFns = [];
    const closeFns = [];
    const iface = {
      id,
      get open() { return st.open; },
      send: (msg) => {
        if (!st.open) return false;
        const payload = encode(msg);
        if (payload === null) return false;
        sendFn(payload);
        return true;
      },
      close: () => closeFn(),
      onData: (fn) => { if (typeof fn === 'function') dataFns.push(fn); },
      onClose: (fn) => { if (typeof fn === 'function') closeFns.push(fn); },
      deliver: (msg) => { if (st.open) dataFns.slice().forEach((fn) => fn(msg)); },
      fireClose: () => closeFns.splice(0).forEach((fn) => fn()),
    };
    return iface;
  }

  /* ---------------------------------------------------------------- client */

  async function connectClient(s, code) {
    let host;
    try {
      host = (await op(s, s.sdk.get(refOf(s, roomPath(code, 'host'))))).val();
    } catch (err) {
      throw Net.netError(ERR.RELAY_OFFLINE);
    }
    if (!host || typeof host.uid !== 'string' || host.uid === s.uid) throw Net.netError(ERR.ROOM_NOT_FOUND);
    const hostUid = host.uid;
    const me = s.uid;
    const paths = { peer: roomPath(code, 'peers', me), up: roomPath(code, 'up', me), down: roomPath(code, 'down', me),
      host: roomPath(code, 'host') };
    try {
      await op(s, Promise.all([paths.peer, paths.up, paths.down].map((p) => s.sdk.onDisconnect(refOf(s, p)).remove())));
      await op(s, s.sdk.remove(refOf(s, paths.down))); // frames meant for an earlier connection
    } catch (err) {
      throw Net.netError(ERR.RELAY_OFFLINE);
    }

    const st = { open: true };
    const unsubs = [];
    const conn = makeConnIface(ID_PREFIX + me, st,
      (payload) => pushFrame(s, paths.up, payload, false),
      () => shut(true));
    function shut(leave) {
      if (!st.open) return;
      st.open = false;
      unsubs.splice(0).forEach((u) => { try { u(); } catch (err) { /* already off */ } });
      if (leave) quiet(s.sdk.remove(refOf(s, paths.peer)));
      conn.fireClose();
    }
    unsubs.push(readFrames(s, paths.down, (f) => {
      if (f.close) shut(true);
      else conn.deliver(f.msg);
    }, () => shut(false)));
    unsubs.push(s.sdk.onValue(refOf(s, paths.host), (snap) => {
      const v = snap.val();
      if (!v || v.uid !== hostUid) shut(true); // host left (or the code was re-used by someone else)
    }, () => shut(false)));
    try {
      await op(s, s.sdk.set(refOf(s, paths.peer), { joinedAt: s.clock.now(), s: randomNonce() }));
    } catch (err) {
      shut(false);
      throw Net.netError(ERR.ROOM_NOT_FOUND); // the rules refuse peers once the host is gone
    }
    return conn;
  }

  async function join(code, o) {
    const s = await getSession(o);
    const conn = await connectClient(s, code);
    const core = createClientCore({
      code, peerId: conn.id, clock: o.clock || Net.realClock, conn,
      connect: () => connectClient(s, code),
    });
    core.ep.transport = 'relay';
    core.ep.relayBackend = 'firebase';
    return core.ep;
  }

  /* ---------------------------------------------------------------- host */

  /** Claim rooms/{code}/host for this tab. Throws NetError room-taken / relay-offline. */
  async function claimRoom(s, code) {
    const hostRef = refOf(s, roomPath(code, 'host'));
    const owner = async () => {
      const v = (await op(s, s.sdk.get(hostRef))).val();
      return v && typeof v.uid === 'string' ? v.uid : null;
    };
    try {
      const cur = await owner();
      if (cur && cur !== s.uid) throw Net.netError(ERR.ROOM_TAKEN);
      try {
        await op(s, s.sdk.set(hostRef, { uid: s.uid, createdAt: s.clock.now() }));
      } catch (err) {
        const now = await owner().catch(() => null);
        throw Net.netError(now && now !== s.uid ? ERR.ROOM_TAKEN : ERR.RELAY_OFFLINE);
      }
      await op(s, s.sdk.onDisconnect(refOf(s, roomPath(code))).remove());
    } catch (err) {
      throw err && err.code === ERR.ROOM_TAKEN ? err : Net.netError(ERR.RELAY_OFFLINE);
    }
  }

  /** Host-side stand-in for one Firebase client; same interface as the other transports' conns. */
  function makePeer(session, cid, nonce) {
    const s = session.s;
    const st = { open: true };
    const downPath = roomPath(session.code, 'down', cid);
    const peer = makeConnIface(ID_PREFIX + cid, st, (payload) => pushFrame(s, downPath, payload, false), () => {
      if (!st.open) return;
      if (session.peers.get(cid) === peer) pushFrame(s, downPath, null, true); // kick, not a supersede
      peer.gone();
    });
    peer.nonce = nonce;
    peer.unsub = readFrames(s, roomPath(session.code, 'up', cid), (f) => {
      if (!f.close) peer.deliver(f.msg);
    }, () => peer.gone());
    peer.gone = () => {
      if (!st.open) return;
      st.open = false;
      try { peer.unsub(); } catch (err) { /* already off */ }
      if (session.peers.get(cid) === peer) session.peers.delete(cid);
      peer.fireClose();
    };
    return peer;
  }

  function onPeers(session, value) {
    const seen = value && typeof value === 'object' ? value : {};
    Object.keys(seen).forEach((cid) => {
      const v = seen[cid];
      if (!CID_RE.test(cid) || cid === session.s.uid || !v || typeof v.s !== 'string') return;
      const cur = session.peers.get(cid);
      if (cur && cur.nonce === v.s) return;
      const peer = makePeer(session, cid, v.s);
      session.peers.set(cid, peer); // before attach: the core closes the old conn without a kick
      session.attach(peer.id, peer);
    });
    Array.from(session.peers.keys()).forEach((cid) => {
      if (seen[cid]) return;
      session.peers.get(cid).gone();
      quiet(session.s.sdk.remove(refOf(session.s, roomPath(session.code, 'down', cid))));
      quiet(session.s.sdk.remove(refOf(session.s, roomPath(session.code, 'up', cid))));
    });
  }

  function dropPeers(session) {
    Array.from(session.peers.values()).forEach((p) => p.gone());
  }

  function unbind(session) {
    session.unsubs.splice(0).forEach((u) => { try { u(); } catch (err) { /* already off */ } });
    session.bound = false;
  }

  function bindSession(session) {
    const s = session.s;
    session.bound = true;
    session.attempt = 0;
    session.unsubs.push(s.sdk.onValue(refOf(s, roomPath(session.code, 'host')), (snap) => {
      const v = snap.val();
      if (v && v.uid === s.uid) return;
      unbind(session);
      dropPeers(session);
      if (v) session.stopped = true; // the code now belongs to another host
      else scheduleRetry(session); // our room vanished (connection blip ran onDisconnect): re-claim
    }));
    session.unsubs.push(s.sdk.onValue(refOf(s, roomPath(session.code, 'peers')), (snap) => {
      if (session.bound) onPeers(session, snap.val());
    }));
  }

  function scheduleRetry(session) {
    if (session.stopped || session.timer != null) return;
    const delay = HOST_RETRY_MS[Math.min(session.attempt, HOST_RETRY_MS.length - 1)];
    session.attempt += 1;
    session.timer = session.clock.setTimeout(() => {
      session.timer = null;
      registerHost(session);
    }, delay);
  }

  async function registerHost(session) {
    if (session.stopped) return;
    try {
      session.s = await getSession(session.o);
      if (session.stopped) return;
      await claimRoom(session.s, session.code);
    } catch (err) {
      if (err && err.code === ERR.ROOM_TAKEN) session.stopped = true;
      else scheduleRetry(session);
      return;
    }
    if (session.stopped) quiet(session.s.sdk.remove(refOf(session.s, roomPath(session.code))));
    else bindSession(session);
  }

  function stopSession(session) {
    const wasBound = session.bound;
    session.stopped = true;
    if (session.timer != null) session.clock.clearTimeout(session.timer);
    session.timer = null;
    unbind(session);
    dropPeers(session);
    if (wasBound && session.s) quiet(session.s.sdk.remove(refOf(session.s, roomPath(session.code))));
  }

  /** Serve `code` over Firebase for an existing host core; `s` = already claimed with this session. */
  function startHostSession(hooks, code, o, s) {
    const session = { code, o, s: s || null, clock: o.clock || Net.realClock, attach: hooks.attach,
      peers: new Map(), unsubs: [], timer: null, attempt: 0, stopped: false, bound: false };
    hooks.onShutdown(() => stopSession(session));
    if (s) bindSession(session);
    else registerHost(session);
    return session;
  }

  /** Host the room on Firebase alone (transport 'relay', or PeerJS unreachable in 'auto'). */
  async function createOnlyHost(o) {
    const s = await getSession(o);
    const clock = o.clock || Net.realClock;
    for (let i = 0; i < MAX_CODE_TRIES; i++) {
      const code = i === 0 && Net.normalizeCode(o.code || '') ? Net.normalizeCode(o.code) : Net.makeCode(o.rng);
      try {
        await claimRoom(s, code);
      } catch (err) {
        if (err && err.code === ERR.ROOM_TAKEN) continue;
        throw err;
      }
      const core = createHostCore({ code, clock, maxInbound: Net.MAX_INBOUND_HOST });
      startHostSession(core, code, o, s);
      core.ep.transport = 'relay';
      core.ep.relayBackend = 'firebase';
      return core.ep;
    }
    throw Net.netError(ERR.ROOM_TAKEN);
  }

  Net.Firebase = Object.freeze({
    ID_PREFIX,
    SDK_VERSION,
    SDK_BASE,
    MAX_FRAME_CHARS,
    validConfig,
    configOf,
    join,
    createOnlyHost,
    startHostSession,
  });
})();
