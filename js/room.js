/*
 * PIXEL HOLD'EM — PP.Room
 * Room layer for peer-to-peer play (MULTIPLAYER.md sections 4 and 5).
 *   HostRoom   — lives in the host's browser; owns the authoritative PP.Engine, seats, lobby,
 *                turn timers, presence, chat, and per-recipient (hidden-information safe) broadcasts.
 *   ClientRoom — lives in a friend's browser; wraps a ClientEndpoint + PP.RemoteEngine.
 * DOM-free. Every timer goes through an injectable clock. Play chips only — no money, ever.
 *
 * File is over the usual 400-line target on purpose: the contract puts both room roles and the
 * shared sanitizers in this one script (one <script> tag, one test loader entry).
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const PROTOCOL = 1;
  const HERO = 'hero';
  const HAND_GAP_MS = 4000;
  const HELLO_MS = 10000;
  const ABSENT_ACT_MS = 600;
  const MAX_SPECTATORS = 8;
  const MAX_SEATS = 9;
  const MAX_IDS = 8;
  const MAX_MSG_PER_SEC = 20;
  const RATE_WINDOW_MS = 1000;
  const MAX_STRIKES = 50;
  const CHAT_RAW_MAX = 500;
  const CHAT_MAX = 140;
  const NAME_MAX = 12;
  const CHAT_BURST = 5;
  const CHAT_REFILL_MS = 2000;     // 5 per 10 s
  const EMOTE_GAP_MS = 2000;
  const TIMEOUTS_TO_SIT_OUT = 2;
  const JOIN_TIMEOUT_MS = 15000;
  const TOKEN_RE = /^[0-9a-f]{32}$/;
  const AVATAR_RE = /^[a-z0-9-]{1,24}$/;
  const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
  const ENGINE_EVENTS = ['handStart', 'blinds', 'deal', 'turn', 'action', 'street', 'showdown', 'potAwarded', 'handEnd'];

  const EMOTES = Object.freeze(['nh', 'gg', 'wow', 'lol', 'ouch', 'think', 'fire', 'ty']);
  const EMOTE_LABELS = Object.freeze({
    nh: 'nice hand', gg: 'gg', wow: 'wow', lol: 'lol', ouch: 'ouch', think: 'hmm...', fire: 'on fire', ty: 'ty',
  });

  const OPTIONS = Object.freeze({
    cashStacks: Object.freeze([500, 1000, 2000, 5000]),
    cashBlinds: Object.freeze([[5, 10], [10, 20], [25, 50], [50, 100]].map((b) => Object.freeze(b))),
    sngStacks: Object.freeze([1000, 1500, 3000, 5000]),
    sngPresets: Object.freeze(['turbo', 'regular', 'slow']),
    turnSeconds: Object.freeze([0, 15, 30, 60]),
  });

  const DEFAULT_SETTINGS = Object.freeze({
    mode: 'cash', maxSeats: 6, startingStack: 1000, sb: 10, bb: 20, sngPreset: 'regular', antes: false,
    turnSeconds: 30, coachAllowed: true, disconnectPolicy: 'autofold', rebuys: true, locked: false,
  });

  /* ------------------------------------------------------------ utilities */

  const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
  const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿]/g;
  const NAME_DROP_RE = /[^\p{L}\p{N} ._!?'-]/gu;

  function cleanText(raw) {
    return String(raw).replace(CONTROL_RE, ' ').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  }

  const capChars = (s, n) => Array.from(s).slice(0, n).join('');

  function sanitizeName(raw, taken) {
    const base = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    let name = capChars(cleanText(base).replace(NAME_DROP_RE, '').replace(/\s+/g, ' ').trim(), NAME_MAX).trim();
    if (!name) name = 'player';
    return Array.isArray(taken) ? uniqueName(name, taken) : name;
  }

  function uniqueName(name, taken) {
    const used = new Set((taken || []).map((n) => String(n).toLowerCase()));
    if (!used.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = ' ' + n;
      const candidate = capChars(name, NAME_MAX - suffix.length).trim() + suffix;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  function sanitizeChat(raw) {
    if (typeof raw !== 'string') return '';
    return capChars(cleanText(raw), CHAT_MAX).trim();
  }

  function cleanAvatar(raw) {
    return typeof raw === 'string' && AVATAR_RE.test(raw) ? raw : 'a0';
  }

  function clampInt(v, lo, hi, def) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  }

  function sngLevelOne(startingStack, preset, antes) {
    if (PP.Tournament && typeof PP.Tournament.levels === 'function') {
      const lv = PP.Tournament.levels({ startingStack, preset, antes })[0];
      if (lv) return { sb: lv.sb, bb: lv.bb };
    }
    const sb = Math.max(1, Math.round((10 * startingStack) / 1500));
    return { sb, bb: 2 * sb };
  }

  /**
   * Clamps settings to the option lists. `opts.customStacks` (host code only, never from the wire)
   * also accepts any whole starting stack in [20, 1e6], e.g. a fast offline practice SNG.
   */
  function sanitizeSettings(input, opts) {
    const s = input && typeof input === 'object' ? input : {};
    const mode = s.mode === 'sng' ? 'sng' : 'cash';
    const stacks = mode === 'sng' ? OPTIONS.sngStacks : OPTIONS.cashStacks;
    const n = Math.floor(Number(s.startingStack));
    const custom = !!(opts && opts.customStacks) && Number.isFinite(n) && n >= 20 && n <= 1e6;
    const startingStack = stacks.includes(n) || custom ? n : mode === 'sng' ? 1500 : 1000;
    const sngPreset = OPTIONS.sngPresets.includes(s.sngPreset) ? s.sngPreset : 'regular';
    const antes = s.antes === true;
    let blinds;
    if (mode === 'cash') {
      const pair = OPTIONS.cashBlinds.find((b) => b[0] === Number(s.sb) && b[1] === Number(s.bb));
      blinds = pair ? { sb: pair[0], bb: pair[1] } : { sb: 10, bb: 20 };
    } else {
      blinds = sngLevelOne(startingStack, sngPreset, antes);
    }
    const turn = Number(s.turnSeconds);
    return Object.freeze({
      mode, maxSeats: clampInt(s.maxSeats, 2, MAX_SEATS, 6), startingStack, sb: blinds.sb, bb: blinds.bb,
      sngPreset, antes, turnSeconds: OPTIONS.turnSeconds.includes(turn) ? turn : 30,
      coachAllowed: s.coachAllowed !== false, disconnectPolicy: s.disconnectPolicy === 'bot' ? 'bot' : 'autofold',
      rebuys: s.rebuys !== false, locked: s.locked === true,
    });
  }

  function newToken() {
    const bytes = new Uint8Array(16);
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function createEmitter(tag) {
    const map = {};
    return {
      on(name, fn) {
        if (typeof fn !== 'function') return () => {};
        (map[name] = map[name] || []).push(fn);
        return () => {
          map[name] = (map[name] || []).filter((f) => f !== fn);
        };
      },
      emit(name, payload) {
        (map[name] || []).slice().forEach((fn) => {
          try {
            fn(payload);
          } catch (err) {
            console.error('[' + tag + '] listener for "' + name + '" failed:', err);
          }
        });
      },
    };
  }

  const passive = (legal) => (legal && legal.canCheck ? { type: 'check' } : { type: 'fold' });
  const clock0 = () => (PP.Net && PP.Net.realClock) || { now: Date.now, setTimeout, clearTimeout };
  const nextTick = () => new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
  const jsonCopy = (v) => JSON.parse(JSON.stringify(v));

  function netError(code, message) {
    if (PP.Net && typeof PP.Net.netError === 'function') return PP.Net.netError(code, message);
    const err = new Error(message || code);
    err.name = 'NetError';
    err.code = code;
    return err;
  }

  function validAction(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
    if (!ACTION_TYPES.includes(a.type)) return false;
    if (a.amount === undefined) return true;
    return typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount >= 0;
  }

  /* ============================================================ HostRoom */

  class HostRoom {
    constructor(opts) {
      const o = opts || {};
      this.endpoint = o.endpoint || null;
      this.clock = o.clock || clock0();
      this.rng = typeof o.rng === 'function' ? o.rng : undefined;
      this.handGapMs = Number.isFinite(o.handGapMs) ? o.handGapMs : HAND_GAP_MS;
      this.customStacks = !!o.customStacks;
      this.settings = sanitizeSettings(o.settings || DEFAULT_SETTINGS, { customStacks: this.customStacks });
      this.seats = [this.makeSeat(HERO, 'host', sanitizeName(o.hostName), cleanAvatar(o.hostAvatar))];
      this.seats[0].conn = 'online';
      this.spectators = new Map();
      this.peers = new Map();
      this.kickedTokens = new Set();
      this.ev = createEmitter('PP.Room');
      this.phase = 'lobby';
      this.resetGame();
      this.localProvider = null;
      this.closed = false;
      this.offs = this.endpoint ? this.bindEndpoint(this.endpoint) : [];
    }

    get code() {
      return this.endpoint ? this.endpoint.code : null;
    }

    makeSeat(id, kind, name, avatar, rating) {
      return { id, kind, name, avatar, rating: kind === 'bot' ? rating : 0, conn: kind === 'bot' ? 'bot' : 'offline',
        sittingOut: false, peerId: null, token: null, timeouts: 0, place: null };
    }

    resetGame() {
      this.engine = null;
      this.engineOffs = [];
      this.bots = {};
      this.takeover = {};
      this.tournament = null;
      this.pending = null;
      this.seq = 0;
      this.evN = 0;
      this.rebuys = new Set();
      this.gap = null;
      this.results = null;
      this.runPromise = null;
    }

    bindEndpoint(ep) {
      return [
        ep.onPeerJoin((id) => this.onPeerJoin(id)),
        ep.onPeerLeave((id) => this.onPeerLeave(id)),
        ep.onPeerStatus((id, status) => this.onPeerStatus(id, status)),
        ep.onMessage((msg, id) => this.onMessage(msg, id)),
        ep.onError((err) => this.ev.emit('error', err)),
      ];
    }

    on(evt, fn) {
      return this.ev.on(evt, fn);
    }

    /* ------------------------------------------------------- lookups */

    seat(id) {
      return this.seats.find((s) => s.id === id) || null;
    }

    hostSeat() {
      return this.seat(HERO);
    }

    takenNames() {
      return this.seats.map((s) => s.name).concat(Array.from(this.spectators.values(), (s) => s.name));
    }

    freeId(prefix) {
      for (let i = 1; i <= MAX_IDS; i++) {
        if (!this.seat(prefix + i)) return prefix + i;
      }
      return null;
    }

    stackOf(id) {
      const p = this.engine ? this.engine.players.find((x) => x.id === id) : null;
      return p ? p.stack : null;
    }

    publicSeats() {
      return this.seats.map((s) => ({
        id: s.id, kind: s.kind, name: s.name, avatar: s.avatar, rating: s.rating, conn: s.conn,
        sittingOut: s.sittingOut, stack: this.stackOf(s.id), place: s.place,
      }));
    }

    lobbyState() {
      return {
        v: PROTOCOL, code: this.code, phase: this.phase, hostName: this.hostSeat().name,
        settings: { ...this.settings }, seats: this.publicSeats(),
        spectators: Array.from(this.spectators.values(), (s) => ({ name: s.name })),
      };
    }

    /* ------------------------------------------------------- sending */

    sendTo(peerId, msg) {
      return !!(this.endpoint && peerId) && this.endpoint.send(peerId, msg);
    }

    sendAll(msg) {
      if (!this.endpoint) return;
      this.peers.forEach((rec) => {
        if (rec.role) this.endpoint.send(rec.peerId, msg);
      });
    }

    broadcastLobby() {
      const room = this.lobbyState();
      this.sendAll({ v: PROTOCOL, t: 'lobby', room });
      this.ev.emit('lobby', room);
    }

    broadcastSeats() {
      const seats = this.publicSeats();
      this.sendAll({ v: PROTOCOL, t: 'seats', seats });
      this.ev.emit('seats', seats);
    }

    changed() {
      if (this.phase === 'lobby') this.broadcastLobby();
      else this.broadcastSeats();
    }

    /* ------------------------------------------------------- lobby API */

    updateSettings(patch) {
      if (this.phase !== 'lobby' || !patch || typeof patch !== 'object') return null;
      const next = sanitizeSettings({ ...this.settings, ...patch }, { customStacks: this.customStacks });
      this.settings = next.maxSeats < this.seats.length ? Object.freeze({ ...next, maxSeats: this.seats.length }) : next;
      this.broadcastLobby();
      return { ...this.settings };
    }

    addBot(rating, name) {
      if (this.phase !== 'lobby' || this.seats.length >= this.settings.maxSeats) return null;
      const id = this.freeId('b');
      if (!id) return null;
      const taken = this.takenNames();
      const raw = name != null ? sanitizeName(name) : PP.Bots.randomName(taken, this.rng);
      const seat = this.makeSeat(id, 'bot', uniqueName(sanitizeName(raw), taken), 'a0', clampInt(rating == null ? 3 : rating, 1, 5, 3));
      this.seats.push(seat);
      this.broadcastLobby();
      return id;
    }

    setBotRating(seatId, rating) {
      const seat = this.seat(seatId);
      if (this.phase !== 'lobby' || !seat || seat.kind !== 'bot') return false;
      seat.rating = clampInt(rating, 1, 5, seat.rating);
      this.broadcastLobby();
      return true;
    }

    removeSeat(seatId) {
      const seat = this.seat(seatId);
      if (!seat || seat.kind === 'host') return false;
      if (seat.kind === 'human') return this.kick(seatId, 'removed');
      if (this.phase !== 'lobby') return false;
      this.seats = this.seats.filter((s) => s !== seat);
      this.broadcastLobby();
      return true;
    }

    kick(seatId, reason) {
      const seat = this.seat(seatId);
      if (!seat || seat.kind !== 'human') return false;
      if (seat.token) this.kickedTokens.add(seat.token);
      const peerId = seat.peerId;
      this.detachSeat(seat);
      if (peerId && this.endpoint) this.endpoint.kick(peerId, reason || 'kicked');
      if (this.phase === 'lobby') this.seats = this.seats.filter((s) => s !== seat);
      this.changed();
      return true;
    }

    /** Seat loses its peer: offline + disconnect policy for a pending turn. Caller broadcasts. */
    detachSeat(seat) {
      const rec = seat.peerId ? this.peers.get(seat.peerId) : null;
      if (rec) rec.seatId = null;
      seat.peerId = null;
      seat.conn = 'offline';
      if (this.pending && this.pending.seatId === seat.id) this.resolveDisconnected(seat);
    }

    /* ------------------------------------------------------- peers */

    onPeerJoin(peerId) {
      const now = this.clock.now();
      const rec = { peerId, seatId: null, role: null, helloed: false, strikes: 0, kicked: false,
        winStart: now, winCount: 0, chatTokens: CHAT_BURST, chatAt: now, emoteAt: -Infinity, helloTimer: null };
      rec.helloTimer = this.clock.setTimeout(() => {
        if (!rec.helloed && this.peers.get(peerId) === rec) this.endpoint.kick(peerId, 'no-hello');
      }, HELLO_MS);
      this.peers.set(peerId, rec);
    }

    onPeerLeave(peerId) {
      const rec = this.peers.get(peerId);
      if (!rec) return;
      this.peers.delete(peerId);
      this.clock.clearTimeout(rec.helloTimer);
      if (rec.role === 'spectator') {
        this.spectators.delete(peerId);
        this.changed();
        return;
      }
      const seat = rec.seatId ? this.seat(rec.seatId) : null;
      if (seat && seat.peerId === peerId) {
        this.detachSeat(seat);
        this.changed();
      }
    }

    onPeerStatus(peerId, status) {
      const rec = this.peers.get(peerId);
      const seat = rec && rec.seatId ? this.seat(rec.seatId) : null;
      if (!seat || seat.peerId !== peerId || seat.conn === status) return;
      seat.conn = status === 'away' ? 'away' : 'online';
      this.changed();
    }

    strike(rec) {
      rec.strikes += 1;
      if (rec.strikes >= MAX_STRIKES && !rec.kicked && this.endpoint) {
        rec.kicked = true;
        this.endpoint.kick(rec.peerId, 'spam');
      }
    }

    rateOk(rec) {
      const now = this.clock.now();
      if (now - rec.winStart >= RATE_WINDOW_MS) {
        rec.winStart = now;
        rec.winCount = 0;
      }
      rec.winCount += 1;
      if (rec.winCount <= MAX_MSG_PER_SEC) return true;
      this.strike(rec);
      return false;
    }

    /** A well-formed answer to the sender's own pending turn is game-paced (one per turn): never throttled. */
    isTurnAnswer(msg, rec) {
      const p = this.pending;
      return msg.t === 'action' && !!p && !!rec.seatId && p.seatId === rec.seatId && msg.seq === p.seq;
    }

    onMessage(msg, peerId) {
      const rec = this.peers.get(peerId);
      if (!rec || this.closed) return;
      if (!this.isTurnAnswer(msg, rec) && !this.rateOk(rec)) return;
      const handler = Object.prototype.hasOwnProperty.call(HANDLERS, msg.t) ? HANDLERS[msg.t] : null;
      if (!handler || (!rec.helloed && msg.t !== 'hello')) {
        this.strike(rec);
        return;
      }
      try {
        handler.call(this, msg, rec);
      } catch (err) {
        console.error('[PP.Room] handler "' + msg.t + '" failed:', err);
        this.strike(rec);
      }
    }

    rejectPeer(rec, code, message) {
      rec.helloed = true;
      this.clock.clearTimeout(rec.helloTimer);
      this.sendTo(rec.peerId, { v: PROTOCOL, t: 'reject', code, message });
      if (this.endpoint) this.endpoint.kick(rec.peerId, code);
    }

    welcome(rec) {
      const seat = rec.seatId ? this.seat(rec.seatId) : null;
      this.sendTo(rec.peerId, {
        v: PROTOCOL, t: 'welcome',
        you: { seatId: rec.seatId, role: rec.role, token: seat ? seat.token : null },
        room: this.lobbyState(),
      });
      if (this.phase === 'playing' && this.engine) this.sendGameState(rec);
      else if (this.phase === 'ended' && this.results) this.sendTo(rec.peerId, { v: PROTOCOL, t: 'end', results: this.results });
    }

    sendGameState(rec) {
      const seatId = rec.role === 'player' ? rec.seatId : null;
      this.sendTo(rec.peerId, { v: PROTOCOL, t: 'start', table: this.tableInit(seatId) });
      const tourney = this.tournament ? this.tournament.state() : null;
      if (tourney) this.sendTo(rec.peerId, { v: PROTOCOL, t: 'tourney', state: tourney });
      this.sendTo(rec.peerId, {
        v: PROTOCOL, t: 'sync', view: this.engine.publicView(seatId), seats: this.publicSeats(),
        tourney, pendingAct: this.pendingActFor(seatId),
      });
    }

    acceptHello(msg, rec) {
      const token = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? msg.token : null;
      if (token && this.kickedTokens.has(token)) return this.rejectPeer(rec, 'kicked', 'you were removed from this table.');
      rec.helloed = true;
      this.clock.clearTimeout(rec.helloTimer);
      const seat = token ? this.seats.find((s) => s.kind === 'human' && s.token === token) : null;
      if (seat) return this.reclaimSeat(seat, rec);
      const name = sanitizeName(msg.name, this.takenNames());
      const avatar = cleanAvatar(msg.avatar);
      const s = this.settings;
      if (this.phase === 'lobby' && !s.locked && this.seats.length < s.maxSeats && this.freeId('h')) {
        return this.newSeat(rec, name, avatar);
      }
      if (s.locked) return this.rejectPeer(rec, 'locked', 'the host locked this table.');
      if (this.spectators.size >= MAX_SPECTATORS) return this.rejectPeer(rec, 'room-full', 'this table is full.');
      return this.addSpectator(rec, name, avatar);
    }

    newSeat(rec, name, avatar) {
      const seat = this.makeSeat(this.freeId('h'), 'human', name, avatar);
      seat.conn = 'online';
      seat.peerId = rec.peerId;
      seat.token = newToken();
      this.seats.push(seat);
      rec.seatId = seat.id;
      rec.role = 'player';
      this.welcome(rec);
      this.changed();
    }

    reclaimSeat(seat, rec) {
      const old = seat.peerId;
      if (old && old !== rec.peerId) {
        const oldRec = this.peers.get(old);
        if (oldRec) oldRec.seatId = null;
        if (this.endpoint) this.endpoint.kick(old, 'replaced');
      }
      seat.peerId = rec.peerId;
      seat.conn = 'online';
      seat.sittingOut = false;
      seat.timeouts = 0;
      rec.seatId = seat.id;
      rec.role = 'player';
      this.welcome(rec);
      this.changed();
    }

    addSpectator(rec, name, avatar) {
      this.spectators.set(rec.peerId, { name, avatar });
      rec.role = 'spectator';
      this.welcome(rec);
      this.changed();
    }

    fromOf(rec) {
      const seat = rec.seatId ? this.seat(rec.seatId) : null;
      if (seat) return { seatId: seat.id, name: seat.name };
      const spec = this.spectators.get(rec.peerId);
      return { seatId: null, name: spec ? spec.name : 'spectator' };
    }

    takeChatToken(rec) {
      const now = this.clock.now();
      rec.chatTokens = Math.min(CHAT_BURST, rec.chatTokens + (now - rec.chatAt) / CHAT_REFILL_MS);
      rec.chatAt = now;
      if (rec.chatTokens < 1) return false;
      rec.chatTokens -= 1;
      return true;
    }

    /* ------------------------------------------------------- chat API */

    deliverChat(from, text) {
      const ts = this.clock.now();
      this.sendAll({ v: PROTOCOL, t: 'chat', from, text, ts });
      this.ev.emit('chat', { from, text, ts });
    }

    deliverEmote(from, id) {
      this.sendAll({ v: PROTOCOL, t: 'emote', from, id });
      this.ev.emit('emote', { from, id });
    }

    sendChat(text) {
      const clean = sanitizeChat(typeof text === 'string' ? text.slice(0, CHAT_RAW_MAX) : '');
      if (!clean) return false;
      this.deliverChat({ seatId: HERO, name: this.hostSeat().name }, clean);
      return true;
    }

    sendEmote(id) {
      if (!EMOTES.includes(id)) return false;
      this.deliverEmote({ seatId: HERO, name: this.hostSeat().name }, id);
      return true;
    }

    /* ------------------------------------------------------- seat state */

    setSittingOut(seatId, on) {
      const seat = this.seat(seatId);
      if (!seat || seat.kind === 'bot') return false;
      if (seat.sittingOut === !!on) return true;   // no-op: never re-broadcast (cheap spam amplifier)
      seat.sittingOut = !!on;
      if (!on) seat.timeouts = 0;
      const p = this.pending;
      if (on && p && p.seatId === seatId) this.finishPending(p, passive(p.legal), 'sitout');
      this.changed();
      return true;
    }

    requestRebuy(seatId) {
      const id = seatId || HERO;
      const ok = this.phase === 'playing' && this.settings.mode === 'cash' && this.settings.rebuys
        && !!this.seat(id) && this.stackOf(id) === 0;
      if (ok) this.rebuys.add(id);
      return ok;
    }

    setLocalActionProvider(fn) {
      this.localProvider = typeof fn === 'function' ? fn : null;
    }

    /* ------------------------------------------------------- game start */

    start() {
      if (this.phase !== 'lobby') throw new Error('Room is not in the lobby');
      if (this.seats.length < 2) throw new Error('Need at least 2 seats to start');
      const s = this.settings;
      this.resetGame();
      this.seats = PP.Cards.shuffle(this.seats, this.rng);
      this.seats.forEach((seat) => {
        seat.place = null;
        seat.timeouts = 0;
        seat.sittingOut = false;
      });
      this.buildEngine(s);
      this.phase = 'playing';
      this.peers.forEach((rec) => {
        if (rec.role) this.sendGameState(rec);
      });
      this.ev.emit('lobby', this.lobbyState());
      if (this.tournament) this.ev.emit('tourney', this.tournament.state());
      return this.tableSpec();
    }

    buildEngine(s) {
      const players = this.seats.map((seat) => ({
        id: seat.id, name: seat.name, stack: s.startingStack, isHuman: seat.kind !== 'bot',
      }));
      let blinds = { sb: s.sb, bb: s.bb, ante: 0 };
      if (s.mode === 'sng' && PP.Tournament) {
        this.tournament = PP.Tournament.create({
          players: players.map((p) => ({ id: p.id, name: p.name })),
          startingStack: s.startingStack, preset: s.sngPreset, antes: s.antes,
        });
        const lv = PP.Tournament.levels({ startingStack: s.startingStack, preset: s.sngPreset, antes: s.antes })[0];
        if (lv) blinds = { sb: lv.sb, bb: lv.bb, ante: lv.ante || 0 };
      }
      this.engine = new PP.Engine({
        players, smallBlind: blinds.sb, bigBlind: blinds.bb, ante: blinds.ante, rng: this.rng, endWhenHumanBusts: false,
      });
      const engine = this.engine;
      // A hand still finishing on an engine from an ended game must never touch the new game's turn state.
      engine.actionProvider = (player, view, legal) => (this.engine === engine ? this.provide(player, view, legal) : passive(legal));
      this.seats.filter((seat) => seat.kind === 'bot').forEach((seat) => {
        this.bots[seat.id] = PP.Bots.create({ rating: seat.rating, id: seat.id, name: seat.name, rng: this.rng });
      });
      this.engineOffs = ENGINE_EVENTS.map((name) => this.engine.on(name, (payload) => this.broadcastEvent(name, payload)));
    }

    meta() {
      const out = {};
      this.seats.forEach((seat) => {
        const bot = this.bots[seat.id];
        out[seat.id] = {
          rating: seat.rating, title: bot ? bot.title : seat.kind === 'host' ? 'host' : 'player',
          style: bot ? bot.style : '', kind: seat.kind, avatar: seat.avatar,
        };
      });
      return out;
    }

    tableInit(seatId) {
      const e = this.engine;
      return {
        mode: this.settings.mode, players: e.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, stack: p.stack })),
        meta: this.meta(), sb: e.smallBlind, bb: e.bigBlind, ante: e.ante,
        coachAllowed: this.settings.coachAllowed, turnSeconds: this.settings.turnSeconds, yourSeatId: seatId || null,
      };
    }

    tableSpec() {
      const e = this.engine;
      const names = {};
      e.players.forEach((p) => {
        names[p.id] = p.name;
      });
      return {
        engine: e, heroId: HERO, players: e.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, stack: p.stack })),
        meta: this.meta(), names, sb: e.smallBlind, bb: e.bigBlind, bots: { ...this.bots }, isHost: true, room: this,
        coachAllowed: this.settings.coachAllowed, mode: this.settings.mode,
      };
    }

    /* ------------------------------------------------------- broadcasts */

    broadcastEvent(name, payload) {
      if (!this.endpoint || !this.engine) return;
      this.evN += 1;
      const n = this.evN;
      this.peers.forEach((rec) => {
        if (!rec.role) return;
        const rid = rec.role === 'player' ? rec.seatId : null;
        const body = name === 'handEnd' ? sanitizeHandEnd(payload, rid) : name === 'deal' ? {} : payload;
        this.endpoint.send(rec.peerId, { v: PROTOCOL, t: 'ev', n, name, payload: body, view: this.engine.publicView(rid) });
      });
    }

    broadcastTourney() {
      const state = this.tournament.state();
      this.sendAll({ v: PROTOCOL, t: 'tourney', state });
      this.ev.emit('tourney', state);
    }

    /* ------------------------------------------------------- actions */

    async provide(player, view, legal) {
      try {
        const seat = this.seat(player.id);
        if (!seat || this.phase !== 'playing') return passive(legal);
        if (seat.kind === 'bot') return await this.botAction(seat, player, view, legal);
        const absent = seat.sittingOut || (seat.kind === 'human' && seat.conn === 'offline');
        if (absent) return await this.absentAction(seat, player, view, legal);
        return await this.humanTurn(seat, player, view, legal);
      } catch (err) {
        console.error('[PP.Room] action provider failed:', err);
        return passive(legal);
      }
    }

    async botAction(seat, player, view, legal) {
      if (this.localProvider) {
        try {
          return (await this.localProvider(player, view, legal)) || passive(legal);
        } catch (err) {
          return passive(legal);
        }
      }
      return decideWith(this.bots[seat.id], player, view, legal);
    }

    async absentAction(seat, player, view, legal) {
      if (this.settings.disconnectPolicy === 'bot') return decideWith(this.takeoverBot(seat), player, view, legal);
      await new Promise((resolve) => this.clock.setTimeout(resolve, ABSENT_ACT_MS));
      return passive(legal);
    }

    takeoverBot(seat) {
      if (!this.takeover[seat.id]) {
        this.takeover[seat.id] = PP.Bots.create({ rating: 3, id: seat.id, name: seat.name, rng: this.rng });
      }
      return this.takeover[seat.id];
    }

    humanTurn(seat, player, view, legal) {
      const timeMs = this.settings.turnSeconds * 1000;
      return new Promise((resolve) => {
        const p = { seq: ++this.seq, seatId: seat.id, player, view, legal, timeMs,
          startedAt: this.clock.now(), resolve, timer: null };
        this.pending = p;
        if (timeMs > 0) p.timer = this.clock.setTimeout(() => this.onTurnTimeout(p), timeMs);
        if (seat.kind === 'host') this.askLocal(p);
        else this.sendAct(seat, p);
        if (timeMs > 0 && this.pending === p) {
          this.sendAll({ v: PROTOCOL, t: 'timer', playerId: seat.id, ms: timeMs });
          this.ev.emit('timer', { playerId: seat.id, ms: timeMs });
        }
      });
    }

    askLocal(p) {
      if (!this.localProvider) {
        this.finishPending(p, passive(p.legal));
        return;
      }
      Promise.resolve()
        .then(() => this.localProvider(p.player, p.view, p.legal))
        .then((a) => this.finishPending(p, a || passive(p.legal)), () => this.finishPending(p, passive(p.legal)));
    }

    sendAct(seat, p) {
      const me = (p.view.players || []).find((x) => x.id === seat.id) || null;
      this.sendTo(seat.peerId, { v: PROTOCOL, t: 'act', seq: p.seq, player: me, view: p.view, legal: p.legal, timeMs: p.timeMs });
    }

    pendingActFor(seatId) {
      const p = this.pending;
      if (!p || !seatId || p.seatId !== seatId) return null;
      const remaining = p.timeMs > 0 ? Math.max(0, p.timeMs - (this.clock.now() - p.startedAt)) : 0;
      const view = this.engine.publicView(seatId);
      const me = view.players.find((x) => x.id === seatId) || null;
      return { seq: p.seq, player: me, view, legal: p.legal, timeMs: remaining };
    }

    finishPending(p, action, reason) {
      if (this.pending !== p) return;
      this.pending = null;
      if (p.timer != null) this.clock.clearTimeout(p.timer);
      if (reason) {
        const seat = this.seat(p.seatId);
        if (seat && seat.peerId) this.sendTo(seat.peerId, { v: PROTOCOL, t: 'actCancel', seq: p.seq, reason });
        this.ev.emit('turnCancelled', { playerId: p.seatId, reason });
      }
      p.resolve(action);
    }

    onTurnTimeout(p) {
      if (this.pending !== p) return;
      const seat = this.seat(p.seatId);
      if (seat && seat.kind === 'human') {
        seat.timeouts += 1;
        if (seat.timeouts >= TIMEOUTS_TO_SIT_OUT && !seat.sittingOut) {
          seat.sittingOut = true;
          this.broadcastSeats();
        }
      }
      this.finishPending(p, passive(p.legal), 'timeout');
    }

    resolveDisconnected(seat) {
      const p = this.pending;
      const action = this.settings.disconnectPolicy === 'bot'
        ? decideWith(this.takeoverBot(seat), p.player, p.view, p.legal)
        : passive(p.legal);
      this.finishPending(p, action, 'disconnect');
    }

    /* ------------------------------------------------------- hand loop */

    run() {
      if (!this.engine || this.phase === 'lobby') return Promise.reject(new Error('Call start() before run()'));
      if (!this.runPromise) this.runPromise = this.loop();
      return this.runPromise;
    }

    async loop() {
      const engine = this.engine;
      const live = () => this.phase === 'playing' && this.engine === engine;
      while (live()) {
        this.beforeHand();
        if (this.withChips() < 2) break;
        let record = null;
        try {
          record = await engine.playHand();
        } catch (err) {
          console.error('[PP.Room] hand failed:', err);
        }
        if (!record || !live()) break;
        this.afterHand(record);
        if (this.isOver()) break;
        await this.handGap();
      }
      if (live()) return this.finish('complete');
      return this.engine === engine ? this.results : null;
    }

    withChips() {
      return this.engine.players.filter((p) => p.stack > 0).length;
    }

    beforeHand() {
      if (this.tournament) {
        const r = this.tournament.beforeHand(this.engine);
        if (r && r.changed) this.broadcastTourney();
      }
      let applied = 0;
      this.rebuys.forEach((id) => {
        if (this.stackOf(id) === 0 && this.engine.addChips(id, this.settings.startingStack)) applied += 1;
      });
      this.rebuys.clear();
      if (applied) this.broadcastSeats();
    }

    afterHand(record) {
      if (this.tournament) {
        const res = this.tournament.afterHand(this.engine, record) || { eliminated: [] };
        (res.eliminated || []).forEach((e) => {
          const seat = this.seat(e.id);
          if (seat) seat.place = e.place;
          this.ev.emit('eliminated', { ...e });
        });
        this.broadcastTourney();
      }
      this.broadcastSeats();
    }

    isOver() {
      if (this.tournament) return this.tournament.isComplete();
      const cashWithRebuys = this.settings.mode === 'cash' && this.settings.rebuys;
      return this.withChips() <= 1 && !cashWithRebuys;
    }

    handGap() {
      const ms = this.handGapMs;
      this.ev.emit('handGap', { ms });
      if (ms <= 0) return nextTick();
      return new Promise((resolve) => {
        this.gap = { resolve, timer: this.clock.setTimeout(() => this.dealNow(), ms) };
      });
    }

    dealNow() {
      const g = this.gap;
      if (!g) return false;
      this.gap = null;
      this.clock.clearTimeout(g.timer);
      g.resolve();
      return true;
    }

    buildResults(reason) {
      const mode = this.settings.mode;
      let standings;
      if (this.tournament) {
        standings = this.tournament.results().map((r) => ({
          id: r.id, name: r.name, place: r.place, stack: r.stack, points: r.points == null ? null : r.points,
        }));
      } else {
        standings = this.engine.players
          .map((p) => ({ id: p.id, name: p.name, stack: p.stack + (this.engine.inHand ? p.totalBet : 0) }))
          .sort((a, b) => b.stack - a.stack)
          .map((p, i) => ({ ...p, place: i + 1, points: null }));
      }
      return { reason, mode, standings };
    }

    finish(reason) {
      if (this.phase !== 'playing') return this.results;
      this.results = this.buildResults(reason);
      this.phase = 'ended';
      this.results.standings.forEach((st) => {
        const seat = this.seat(st.id);
        if (seat) seat.place = st.place;
      });
      if (this.pending) this.finishPending(this.pending, passive(this.pending.legal));
      this.dealNow();
      this.engineOffs.forEach((off) => off());
      this.engineOffs = [];
      this.sendAll({ v: PROTOCOL, t: 'end', results: this.results });
      this.ev.emit('end', this.results);
      return this.results;
    }

    endGame() {
      return this.finish('host-ended');
    }

    backToLobby() {
      if (this.phase !== 'ended') return false;
      this.resetGame();
      this.phase = 'lobby';
      this.seats.forEach((seat) => {
        seat.place = null;
        seat.sittingOut = false;
        seat.timeouts = 0;
      });
      this.broadcastLobby();
      return true;
    }

    close() {
      if (this.closed) return;
      if (this.phase === 'playing') this.finish('host-ended');
      this.sendAll({ v: PROTOCOL, t: 'closed', reason: 'host-ended' });
      this.closed = true;
      this.peers.forEach((rec) => this.clock.clearTimeout(rec.helloTimer));
      this.offs.forEach((off) => off());
      this.offs = [];
      if (this.endpoint) this.endpoint.close();
    }
  }

  /* --------------------------------------------------- inbound handlers */

  const HANDLERS = {
    hello(msg, rec) {
      if (rec.helloed) {
        const seat = rec.seatId ? this.seat(rec.seatId) : null;
        if (seat && typeof msg.token === 'string' && msg.token === seat.token) this.welcome(rec);
        else this.strike(rec);
        return;
      }
      if (msg.v !== PROTOCOL) {
        this.rejectPeer(rec, 'version-mismatch', 'you and the host are on different versions. both refresh.');
        return;
      }
      this.acceptHello(msg, rec);
    },

    action(msg, rec) {
      const p = this.pending;
      const ok = p && rec.seatId && p.seatId === rec.seatId && Number.isInteger(msg.seq) && msg.seq === p.seq
        && validAction(msg.action);
      if (!ok) {
        this.strike(rec);
        return;
      }
      const seat = this.seat(rec.seatId);
      if (seat) seat.timeouts = 0;
      const a = msg.action;
      this.finishPending(p, a.amount === undefined ? { type: a.type } : { type: a.type, amount: a.amount });
    },

    chat(msg, rec) {
      if (!rec.role) return;   // left the room on this connection: no voice
      if (typeof msg.text !== 'string' || msg.text.length > CHAT_RAW_MAX) {
        this.strike(rec);
        return;
      }
      const text = sanitizeChat(msg.text);
      if (!text || !this.takeChatToken(rec)) return;
      this.deliverChat(this.fromOf(rec), text);
    },

    emote(msg, rec) {
      if (!rec.role) return;
      if (!EMOTES.includes(msg.id)) {
        this.strike(rec);
        return;
      }
      const now = this.clock.now();
      if (now - rec.emoteAt < EMOTE_GAP_MS) return;
      rec.emoteAt = now;
      this.deliverEmote(this.fromOf(rec), msg.id);
    },

    sitOut(msg, rec) {
      if (typeof msg.on !== 'boolean' || !rec.seatId) {
        this.strike(rec);
        return;
      }
      this.setSittingOut(rec.seatId, msg.on);
    },

    rebuy(msg, rec) {
      if (!rec.seatId || !this.requestRebuy(rec.seatId)) this.strike(rec);
    },

    leave(msg, rec) {
      if (rec.role === 'spectator') {
        this.spectators.delete(rec.peerId);
        rec.role = null;
        this.changed();
        return;
      }
      const seat = rec.seatId ? this.seat(rec.seatId) : null;
      if (!seat || seat.peerId !== rec.peerId) return;
      this.detachSeat(seat);
      rec.role = null;
      if (this.phase === 'lobby') this.seats = this.seats.filter((s) => s !== seat);
      this.changed();
    },
  };

  function decideWith(bot, player, view, legal) {
    if (!bot) return passive(legal);
    try {
      const me = (view.players || []).find((p) => p.id === player.id) || player;
      return bot.decide(view, legal, me) || passive(legal);
    } catch (err) {
      return passive(legal);
    }
  }

  /** handEnd for one recipient: hide every unrevealed hole that is not theirs. */
  function sanitizeHandEnd(payload, recipientId) {
    const record = jsonCopy((payload && payload.record) || {});
    const revealed = new Set((record.reveals || []).map((r) => r.playerId));
    (record.players || []).forEach((p) => {
      if (p.id !== recipientId && !revealed.has(p.id)) p.hole = [];
    });
    return { record };
  }

  /* ============================================================ ClientRoom */

  class ClientRoom {
    constructor(endpoint, opts) {
      const o = opts || {};
      this.endpoint = endpoint;
      this.clock = o.clock || clock0();
      this.name = typeof o.name === 'string' ? o.name : 'player';
      this.avatar = cleanAvatar(o.avatar);
      this.token = typeof o.token === 'string' && TOKEN_RE.test(o.token) ? o.token : null;
      this.selfId = null;
      this.role = null;
      this.lobby = null;
      this.engine = null;
      this.table = null;
      this.tourney = null;
      this.results = null;
      this.closed = false;
      this.joinWait = null;
      this.seenEliminated = new Set();
      this.ev = createEmitter('PP.ClientRoom');
      this.offs = [
        endpoint.onMessage((msg) => this.onMessage(msg)),
        endpoint.onStatus((s) => this.onStatus(s)),
        endpoint.onError((err) => this.ev.emit('error', err)),
      ];
    }

    get code() {
      return this.endpoint.code;
    }

    on(evt, fn) {
      return this.ev.on(evt, fn);
    }

    send(msg) {
      return !this.closed && this.endpoint.send({ v: PROTOCOL, ...msg });
    }

    hello() {
      const msg = { t: 'hello', name: this.name, avatar: this.avatar };
      if (this.token) msg.token = this.token;
      return this.send(msg);
    }

    handshake(timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = this.clock.setTimeout(() => fail(netError('timeout')), timeoutMs);
        const fail = (err) => {
          this.clock.clearTimeout(timer);
          this.joinWait = null;
          reject(err);
        };
        this.joinWait = {
          resolve: () => {
            this.clock.clearTimeout(timer);
            this.joinWait = null;
            resolve(this);
          },
          reject: fail,
        };
        this.hello();
      });
    }

    /* ---------------------------------------------------- alias helpers */

    alias(v) {
      return PP.RemoteEngine.aliasDeep(v, this.selfId);
    }

    aliasSeats(seats) {
      const mine = !!this.selfId;
      return (Array.isArray(seats) ? seats : []).map((s) => ({ ...this.alias(s), isYou: mine && this.alias(s).id === HERO }));
    }

    aliasLobby(room) {
      const r = room && typeof room === 'object' ? room : {};
      return { ...this.alias(r), seats: this.aliasSeats(r.seats) };
    }

    /* ---------------------------------------------------- inbound */

    onMessage(msg) {
      if (this.closed) return;
      const handler = Object.prototype.hasOwnProperty.call(CLIENT_HANDLERS, msg.t) ? CLIENT_HANDLERS[msg.t] : null;
      if (!handler) return;
      try {
        handler.call(this, msg);
      } catch (err) {
        console.error('[PP.ClientRoom] handler "' + msg.t + '" failed:', err);
      }
    }

    onStatus(status) {
      if (status === 'open' && !this.closed) this.hello();
      this.ev.emit('status', status);
      if (status === 'closed' && !this.closed) {
        this.closed = true;
        if (this.engine) this.engine.dispose();
        this.ev.emit('closed', { reason: 'host-left' });
      }
    }

    startTable(table) {
      if (!table || typeof table !== 'object') return;
      if (this.engine) this.engine.dispose();
      this.table = table;
      this.results = null;
      this.engine = new PP.RemoteEngine({
        selfId: this.selfId, clock: this.clock, mode: table.mode, players: table.players,
        send: (m) => this.endpoint.send(m),
        onTurnCancelled: (info) => this.ev.emit('turnCancelled', { playerId: HERO, reason: info.reason }),
      });
      this.ev.emit('start', this.tableSpec());
    }

    tableSpec() {
      const t = this.table;
      if (!t || !this.engine) return null;
      const players = this.alias(t.players || []);
      const names = {};
      players.forEach((p) => {
        names[p.id] = p.name;
      });
      return {
        engine: this.engine, heroId: this.selfId ? HERO : null, players,
        meta: PP.RemoteEngine.aliasKeys(t.meta || {}, this.selfId), names, sb: t.sb, bb: t.bb, bots: {},
        isHost: false, room: this, coachAllowed: t.coachAllowed !== false, mode: t.mode,
      };
    }

    noteTourney(state) {
      this.tourney = this.alias(state || {});
      this.ev.emit('tourney', this.tourney);
      (this.tourney.eliminated || []).forEach((e) => {
        if (this.seenEliminated.has(e.id)) return;
        this.seenEliminated.add(e.id);
        this.ev.emit('eliminated', e);
      });
    }

    /* ---------------------------------------------------- outbound */

    sendChat(text) {
      return typeof text === 'string' && this.send({ t: 'chat', text: text.slice(0, CHAT_RAW_MAX) });
    }

    sendEmote(id) {
      return EMOTES.includes(id) && this.send({ t: 'emote', id });
    }

    setSittingOut(on) {
      return this.send({ t: 'sitOut', on: !!on });
    }

    requestRebuy() {
      return this.send({ t: 'rebuy' });
    }

    leave() {
      this.send({ t: 'leave' });
      this.close();
      return Promise.resolve();
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.engine) this.engine.dispose();
      this.endpoint.close();
    }
  }

  const CLIENT_HANDLERS = {
    welcome(msg) {
      const you = msg.you && typeof msg.you === 'object' ? msg.you : {};
      this.selfId = typeof you.seatId === 'string' ? you.seatId : null;
      this.role = you.role === 'player' ? 'player' : 'spectator';
      if (typeof you.token === 'string' && TOKEN_RE.test(you.token)) this.token = you.token;
      this.lobby = this.aliasLobby(msg.room);
      if (this.joinWait) this.joinWait.resolve();
      this.ev.emit('welcome', { selfId: this.selfId, role: this.role, token: this.token, room: this.lobby });
    },
    reject(msg) {
      const err = netError(typeof msg.code === 'string' ? msg.code : 'closed', typeof msg.message === 'string' ? msg.message : '');
      this.close();
      if (this.joinWait) this.joinWait.reject(err);
      else this.ev.emit('error', err);
    },
    lobby(msg) {
      this.lobby = this.aliasLobby(msg.room);
      this.ev.emit('lobby', this.lobby);
    },
    start(msg) {
      this.startTable(msg.table);
    },
    ev(msg) {
      if (this.engine) this.engine.receive(msg);
    },
    act(msg) {
      if (this.engine) this.engine.receive(msg);
    },
    actCancel(msg) {
      if (this.engine) this.engine.receive(msg);
    },
    sync(msg) {
      if (msg.tourney) this.noteTourney(msg.tourney);
      if (Array.isArray(msg.seats)) this.ev.emit('seats', this.aliasSeats(msg.seats));
      if (this.engine) this.engine.receive(msg);
    },
    seats(msg) {
      this.ev.emit('seats', this.aliasSeats(msg.seats));
    },
    chat(msg) {
      this.ev.emit('chat', { from: this.alias(msg.from || {}), text: String(msg.text || ''), ts: msg.ts });
    },
    emote(msg) {
      if (EMOTES.includes(msg.id)) this.ev.emit('emote', { from: this.alias(msg.from || {}), id: msg.id });
    },
    tourney(msg) {
      this.noteTourney(msg.state);
    },
    timer(msg) {
      this.ev.emit('timer', { playerId: this.alias({ playerId: msg.playerId }).playerId, ms: Number(msg.ms) || 0 });
    },
    end(msg) {
      this.results = this.alias(msg.results || {});
      if (this.engine) this.engine.receive(msg);
      this.ev.emit('end', this.results);
    },
    closed(msg) {
      this.close();
      this.ev.emit('closed', { reason: msg.reason === 'host-left' ? 'host-left' : 'host-ended' });
    },
    kicked(msg) {
      this.close();
      this.ev.emit('error', netError('kicked', typeof msg.reason === 'string' ? msg.reason : 'kicked'));
      this.ev.emit('closed', { reason: 'kicked' });
    },
  };

  async function joinRoom(opts) {
    const o = opts || {};
    const endpoint = await PP.Net.join(o.code, { hub: o.hub, clock: o.clock, transport: o.transport });
    const client = new ClientRoom(endpoint, o);
    try {
      await client.handshake(Number.isFinite(o.timeoutMs) ? o.timeoutMs : JOIN_TIMEOUT_MS);
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  PP.Room = Object.freeze({
    PROTOCOL,
    HAND_GAP_MS,
    EMOTES,
    EMOTE_LABELS,
    OPTIONS,
    DEFAULT_SETTINGS,
    sanitizeName,
    sanitizeChat,
    sanitizeSettings,
    HostRoom,
    ClientRoom,
    joinRoom,
  });
})();
