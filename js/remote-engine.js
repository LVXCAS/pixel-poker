/*
 * PIXEL HOLD'EM — PP.RemoteEngine
 * Client-side mirror of PP.Engine for net games (MULTIPLAYER.md section 3). It never deals or
 * decides anything: the host's engine is authoritative and streams per-recipient views.
 * main.js talks to it exactly like a local engine (on / publicView / getLegal / actionProvider).
 *
 * ID alias: the client's own wire seat id is swapped with 'hero' (and vice versa) on every
 * inbound payload, so main.js's HERO_ID constant keeps working unchanged.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const HERO = 'hero';
  const ID_KEYS = new Set(['id', 'playerId', 'winnerId', 'toActId', 'seatId']);
  const NO_LEGAL = Object.freeze({
    canFold: false, canCheck: false, canCall: false, callAmount: 0,
    canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, toCall: 0,
  });
  const EMPTY_VIEW = Object.freeze({
    handNumber: 0, street: 'preflop', board: [], pot: 0, pots: [], currentBet: 0, minRaiseTo: 0,
    bigBlind: 0, smallBlind: 0, dealerSeat: -1, sbSeat: -1, bbSeat: -1, toActId: null, players: [], history: [],
  });

  /* ------------------------------------------------------------- alias */

  function makeSwap(selfId) {
    if (!selfId || selfId === HERO) return (id) => id;
    return (id) => (id === selfId ? HERO : id === HERO ? selfId : id);
  }

  /** Deep-copies `value`, swapping ids under the alias keys and inside `eligible` arrays. */
  function aliasDeep(value, selfId) {
    const swap = makeSwap(selfId);
    const walk = (v, key) => {
      if (Array.isArray(v)) {
        return key === 'eligible' ? v.map((x) => (typeof x === 'string' ? swap(x) : walk(x))) : v.map((x) => walk(x));
      }
      if (v && typeof v === 'object') {
        const out = {};
        Object.keys(v).forEach((k) => {
          out[k] = walk(v[k], k);
        });
        return out;
      }
      if (typeof v === 'string' && ID_KEYS.has(key)) return swap(v);
      return v;
    };
    return walk(value, null);
  }

  /** Re-keys an object map ({[id]: x}) through the alias. */
  function aliasKeys(map, selfId) {
    const swap = makeSwap(selfId);
    const out = {};
    Object.keys(map || {}).forEach((k) => {
      out[swap(k)] = aliasDeep(map[k], selfId);
    });
    return out;
  }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      Object.keys(v).forEach((k) => deepFreeze(v[k]));
    }
    return v;
  }

  const passive = (legal) => (legal && legal.canCheck ? { type: 'check' } : { type: 'fold' });

  /* ------------------------------------------------------------- class */

  class RemoteEngine {
    constructor(opts) {
      const o = opts || {};
      this.selfId = typeof o.selfId === 'string' ? o.selfId : null;
      this.clock = o.clock || (PP.Net && PP.Net.realClock) || null;
      this.mode = o.mode || 'cash';
      this.send = typeof o.send === 'function' ? o.send : () => false;
      this.onTurnCancelled = typeof o.onTurnCancelled === 'function' ? o.onTurnCancelled : () => {};
      this.provider = null;
      this.providerWaiters = [];
      this.listeners = {};
      this.currentView = EMPTY_VIEW;
      // TableInit players (wire ids): `players` is read by main.js to build the table before any event arrives.
      this.initialPlayers = Array.isArray(o.players) ? deepFreeze(aliasDeep(o.players, this.selfId)) : [];
      this.queue = [];
      this.processing = false;
      this.pending = null;
      this.ended = false;
      this.disposed = false;
      this.inHand = false;
      this.handWaiters = [];
    }

    /**
     * Set by main.js integration. A turn that arrives before it is set (late join / rejoin: `sync`
     * can land before the table is built) waits for it instead of auto-folding; the host's turn
     * timer still bounds the wait.
     */
    get actionProvider() {
      return this.provider;
    }

    set actionProvider(fn) {
      this.provider = typeof fn === 'function' ? fn : null;
      if (!this.provider) return;
      const waiters = this.providerWaiters;
      this.providerWaiters = [];
      waiters.forEach((w) => w());
    }

    /* ---------------------------------------------------------- events */

    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      (this.listeners[name] = this.listeners[name] || []).push(fn);
      return () => {
        this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn);
      };
    }

    async emit(name, payload) {
      const fns = (this.listeners[name] || []).slice();
      for (const fn of fns) {
        try {
          await fn(payload);
        } catch (err) {
          console.error('[PP.RemoteEngine] listener for "' + name + '" failed:', err);
        }
      }
    }

    /* ------------------------------------------------------- engine API */

    publicView() {
      return this.currentView;
    }

    getLegal(id) {
      return id === HERO && this.pending ? this.pending.legal : NO_LEGAL;
    }

    get players() {
      const live = this.currentView.players || [];
      const src = live.length ? live : this.initialPlayers;
      return src.map((p) => ({ ...p, hole: p.hole ? p.hole.slice() : null }));
    }

    get handNumber() { return this.currentView.handNumber; }
    get smallBlind() { return this.currentView.smallBlind; }
    get bigBlind() { return this.currentView.bigBlind; }
    get dealerSeat() { return this.currentView.dealerSeat; }

    isGameOver() {
      if (this.ended) return true;
      if (this.mode !== 'sng' || !this.selfId) return false;
      const me = (this.currentView.players || []).find((p) => p.id === HERO);
      return !!me && me.out;
    }

    playHand() {
      if (this.ended) return Promise.resolve(null);
      return new Promise((resolve) => this.handWaiters.push(resolve));
    }

    addChips() {
      return false;
    }

    toLocalId(wireId) {
      return makeSwap(this.selfId)(wireId);
    }

    toWireId(localId) {
      return makeSwap(this.selfId)(localId);
    }

    alias(value) {
      return aliasDeep(value, this.selfId);
    }

    /* ---------------------------------------------------------- inbound */

    receive(msg) {
      if (this.disposed || !msg || typeof msg.t !== 'string') return;
      if (msg.t === 'actCancel') {
        this.cancel(msg);
        return;
      }
      if (msg.t === 'ev' || msg.t === 'act' || msg.t === 'sync' || msg.t === 'end') {
        this.queue.push(msg);
        this.drain();
      }
    }

    async drain() {
      if (this.processing) return;
      this.processing = true;
      try {
        while (this.queue.length && !this.disposed) {
          const msg = this.queue.shift();
          try {
            await this.process(msg);
          } catch (err) {
            console.error('[PP.RemoteEngine] failed to process "' + msg.t + '":', err);
          }
        }
      } finally {
        this.processing = false;
      }
    }

    process(msg) {
      switch (msg.t) {
        case 'ev': return this.processEvent(msg);
        case 'act': return this.processAct(msg);
        case 'sync': return this.processSync(msg);
        case 'end': return this.processEnd(msg);
        default: return null;
      }
    }

    setView(view) {
      if (view && typeof view === 'object') this.currentView = deepFreeze(this.alias(view));
    }

    async processEvent(msg) {
      const name = typeof msg.name === 'string' ? msg.name : '';
      if (!name) return;
      this.setView(msg.view);
      const payload = deepFreeze(this.alias(msg.payload || {}));
      if (name === 'handStart') this.inHand = true;
      if (name === 'handEnd') this.inHand = false;
      await this.emit(name, payload);
      if (name === 'handEnd') this.resolveHand(payload.record || null);
    }

    async processAct(msg) {
      const seq = msg.seq;
      this.setView(msg.view);
      const legal = Object.freeze({ ...NO_LEGAL, ...(msg.legal || {}) });
      const player = deepFreeze(this.alias(msg.player || {}));
      let cancel;
      const cancelled = new Promise((resolve) => {
        cancel = resolve;
      });
      this.pending = { seq, legal, cancel };
      let action;
      try {
        action = await Promise.race([this.ask(seq, player, legal), cancelled]);
      } catch (err) {
        action = passive(legal);
      }
      if (!this.pending || this.pending.seq !== seq || action === CANCELLED) return;
      this.pending = null;
      this.send({ v: 1, t: 'action', seq, action: cleanAction(action, legal) });
    }

    async ask(seq, player, legal) {
      if (!this.provider) await new Promise((resolve) => this.providerWaiters.push(resolve));
      if (this.disposed || !this.pending || this.pending.seq !== seq) return CANCELLED;
      return this.provider(player, this.currentView, legal);
    }

    cancel(msg) {
      const reason = msg.reason || 'timeout';
      if (this.pending && this.pending.seq === msg.seq) {
        const p = this.pending;
        this.pending = null;
        p.cancel(CANCELLED);
        try {
          this.onTurnCancelled({ reason, seq: msg.seq });
        } catch (err) {
          console.error('[PP.RemoteEngine] onTurnCancelled failed:', err);
        }
        return;
      }
      this.queue = this.queue.filter((q) => !(q.t === 'act' && q.seq === msg.seq));
    }

    async processSync(msg) {
      this.setView(msg.view);
      const street = this.currentView.street;
      this.inHand = this.currentView.handNumber > 0 && street !== 'showdown';
      await this.emit('sync', { view: this.currentView });
      if (msg.pendingAct && typeof msg.pendingAct === 'object') {
        await this.processAct({ t: 'act', ...msg.pendingAct });
      }
    }

    async processEnd(msg) {
      this.ended = true;
      const results = this.alias(msg.results || {});
      const standings = Array.isArray(results.standings) ? results.standings : [];
      const winner = standings.find((s) => s.place === 1) || standings[0] || null;
      await this.emit('gameOver', { winnerId: winner ? winner.id : null, results });
      this.resolveHand(null);
    }

    resolveHand(record) {
      const waiters = this.handWaiters;
      this.handWaiters = [];
      waiters.forEach((w) => w(record));
    }

    dispose() {
      this.disposed = true;
      this.queue = [];
      if (this.pending) {
        this.pending.cancel(CANCELLED);
        this.pending = null;
      }
      this.listeners = {};
      const waiters = this.providerWaiters;
      this.providerWaiters = [];
      waiters.forEach((w) => w());
      this.resolveHand(null);
    }
  }

  const CANCELLED = Object.freeze({ cancelled: true });
  const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];

  /** Only {type, amount?} leaves the client; anything odd becomes check/fold. */
  function cleanAction(action, legal) {
    const type = action && typeof action.type === 'string' ? action.type.toLowerCase() : '';
    if (!ACTION_TYPES.includes(type)) return passive(legal);
    const amount = Number(action.amount);
    if ((type === 'bet' || type === 'raise') && Number.isFinite(amount) && amount >= 0) {
      return { type, amount: Math.floor(amount) };
    }
    return { type };
  }

  RemoteEngine.NO_LEGAL = NO_LEGAL;
  RemoteEngine.aliasDeep = aliasDeep;
  RemoteEngine.aliasKeys = aliasKeys;
  PP.RemoteEngine = RemoteEngine;
})();
