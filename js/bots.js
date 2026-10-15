/* PIXEL HOLD'EM — PP.Bots: rated AI opponents (pure, DOM-free).
 * Each rating plays a recognisably different, *teachable* style and explains
 * every decision in bot.lastReasoning. decide() is synchronous and always
 * returns an action that is legal for the supplied `legal` object. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  // ---------------------------------------------------------------- constants
  const RANK_CHARS = '23456789TJQKA';
  const RANK_NAMES = { 2: 'Deuce', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const EVAL_BUDGET = 3200;          // max 7-card evals per Monte Carlo run (keeps decide() well under 40ms)
  const MIN_MC_ITERS = 60;
  const RANGE_COST = 3;              // range-weighted Monte Carlo rejects samples, so run fewer iterations
  const IMPLIED_FRACTION = 0.5;       // share of remaining effective stack assumed winnable when a draw hits
  const SHOVE_REMAINDER_BB = 2;      // if a bet leaves < this many BB behind, just move all-in
  const MULTIWAY_THRESHOLD_STEP = 0.08;
  const MIN_THRESHOLD = 0.33;
  const BB_DEFEND_CHEN = 4;          // big blind defends a small open only with a real hand
  const SHARK_CALL_CHEN = 6;
  const STATION_VALUE_BONUS = 0.08;  // Shark value-bets this much thinner vs calling stations
  const REALISE_IP = 0.95;           // share of raw equity a hand realises in position...
  const REALISE_OOP = 0.75;          // ...and out of position

  const RATINGS = Object.freeze({
    1: Object.freeze({ rating: 1, title: 'Fish', style: 'Loose-Passive',
      blurb: 'Plays almost any two cards, calls too much and chases every draw. Value-bet relentlessly; never bluff a fish.' }),
    2: Object.freeze({ rating: 2, title: 'Rookie', style: 'Tight-Passive',
      blurb: 'Plays few hands and only bets big when strong. A big bet from a Rookie means a big hand.' }),
    3: Object.freeze({ rating: 3, title: 'Regular', style: 'Tight-Aggressive',
      blurb: 'Solid TAG: position-aware opening ranges and steady continuation bets. Respect their raises.' }),
    4: Object.freeze({ rating: 4, title: 'Grinder', style: 'Loose-Aggressive',
      blurb: 'Steals blinds, 3-bets light and barrels scare cards. Trap them and call down a little lighter.' }),
    5: Object.freeze({ rating: 5, title: 'Shark', style: 'Balanced Pro',
      blurb: 'Equity and pot-odds driven. Semi-bluffs draws, sizes bluffs like value bets, exploits limpers.' }),
  });

  // Postflop tendencies for the equity-driven ratings (2..5). Fish has its own logic.
  const PROFILES = Object.freeze({
    1: { iters: 0 },
    2: { iters: 150, value: 0.72, raise: 0.86, callMargin: 0.12, valueSize: 1.0, raiseSize: 1.1,
      cbet: 0.15, barrel: 0, semi: 0, semiRaise: 0, stab: 0, riverBluff: 0, implied: false, drawFoldFrac: 0.3 },
    3: { iters: 300, value: 0.62, raise: 0.78, callMargin: 0.03, valueSize: 0.6, raiseSize: 0.8,
      cbet: 0.65, barrel: 0.25, semi: 0.3, semiRaise: 0.1, stab: 0.05, riverBluff: 0.05, implied: true, bluffSize: 0.5 },
    4: { iters: 300, value: 0.56, raise: 0.72, callMargin: -0.02, valueSize: 0.7, raiseSize: 0.85,
      cbet: 0.82, barrel: 0.6, semi: 0.5, semiRaise: 0.3, stab: 0.18, riverBluff: 0.15, implied: true, bluffSize: 0.6 },
    5: { iters: 700, value: 0.6, raise: 0.78, callMargin: 0, valueSize: null, raiseSize: 0.8,
      cbet: 0.8, barrel: 0.55, semi: 0.6, semiRaise: 0.35, stab: 0.15, riverBluff: 0.2, implied: true, bluffSize: null },
  });

  // Preflop open thresholds on the Chen scale, by position.
  const OPEN_CHEN = Object.freeze({
    3: { Early: 9, Middle: 8, Late: 7, Button: 6, Blinds: 7 },
    4: { Early: 8, Middle: 7, Late: 5, Button: 4, Blinds: 5 },
    5: { Early: 8, Middle: 7, Late: 5, Button: 4, Blinds: 5 },
  });

  const BOT_NAMES = Object.freeze([
    'PIXEL PETE', 'BIT BARON', 'CHIPTUNE', 'NEON NINA', '8-BIT BETTY', 'GLITCH', 'SPRITE', 'TURBO TINA',
    'MEGA MAX', 'ROM RAIDER', 'CRT CARL', 'JOYSTICK JO', 'HI-SCORE', 'COIN-OP', 'BLIP', 'NIBBLE',
    'PAC RAT', 'VECTOR VIC', 'SCANLINE SAM', 'DOT MATRIX', 'POWER-UP', 'LASER LOU', 'ARCADE ANNIE',
    'BOSS LEVEL', 'CHEAT CODE', 'K.O. KIM', 'RETRO REX', 'D-PAD DAN', 'SYNTH SUE', 'TILT', 'COMBO',
    'EXTRA LIFE', 'PLAYER 2', 'BYTE ME', 'GAME GENIE', 'QUARTER', 'STARMAN', '1UP', 'BONUS BOB', 'KONAMI',
  ]);

  // ------------------------------------------------------------------ helpers
  const pct = (x) => Math.round(x * 100) + '%';
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const fmt = (n) => String(Math.round(n));
  const rankName = (r) => RANK_NAMES[r] || String(r);

  function roundToUnit(amount, unit) {
    const u = unit > 0 ? unit : 1;
    return Math.max(u, Math.round(amount / u) * u);
  }

  function handLabel(hole) {
    const [hi, lo] = hole[0].r >= hole[1].r ? hole : [hole[1], hole[0]];
    const base = RANK_CHARS[hi.r - 2] + RANK_CHARS[lo.r - 2];
    if (hi.r === lo.r) return base;
    return base + (hi.s === lo.s ? 's' : 'o');
  }

  /** Chen formula (raw, rounded up). AA=20, 72o=-1. */
  function chenScore(hole) {
    const hi = Math.max(hole[0].r, hole[1].r);
    const lo = Math.min(hole[0].r, hole[1].r);
    const base = hi === 14 ? 10 : hi === 13 ? 8 : hi === 12 ? 7 : hi === 11 ? 6 : hi / 2;
    if (hi === lo) return Math.ceil(Math.max(base * 2, 5));
    let score = base;
    if (hole[0].s === hole[1].s) score += 2;
    const gap = hi - lo - 1;
    score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 12) score += 1;
    return Math.ceil(score);
  }

  function suitCounts(cards) {
    const counts = { s: 0, h: 0, d: 0, c: 0 };
    cards.forEach((c) => { counts[c.s] += 1; });
    return counts;
  }

  function rankCounts(cards) {
    const counts = {};
    cards.forEach((c) => { counts[c.r] = (counts[c.r] || 0) + 1; });
    return counts;
  }

  function boardIsWet(board) {
    if (PP.Equity && typeof PP.Equity.boardTexture === 'function' && board.length >= 3) {
      try { return !!PP.Equity.boardTexture(board).wet; } catch (e) { /* fall through to local check */ }
    }
    const maxSuit = Math.max(...Object.values(suitCounts(board)));
    const ranks = [...new Set(board.map((c) => c.r))].sort((a, b) => a - b);
    const connected = ranks.some((r, i) => i >= 1 && r - ranks[i - 1] <= 2);
    return maxSuit >= 2 || connected;
  }

  function scaryBoardReason(board) {
    if (Math.max(...Object.values(suitCounts(board))) >= 3) return 'three suited cards are out';
    if (Object.values(rankCounts(board)).some((n) => n >= 2)) return 'the board is paired';
    const ranks = [...new Set(board.map((c) => c.r))].sort((a, b) => a - b);
    for (let i = 0; i + 3 < ranks.length; i += 1) {
      if (ranks[i + 3] - ranks[i] <= 4) return 'four cards to a straight are out';
    }
    return null;
  }

  function scareCardReason(board) {
    if (board.length < 4) return null;
    const last = board[board.length - 1];
    const prev = board.slice(0, -1);
    if (suitCounts(board)[last.s] === 3 && suitCounts(prev)[last.s] === 2) return 'the flush-completing card';
    if (last.r >= 10 && last.r > Math.max(...prev.map((c) => c.r))) return `the ${rankName(last.r)} overcard`;
    if (prev.some((c) => c.r === last.r)) return 'the board-pairing card';
    return null;
  }

  // ------------------------------------------------- opponent reads (Shark)
  const STATION_MIN_HANDS = 8;
  const STATION_VPIP = 0.5;
  const STATION_PASSIVE = 0.35;
  const STATION_ISO_BONUS = 3;     // Shark isolates a limping station with a much wider range
  const VOLUNTARY = new Set(['call', 'bet', 'raise', 'allin']);
  const RAISES = new Set(['bet', 'raise', 'allin']);
  const MANIAC_PFR = 0.3;

  /**
   * Remembers how often each opponent puts money in voluntarily preflop.
   * Samples only the actions taken BEFORE the bot's first decision of a hand, so
   * folds that happen after the bot acts (which it never sees) can't bias the read.
   */
  function observe(bot, view) {
    if (!bot.reads || view.handNumber == null || view.street !== 'preflop') return;
    if (bot.readHand === view.handNumber) return;
    bot.readHand = view.handNumber;
    const firstAction = {};
    (view.history || []).forEach((h) => {
      if (h.street !== 'preflop' || h.playerId === bot.id || firstAction[h.playerId]) return;
      firstAction[h.playerId] = h;
    });
    Object.keys(firstAction).forEach((id) => {
      const h = firstAction[id];
      const r = bot.reads[id] || (bot.reads[id] = { hands: 0, vpip: 0, pfr: 0 });
      r.hands += 1;
      if (VOLUNTARY.has(h.type)) r.vpip += 1;
      if (RAISES.has(h.type) && Number(h.amount) > (view.bigBlind || 0)) r.pfr += 1;
    });
  }

  /** A loose-aggressive raiser: their bets and raises mean less, so call down lighter. */
  function isManiac(bot, id) {
    const r = bot.reads && bot.reads[id];
    return !!r && r.hands >= STATION_MIN_HANDS && r.pfr / r.hands >= MANIAC_PFR;
  }

  /** A calling station: plays most hands, rarely raises. Never bluff one; value-bet it thinner. */
  function isStation(bot, id) {
    const r = bot.reads && bot.reads[id];
    if (!r || r.hands < STATION_MIN_HANDS || r.vpip / r.hands < STATION_VPIP) return false;
    return r.pfr / Math.max(1, r.vpip) < STATION_PASSIVE; // plays lots of hands but rarely raises
  }

  // ----------------------------------------------------------- view parsing
  function resolveSelf(view, me, botId) {
    const fromView = (view.players || []).find((p) => p.id === (me && me.id != null ? me.id : botId));
    return Object.assign({}, fromView || {}, me || {});
  }

  function positionInfo(view, myId) {
    const live = (view.players || []).filter((p) => !p.out);
    const n = live.length;
    const seatSpan = Math.max(...(view.players || []).map((p) => p.seat), 0) + 1;
    const dist = (seat) => (((seat - view.dealerSeat - 1) % seatSpan) + seatSpan) % seatSpan;
    const order = live.slice().sort((a, b) => dist(a.seat) - dist(b.seat));
    const idx = order.findIndex((p) => p.id === myId);
    return { pos: positionName(idx, n), tableSize: n };
  }

  function positionName(idx, n) {
    if (n <= 2) return idx === n - 1 ? 'Button' : 'Blinds';
    if (idx === n - 1) return 'Button';
    if (idx <= 1) return 'Blinds';
    if (idx === n - 2) return 'Late';
    const earlySlots = Math.ceil((n - 4) / 2);
    return idx - 2 < earlySlots ? 'Early' : 'Middle';
  }

  const AGGRESSIVE_TYPES = new Set(['bet', 'raise', 'allin']);

  /** Summarise a street's betting: number of raises, limpers, last aggressor. */
  function streetActions(view, street, openingBet) {
    let level = openingBet;
    let raises = 0;
    let limpers = 0;
    let aggressor = null;
    (view.history || []).filter((h) => h.street === street).forEach((h) => {
      const amt = Number(h.amount) || 0;
      if (AGGRESSIVE_TYPES.has(h.type) && amt > level) {
        level = amt;
        raises += 1;
        aggressor = h.playerId;
      } else if (h.type === 'call' && raises === 0 && street === 'preflop') {
        limpers += 1;
      }
    });
    return { raises, limpers, aggressor };
  }

  function previousStreet(street) {
    return { flop: 'preflop', turn: 'flop', river: 'turn' }[street] || null;
  }

  function buildContext(bot, view, legal, me) {
    const self = resolveSelf(view, me, bot.id);
    const board = view.board || [];
    const street = view.street || 'preflop';
    const bb = view.bigBlind || 2;
    const sb = view.smallBlind || Math.max(1, Math.floor(bb / 2));
    const callAmount = legal.canCall ? (legal.callAmount != null ? legal.callAmount : legal.toCall || 0) : 0;
    const pot = view.pot || 0;
    const opponents = (view.players || []).filter((p) => p.id !== self.id && !p.folded && !p.out);
    const stack = self.stack || 0;
    const maxOppStack = Math.max(0, ...opponents.map((p) => (p.stack || 0) + (p.bet || 0)));
    const pre = streetActions(view, 'preflop', bb);
    const prev = previousStreet(street);
    const ctx = {
      bot, view, legal, self, board, street, bb, sb, pot, opponents, stack,
      hole: self.hole || [],
      numOpp: Math.max(1, opponents.length),
      myBet: self.bet || 0,
      currentBet: view.currentBet != null ? view.currentBet : (self.bet || 0) + callAmount,
      toCall: callAmount,
      potOdds: callAmount > 0 ? callAmount / (pot + callAmount) : 0,
      effStack: Math.min(stack + (self.bet || 0), maxOppStack || stack),
      pre,
      cur: streetActions(view, street, street === 'preflop' ? bb : 0),
      wasAggressor: prev ? streetActions(view, prev, prev === 'preflop' ? bb : 0).aggressor === self.id : false,
      rng: bot.rng || (PP.Cards && PP.Cards.rng) || Math.random,
      ...positionInfo(view, self.id),
    };
    ctx.pressure = pressureOf(view, self.id, bb, street);
    ctx.rangeAware = ctx.pressure.preLevel > 0 || ctx.pressure.postLevel > 0;
    ctx.vsStation = bot.rating === 5 && opponents.length > 0 && opponents.every((p) => isStation(bot, p.id));
    ctx.equity = memoEquity(ctx, PROFILES[bot.rating].iters);
    ctx.draws = memoDraws(ctx);
    return ctx;
  }

  function memoEquity(ctx, iters) {
    let cached = null;
    return () => {
      if (cached == null) cached = computeEquity(ctx, iters || 200);
      return cached;
    };
  }

  const NO_PRESSURE = Object.freeze({ preLevel: 0, postLevel: 0, betsThisStreet: 0, facingRaise: false, byPlayer: {} });

  /** Aggression shown by the other players (drives the range they are put on). */
  function pressureOf(view, myId, bb, street) {
    if (!PP.Equity || typeof PP.Equity.pressureFromHistory !== 'function') return NO_PRESSURE;
    return PP.Equity.pressureFromHistory(view.history, myId, bb, street);
  }

  /** One range per live opponent, from what that opponent has done this hand. */
  function opponentRange(ctx) {
    if (!ctx.rangeAware || !PP.Equity || typeof PP.Equity.villainRange !== 'function') return null;
    return ctx.opponents.map((p) => {
      const read = ctx.pressure.byPlayer[p.id];
      if (!read) return null;
      // Shark exploit: a loose raiser's range is one notch wider than its action suggests.
      const widen = ctx.bot.rating === 5 && isManiac(ctx.bot, p.id) ? 1 : 0;
      const level = { preLevel: read.preLevel - widen, postLevel: read.postLevel };
      return PP.Equity.villainRange(ctx.street === 'preflop' ? { preLevel: level.preLevel } : level);
    });
  }

  function computeEquity(ctx, iters) {
    const opponents = ctx.numOpp;
    const range = opponentRange(ctx);
    const budget = range ? EVAL_BUDGET / RANGE_COST : EVAL_BUDGET;
    const iterations = Math.max(MIN_MC_ITERS, Math.min(iters, Math.floor(budget / (opponents + 1))));
    if (PP.Equity && typeof PP.Equity.monteCarlo === 'function') {
      const res = PP.Equity.monteCarlo({ hero: ctx.hole, board: ctx.board, opponents, iterations, rng: ctx.rng, oppWeight: range || undefined });
      if (res && Number.isFinite(res.equity)) return res.equity;
    }
    return heuristicEquity(ctx);
  }

  /** Crude fallback if PP.Equity is unavailable: based on Chen / made-hand category. */
  function heuristicEquity(ctx) {
    const base = ctx.board.length === 0
      ? clamp((chenScore(ctx.hole) + 2) / 24, 0.05, 0.95)
      : clamp(0.25 + madeInfo(ctx).cat * 0.12, 0.05, 0.97);
    return clamp(base / Math.sqrt(ctx.numOpp), 0.02, 0.98);
  }

  function memoDraws(ctx) {
    let cached = null;
    return () => {
      if (cached) return cached;
      cached = { count: 0, draws: [] };
      const drawStreet = ctx.street === 'flop' || ctx.street === 'turn';
      if (drawStreet && PP.Equity && typeof PP.Equity.outs === 'function') {
        const res = PP.Equity.outs(ctx.hole, ctx.board);
        if (res) cached = { count: res.count || 0, draws: res.draws || [] };
      }
      return cached;
    };
  }

  /** Made-hand info used by the Fish and for reasoning text. */
  function madeInfo(ctx) {
    const all = ctx.hole.concat(ctx.board);
    if (ctx.board.length < 3 || !PP.Eval || typeof PP.Eval.evaluate !== 'function') {
      return { cat: 0, desc: null, usesHole: false };
    }
    const res = PP.Eval.evaluate(all);
    const boardCounts = Object.values(rankCounts(ctx.board)).sort((a, b) => b - a);
    const boardCat = boardCounts[0] >= 3 ? 3 : boardCounts[0] === 2 ? (boardCounts[1] === 2 ? 2 : 1) : 0;
    return { cat: res.cat, desc: res.desc, usesHole: res.cat > boardCat };
  }

  // ---------------------------------------------------------------- intents
  const fold = (because) => ({ kind: 'fold', because });
  const check = (because) => ({ kind: 'check', because });
  const call = (because) => ({ kind: 'call', because });
  const raiseTo = (to, because) => ({ kind: 'raise', to, because });
  const allIn = (because) => ({ kind: 'allin', because });

  const OVERCARDS_RE = /overcard/i;
  // Only straight and flush draws are "draws" for implied odds / semi-bluffs.
  // Made-hand improvement labels ('Set draw', 'Two pair / trips draw', ...) are not.
  const REAL_DRAW_RE = /flush draw|straight draw|gutshot/i;

  /** A draw worth chasing/semi-bluffing: straight/flush draws only. */
  function realDraw(ctx, minOuts) {
    const d = ctx.draws();
    return d.count >= minOuts && d.draws.some((name) => REAL_DRAW_RE.test(name));
  }

  function drawText(ctx) {
    const d = ctx.draws();
    if (!d.count) return 'no real draw';
    const named = d.draws.filter((name) => REAL_DRAW_RE.test(name));
    const label = (named.length ? named.slice(0, 2).join(' + ') : d.draws[0] || 'draw').toLowerCase();
    const article = /^[aeiou]/.test(label) ? 'an' : 'a';
    const approx = ctx.street === 'flop' ? d.count * 4 : d.count * 2;
    return `${article} ${label}: ${d.count} outs, ~${Math.min(approx, 100)}% to hit`;
  }

  function shortDesc(desc) {
    return desc.replace(/,[^,]*kickers?$/i, '');
  }

  function handText(ctx) {
    if (ctx.street === 'preflop') return handLabel(ctx.hole);
    const m = madeInfo(ctx);
    return m.desc ? `${shortDesc(m.desc)} (${handLabel(ctx.hole)})` : handLabel(ctx.hole);
  }

  function vsText(ctx) {
    const who = ctx.numOpp === 1 ? '1 opponent' : `${ctx.numOpp} opponents`;
    if (ctx.street !== 'preflop' && ctx.pressure.postLevel > 0) return `${who}'s betting range`;
    if (ctx.pressure.preLevel > 0) return `${who}'s preflop range`;
    return `${who} (random hands)`;
  }

  // ------------------------------------------------------- preflop strategy
  function openSize(ctx, multiplierBB) {
    return ctx.bb * multiplierBB + ctx.bb * ctx.pre.limpers;
  }

  function threeBetSize(ctx, inPosition) {
    return ctx.currentBet * (inPosition ? 3 : 3.5);
  }

  function isInPosition(ctx) {
    return ctx.pos === 'Button' || ctx.pos === 'Late';
  }

  function shorthandedAdjust(tableSize) {
    if (tableSize <= 3) return 2;
    if (tableSize <= 6) return 1;
    return 0;
  }

  function fishPreflop(ctx) {
    const chen = chenScore(ctx.hole);
    const label = handLabel(ctx.hole);
    const suited = ctx.hole[0].s === ctx.hole[1].s;
    const hasBigCard = Math.max(ctx.hole[0].r, ctx.hole[1].r) >= 10;
    if (ctx.pre.raises === 0) {
      if (chen >= 14 && ctx.rng() < 0.6) return raiseTo(ctx.bb * 3, `${label} is a monster, so even a fish raises it`);
      if (ctx.toCall === 0) return check(`${label}, happy to see a free flop`);
      if (chen >= 10) return call(`${label} is strong, but a fish just limps instead of raising`);
      if (chen >= 1 || suited || hasBigCard) return call(`${label} "could flop something", so limping in like a fish`);
      return fold(`${label} is too ugly even for a fish`);
    }
    if (chen >= 16) return raiseTo(threeBetSize(ctx, true), `${label} is one of the best hands, re-raising`);
    const affordable = ctx.toCall <= ctx.stack * 0.35;
    if (affordable && (chen >= 3 || suited || hasBigCard)) {
      return call(`${label} "might get there": calling a raise with a hand that should often fold`);
    }
    if (chen >= 10) return call(`${label} is too pretty to fold, even for a big bet`);
    return fold(`${label} and the raise is too big, even for a fish`);
  }

  function rookiePreflop(ctx) {
    const chen = chenScore(ctx.hole);
    const label = handLabel(ctx.hole);
    if (ctx.pre.raises === 0) {
      if (chen >= 11) return raiseTo(ctx.bb * 5, `${label} is a premium hand, and a Rookie raises big only with premiums (a readable tell)`);
      if (ctx.toCall === 0) return check(`${label}, taking the free flop`);
      if (chen >= 8) return call(`${label} is decent, so limping in cautiously`);
      return fold(`${label} isn't strong enough; Rookies play very tight`);
    }
    if (chen >= 14) return raiseTo(threeBetSize(ctx, true) * 1.2, `${label} is a premium pair/hand, re-raising big`);
    if (chen >= 9 && ctx.toCall <= ctx.stack * 0.15) return call(`${label} is good but the Rookie is scared to re-raise`);
    return fold(`${label} facing a raise; Rookies give up without a premium`);
  }

  function regularPreflop(ctx) {
    const chen = chenScore(ctx.hole);
    const label = handLabel(ctx.hole);
    const openAt = OPEN_CHEN[3][ctx.pos] - shorthandedAdjust(ctx.tableSize);
    if (ctx.pre.raises === 0) {
      if (ctx.toCall === 0 && ctx.pos === 'Blinds' && chen < openAt + 3) return check(`${label} in the big blind: taking the free flop`);
      if (chen >= openAt) return raiseTo(openSize(ctx, 2.5), `${label} is inside a ${ctx.pos.toLowerCase()}-position opening range (${ctx.tableSize}-handed); a TAG opens rather than limps`);
      return foldOrCheck(ctx, `${label} is outside the ${ctx.pos.toLowerCase()}-position opening range`);
    }
    return regularFacingRaise(ctx, chen, label);
  }

  function regularFacingRaise(ctx, chen, label) {
    const ip = isInPosition(ctx);
    const deep = ctx.toCall > ctx.stack * 0.3;
    if (ctx.pre.raises >= 2) {
      if (chen >= 14) return allInOrRaise(ctx, `${label} is strong enough to go to war against a 4-bet`);
      if (chen >= 12 && !deep) return call(`${label} is good enough to call a re-raise but not to 4-bet`);
      return fold(`${label} can't continue against a 3-bet and 4-bet range`);
    }
    if (chen >= 11) return raiseTo(threeBetSize(ctx, ip), `${label} is strong enough to 3-bet for value`);
    const callAt = ip ? 8 : 9;
    if (chen >= callAt && !deep) return call(`${label} plays well ${ip ? 'in position' : 'from here'}; calling the open`);
    const where = ip ? '' : ' out of position';
    return fold(`${label} is too weak to call a raise${where}; a TAG folds marginal hands`);
  }

  function grinderPreflop(ctx) {
    const chen = chenScore(ctx.hole);
    const label = handLabel(ctx.hole);
    const openAt = OPEN_CHEN[4][ctx.pos] - shorthandedAdjust(ctx.tableSize);
    if (ctx.pre.raises === 0) {
      const steal = ctx.pre.limpers === 0 && (ctx.pos === 'Button' || ctx.pos === 'Late' || ctx.pos === 'Blinds');
      if (ctx.toCall === 0 && ctx.pos === 'Blinds' && chen < openAt) return check(`${label} in the big blind, checking the option`);
      if (chen >= openAt) {
        const seatName = { Button: 'button', Late: 'cutoff', Blinds: 'small blind' }[ctx.pos];
        const why = steal ? `stealing the blinds from the ${seatName} with ${label}; a LAG attacks folded pots` : `${label} is in a loose-aggressive opening range`;
        return raiseTo(openSize(ctx, steal ? 2.2 : 2.5), why);
      }
      return foldOrCheck(ctx, `${label} is too weak even for a LAG from ${ctx.pos.toLowerCase()} position`);
    }
    return grinderFacingRaise(ctx, chen, label);
  }

  function grinderFacingRaise(ctx, chen, label) {
    const ip = isInPosition(ctx);
    const suited = ctx.hole[0].s === ctx.hole[1].s;
    if (ctx.pre.raises >= 2) {
      if (chen >= 12) return allInOrRaise(ctx, `${label} is strong enough to shove over a re-raise`);
      if (chen >= 10 && ctx.toCall <= ctx.stack * 0.25) return call(`${label} calls the re-raise in position-ish`);
      return fold(`${label} can't continue against heavy re-raising`);
    }
    if (chen >= 10) return raiseTo(threeBetSize(ctx, ip), `${label} is a value 3-bet`);
    if (ip && suited && chen >= 6 && ctx.rng() < 0.3) {
      return raiseTo(threeBetSize(ctx, ip), `light 3-bet with ${label}: suited, playable if called, and wins the pot often when they fold`);
    }
    if (chen >= 7 && ctx.toCall <= ctx.stack * 0.15) return call(`${label} defends against the raise; a LAG doesn't give up easily`);
    return fold(`${label} is too weak to continue vs a raise`);
  }

  function sharkPreflop(ctx) {
    const chen = chenScore(ctx.hole);
    const label = handLabel(ctx.hole);
    if (ctx.pre.raises === 0) return sharkUnraised(ctx, chen, label);
    return sharkFacingRaise(ctx, chen, label);
  }

  function sharkUnraised(ctx, chen, label) {
    const openAt = OPEN_CHEN[5][ctx.pos] - shorthandedAdjust(ctx.tableSize);
    const limpers = ctx.pre.limpers;
    const stationLimped = limpers > 0 && limperIds(ctx).some((id) => isStation(ctx.bot, id));
    const isoAt = openAt - (stationLimped ? STATION_ISO_BONUS : 1);
    if (limpers > 0 && chen >= isoAt) {
      if (stationLimped) {
        return raiseTo(ctx.bb * 4 + ctx.bb * limpers, `isolating a calling station with ${label}: they limp and call with weak hands, so a bigger raise plays a bloated pot heads-up against their worse range`);
      }
      return raiseTo(ctx.bb * 3 + ctx.bb * limpers, `isolating ${limpers} limper${limpers > 1 ? 's' : ''} with ${label}: limpers have weak, capped ranges, so raising wins the pot now or plays it heads-up with the better hand`);
    }
    if (ctx.toCall === 0 && ctx.pos === 'Blinds' && chen < openAt + 2) return check(`${label} in the big blind; no reason to bloat the pot`);
    if (chen >= openAt) return raiseTo(openSize(ctx, 2.5), `${label} is a standard ${ctx.pos.toLowerCase()}-position open (${ctx.tableSize}-handed)`);
    return foldOrCheck(ctx, `${label} loses money from ${ctx.pos.toLowerCase()} position over the long run`);
  }

  function limperIds(ctx) {
    return (ctx.view.history || []).filter((h) => h.street === 'preflop' && h.type === 'call').map((h) => h.playerId);
  }

  function sharkFacingRaise(ctx, chen, label) {
    const ip = isInPosition(ctx);
    const eq = ctx.equity(); // Monte Carlo vs a Chen-filtered raising range
    const need = ctx.potOdds;
    const isWheelAce = Math.max(ctx.hole[0].r, ctx.hole[1].r) === 14 && Math.min(ctx.hole[0].r, ctx.hole[1].r) <= 5 && ctx.hole[0].s === ctx.hole[1].s;
    if (ctx.pre.raises >= 2) {
      if (chen >= 14) return allInOrRaise(ctx, `${label} is at the top of the range; getting it in vs a 4-bet`);
      if (chen >= 11 && eq >= need) return call(`${label} has ~${pct(eq)} vs ${vsText(ctx)} and needs ${pct(need)}`);
      return fold(`${label} has only ~${pct(eq)} vs ${vsText(ctx)}; needs ${pct(need)}`);
    }
    if (chen >= 11) return raiseTo(threeBetSize(ctx, ip), `${label} 3-bets for value (~${pct(eq)} vs ${vsText(ctx)})`);
    if (isWheelAce && ip && ctx.rng() < 0.35) {
      return raiseTo(threeBetSize(ctx, ip), `balanced 3-bet bluff with ${label}: the ace blocks their best hands and it can make the nut flush or a wheel`);
    }
    const bigBlindDefend = ctx.pos === 'Blinds' && ctx.toCall <= ctx.bb * 2.5 && chen >= BB_DEFEND_CHEN;
    // Out of position you rarely realise all your raw equity, so demand more.
    const realised = eq * (ip ? REALISE_IP : REALISE_OOP);
    if ((chen >= SHARK_CALL_CHEN || bigBlindDefend) && realised >= need + 0.02) {
      return call(`${label} has ~${pct(eq)} vs ${vsText(ctx)} (about ${pct(realised)} after playing ${ip ? 'in' : 'out of'} position) and only needs ${pct(need)} from pot odds`);
    }
    return fold(`${label} has ~${pct(eq)} vs ${vsText(ctx)}; the price needs ${pct(need)}. Folding saves money`);
  }

  function foldOrCheck(ctx, because) {
    return ctx.toCall === 0 ? check(because) : fold(because);
  }

  function allInOrRaise(ctx, because) {
    const target = ctx.currentBet * 2.5;
    return target >= (ctx.legal.maxRaiseTo || 0) * 0.5 ? allIn(because) : raiseTo(target, because);
  }

  // ------------------------------------------------------ postflop strategy
  function fishPostflop(ctx) {
    const made = madeInfo(ctx);
    const hand = handText(ctx);
    if (ctx.toCall === 0) {
      if (made.usesHole && made.cat >= 2 && ctx.rng() < 0.5) return raiseTo(ctx.pot * 0.5, `${hand}; a fish bets small even with a strong hand`);
      if (made.usesHole && made.cat === 1 && ctx.rng() < 0.2) return raiseTo(ctx.pot * 0.33, `${hand}; a little feeler bet`);
      return check(`${hand}; fish rarely take the lead`);
    }
    if (made.usesHole && made.cat >= 6 && ctx.rng() < 0.4) return raiseTo(ctx.currentBet * 2, `${hand}; finally a big hand worth raising`);
    if (made.usesHole && made.cat >= 3) return call(`${hand} is strong, but a fish just calls instead of raising for value`);
    if (made.usesHole && made.cat >= 1) return call(`${hand}: "can't fold a pair", even when beaten`);
    if (realDraw(ctx, 4)) return call(`chasing ${drawText(ctx)} regardless of the price (pot odds say ${pct(ctx.potOdds)} needed)`);
    const overcards = Math.min(ctx.hole[0].r, ctx.hole[1].r) > Math.max(...ctx.board.map((c) => c.r));
    if (overcards && ctx.street !== 'river' && ctx.rng() < 0.6) return call(`${handLabel(ctx.hole)} has overcards — "maybe an ace comes"`);
    if (ctx.rng() < 0.12) return call(`${hand}; just curious what they have`);
    return fold(`${hand}: nothing at all, even a fish lets this go`);
  }

  function multiwayThreshold(base, numOpp) {
    return Math.max(MIN_THRESHOLD, base - MULTIWAY_THRESHOLD_STEP * (numOpp - 1));
  }

  function valueBetFraction(ctx, profile) {
    if (ctx.vsStation) return 1; // stations pay off big bets
    if (profile.valueSize != null) return profile.valueSize;
    return boardIsWet(ctx.board) ? 0.75 : 0.5; // Shark: size by texture, not hand strength
  }

  function bluffFraction(ctx, profile) {
    return profile.bluffSize != null ? profile.bluffSize : valueBetFraction(ctx, profile);
  }

  function betTo(ctx, frac) {
    return ctx.myBet + ctx.pot * frac;
  }

  function raiseAmount(ctx, frac) {
    return ctx.currentBet + (ctx.pot + ctx.toCall) * frac;
  }

  const STRONG_DRAW_RE = /flush draw|open-ended/i;

  /** Flush draw or open-ender (8+ outs): the only draws worth semi-bluffing. */
  function hasStrongDraw(ctx) {
    const d = ctx.draws();
    return d.count >= 8 && d.draws.some((name) => STRONG_DRAW_RE.test(name));
  }

  /** Two pair (using both hole cards) or better: strong enough to re-raise a raise. */
  function isMonster(ctx) {
    if (!PP.Equity || typeof PP.Equity.handClass !== 'function') return madeInfo(ctx).cat >= 3;
    return PP.Equity.handClass(ctx.hole, ctx.board) === PP.Equity.RANGE_CLASS.STRONG;
  }

  function postflopEquityBot(ctx, profile) {
    return ctx.toCall === 0 ? checkedTo(ctx, profile) : facingBet(ctx, profile);
  }

  function checkedTo(ctx, profile) {
    const eq = ctx.equity();
    const hand = handText(ctx);
    const valueAt = multiwayThreshold(profile.value, ctx.numOpp);
    const sizeLabel = (f) => (f >= 1 ? 'pot' : f >= 0.7 ? '¾ pot' : f >= 0.6 ? '⅔ pot' : '½ pot');
    const thinValue = ctx.vsStation ? STATION_VALUE_BONUS : 0;
    if (eq >= valueAt - thinValue) {
      const f = valueBetFraction(ctx, profile);
      if (ctx.vsStation && eq < valueAt) {
        return raiseTo(betTo(ctx, f), `thin value bet with ${hand} (~${pct(eq)}): they call with worse far too often, so bet any decent hand and never bluff them`);
      }
      const tell = ctx.bot.rating === 2 ? '; Rookies bet big only with strong hands' : '';
      return raiseTo(betTo(ctx, f), `value bet (${sizeLabel(f)}) with ${hand}: ~${pct(eq)} equity vs ${vsText(ctx)}${tell}`);
    }
    if (ctx.vsStation) return check(`${hand} with ~${pct(eq)}: no bluffs against a calling station, they won't fold`);
    const bluffBet = betTo(ctx, bluffFraction(ctx, profile));
    if (ctx.street === 'flop' && ctx.wasAggressor && ctx.numOpp <= 2 && ctx.rng() < profile.cbet) {
      return raiseTo(bluffBet, `continuation bet as the preflop raiser with ${hand} (~${pct(eq)}): the flop misses most hands, so they fold often`);
    }
    const scare = scareCardReason(ctx.board);
    if (ctx.street !== 'flop' && ctx.wasAggressor && scare && ctx.numOpp === 1 && ctx.rng() < profile.barrel) {
      return raiseTo(bluffBet, `barreling ${scare}: it hits my perceived range more than theirs (${hand}, ~${pct(eq)})`);
    }
    if (ctx.street !== 'river' && hasStrongDraw(ctx) && ctx.rng() < profile.semi) {
      return raiseTo(bluffBet, `semi-bluff with ${drawText(ctx)} + fold equity`);
    }
    const scary = scaryBoardReason(ctx.board);
    if (ctx.street === 'river' && eq < 0.25 && scary && ctx.numOpp === 1 && ctx.rng() < profile.riverBluff) {
      const f = bluffFraction(ctx, profile);
      return raiseTo(bluffBet, `river bluff because ${scary}: my hand can't win at showdown, and a ${sizeLabel(f)} bluff only needs to work ${pct(f / (1 + f))} of the time`);
    }
    if (ctx.numOpp === 1 && ctx.rng() < profile.stab) {
      return raiseTo(bluffBet, `stab at the pot after it was checked to me (${hand}, ~${pct(eq)})`);
    }
    return check(`${hand} with ~${pct(eq)} equity vs ${vsText(ctx)}; not strong enough to bet for value`);
  }

  function requiredEquity(ctx, profile) {
    const drawing = ctx.street !== 'river' && realDraw(ctx, 4);
    if (!profile.implied || !drawing) return { need: ctx.potOdds, implied: false };
    const remaining = Math.max(0, ctx.effStack - ctx.toCall);
    const impliedWin = Math.min(remaining, ctx.pot) * IMPLIED_FRACTION;
    return { need: ctx.toCall / (ctx.pot + ctx.toCall + impliedWin), implied: true };
  }

  function facingBet(ctx, profile) {
    const eq = ctx.equity();
    const hand = handText(ctx);
    const raiseAt = multiwayThreshold(profile.raise, ctx.numOpp);
    const { need, implied } = requiredEquity(ctx, profile);
    const odds = `needed ${pct(need)}${implied ? ' with implied odds' : ''}, had ~${pct(eq)}`;
    const facingRaise = ctx.pressure.facingRaise;
    if (eq >= raiseAt && (!facingRaise || isMonster(ctx))) {
      return raiseTo(raiseAmount(ctx, profile.raiseSize), `${hand} is strong (~${pct(eq)} vs ${vsText(ctx)}), raising for value`);
    }
    if (!facingRaise && !ctx.vsStation && ctx.street !== 'river' && hasStrongDraw(ctx) && ctx.numOpp === 1 && ctx.rng() < profile.semiRaise) {
      return raiseTo(raiseAmount(ctx, profile.raiseSize), `semi-bluff raise with ${drawText(ctx)} + fold equity`);
    }
    if (ctx.bot.rating === 2 && eq < 0.5 && ctx.toCall > ctx.pot * profile.drawFoldFrac) {
      return fold(`${hand} with ~${pct(eq)}; a Rookie won't pay a big bet without a made hand`);
    }
    if (eq >= need + profile.callMargin) return call(`${hand}: ${odds} vs ${vsText(ctx)}`);
    return fold(`${hand}: ${odds}. The price is too high`);
  }

  const PREFLOP = { 1: fishPreflop, 2: rookiePreflop, 3: regularPreflop, 4: grinderPreflop, 5: sharkPreflop };

  function chooseIntent(ctx) {
    if (ctx.hole.length !== 2) return check('no cards visible');
    if (ctx.street === 'preflop' || ctx.board.length < 3) return PREFLOP[ctx.bot.rating](ctx);
    if (ctx.bot.rating === 1) return fishPostflop(ctx);
    return postflopEquityBot(ctx, PROFILES[ctx.bot.rating]);
  }

  // ----------------------------------------------------- legality / output
  function passiveAction(legal) {
    if (legal.canCheck) return { type: 'check' };
    if (legal.canCall) return { type: 'call', amount: legal.callAmount };
    return { type: 'fold' };
  }

  function aggressiveAction(target, legal, unit, bb) {
    if (!legal.canBet && !legal.canRaise) return { action: passiveAction(legal), note: 'no raise was allowed' };
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    if (!(max > 0) || max <= min) return { action: { type: 'allin', amount: max } };
    const amount = clamp(roundToUnit(target, unit), min, max);
    if (amount >= max || max - amount < bb * SHOVE_REMAINDER_BB) return { action: { type: 'allin', amount: max } };
    return { action: { type: legal.canBet ? 'bet' : 'raise', amount } };
  }

  function toLegal(intent, legal, unit, bb) {
    switch (intent.kind) {
      case 'raise':
        return aggressiveAction(intent.to, legal, unit, bb);
      case 'allin':
        return aggressiveAction(Infinity, legal, unit, bb);
      case 'call':
        if (legal.canCall) return { action: { type: 'call', amount: legal.callAmount } };
        return { action: passiveAction(legal) };
      case 'check':
        if (legal.canCheck) return { action: { type: 'check' } };
        return { action: { type: 'fold' } };
      default:
        if (legal.canCheck) return { action: { type: 'check' }, note: 'checking is free, so no need to fold' };
        return { action: { type: 'fold' } };
    }
  }

  function verb(action) {
    switch (action.type) {
      case 'fold': return 'Folded';
      case 'check': return 'Checked';
      case 'call': return `Called ${fmt(action.amount)}`;
      case 'bet': return `Bet ${fmt(action.amount)}`;
      case 'raise': return `Raised to ${fmt(action.amount)}`;
      default: return `Went all-in (${fmt(action.amount)})`;
    }
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function reasoningFor(action, intent, note) {
    const because = capitalize(intent.because || 'gut feeling');
    const tail = note ? ` (${note})` : '';
    return `${verb(action)}: ${because}${tail}.`.replace(/\.\.$/, '.');
  }

  function safeFallback(legal) {
    return passiveAction(legal || { canFold: true });
  }

  // ------------------------------------------------------------- public API
  function decide(bot, view, legal, me) {
    try {
      if (bot.rating === 5) observe(bot, view);
      const ctx = buildContext(bot, view, legal, me);
      const intent = chooseIntent(ctx);
      const { action, note } = toLegal(intent, legal, ctx.sb, ctx.bb);
      bot.lastReasoning = reasoningFor(action, intent, note);
      return Object.freeze(action);
    } catch (err) {
      const action = safeFallback(legal);
      bot.lastReasoning = `${verb(action)}: (played safe after an internal error: ${err && err.message ? err.message : err}).`;
      return Object.freeze(action);
    }
  }

  function create(opts) {
    const options = opts || {};
    const rating = clamp(Math.round(Number(options.rating) || 3), 1, 5);
    const meta = RATINGS[rating];
    const bot = {
      id: options.id,
      name: options.name || randomName([]),
      rating,
      title: meta.title,
      style: meta.style,
      blurb: meta.blurb,
      rng: typeof options.rng === 'function' ? options.rng : null,
      lastReasoning: '',
      reads: rating === 5 ? {} : null,
      readHand: null,
    };
    bot.decide = (view, legal, me) => decide(bot, view, legal, me);
    return bot;
  }

  function randomName(usedNames, rng) {
    const used = new Set(usedNames || []);
    const random = rng || (PP.Cards && PP.Cards.rng) || Math.random;
    const free = BOT_NAMES.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(random() * free.length)];
    let i = 2;
    const base = BOT_NAMES[Math.floor(random() * BOT_NAMES.length)];
    while (used.has(`${base} ${i}`)) i += 1;
    return `${base} ${i}`;
  }

  PP.Bots = Object.freeze({
    RATINGS,
    NAMES: BOT_NAMES,
    create,
    randomName,
    chenScore,
    handLabel,
  });
})();
