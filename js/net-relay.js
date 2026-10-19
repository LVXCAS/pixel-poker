/*
 * PIXEL HOLD'EM — PP.Net relay transport (load after js/net.js, before js/net-config.js).
 * Fallback for networks that block WebRTC (school Wi-Fi): a tiny WebSocket relay
 * (relay/server.js, protocol documented there) carries the same messages over wss:443.
 *
 *   HOST   — hosting still happens on PeerJS; the room is ALSO registered on the relay, and relay
 *            clients are attached to the same host core as PeerJS clients (ids prefixed "r-").
 *            If PeerJS itself is unreachable, the room is hosted on the relay alone.
 *   CLIENT — PeerJS first; on network-blocked / timeout / unreachable / not-found, the same room
 *            code is tried on the relay. The original error only surfaces if the relay fails too.
 *
 * Relay URL: config.relayUrl, else config.relayJsonUrl ({"url":"wss://..."}, same origin).
 * On localhost only, ?relay=ws://localhost:PORT overrides it (tests); ?forceRelay=1 skips PeerJS.
 *
 * options.transport (player setting, see TRANSPORTS):
 *   'auto'   (default) the behaviour above: PeerJS first, relay alongside / as the fallback.
 *   'direct' PeerJS only: the host never registers on the relay, the client never falls back.
 *   'relay'  relay only: the client joins straight over the relay (no PeerJS attempt) and the host
 *            hosts relay-only. No relay configured / reachable -> NetError 'relay-offline'.
 * options.forceRelay / ?forceRelay=1 (localhost) are the old test switches; they mean 'relay' on join.
 *
 * Relay BACKEND: if PP.Net.config.firebase (or options.firebase) is set and js/net-firebase.js is
 * loaded, the relay role runs on Firebase Realtime Database (PP.Net.Firebase) and relay.json is never
 * fetched; otherwise it is the WebSocket relay above. 'direct' never touches either backend.
 */
(function () {
  'use strict';
  const PP = globalThis.PP;
  if (!PP || !PP.Net || !PP.Net._internal) return;
  const Net = PP.Net;
  const { createHostCore, createClientCore } = Net._internal;
  const ERR = Net.ERR;

  const RELAY_ID_PREFIX = 'r-';
  const CLIENT_ID_LENGTH = 16;
  const CLIENT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  const MAX_URL_LENGTH = 200;
  const MAX_SEND_BYTES = 65536;
  const RELAY_JSON_TIMEOUT_MS = 4000;
  const RELAY_URL_CACHE_MS = 60 * 1000;
  const RELAY_OPEN_TIMEOUT_MS = 10000;
  const HOST_RETRY_MS = [2000, 4000, 8000, 16000, 30000];
  const MAX_CODE_TRIES = 5;
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
  const FALLBACK_CODES = new Set([ERR.NETWORK_BLOCKED, ERR.TIMEOUT, ERR.SERVICE_UNREACHABLE,
    ERR.BROWSER_UNSUPPORTED, ERR.ROOM_NOT_FOUND]);
  const CLOSE_CODES = Object.freeze({ 4404: ERR.ROOM_NOT_FOUND, 4409: ERR.ROOM_TAKEN, 4410: ERR.HOST_LEFT });

  const TRANSPORTS = Object.freeze(['auto', 'direct', 'relay']);
  const base = { createHost: Net.createHost, join: Net.join };

  /** The requested transport; anything unknown is 'auto'. */
  function transportOf(o) {
    return TRANSPORTS.includes(o.transport) ? o.transport : 'auto';
  }

  /** In relay mode "the relay could not be reached" is the whole story; room-level codes pass through. */
  function relayModeError(err) {
    const code = err && err.code;
    return code === ERR.ROOM_NOT_FOUND || code === ERR.ROOM_TAKEN || code === ERR.HOST_LEFT
      ? err : Net.netError(ERR.RELAY_OFFLINE);
  }
  const urlCache = { src: null, at: -Infinity, url: null };

  /** The Firebase relay backend when it is configured for this call, else null (WebSocket relay). */
  function firebaseBackend(o) {
    const fb = Net.Firebase;
    return fb && fb.configOf(o) ? fb : null;
  }

  /** Whether loopback (hub) test setups asked for a relay explicitly. */
  const relayRequested = (o) => !!o.relayUrl || o.firebase !== undefined;

  /* ------------------------------------------------------------- relay URL */

  /** wss://host[/path] anywhere, ws:// only to localhost. Returns a normalized URL or null. */
  function validRelayUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
    let u;
    try {
      u = new URL(raw);
    } catch (err) {
      return null;
    }
    if (u.username || u.password || u.search || u.hash || !u.hostname) return null;
    const ok = u.protocol === 'wss:' || (u.protocol === 'ws:' && LOCAL_HOSTS.has(u.hostname));
    return ok ? u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '') : null;
  }

  function isLocalPage(loc) {
    return !!loc && typeof loc.hostname === 'string' && LOCAL_HOSTS.has(loc.hostname);
  }

  function queryParam(loc, name) {
    const search = loc && typeof loc.search === 'string' ? loc.search : '';
    const m = new RegExp('[?&]' + name + '=([^&#]*)').exec(search);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (err) {
      return null;
    }
  }

  /** Test-only page overrides; honored on localhost pages only so invite links can't redirect. */
  function pageOverrides(o) {
    const loc = o.location || globalThis.location || null;
    if (!isLocalPage(loc)) return { relayUrl: null, forceRelay: false };
    return { relayUrl: validRelayUrl(queryParam(loc, 'relay')), forceRelay: queryParam(loc, 'forceRelay') === '1' };
  }

  function withTimeout(promise, clock, ms) {
    return Promise.race([promise, new Promise((_, rej) => clock.setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  async function fetchRelayJson(src, clock) {
    if (typeof globalThis.fetch !== 'function') return null;
    const sep = src.includes('?') ? '&' : '?';
    try {
      const res = await withTimeout(globalThis.fetch(src + sep + 't=' + clock.now(),
        { credentials: 'omit', cache: 'no-store' }), clock, RELAY_JSON_TIMEOUT_MS);
      const body = res && res.ok ? await withTimeout(res.json(), clock, RELAY_JSON_TIMEOUT_MS) : null;
      return body && typeof body === 'object' ? validRelayUrl(body.url) : null;
    } catch (err) {
      return null; // relay unknown: P2P only
    }
  }

  async function resolveRelayUrl(o, fresh) {
    const direct = validRelayUrl(o.relayUrl) || pageOverrides(o).relayUrl;
    if (direct) return direct;
    const cfg = Net.config || {};
    const fromCfg = validRelayUrl(cfg.relayUrl);
    if (fromCfg) return fromCfg;
    const src = typeof cfg.relayJsonUrl === 'string' && cfg.relayJsonUrl ? cfg.relayJsonUrl : null;
    if (!src) return null;
    const clock = o.clock || Net.realClock;
    const now = clock.now();
    if (!fresh && urlCache.src === src && now - urlCache.at < RELAY_URL_CACHE_MS) return urlCache.url;
    const url = await fetchRelayJson(src, clock);
    Object.assign(urlCache, { src, at: now, url });
    return url;
  }

  /* -------------------------------------------------------------- sockets */

  function randomClientId(rng) {
    const bytes = new Uint8Array(CLIENT_ID_LENGTH);
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor((rng || Math.random)() * 256);
    return Array.from(bytes, (b) => CLIENT_ID_ALPHABET[b % CLIENT_ID_ALPHABET.length]).join('');
  }

  function parseFrame(data) {
    if (typeof data !== 'string' || data.length > MAX_SEND_BYTES) return null;
    try {
      const f = JSON.parse(data);
      return f && typeof f === 'object' && !Array.isArray(f) ? f : null;
    } catch (err) {
      return null;
    }
  }

  function sendFrame(ws, frame) {
    if (!ws || ws.readyState !== 1) return false;
    let json;
    try {
      json = JSON.stringify(frame);
    } catch (err) {
      return false;
    }
    if (typeof json !== 'string' || json.length > MAX_SEND_BYTES) return false;
    try {
      ws.send(json);
      return true;
    } catch (err) {
      return false;
    }
  }

  function closeError(code) {
    return Net.netError(CLOSE_CODES[code] || ERR.SERVICE_UNREACHABLE);
  }

  /**
   * Open a relay socket and wait for the relay's {t:'ready'}. Resolves with the live socket;
   * rejects with a NetError mapped from the close code. onFrame/onClose fire after ready.
   */
  function openRelaySocket(url, params, o) {
    const WS = o.WebSocket || globalThis.WebSocket;
    const clock = o.clock || Net.realClock;
    if (typeof WS !== 'function') return Promise.reject(Net.netError(ERR.SERVICE_UNREACHABLE));
    const query = Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WS(url + '/?' + query);
      } catch (err) {
        reject(Net.netError(ERR.SERVICE_UNREACHABLE));
        return;
      }
      const state = { ready: false, settled: false };
      const fail = (err) => {
        if (state.settled) return;
        state.settled = true;
        clock.clearTimeout(timer);
        try { ws.close(); } catch (e) { /* already closed */ }
        reject(err);
      };
      const timer = clock.setTimeout(() => fail(Net.netError(ERR.SERVICE_UNREACHABLE)), RELAY_OPEN_TIMEOUT_MS);
      ws.onmessage = (ev) => {
        const f = parseFrame(ev && ev.data);
        if (state.ready) {
          if (f && typeof ws.ppFrame === 'function') ws.ppFrame(f);
          return;
        }
        if (!f || f.t !== 'ready' || state.settled) return;
        state.ready = true;
        state.settled = true;
        clock.clearTimeout(timer);
        resolve(ws);
      };
      ws.onclose = (ev) => {
        if (!state.ready) fail(closeError(ev && ev.code));
        else if (typeof ws.ppClose === 'function') ws.ppClose(ev && ev.code);
      };
      ws.onerror = () => { /* onclose follows */ };
    });
  }

  /* --------------------------------------------------------------- client */

  /** Wrap a ready client socket in the connection interface the cores expect. */
  function wrapClientSocket(ws, id) {
    const dataFns = [];
    const closeFns = [];
    const st = { open: true };
    ws.ppFrame = (f) => {
      if (!st.open || !('d' in f)) return;
      dataFns.slice().forEach((fn) => fn(f.d));
    };
    ws.ppClose = () => {
      if (!st.open) return;
      st.open = false;
      closeFns.splice(0).forEach((fn) => fn());
    };
    return {
      id,
      get open() { return st.open; },
      send: (msg) => st.open && sendFrame(ws, { d: msg }),
      close() {
        if (!st.open) return;
        try { ws.close(1000); } catch (err) { /* gone */ }
        ws.ppClose();
      },
      onData: (fn) => { if (typeof fn === 'function') dataFns.push(fn); },
      onClose: (fn) => { if (typeof fn === 'function') closeFns.push(fn); },
    };
  }

  async function connectRelayClient(url, code, clientId, o) {
    const ws = await openRelaySocket(url, { role: 'client', room: code, id: clientId }, o);
    return wrapClientSocket(ws, RELAY_ID_PREFIX + clientId);
  }

  async function joinRelay(code, o, url) {
    const clock = o.clock || Net.realClock;
    const clientId = randomClientId(o.rng);
    const conn = await connectRelayClient(url, code, clientId, o);
    const core = createClientCore({
      code, peerId: conn.id, clock, conn,
      connect: () => connectRelayClient(url, code, clientId, o),
    });
    core.ep.transport = 'relay';
    return core.ep;
  }

  function pickError(p2pErr, relayErr) {
    const notFound = relayErr && relayErr.code === ERR.ROOM_NOT_FOUND;
    if (notFound && (p2pErr.code === ERR.ROOM_NOT_FOUND || p2pErr.code === ERR.SERVICE_UNREACHABLE)) return relayErr;
    return p2pErr;
  }

  async function join(code, options) {
    const o = options || {};
    const normalized = Net.normalizeCode(code);
    if (!normalized) throw Net.netError(ERR.ROOM_NOT_FOUND);
    const mode = transportOf(o);
    if (mode === 'direct') return (o.p2pJoin || base.join)(normalized, o);
    const fb = firebaseBackend(o);
    if (mode === 'relay' || o.forceRelay || pageOverrides(o).forceRelay) {
      if (fb) {
        try {
          return await fb.join(normalized, o);
        } catch (err) {
          throw relayModeError(err);
        }
      }
      const url = await resolveRelayUrl(o, true);
      if (!url) throw Net.netError(ERR.RELAY_OFFLINE);
      try {
        return await joinRelay(normalized, o, url);
      } catch (err) {
        throw relayModeError(err);
      }
    }
    if (o.hub && !relayRequested(o)) return base.join(normalized, o);
    try {
      return await (o.p2pJoin || base.join)(normalized, o);
    } catch (err) {
      if (!err || !FALLBACK_CODES.has(err.code)) throw err;
      if (fb) {
        try {
          return await fb.join(normalized, o);
        } catch (relayErr) {
          throw pickError(err, relayErr);
        }
      }
      const url = await resolveRelayUrl(o);
      if (!url) throw err;
      try {
        return await joinRelay(normalized, o, url);
      } catch (relayErr) {
        throw pickError(err, relayErr);
      }
    }
  }

  /* ----------------------------------------------------------------- host */

  /** Host-side stand-in for one relay client; same interface as PP.Net's wrapPeerConn. */
  function makeRelayPeer(session, clientId) {
    const dataFns = [];
    const closeFns = [];
    const peer = {
      id: RELAY_ID_PREFIX + clientId,
      clientId,
      ws: session.ws,
      alive: true,
      get open() { return peer.alive; },
      send: (msg) => peer.alive && sendFrame(peer.ws, { to: clientId, d: msg }),
      close() {
        if (!peer.alive) return;
        if (session.peers.get(clientId) === peer) sendFrame(peer.ws, { kick: clientId });
        peer.gone();
      },
      onData: (fn) => { if (typeof fn === 'function') dataFns.push(fn); },
      onClose: (fn) => { if (typeof fn === 'function') closeFns.push(fn); },
      deliver: (d) => { if (peer.alive) dataFns.slice().forEach((fn) => fn(d)); },
      gone() {
        if (!peer.alive) return;
        peer.alive = false;
        if (session.peers.get(clientId) === peer) session.peers.delete(clientId);
        closeFns.splice(0).forEach((fn) => fn());
      },
    };
    return peer;
  }

  const validClientId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(id);

  function onHostFrame(session, f) {
    if (!validClientId(f.id || f.from)) return;
    if (f.t === 'join') {
      const peer = makeRelayPeer(session, f.id);
      session.peers.set(f.id, peer); // supersedes any old one; the core closes the old conn
      session.attach(peer.id, peer);
    } else if (f.t === 'leave') {
      const peer = session.peers.get(f.id);
      if (peer) peer.gone();
    } else if (f.t === 'msg' && 'd' in f) {
      const peer = session.peers.get(f.from);
      if (peer) peer.deliver(f.d);
    }
  }

  function bindHostSocket(session, ws) {
    session.ws = ws;
    session.attempt = 0;
    ws.ppFrame = (f) => onHostFrame(session, f);
    ws.ppClose = (code) => {
      if (session.ws !== ws) return;
      session.ws = null;
      Array.from(session.peers.values()).forEach((p) => p.gone());
      if (code === 4409) session.stopped = true; // code now owned by another relay host
      scheduleRetry(session);
    };
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
    const url = await resolveRelayUrl(session.o, session.attempt > 0);
    if (session.stopped) return;
    if (!url) {
      if (session.attempt === 0) session.stopped = true; // no relay configured: P2P only
      else scheduleRetry(session);
      return;
    }
    try {
      const ws = await openRelaySocket(url, { role: 'host', room: session.code }, session.o);
      if (session.stopped) ws.close(1000);
      else bindHostSocket(session, ws);
    } catch (err) {
      if (err && err.code === ERR.ROOM_TAKEN) session.stopped = true;
      else scheduleRetry(session);
    }
  }

  function stopSession(session) {
    session.stopped = true;
    if (session.timer != null) session.clock.clearTimeout(session.timer);
    session.timer = null;
    const ws = session.ws;
    session.ws = null;
    if (ws) {
      try { ws.close(1000); } catch (err) { /* gone */ }
    }
    Array.from(session.peers.values()).forEach((p) => p.gone());
  }

  /** Register `code` on the relay for an existing host core; keeps retrying with backoff. */
  function startHostSession(hooks, code, o, ws) {
    const session = { code, o, clock: o.clock || Net.realClock, attach: hooks.attach, peers: new Map(),
      ws: null, timer: null, attempt: 0, stopped: false };
    hooks.onShutdown(() => stopSession(session));
    if (ws) bindHostSocket(session, ws);
    else registerHost(session);
    return session;
  }

  /** PeerJS is unreachable but the relay is not: host the room on the relay alone. */
  async function createRelayOnlyHost(o, url) {
    const clock = o.clock || Net.realClock;
    for (let i = 0; i < MAX_CODE_TRIES; i++) {
      const code = i === 0 && Net.normalizeCode(o.code || '') ? Net.normalizeCode(o.code) : Net.makeCode(o.rng);
      let ws;
      try {
        ws = await openRelaySocket(url, { role: 'host', room: code }, o);
      } catch (err) {
        if (err && err.code === ERR.ROOM_TAKEN) continue;
        throw err;
      }
      const core = createHostCore({ code, clock, maxInbound: Net.MAX_INBOUND_HOST });
      startHostSession(core, code, o, ws);
      core.ep.transport = 'relay';
      return core.ep;
    }
    throw Net.netError(ERR.ROOM_TAKEN);
  }

  async function createHost(options) {
    const o = options || {};
    const mode = transportOf(o);
    if (mode === 'direct') return (o.p2pHost || base.createHost)(o);
    const fb = firebaseBackend(o);
    if (mode === 'relay') {
      const url = fb ? null : await resolveRelayUrl(o, true);
      if (!fb && !url) throw Net.netError(ERR.RELAY_OFFLINE);
      try {
        return await (fb ? fb.createOnlyHost(o) : createRelayOnlyHost(o, url));
      } catch (err) {
        throw relayModeError(err);
      }
    }
    const wantRelay = !o.hub || relayRequested(o);
    let ep;
    try {
      ep = await (o.p2pHost || base.createHost)(o);
    } catch (err) {
      const fallback = wantRelay && err && (err.code === ERR.SERVICE_UNREACHABLE || err.code === ERR.BROWSER_UNSUPPORTED);
      const url = fallback && !fb ? await resolveRelayUrl(o) : null;
      if (!(fallback && fb) && !url) throw err;
      try {
        return await (fb ? fb.createOnlyHost(o) : createRelayOnlyHost(o, url));
      } catch (relayErr) {
        throw err;
      }
    }
    const hooks = wantRelay ? Net._internal.hostCoreOf(ep) : null;
    if (hooks && fb) fb.startHostSession(hooks, ep.code, o);
    else if (hooks) startHostSession(hooks, ep.code, o);
    return ep;
  }

  Net.createHost = createHost;
  Net.join = join;
  Net.TRANSPORTS = TRANSPORTS;
  Net.Relay = Object.freeze({
    ID_PREFIX: RELAY_ID_PREFIX,
    validRelayUrl,
    resolveRelayUrl,
    pageOverrides,
    randomClientId,
    resetCache: () => Object.assign(urlCache, { src: null, at: -Infinity, url: null }),
  });
})();
