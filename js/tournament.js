/*
 * PIXEL HOLD'EM — PP.Tournament
 * Single-table Sit-n-Go bookkeeping: blind levels, antes, eliminations, standings, points.
 * Pure and DOM-free (see MULTIPLAYER.md section 6). Works with a real PP.Engine offline vs bots
 * and inside a HostRoom. Points are bragging rights only — play chips, never money.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const PRESETS = Object.freeze({
    turbo: Object.freeze({ handsPerLevel: 6, label: 'turbo' }),
    regular: Object.freeze({ handsPerLevel: 10, label: 'regular' }),
    slow: Object.freeze({ handsPerLevel: 15, label: 'slow' }),
  });
  const DEFAULT_PRESET = 'regular';
  const DEFAULT_STACK = 1500;
  const BASE_SB = Object.freeze([10, 15, 25, 50, 75, 100, 150, 200, 300, 400, 500, 700,
    1000, 1500, 2000, 3000, 4000, 5000]);
  const ANTE_FROM_LEVEL = 3;
  const ANTE_FRACTION_OF_BB = 10;
  const POINTS_POOL = 100;

  const toChips = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);

  /* ------------------------------------------------------------ numbers */

  function niceRound(x) {
    const v = Number(x);
    if (!Number.isFinite(v) || v < 10) return Math.max(1, Math.round(Number.isFinite(v) ? v : 1));
    if (v < 200) return Math.round(v / 5) * 5;
    if (v < 1000) return Math.round(v / 25) * 25;
    return Math.round(v / 100) * 100;
  }

  /** Smallest nice value strictly above an already-nice value. */
  function nextNice(prev) {
    const step = prev < 10 ? 1 : prev < 200 ? 5 : prev < 1000 ? 25 : 100;
    return niceRound(prev + step);
  }

  function presetOf(name) {
    return Object.prototype.hasOwnProperty.call(PRESETS, name) ? name : DEFAULT_PRESET;
  }

  function levels(opts) {
    const o = opts || {};
    const stack = toChips(o.startingStack) || DEFAULT_STACK;
    const handsPerLevel = PRESETS[presetOf(o.preset)].handsPerLevel;
    const antes = !!o.antes;
    let prev = 0;
    return Object.freeze(BASE_SB.map((base, i) => {
      const scaled = niceRound(base * stack / DEFAULT_STACK);
      const sb = scaled > prev ? scaled : nextNice(prev);
      prev = sb;
      const bb = 2 * sb;
      const level = i + 1;
      const ante = antes && level >= ANTE_FROM_LEVEL ? Math.max(1, Math.round(bb / ANTE_FRACTION_OF_BB)) : 0;
      return Object.freeze({ level, sb, bb, ante, handsPerLevel });
    }));
  }

  function payouts(entrants) {
    const n = Math.floor(Number(entrants)) || 0;
    if (n >= 6) return Object.freeze([50, 30, 20]);
    if (n >= 4) return Object.freeze([65, 35]);
    return Object.freeze([POINTS_POOL]);
  }

  /* ------------------------------------------------------------ helpers */

  function validatePlayers(players) {
    if (!Array.isArray(players) || players.length < 2) {
      throw new Error('Tournament requires at least 2 players');
    }
    const seen = new Set();
    return players.map((p) => {
      const id = p && p.id;
      if (typeof id !== 'string' || !id || seen.has(id)) throw new Error('Tournament player ids must be unique strings');
      seen.add(id);
      return Object.freeze({ id, name: p.name != null ? String(p.name) : id });
    });
  }

  /** Engine stacks keyed by id (only tournament ids). */
  function readStacks(engine, entrants, fallback) {
    const byId = new Map((engine && Array.isArray(engine.players) ? engine.players : []).map((p) => [p.id, p]));
    return entrants.reduce((acc, e) => {
      const p = byId.get(e.id);
      return { ...acc, [e.id]: p ? toChips(p.stack) : (fallback[e.id] || 0) };
    }, {});
  }

  /**
   * Order a same-hand bust batch from lowest finisher to highest finisher:
   * smaller start-of-hand stack finishes lower; equal -> the one farther (clockwise) from the
   * button's left finishes lower.
   */
  function orderBatch(busted, record, seatCount) {
    const recPlayers = (record && Array.isArray(record.players)) ? record.players : [];
    const info = new Map(recPlayers.map((p) => [p.id, p]));
    const dealer = record && Number.isInteger(record.dealerSeat) ? record.dealerSeat : 0;
    const n = Math.max(1, seatCount);
    const startOf = (e) => toChips(info.has(e.id) ? info.get(e.id).startStack : 0);
    const distOf = (e) => {
      const seat = info.has(e.id) && Number.isInteger(info.get(e.id).seat) ? info.get(e.id).seat : e.seat;
      return (((seat - dealer - 1) % n) + n) % n;
    };
    return busted.slice().sort((a, b) => (startOf(a) - startOf(b)) || (distOf(b) - distOf(a)));
  }

  /* ------------------------------------------------------------ Sit-n-Go */

  /** One Sit-n-Go. Internal bookkeeping lives in `this.s`; every public return value is frozen. */
  class SitNGo {
    constructor(opts) {
      const o = opts || {};
      this.entrants = Object.freeze(validatePlayers(o.players));
      this.preset = presetOf(o.preset);
      this.startingStack = toChips(o.startingStack) || DEFAULT_STACK;
      this.levels = levels({ startingStack: this.startingStack, preset: this.preset, antes: !!o.antes });
      this.payouts = payouts(this.entrants.length);
      this.s = {
        handsPlayed: 0,
        appliedIndex: -1,
        stacks: this.entrants.reduce((acc, e) => ({ ...acc, [e.id]: this.startingStack }), {}),
        places: {},          // id -> place (busted players, plus the winner once complete)
        eliminated: [],      // frozen {id,name,place,points} in elimination order
        seats: {},           // id -> engine seat, learned from the engine
      };
      Object.freeze(this);
    }

    pointsFor(place) { return this.payouts[place - 1] || 0; }

    isLiving(e) { return this.s.places[e.id] == null || this.s.places[e.id] === 1; }

    indexFor(hands) {
      return Math.min(Math.floor(hands / PRESETS[this.preset].handsPerLevel), this.levels.length - 1);
    }

    sync(engine) {
      (engine && Array.isArray(engine.players) ? engine.players : []).forEach((p) => {
        if (Number.isInteger(p.seat)) this.s.seats[p.id] = p.seat;
      });
      this.s.stacks = readStacks(engine, this.entrants, this.s.stacks);
    }

    beforeHand(engine) {
      this.sync(engine);
      const idx = this.indexFor(this.s.handsPlayed);
      const lv = this.levels[idx];
      let changed = idx !== this.s.appliedIndex;
      if (changed) {
        const ok = !!engine && typeof engine.setBlinds === 'function' && engine.setBlinds(lv.sb, lv.bb, lv.ante);
        if (ok) this.s.appliedIndex = idx; else changed = false;
      }
      return Object.freeze({ level: lv.level, sb: lv.sb, bb: lv.bb, ante: lv.ante, changed });
    }

    afterHand(engine, record) {
      const s = this.s;
      this.sync(engine);
      s.handsPlayed += 1;
      const alive = this.entrants.filter((e) => s.places[e.id] == null);
      const busted = alive.filter((e) => s.stacks[e.id] <= 0);
      // Never eliminate everyone: chips are conserved, so at least one player must remain.
      const batch = busted.length >= alive.length ? [] : busted;
      const seatCount = engine && Array.isArray(engine.players) ? engine.players.length : this.entrants.length;
      const ordered = orderBatch(batch.map((e) => ({ ...e, seat: s.seats[e.id] })), record, seatCount);
      const out = ordered.map((e, i) => {
        const place = alive.length - i;
        s.places[e.id] = place;
        return Object.freeze({ id: e.id, name: e.name, place, points: this.pointsFor(place) });
      });
      s.eliminated = s.eliminated.concat(out);
      const remaining = alive.filter((e) => s.places[e.id] == null);
      if (remaining.length === 1) s.places[remaining[0].id] = 1;
      return Object.freeze({ eliminated: Object.freeze(out), complete: remaining.length <= 1 });
    }

    isComplete() { return this.entrants.filter((e) => this.isLiving(e)).length <= 1; }

    /** Alive by stack desc (ties: entry order), then busted by place. */
    standings() {
      const { stacks, places } = this.s;
      const living = this.entrants.filter((e) => this.isLiving(e))
        .map((e, i) => ({ e, i }))
        .sort((a, b) => (stacks[b.e.id] - stacks[a.e.id]) || (a.i - b.i))
        .map(({ e }) => e);
      const gone = this.entrants.filter((e) => places[e.id] > 1).sort((a, b) => places[a.id] - places[b.id]);
      return living.concat(gone).map((e) => {
        const place = places[e.id] != null ? places[e.id] : null;
        return Object.freeze({ id: e.id, name: e.name, stack: stacks[e.id] || 0, place,
          points: place != null ? this.pointsFor(place) : null });
      });
    }

    /** Level fields describe the level the next hand is (or the current hand was last scheduled) played at. */
    state() {
      const idx = this.indexFor(this.s.handsPlayed);
      const lv = this.levels[idx];
      const hpl = PRESETS[this.preset].handsPerLevel;
      const nxt = idx + 1 < this.levels.length ? this.levels[idx + 1] : null;
      return Object.freeze({
        preset: this.preset, level: lv.level, sb: lv.sb, bb: lv.bb, ante: lv.ante,
        handsPlayed: this.s.handsPlayed, handsPerLevel: hpl,
        handsToNext: nxt ? hpl - (this.s.handsPlayed % hpl) : 0,
        next: nxt ? Object.freeze({ sb: nxt.sb, bb: nxt.bb, ante: nxt.ante }) : null,
        entrants: this.entrants.length,
        alive: this.entrants.filter((e) => this.isLiving(e)).length,
        standings: Object.freeze(this.standings()),
        eliminated: Object.freeze(this.s.eliminated.slice()),
        payouts: this.payouts, complete: this.isComplete(),
      });
    }

    /** Final (or provisional, if ended early) places: busted keep theirs, the living rank by stack. */
    results() {
      const table = this.standings();
      const ranked = table.filter((r) => r.place == null || r.place === 1).map((r, i) => ({ ...r, place: i + 1 }));
      const gone = table.filter((r) => r.place != null && r.place > 1);
      return Object.freeze(ranked.concat(gone)
        .map((r) => Object.freeze({ id: r.id, name: r.name, place: r.place, stack: r.stack,
          points: this.pointsFor(r.place) }))
        .sort((a, b) => a.place - b.place));
    }
  }

  const create = (opts) => new SitNGo(opts);

  PP.Tournament = Object.freeze({
    PRESETS, BASE_SB, niceRound, levels, payouts, create,
  });
})();
