/*
 * PIXEL HOLD'EM — PP.Net
 * Transport for peer-to-peer play (see MULTIPLAYER.md section 2). DOM-free except for the lazy
 * PeerJS <script> injection, which only runs on first online use in a browser.
 *
 * Two drivers with the same endpoint shape:
 *   - PeerJS (WebRTC data channels, free PeerJS cloud signaling)
 *   - Loopback (in-memory hub; Node tests and offline demos)
 * Shared "cores" implement validation, heartbeat, presence and reconnect on top of a tiny
 * connection interface: { open, send(msg) -> bool, close(), onData(fn), onClose(fn) }.
 *
 * Play chips only: nothing in here moves money, ever.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 5;
  const PEER_PREFIX = 'pxhe-';
  const INVITE_BASE = 'https://lvxcas.github.io/pixel-poker/';
  const MAX_CODE_TRIES = 5;
  const TICK_MS = 1000;
  const PEERJS_LOAD_TIMEOUT_MS = 15000;
  const HOST_DESTROY_DELAY_MS = 500;
  const PROBE_TIMEOUT_MS = 6000;
  const PROBE_N = -1;

  const ERR = Object.freeze({
    ROOM_NOT_FOUND: 'room-not-found',
    ROOM_TAKEN: 'room-taken',
    SERVICE_UNREACHABLE: 'service-unreachable',
    NETWORK_BLOCKED: 'network-blocked',
    BROWSER_UNSUPPORTED: 'browser-unsupported',
    HOST_LEFT: 'host-left',
    TIMEOUT: 'timeout',
    CLOSED: 'closed',
  });

  const ERROR_TEXT = Object.freeze({
    'room-not-found': 'No table with that code.',
    'room-taken': 'Could not reserve a room code. Try again.',
    'service-unreachable': 'Cannot reach the matchmaking server.',
    'network-blocked': 'Found the table, but this network blocks direct connections, and the relay could not get through either. Try a phone hotspot.',
    'browser-unsupported': 'This browser does not support peer-to-peer connections.',
    'host-left': 'The host closed the table.',
    timeout: 'Timed out.',
    closed: 'Connection closed.',
  });

  /* ------------------------------------------------------------------ helpers */

  function netError(code, message) {
    const err = new Error(message || ERROR_TEXT[code] || String(code));
    err.name = 'NetError';
    err.code = code;
    return err;
  }

  function defer(fn) {
    if (typeof setImmediate === 'function') setImmediate(fn);
    else setTimeout(fn, 0);
  }

  const nextTick = () => new Promise((resolve) => defer(resolve));

  function defaultRng() {
    return PP.Cards && typeof PP.Cards.rng === 'function' ? PP.Cards.rng() : Math.random();
  }

  function createEmitter() {
    const map = {};
    return {
      on(name, fn) {
        if (typeof fn !== 'function') return () => {};
        (map[name] = map[name] || []).push(fn);
        return () => {
          map[name] = (map[name] || []).filter((f) => f !== fn);
        };
      },
      emit(name, ...args) {
        (map[name] || []).slice().forEach((fn) => {
          try {
            fn(...args);
          } catch (err) {
            console.error('[PP.Net] listener for "' + name + '" failed:', err);
          }
        });
      },
    };
  }

  /** Inbound app-message gate: plain object, string `t`, JSON size within the cap. */
  function acceptInbound(msg, maxBytes) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (typeof msg.t !== 'string') return false;
    let json;
    try {
      json = JSON.stringify(msg);
    } catch (err) {
      return false;
    }
    return typeof json === 'string' && json.length <= maxBytes;
  }

  /** Echo only a number: a reserved message bypasses the size cap, so never reflect its payload. */
  const pingNumber = (n) => (Number.isFinite(n) ? n : 0);

  const isReserved = (msg) => !!msg && typeof msg === 'object' && typeof msg.t === 'string' && msg.t[0] === '_';

  /* ---------------------------------------------------------------- clocks */

  const realClock = Object.freeze({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  });

  /** Deterministic clock for tests: timers only fire inside advance(). */
  function createManualClock(start) {
    let now = Number.isFinite(start) ? start : 0;
    let nextId = 1;
    let timers = [];
    const settle = async () => {
      for (let i = 0; i < 4; i++) await nextTick();
    };
    return {
      now: () => now,
      setTimeout(fn, ms) {
        const id = nextId++;
        timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn });
        return id;
      },
      clearTimeout(id) {
        timers = timers.filter((t) => t.id !== id);
      },
      pending: () => timers.length,
      async advance(ms) {
        const target = now + Math.max(0, Number(ms) || 0);
        for (;;) {
          const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
          if (!due) break;
          timers = timers.filter((t) => t !== due);
          now = Math.max(now, due.at);
          try {
            due.fn();
          } catch (err) {
            console.error('[PP.Net] manual clock timer failed:', err);
          }
          await settle();
        }
        now = target;
        await settle();
      },
    };
  }

  function waitMs(clock, ms) {
    return new Promise((resolve) => clock.setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------ room codes */

  function makeCode(rng) {
    const random = typeof rng === 'function' ? rng : defaultRng;
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
    }
    return code;
  }

  function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    const code = input.trim().toUpperCase().replace(/[\s-]+/g, '');
    if (code.length !== CODE_LENGTH) return null;
    for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
    return code;
  }

  const peerIdFor = (code) => PEER_PREFIX + code;

  function inviteUrl(code, location) {
    const loc = location || globalThis.location || null;
    const proto = loc && typeof loc.protocol === 'string' ? loc.protocol : '';
    const host = loc && typeof loc.hostname === 'string' ? loc.hostname : '';
    const local = host === 'localhost' || host === '127.0.0.1' || host === '';
    if ((proto === 'https:' || proto === 'http:') && !local) {
      return loc.origin + loc.pathname + '?room=' + code;
    }
    return INVITE_BASE + '?room=' + code;
  }

  function codeFromLocation(location) {
    const search = location && typeof location.search === 'string' ? location.search : '';
    const match = /[?&]room=([^&#]*)/.exec(search);
    if (!match) return null;
    let raw = match[1];
    try {
      raw = decodeURIComponent(raw);
    } catch (err) {
      return null;
    }
    return normalizeCode(raw);
  }

  /* ------------------------------------------------------------ host core */

  // Host endpoint -> { attach, onShutdown } so a second transport (js/net-relay.js) can feed the
  // same core. Not reachable from the network; page code could already do anything anyway.
  const hostCores = new WeakMap();

  function createHostCore(opts) {
    const clock = opts.clock;
    const max = opts.maxInbound;
    const peers = new Map();
    const ev = createEmitter();
    const state = { closed: false, tick: null, pingN: 0, lastPing: clock.now() };
    const shutdownFns = [];
    const runShutdown = () => shutdownFns.splice(0).forEach((fn) => {
      try { fn(); } catch (err) { console.error('[PP.Net] host shutdown hook failed:', err); }
    });

    const ep = {
      role: 'host',
      code: opts.code,
      stats: { dropped: 0 },
      send: (peerId, msg) => {
        const rec = peers.get(peerId);
        return !!rec && !rec.gone && rec.conn.send(msg);
      },
      broadcast: (msg, exceptPeerId) => {
        peers.forEach((rec, id) => {
          if (id !== exceptPeerId && !rec.gone) rec.conn.send(msg);
        });
      },
      peers: () => Array.from(peers.keys()),
      kick: (peerId, reason) => kick(peerId, reason),
      onPeerJoin: (fn) => ev.on('join', fn),
      onPeerLeave: (fn) => ev.on('leave', fn),
      onPeerStatus: (fn) => ev.on('status', fn),
      onMessage: (fn) => ev.on('message', fn),
      onError: (fn) => ev.on('error', fn),
      close: () => close(),
    };

    function attach(peerId, conn) {
      if (state.closed) {
        conn.close();
        return;
      }
      const old = peers.get(peerId);
      if (old) {
        old.gone = true;
        old.conn.close();
      }
      const rec = { peerId, conn, lastSeen: clock.now(), status: 'online', gone: false };
      peers.set(peerId, rec);
      conn.onData((msg) => onData(rec, msg));
      conn.onClose(() => detach(rec, 'closed'));
      if (!old) ev.emit('join', peerId);
    }

    function onData(rec, msg) {
      if (rec.gone) return;
      rec.lastSeen = clock.now();
      if (rec.status !== 'online') {
        rec.status = 'online';
        ev.emit('status', rec.peerId, 'online');
      }
      if (isReserved(msg)) {
        if (msg.t === '_ping') rec.conn.send({ t: '_pong', n: pingNumber(msg.n) });
        return;
      }
      if (!acceptInbound(msg, max)) {
        ep.stats.dropped += 1;
        return;
      }
      ev.emit('message', msg, rec.peerId);
    }

    function detach(rec, reason) {
      if (rec.gone) return;
      rec.gone = true;
      if (peers.get(rec.peerId) === rec) peers.delete(rec.peerId);
      if (!state.closed) ev.emit('leave', rec.peerId, reason);
    }

    function kick(peerId, reason) {
      const rec = peers.get(peerId);
      if (!rec || rec.gone) return;
      rec.conn.send({ t: 'kicked', reason: String(reason || 'kicked') });
      detach(rec, 'kicked');
      rec.conn.close();
    }

    function tick() {
      state.tick = null;
      if (state.closed) return;
      const now = clock.now();
      const ping = now - state.lastPing >= PP.Net.PING_MS;
      if (ping) {
        state.lastPing = now;
        state.pingN += 1;
      }
      Array.from(peers.values()).forEach((rec) => checkPeer(rec, now, ping));
      state.tick = clock.setTimeout(tick, TICK_MS);
    }

    function checkPeer(rec, now, ping) {
      const silent = now - rec.lastSeen;
      if (silent >= PP.Net.DROP_MS) {
        detach(rec, 'timeout');
        rec.conn.close();
        return;
      }
      if (silent >= PP.Net.AWAY_MS && rec.status === 'online') {
        rec.status = 'away';
        ev.emit('status', rec.peerId, 'away');
      }
      if (ping) rec.conn.send({ t: '_ping', n: state.pingN });
    }

    function close() {
      if (state.closed) return;
      state.closed = true;
      if (state.tick != null) clock.clearTimeout(state.tick);
      peers.forEach((rec) => {
        rec.gone = true;
        rec.conn.close();
      });
      peers.clear();
      runShutdown();
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    /** Driver hook: the host went away underneath us (tab closed / hub.dropHost). No events. */
    function kill() {
      state.closed = true;
      if (state.tick != null) clock.clearTimeout(state.tick);
      peers.forEach((rec) => {
        rec.gone = true;
      });
      peers.clear();
      runShutdown();
    }

    const onShutdown = (fn) => {
      if (typeof fn !== 'function') return;
      if (state.closed) fn();
      else shutdownFns.push(fn);
    };
    hostCores.set(ep, { attach, onShutdown });
    state.tick = clock.setTimeout(tick, TICK_MS);
    return { ep, attach, kill, onShutdown, emitError: (err) => ev.emit('error', err) };
  }

  /* ---------------------------------------------------------- client core */

  function createClientCore(opts) {
    const clock = opts.clock;
    const ev = createEmitter();
    const state = { current: null, closed: false, reconnecting: false, tick: null, lastSeen: clock.now(),
      lastPing: clock.now(), pingN: 0 };

    const ep = {
      role: 'client',
      code: opts.code,
      peerId: opts.peerId,
      stats: { dropped: 0 },
      send: (msg) => !!state.current && state.current.send(msg),
      onMessage: (fn) => ev.on('message', fn),
      onStatus: (fn) => ev.on('status', fn),
      onError: (fn) => ev.on('error', fn),
      close: () => close(),
    };

    function attach(conn) {
      state.current = conn;
      state.lastSeen = clock.now();
      conn.onData((msg) => onData(conn, msg));
      conn.onClose(() => {
        if (conn === state.current) lost();
      });
    }

    function onData(conn, msg) {
      if (conn !== state.current || state.closed) return;
      state.lastSeen = clock.now();
      if (isReserved(msg)) {
        if (msg.t === '_ping') conn.send({ t: '_pong', n: pingNumber(msg.n) });
        return;
      }
      if (!acceptInbound(msg, PP.Net.MAX_INBOUND_CLIENT)) {
        ep.stats.dropped += 1;
        return;
      }
      ev.emit('message', msg);
    }

    function lost() {
      const conn = state.current;
      state.current = null;
      if (conn) conn.close();
      if (state.closed || state.reconnecting) return;
      reconnect();
    }

    async function reconnect() {
      state.reconnecting = true;
      ev.emit('status', 'reconnecting');
      for (const delay of PP.Net.RECONNECT_DELAYS) {
        await waitMs(clock, delay);
        if (state.closed) return;
        try {
          const conn = await opts.connect();
          if (state.closed) {
            conn.close();
            return;
          }
          state.reconnecting = false;
          attach(conn);
          ev.emit('status', 'open');
          return;
        } catch (err) {
          // try the next delay
        }
      }
      state.reconnecting = false;
      ev.emit('error', netError(ERR.HOST_LEFT));
      finish();
    }

    function tick() {
      state.tick = null;
      if (state.closed) return;
      const now = clock.now();
      if (state.current && now - state.lastSeen >= PP.Net.DROP_MS) lost();
      else if (state.current && now - state.lastPing >= PP.Net.PING_MS) {
        state.lastPing = now;
        state.pingN += 1;
        state.current.send({ t: '_ping', n: state.pingN });
      }
      if (!state.closed) state.tick = clock.setTimeout(tick, TICK_MS);
    }

    function finish() {
      if (state.closed) return;
      state.closed = true;
      if (state.tick != null) clock.clearTimeout(state.tick);
      const conn = state.current;
      state.current = null;
      if (conn) conn.close();
      if (typeof opts.onClose === 'function') opts.onClose();
      ev.emit('status', 'closed');
    }

    function close() {
      finish();
    }

    attach(opts.conn);
    state.tick = clock.setTimeout(tick, TICK_MS);
    return { ep };
  }

  /* -------------------------------------------------------------- loopback */

  function createHub(options) {
    const o = options || {};
    const latencyMs = Math.max(0, Number(o.latencyMs) || 0);
    const clock = o.clock || realClock;
    const hosts = new Map();
    const queue = [];
    const state = { scheduled: false, inflight: 0, nextPeer: 1 };
    const log = [];

    function enqueue(item) {
      if (latencyMs > 0) {
        state.inflight += 1;
        clock.setTimeout(() => {
          state.inflight -= 1;
          deliver(item);
        }, latencyMs);
        return;
      }
      queue.push(item);
      if (!state.scheduled) {
        state.scheduled = true;
        defer(pump);
      }
    }

    function pump() {
      state.scheduled = false;
      while (queue.length) deliver(queue.shift());
    }

    function deliver(item) {
      const end = item.to;
      if (item.kind === 'close') {
        if (end.closeFired) return;
        end.open = false;
        end.closeFired = true;
        end.closeFns.slice().forEach((fn) => safeCall(fn));
        return;
      }
      if (!end.open) return;
      const msg = JSON.parse(item.json);
      if (!isReserved(msg)) log.push({ from: item.from, to: end.id, msg: JSON.parse(item.json) });
      end.dataFns.slice().forEach((fn) => safeCall(fn, msg));
    }

    function safeCall(fn, arg) {
      try {
        fn(arg);
      } catch (err) {
        console.error('[PP.Net] loopback handler failed:', err);
      }
    }

    function makeEnd(id) {
      const end = { id, open: true, closeFired: false, other: null, dataFns: [], closeFns: [] };
      end.send = (msg) => {
        if (!end.open) return false;
        let json;
        try {
          json = JSON.stringify(msg);
        } catch (err) {
          return false;
        }
        if (typeof json !== 'string') return false;
        enqueue({ kind: 'data', to: end.other, json, from: id });
        return true;
      };
      end.close = () => {
        if (!end.open) return;
        end.open = false;
        enqueue({ kind: 'close', to: end.other });
        enqueue({ kind: 'close', to: end });
      };
      end.onData = (fn) => end.dataFns.push(fn);
      end.onClose = (fn) => end.closeFns.push(fn);
      return end;
    }

    function connect(code, peerId) {
      const id = peerId || 'peer-' + state.nextPeer++;
      return new Promise((resolve, reject) => {
        defer(() => {
          const host = hosts.get(code);
          if (!host) {
            reject(netError(ERR.ROOM_NOT_FOUND));
            return;
          }
          const clientEnd = makeEnd(id);
          const hostEnd = makeEnd(peerIdFor(code));
          clientEnd.other = hostEnd;
          hostEnd.other = clientEnd;
          host.ends.add(hostEnd);
          host.accept(id, hostEnd);
          resolve(clientEnd);
        });
      });
    }

    function closeEnd(end) {
      if (!end.open) return;
      end.close();
    }

    const hub = {
      log,
      latencyMs,
      register(code, accept, kill) {
        if (hosts.has(code)) return false;
        hosts.set(code, { accept, kill, ends: new Set() });
        return true;
      },
      unregister(code) {
        hosts.delete(code);
      },
      connect,
      drop(peerId) {
        hosts.forEach((host) => {
          host.ends.forEach((end) => {
            if (end.other && end.other.id === peerId && end.open) closeEnd(end);
          });
        });
      },
      dropHost(code) {
        const host = hosts.get(code);
        if (!host) return;
        hosts.delete(code);
        host.kill();
        host.ends.forEach(closeEnd);
      },
      async flush() {
        let idle = 0;
        while (idle < 3) {
          await nextTick();
          if (queue.length === 0 && state.inflight === 0 && !state.scheduled) idle += 1;
          else idle = 0;
        }
      },
    };
    return hub;
  }

  async function createLoopbackHost(o) {
    const hub = o.hub;
    const clock = o.clock || realClock;
    for (let i = 0; i < MAX_CODE_TRIES; i++) {
      const code = i === 0 && normalizeCode(o.code || '') ? normalizeCode(o.code) : makeCode(o.rng);
      let core = null;
      const ok = hub.register(code, (peerId, end) => core.attach(peerId, end), () => core.kill());
      if (!ok) continue;
      core = createHostCore({ code, clock, maxInbound: PP.Net.MAX_INBOUND_HOST, onClose: () => hub.unregister(code) });
      await nextTick();
      return core.ep;
    }
    throw netError(ERR.ROOM_TAKEN);
  }

  async function joinLoopback(code, o) {
    const hub = o.hub;
    const clock = o.clock || realClock;
    const conn = await hub.connect(code);
    const core = createClientCore({
      code, peerId: conn.id, clock, conn,
      connect: () => hub.connect(code, conn.id),
    });
    return core.ep;
  }

  /* ---------------------------------------------------------------- PeerJS */

  let peerJsPromise = null;

  function loadPeerJS(clock) {
    if (typeof globalThis.Peer === 'function') return Promise.resolve(globalThis.Peer);
    if (peerJsPromise) return peerJsPromise;
    const doc = globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') {
      return Promise.reject(netError(ERR.SERVICE_UNREACHABLE, 'PeerJS is not available here.'));
    }
    const c = clock || realClock;
    peerJsPromise = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      const fail = () => {
        peerJsPromise = null;
        reject(netError(ERR.SERVICE_UNREACHABLE, 'Could not load the connection library.'));
      };
      const timer = c.setTimeout(fail, PEERJS_LOAD_TIMEOUT_MS);
      script.src = PP.Net.PEERJS_URL;
      script.integrity = PP.Net.PEERJS_SRI;
      script.crossOrigin = 'anonymous';
      script.async = true;
      script.onload = () => {
        c.clearTimeout(timer);
        if (typeof globalThis.Peer === 'function') resolve(globalThis.Peer);
        else fail();
      };
      script.onerror = () => {
        c.clearTimeout(timer);
        fail();
      };
      (doc.head || doc.documentElement).appendChild(script);
    });
    return peerJsPromise;
  }

  function mapPeerError(err) {
    const type = err && err.type;
    switch (type) {
      case 'peer-unavailable': return netError(ERR.ROOM_NOT_FOUND);
      case 'unavailable-id': return netError(ERR.ROOM_TAKEN);
      case 'browser-incompatible': return netError(ERR.BROWSER_UNSUPPORTED);
      case 'webrtc': return netError(ERR.NETWORK_BLOCKED);
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed': return netError(ERR.SERVICE_UNREACHABLE);
      default: return netError(ERR.SERVICE_UNREACHABLE, (err && err.message) || 'Connection error.');
    }
  }

  function offPeer(target, name, fn) {
    if (typeof target.off === 'function') target.off(name, fn);
    else if (typeof target.removeListener === 'function') target.removeListener(name, fn);
  }

  function peerOptions(ice) {
    const list = ice || (PP.Net.config && PP.Net.config.iceServers);
    return list ? { debug: 0, config: { iceServers: list } } : { debug: 0 };
  }

  // Strict networks (school, office) block direct WebRTC. A TURN relay on port 443
  // gets through because it looks like ordinary HTTPS. Credentials come from
  // config.turnUrl (e.g. a Metered.ca credentials endpoint) and are cached.
  const TURN_FETCH_TIMEOUT_MS = 6000;
  const TURN_CACHE_MS = 30 * 60 * 1000;
  const turnCache = { url: null, at: -Infinity, list: null };

  function validIceList(list) {
    return Array.isArray(list) && list.length > 0 && list.length <= 16 &&
      list.every((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
  }

  async function resolveIce(clock) {
    const cfg = PP.Net.config || {};
    const base = cfg.iceServers || null;
    if (!cfg.turnUrl || typeof globalThis.fetch !== 'function') return base;
    const now = clock.now();
    if (turnCache.list && turnCache.url === cfg.turnUrl && now - turnCache.at < TURN_CACHE_MS) {
      return turnCache.list;
    }
    try {
      const res = await Promise.race([
        globalThis.fetch(cfg.turnUrl, { credentials: 'omit' }),
        new Promise((_, rej) => clock.setTimeout(() => rej(new Error('turn timeout')), TURN_FETCH_TIMEOUT_MS)),
      ]);
      const list = res && res.ok ? await res.json() : null;
      if (!validIceList(list)) return base;
      const merged = (base || []).concat(list);
      turnCache.url = cfg.turnUrl;
      turnCache.at = now;
      turnCache.list = merged;
      return merged;
    } catch (err) {
      return base; // relay unavailable: fall back to direct-only
    }
  }

  function openPeer(Peer, id, clock, ice) {
    if (typeof globalThis.RTCPeerConnection !== 'function' && globalThis.document) {
      return Promise.reject(netError(ERR.BROWSER_UNSUPPORTED));
    }
    return new Promise((resolve, reject) => {
      let peer;
      try {
        peer = id ? new Peer(id, peerOptions(ice)) : new Peer(peerOptions(ice));
      } catch (err) {
        reject(netError(ERR.BROWSER_UNSUPPORTED));
        return;
      }
      const done = (err) => {
        clock.clearTimeout(timer);
        offPeer(peer, 'open', onOpen);
        offPeer(peer, 'error', onError);
        if (!err) return resolve(peer);
        try { peer.destroy(); } catch (e) { /* already gone */ }
        return reject(err);
      };
      const onOpen = () => done(null);
      const onError = (err) => done(mapPeerError(err));
      const timer = clock.setTimeout(() => done(netError(ERR.SERVICE_UNREACHABLE)), PP.Net.OPEN_TIMEOUT_MS);
      peer.on('open', onOpen);
      peer.on('error', onError);
    });
  }

  function wrapPeerConn(conn) {
    const wrapped = {
      id: conn.peer,
      get open() { return !!conn.open; },
      send(msg) {
        if (!conn.open) return false;
        try {
          conn.send(msg);
          return true;
        } catch (err) {
          return false;
        }
      },
      close() {
        // PeerJS >= 1.5 drains the send buffer first with {flush: true}; older builds ignore the arg.
        try { conn.close({ flush: true }); } catch (err) { /* already closed */ }
      },
      onData: (fn) => conn.on('data', fn),
      onClose(fn) {
        let fired = false;
        const once = () => {
          if (fired) return;
          fired = true;
          fn();
        };
        conn.on('close', once);
        conn.on('error', once);
      },
    };
    return wrapped;
  }

  function connectConn(peer, hostId, clock) {
    return new Promise((resolve, reject) => {
      let conn;
      try {
        conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
      } catch (err) {
        reject(netError(ERR.NETWORK_BLOCKED));
        return;
      }
      const done = (err) => {
        clock.clearTimeout(timer);
        offPeer(peer, 'error', onPeerError);
        if (!err) return resolve(wrapPeerConn(conn));
        try { conn.close(); } catch (e) { /* ignore */ }
        return reject(err);
      };
      const onPeerError = (err) => done(mapPeerError(err));
      const timer = clock.setTimeout(() => done(netError(ERR.NETWORK_BLOCKED)), PP.Net.CONNECT_TIMEOUT_MS);
      conn.on('open', () => done(null));
      peer.on('error', onPeerError);
    });
  }

  /** Data can be blocked even after the channel "opens": require one _ping/_pong round trip. */
  function probeConn(conn, clock) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clock.clearTimeout(timer);
        if (err) reject(err);
        else resolve(conn);
      };
      const timer = clock.setTimeout(() => finish(netError(ERR.NETWORK_BLOCKED)), PROBE_TIMEOUT_MS);
      conn.onData((msg) => {
        if (msg && msg.t === '_pong' && msg.n === PROBE_N) finish(null);
      });
      conn.onClose(() => finish(netError(ERR.NETWORK_BLOCKED)));
      if (!conn.send({ t: '_ping', n: PROBE_N })) finish(netError(ERR.NETWORK_BLOCKED));
    });
  }

  async function createPeerHost(o) {
    const clock = o.clock || realClock;
    const Peer = await loadPeerJS(clock);
    const ice = await resolveIce(clock);
    for (let i = 0; i < MAX_CODE_TRIES; i++) {
      const code = i === 0 && normalizeCode(o.code || '') ? normalizeCode(o.code) : makeCode(o.rng);
      let peer;
      try {
        peer = await openPeer(Peer, peerIdFor(code), clock, ice);
      } catch (err) {
        if (err.code === ERR.ROOM_TAKEN) continue;
        throw err;
      }
      return wirePeerHost(peer, code, clock);
    }
    throw netError(ERR.ROOM_TAKEN);
  }

  function wirePeerHost(peer, code, clock) {
    const core = createHostCore({
      code, clock, maxInbound: PP.Net.MAX_INBOUND_HOST,
      onClose: () => {
        // Give flushed connections a moment to deliver the final `closed` message.
        clock.setTimeout(() => {
          try { peer.destroy(); } catch (e) { /* ignore */ }
        }, HOST_DESTROY_DELAY_MS);
      },
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => core.attach(conn.peer, wrapPeerConn(conn)));
    });
    peer.on('disconnected', () => {
      if (!peer.destroyed) {
        try { peer.reconnect(); } catch (e) { core.emitError(netError(ERR.SERVICE_UNREACHABLE)); }
      }
    });
    peer.on('error', (err) => {
      if (err && err.type === 'peer-unavailable') return; // not meaningful for a host
      core.emitError(mapPeerError(err));
    });
    return core.ep;
  }

  async function joinPeer(code, o) {
    const clock = o.clock || realClock;
    const Peer = await loadPeerJS(clock);
    const hostId = peerIdFor(code);
    const ice = await resolveIce(clock);
    const ref = { peer: await openPeer(Peer, null, clock, ice) };
    let conn;
    try {
      conn = await connectConn(ref.peer, hostId, clock);
      await probeConn(conn, clock);
    } catch (err) {
      if (conn) conn.close();
      try { ref.peer.destroy(); } catch (e) { /* ignore */ }
      throw err;
    }
    const reconnectFn = async () => {
      if (ref.peer.destroyed) ref.peer = await openPeer(Peer, null, clock, ice);
      else if (ref.peer.disconnected) ref.peer.reconnect();
      return connectConn(ref.peer, hostId, clock);
    };
    const core = createClientCore({
      code, peerId: ref.peer.id, clock, conn, connect: reconnectFn,
      onClose: () => {
        try { ref.peer.destroy(); } catch (e) { /* ignore */ }
      },
    });
    return core.ep;
  }

  /* ------------------------------------------------------------ public API */

  function createHost(options) {
    const o = options || {};
    return o.hub ? createLoopbackHost(o) : createPeerHost(o);
  }

  function join(code, options) {
    const o = options || {};
    const normalized = normalizeCode(code);
    if (!normalized) return Promise.reject(netError(ERR.ROOM_NOT_FOUND));
    return o.hub ? joinLoopback(normalized, o) : joinPeer(normalized, o);
  }

  PP.Net = {
    VERSION: 1,
    CODE_ALPHABET,
    CODE_LENGTH,
    PEER_PREFIX,
    PEERJS_URL: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
    PEERJS_SRI: 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR',
    INVITE_BASE,
    MAX_INBOUND_HOST: 2048,
    MAX_INBOUND_CLIENT: 65536,
    PING_MS: 5000,
    AWAY_MS: 12000,
    DROP_MS: 30000,
    OPEN_TIMEOUT_MS: 10000,
    CONNECT_TIMEOUT_MS: 15000,
    RECONNECT_DELAYS: [1000, 2000, 4000, 8000, 8000],
    ERR,
    config: { iceServers: null, turnUrl: null },
    resolveIce,
    realClock,
    makeCode,
    normalizeCode,
    peerIdFor,
    inviteUrl,
    codeFromLocation,
    netError,
    createManualClock,
    loadPeerJS,
    createHost,
    join,
    Loopback: Object.freeze({ createHub }),
    // Transport plumbing for js/net-relay.js; not part of the app-facing API.
    _internal: Object.freeze({
      createHostCore, createClientCore, probeConn, isReserved,
      hostCoreOf: (ep) => hostCores.get(ep) || null,
    }),
  };
})();
