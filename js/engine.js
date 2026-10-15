/*
 * PIXEL HOLD'EM — PP.Engine
 * Pure No-Limit Texas Hold'em state machine (no DOM). See CONTRACT.md.
 *
 * Action amounts reported in `action` events / history:
 *   fold, check     -> 0
 *   call            -> chips added by the call
 *   bet, raise      -> player's total street bet after the action ("raise to")
 *   allin           -> player's total street bet after the action
 *
 * Optional constructor extension (non-contract, for tests/replays):
 *   deckFn(handNumber) -> Card[]   ordered deck; cards are drawn from index 0.
 *   deck: Card[52]                 preset deck (52 unique cards) used for every hand instead of
 *                                  shuffling, e.g. scripted tutorial hands. deckFn wins if both given.
 *   Deal order: one card at a time, starting left of the button, two passes;
 *   then burn+3 flop, burn+1 turn, burn+1 river.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const STREET_CARDS = { flop: 3, turn: 1, river: 1 };
  const HOLE_CARDS = 2;
  const MAX_ACTIONS_PER_ROUND = 1000;
  const HEADS_UP = 2;

  const toChips = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function createPlayer(p, seat) {
    const stack = toChips(p.stack);
    return {
      id: p.id,
      name: p.name != null ? String(p.name) : String(p.id),
      seat,
      stack,
      hole: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      isHuman: !!p.isHuman,
      out: stack <= 0,
      lastAction: null,
      // internal
      inHand: false,
      acted: false,
      facedBet: 0,
    };
  }

  const NO_LEGAL = Object.freeze({
    canFold: false, canCheck: false, canCall: false, callAmount: 0,
    canBet: false, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, toCall: 0,
  });

  class Engine {
    constructor(opts) {
      const o = opts || {};
      if (!Array.isArray(o.players) || o.players.length < 2) {
        throw new Error('Engine requires at least 2 players');
      }
      this.smallBlind = Math.max(1, toChips(o.smallBlind) || 1);
      this.bigBlind = Math.max(this.smallBlind, toChips(o.bigBlind) || this.smallBlind * 2);
      this.ante = toChips(o.ante);
      this.rng = typeof o.rng === 'function' ? o.rng : null;
      this.deckFn = typeof o.deckFn === 'function' ? o.deckFn : null;
      this.presetDeck = o.deck != null ? validPresetDeck(o.deck) : null;
      this.players = o.players.map(createPlayer);
      this.actionProvider = null;
      this.listeners = {};
      this.handNumber = 0;
      this.dealerSeat = -1;
      this.sbSeat = -1;
      this.bbSeat = -1;
      this.inHand = false;
      this.resetHandState();
    }

    /* ------------------------------------------------------------ events */

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
          // A broken listener must never stall the game; report and continue.
          console.error('[PP.Engine] listener for "' + name + '" failed:', err);
        }
      }
    }

    /* ----------------------------------------------------------- helpers */

    byId(id) {
      return this.players.find((p) => p.id === id) || null;
    }

    nextSeatWhere(from, pred) {
      const n = this.players.length;
      for (let k = 1; k <= n; k++) {
        const seat = (((from + k) % n) + n) % n;
        if (pred(this.players[seat])) return seat;
      }
      return -1;
    }

    nextActiveSeat(from) {
      return this.nextSeatWhere(from, (p) => !p.out);
    }

    activePlayers() {
      return this.players.filter((p) => !p.out);
    }

    livePlayers() {
      return this.players.filter((p) => p.inHand && !p.folded);
    }

    canAct(p) {
      return p.inHand && !p.folded && !p.allIn;
    }

    potTotal() {
      return this.players.reduce((sum, p) => sum + p.totalBet, 0);
    }

    markBusted() {
      this.players.forEach((p) => {
        if (p.stack <= 0) p.out = true;
      });
    }

    resetHandState() {
      this.board = [];
      this.deck = [];
      this.street = 'preflop';
      this.history = [];
      this.blindPosts = [];
      this.returned = [];
      this.revealed = new Set();
      this.reveals = [];
      this.awards = [];
      this.isShowdown = false;
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;
      this.toActId = null;
      this.startStacks = {};
    }

    resetPlayersForHand() {
      this.players.forEach((p) => {
        p.hole = [];
        p.bet = 0;
        p.totalBet = 0;
        p.folded = false;
        p.allIn = false;
        p.lastAction = null;
        p.acted = false;
        p.facedBet = 0;
        p.inHand = !p.out;
        this.startStacks[p.id] = p.stack;
      });
    }

    /* --------------------------------------------------------- public API */

    isGameOver() {
      const hero = this.players.find((p) => p.isHuman);
      if (hero && hero.stack + hero.totalBet <= 0) return true;
      return this.players.filter((p) => p.stack + p.totalBet > 0).length <= 1;
    }

    addChips(playerId, amount) {
      const p = this.byId(playerId);
      const chips = toChips(amount);
      if (!p || this.inHand || chips <= 0) return false;
      p.stack += chips;
      p.out = false;
      return true;
    }

    async playHand() {
      if (typeof this.actionProvider !== 'function') {
        throw new Error('Engine.actionProvider must be set before playHand()');
      }
      if (this.inHand) throw new Error('A hand is already in progress');
      this.markBusted();
      if (this.activePlayers().length < 2) {
        await this.emitGameOver();
        return null;
      }
      this.inHand = true;
      try {
        return await this.runHand();
      } finally {
        this.inHand = false;
      }
    }

    getLegal(playerId) {
      const p = this.byId(playerId);
      if (!p || !this.canAct(p) || p.stack <= 0) return NO_LEGAL;
      const toCall = Math.max(0, this.currentBet - p.bet);
      const maxRaiseTo = p.bet + p.stack;
      const reopened = !p.acted || this.currentBet - p.facedBet >= this.lastRaiseSize;
      const othersCanAct = this.players.some((q) => q !== p && this.canAct(q));
      const raiseAllowed = reopened && othersCanAct && p.stack > toCall;
      return Object.freeze({
        canFold: true,
        canCheck: toCall === 0,
        canCall: toCall > 0,
        callAmount: Math.min(toCall, p.stack),
        canBet: raiseAllowed && this.currentBet === 0,
        canRaise: raiseAllowed && this.currentBet > 0,
        minRaiseTo: raiseAllowed ? Math.min(maxRaiseTo, this.currentBet + this.lastRaiseSize) : 0,
        maxRaiseTo: raiseAllowed ? maxRaiseTo : 0,
        toCall,
      });
    }

    publicView(forPlayerId) {
      return Object.freeze({
        handNumber: this.handNumber,
        street: this.street,
        board: this.board.slice(),
        pot: this.potTotal(),
        pots: this.computePots().map((pt) => ({ amount: pt.amount, eligible: pt.eligible.slice() })),
        currentBet: this.currentBet,
        minRaiseTo: this.currentBet + this.lastRaiseSize,
        bigBlind: this.bigBlind,
        smallBlind: this.smallBlind,
        dealerSeat: this.dealerSeat,
        sbSeat: this.sbSeat,
        bbSeat: this.bbSeat,
        toActId: this.toActId,
        players: this.players.map((p) => this.publicPlayer(p, forPlayerId)),
        history: this.history.map((h) => ({ ...h })),
      });
    }

    publicPlayer(p, forPlayerId) {
      const visible = p.hole.length > 0 && (p.id === forPlayerId || this.revealed.has(p.id));
      return {
        id: p.id, name: p.name, seat: p.seat, stack: p.stack, bet: p.bet, totalBet: p.totalBet,
        folded: p.folded, allIn: p.allIn, out: p.out, isHuman: p.isHuman, lastAction: p.lastAction,
        hole: visible ? p.hole.slice() : null,
      };
    }

    /* ------------------------------------------------------- hand flow */

    async runHand() {
      this.handNumber += 1;
      this.resetHandState();
      this.resetPlayersForHand();
      this.assignPositions();
      await this.emit('handStart', {
        handNumber: this.handNumber, dealerSeat: this.dealerSeat, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
      });
      await this.postForcedBets();
      this.prepareDeck();
      this.dealHoleCards();
      await this.emit('deal', {});
      await this.playStreets();
      const record = this.buildRecord();
      await this.emit('handEnd', { record });
      this.markBusted();
      if (this.isGameOver()) await this.emitGameOver();
      return record;
    }

    assignPositions() {
      const prev = { dealer: this.dealerSeat, sb: this.sbSeat, bb: this.bbSeat };
      const deadButton = prev.bb >= 0 ? this.deadButtonPositions(prev) : null;
      if (deadButton) {
        this.dealerSeat = deadButton.dealer;
        this.sbSeat = deadButton.sb;
        this.bbSeat = deadButton.bb;
        return;
      }
      this.dealerSeat = this.nextActiveSeat(this.dealerSeat);
      if (this.activePlayers().length === HEADS_UP) {
        this.sbSeat = this.dealerSeat;
      } else {
        this.sbSeat = this.nextActiveSeat(this.dealerSeat);
      }
      this.bbSeat = this.nextActiveSeat(this.sbSeat);
    }

    /**
     * TDA "dead button" rule: the big blind always moves to the next live seat
     * after last hand's BB, so nobody posts the BB twice in a row or skips it
     * when a player busts. The SB sits on last hand's BB seat and the button on
     * last hand's SB seat — either may be a busted seat (dead SB: no SB posted;
     * dead button). Heads-up: the non-BB player is button + SB.
     * Returns null when the rule cannot produce a sane layout (caller falls back).
     */
    deadButtonPositions(prev) {
      const bb = this.nextActiveSeat(prev.bb);
      if (bb < 0) return null;
      if (this.activePlayers().length === HEADS_UP) {
        const other = this.nextActiveSeat(bb);
        if (other < 0 || other === bb) return null;
        return { dealer: other, sb: other, bb };
      }
      const sb = prev.bb;
      const dealer = prev.sb;
      if (sb === bb || dealer === bb || dealer === sb || dealer < 0) return null;
      return { dealer, sb, bb };
    }

    commit(p, amount) {
      const chips = Math.min(toChips(amount), p.stack);
      p.stack -= chips;
      p.bet += chips;
      p.totalBet += chips;
      if (p.stack === 0) p.allIn = true;
      return chips;
    }

    async postForcedBets() {
      const posts = [];
      if (this.ante > 0) {
        this.players.filter((p) => p.inHand).forEach((p) => {
          const chips = Math.min(this.ante, p.stack);
          p.stack -= chips;
          p.totalBet += chips;
          if (p.stack === 0) p.allIn = true;
          if (chips > 0) posts.push({ playerId: p.id, amount: chips, kind: 'ante' });
        });
      }
      const blind = (seat, size, kind) => {
        const p = this.players[seat];
        if (!p || p.out || !p.inHand) return; // dead blind on a busted seat
        const chips = this.commit(p, size);
        if (chips > 0) posts.push({ playerId: p.id, amount: chips, kind });
      };
      blind(this.sbSeat, this.smallBlind, 'sb');
      blind(this.bbSeat, this.bigBlind, 'bb');
      this.currentBet = this.bigBlind;
      this.lastRaiseSize = this.bigBlind;
      this.blindPosts = posts;
      await this.emit('blinds', { posts: posts.map((x) => ({ ...x })) });
    }

    prepareDeck() {
      const Cards = PP.Cards;
      const supplied = this.deckFn ? this.deckFn(this.handNumber) : null;
      if (Array.isArray(supplied) && supplied.length >= 52) {
        this.deck = supplied.slice();
        return;
      }
      if (this.presetDeck) {
        this.deck = this.presetDeck.slice();
        return;
      }
      if (!Cards) throw new Error('PP.Cards is required to deal');
      this.deck = Cards.shuffle(Cards.makeDeck(), this.rng || Cards.rng);
    }

    draw() {
      return this.deck.shift();
    }

    dealHoleCards() {
      const order = [];
      let seat = this.dealerSeat;
      for (let i = 0; i < this.players.length; i++) {
        seat = this.nextSeatWhere(seat, (p) => p.inHand);
        if (seat < 0 || order.includes(seat)) break;
        order.push(seat);
      }
      for (let pass = 0; pass < HOLE_CARDS; pass++) {
        order.forEach((s) => this.players[s].hole.push(this.draw()));
      }
    }

    async playStreets() {
      for (let i = 0; i < STREETS.length; i++) {
        if (i > 0) {
          this.resetStreet();
          await this.dealStreet(STREETS[i]);
        }
        await this.bettingRound();
        this.returnUncalled();
        if (this.livePlayers().length <= 1) return this.awardByFold();
      }
      return this.showdown();
    }

    resetStreet() {
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;
      this.players.forEach((p) => {
        p.bet = 0;
        p.acted = false;
        p.facedBet = 0;
        if (this.canAct(p)) p.lastAction = null;
      });
    }

    async dealStreet(street) {
      this.draw(); // burn
      for (let i = 0; i < STREET_CARDS[street]; i++) this.board.push(this.draw());
      this.street = street;
      await this.emit('street', { street, board: this.board.slice() });
    }

    /* ---------------------------------------------------- betting round */

    async bettingRound() {
      const n = this.players.length;
      const anchor = this.street === 'preflop' ? this.bbSeat : this.dealerSeat;
      let from = (anchor + 1) % n;
      for (let count = 0; count < MAX_ACTIONS_PER_ROUND; count++) {
        if (this.livePlayers().length <= 1) break;
        const p = this.findActor(from);
        if (!p) break;
        await this.takeTurn(p);
        from = (p.seat + 1) % n;
      }
      this.toActId = null;
    }

    findActor(from) {
      const n = this.players.length;
      for (let k = 0; k < n; k++) {
        const p = this.players[(from + k) % n];
        if (this.needsAction(p)) return p;
      }
      return null;
    }

    needsAction(p) {
      if (!this.canAct(p) || p.stack <= 0) return false;
      const actors = this.players.filter((q) => this.canAct(q));
      if (actors.length === 1) {
        const maxOther = Math.max(0, ...this.livePlayers().filter((q) => q !== p).map((q) => q.bet));
        return p.bet < maxOther;
      }
      return !p.acted || p.bet < this.currentBet;
    }

    async takeTurn(p) {
      this.toActId = p.id;
      const legal = this.getLegal(p.id);
      await this.emit('turn', { playerId: p.id, legal });
      let raw = null;
      try {
        raw = await this.actionProvider(this.publicPlayer(p, p.id), this.publicView(p.id), legal);
      } catch (err) {
        raw = null; // provider failure is coerced to check/fold below
      }
      const action = this.normalizeAction(raw, legal);
      await this.applyAction(p, action);
    }

    normalizeAction(raw, legal) {
      const type = raw && typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
      const passive = legal.canCheck ? { type: 'check' } : { type: 'fold' };
      switch (type) {
        case 'fold':
          return { type: 'fold' };
        case 'check':
          return passive;
        case 'call':
          return legal.canCall ? { type: 'call' } : passive;
        case 'bet':
        case 'raise':
          return this.normalizeRaise(raw.amount, legal);
        case 'allin':
          if (legal.canBet || legal.canRaise) return { type: 'raise', to: legal.maxRaiseTo };
          return legal.canCall ? { type: 'call' } : passive;
        default:
          return passive;
      }
    }

    normalizeRaise(amount, legal) {
      if (!legal.canBet && !legal.canRaise) {
        return legal.canCall ? { type: 'call' } : { type: 'check' };
      }
      const requested = Number.isFinite(Number(amount)) ? Math.floor(Number(amount)) : legal.minRaiseTo;
      return { type: 'raise', to: clamp(requested, legal.minRaiseTo, legal.maxRaiseTo) };
    }

    async applyAction(p, action) {
      const betBefore = this.currentBet;
      let added = 0;
      if (action.type === 'fold') {
        p.folded = true;
      } else if (action.type === 'call') {
        added = this.commit(p, this.currentBet - p.bet);
      } else if (action.type === 'raise') {
        added = this.commit(p, action.to - p.bet);
        this.registerRaise(p.bet);
      }
      p.acted = true;
      p.facedBet = this.currentBet;
      const type = this.displayType(p, action.type, betBefore);
      const amount = type === 'call' ? added : type === 'fold' || type === 'check' ? 0 : p.bet;
      p.lastAction = type;
      const potAfter = this.potTotal();
      this.history.push({ street: this.street, playerId: p.id, type, amount, potAfter });
      await this.emit('action', { playerId: p.id, type, amount, stack: p.stack, pot: potAfter });
    }

    registerRaise(newBet) {
      if (newBet <= this.currentBet) return;
      const increment = newBet - this.currentBet;
      if (increment >= this.lastRaiseSize) this.lastRaiseSize = increment;
      this.currentBet = newBet;
    }

    displayType(p, type, betBefore) {
      if (p.allIn && (type === 'call' || type === 'raise')) return 'allin';
      if (type === 'raise') return betBefore === 0 ? 'bet' : 'raise';
      return type;
    }

    returnUncalled() {
      const sorted = this.players.filter((p) => p.inHand).sort((a, b) => b.totalBet - a.totalBet);
      if (sorted.length === 0) return;
      const top = sorted[0];
      const second = sorted.length > 1 ? sorted[1].totalBet : 0;
      const excess = top.totalBet - second;
      if (excess <= 0) return;
      top.totalBet -= excess;
      top.bet = Math.max(0, top.bet - excess);
      top.stack += excess;
      top.allIn = false;
      this.currentBet = Math.max(...this.players.map((p) => p.bet));
      this.returned.push({ playerId: top.id, amount: excess, street: this.street });
    }

    /* ------------------------------------------------------- pots/awards */

    computePots() {
      const inHand = this.players.filter((p) => p.inHand && p.totalBet > 0);
      if (inHand.length === 0) return [];
      const live = this.livePlayers();
      const maxBet = Math.max(...inHand.map((p) => p.totalBet));
      const levels = Array.from(new Set(
        live.filter((p) => p.allIn).map((p) => p.totalBet).concat([maxBet])
      )).sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      levels.forEach((level) => {
        const amount = inHand.reduce(
          (sum, p) => sum + Math.min(p.totalBet, level) - Math.min(p.totalBet, prev), 0);
        const eligible = live.filter((p) => !p.allIn || p.totalBet >= level).map((p) => p.id);
        prev = level;
        if (amount <= 0) return;
        const last = pots[pots.length - 1];
        if (last && (eligible.length === 0 || sameIds(last.eligible, eligible))) {
          last.amount += amount;
        } else {
          pots.push({ amount, eligible });
        }
      });
      return pots;
    }

    clearContributions() {
      this.players.forEach((p) => {
        p.bet = 0;
        p.totalBet = 0;
      });
      this.currentBet = 0;
    }

    async awardByFold() {
      const winner = this.livePlayers()[0];
      const amount = this.potTotal();
      this.awards = [{ playerId: winner.id, amount, potIndex: 0, hand: null }];
      winner.stack += amount;
      this.clearContributions();
      await this.emit('potAwarded', { awards: this.awards.map((a) => ({ ...a })) });
    }

    async showdown() {
      this.street = 'showdown';
      this.isShowdown = true;
      const live = this.orderFromButton(this.livePlayers());
      const evaluate = PP.Eval && PP.Eval.evaluate;
      if (typeof evaluate !== 'function') throw new Error('PP.Eval is required for showdown');
      this.reveals = live.map((p) => ({
        playerId: p.id, hole: p.hole.slice(), hand: evaluate(p.hole.concat(this.board)),
      }));
      this.reveals.forEach((r) => this.revealed.add(r.playerId));
      await this.emit('showdown', { reveals: this.reveals.slice() });
      const handOf = new Map(this.reveals.map((r) => [r.playerId, r.hand]));
      this.awards = [];
      this.computePots().forEach((pot, potIndex) => this.awardPot(pot, potIndex, handOf));
      this.awards.forEach((a) => {
        this.byId(a.playerId).stack += a.amount;
      });
      this.clearContributions();
      await this.emit('potAwarded', { awards: this.awards.map((a) => ({ ...a })) });
    }

    awardPot(pot, potIndex, handOf) {
      const listed = pot.eligible.filter((id) => handOf.has(id));
      // Defensive: a pot nobody is listed for goes to the best live hand (keeps chips conserved).
      const eligible = listed.length > 0 ? listed : Array.from(handOf.keys());
      if (eligible.length === 0) return;
      const best = Math.max(...eligible.map((id) => handOf.get(id).score));
      const winners = this.orderFromButton(
        eligible.filter((id) => handOf.get(id).score === best).map((id) => this.byId(id)));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      winners.forEach((w) => {
        const extra = odd > 0 ? 1 : 0;
        odd -= extra;
        this.awards.push({ playerId: w.id, amount: share + extra, potIndex, hand: handOf.get(w.id) });
      });
    }

    orderFromButton(list) {
      const n = this.players.length;
      const dist = (p) => (p.seat - this.dealerSeat - 1 + 2 * n) % n;
      return list.slice().sort((a, b) => dist(a) - dist(b));
    }

    /* ----------------------------------------------------------- record */

    buildRecord() {
      return {
        handNumber: this.handNumber,
        dealerSeat: this.dealerSeat,
        sbSeat: this.sbSeat,
        bbSeat: this.bbSeat,
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        players: this.players.filter((p) => p.inHand).map((p) => ({
          id: p.id, name: p.name, seat: p.seat,
          startStack: this.startStacks[p.id], endStack: p.stack, hole: p.hole.slice(),
        })),
        board: this.board.slice(),
        actions: this.history.map((h) => ({ ...h })),
        blinds: this.blindPosts.map((b) => ({ ...b })),
        returned: this.returned.map((r) => ({ ...r })),
        showdown: this.isShowdown,
        awards: this.awards.map((a) => ({ ...a })),
        reveals: this.reveals.map((r) => ({ ...r, hole: r.hole.slice() })),
      };
    }

    async emitGameOver() {
      const ranked = this.players.slice().sort((a, b) => b.stack - a.stack);
      await this.emit('gameOver', { winnerId: ranked[0] ? ranked[0].id : null });
    }
  }

  /** A preset deck must be exactly 52 distinct cards; anything else is a caller bug, so fail fast. */
  function validPresetDeck(deck) {
    const seen = new Set();
    const ok = Array.isArray(deck) && deck.length === 52 && deck.every((c) => {
      const key = c && Number.isInteger(c.r) && c.r >= 2 && c.r <= 14 && 'shdc'.includes(c.s) ? c.r + c.s : null;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!ok) throw new Error('Engine deck must be 52 unique cards');
    return Object.freeze(deck.slice());
  }

  function sameIds(a, b) {
    return a.length === b.length && a.every((id) => b.includes(id));
  }

  PP.Engine = Engine;
})();
