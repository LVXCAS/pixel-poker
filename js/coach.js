/* PIXEL HOLD'EM — PP.Coach
 * Teaching layer: per-decision advice, action grading, post-hand review and drills.
 * Pure / DOM-free. Depends on PP.Cards, PP.Eval, PP.Equity (see CONTRACT.md).
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  // ---------------------------------------------------------------- constants
  const ADVICE_ITERATIONS = 1500;
  const OPEN_RAISE_BB = 2.5;
  const LIMPER_EXTRA_BB = 1;
  const THREE_BET_MULT = 3;
  const RAISE_MULT = 3;
  const VALUE_BET_FRACTION = 0.66;
  const WET_VALUE_BET_FRACTION = 0.75;
  const SEMI_BLUFF_FRACTION = 0.5;
  const RANGE_ITERATIONS = 900;
  const NUT_BEATEN_MAX = 0.02;   // "near the nuts": at most 2% of opponent holdings beat you now
  const SHOWDOWN_SHARE = 0.05;   // what an unpaired hand wins at showdown vs a betting range
  const BB_DEFEND_MAX_BB = 3;
  const BUTTON_STEAL_CHEN = 3;   // folded to the Button: raise any hand at least this good
  const BB_DEFEND_MARGIN = 0.05;
  const VALUE_EDGE = 0.2;
  const VALUE_CAP = 0.65;
  const RAISE_EDGE = 0.15;
  const IMPLIED_MARGIN = 0.05;
  const IMPLIED_MAX_STACK_FRACTION = 0.2;
  const BIG_DRAW_OUTS = 8;
  const SHOVE_STACK_FRACTION = 0.4;
  const STRONG_CALL_MAX_BB = 12;
  const PLAYABLE_CALL_MAX_BB = 4;
  const CONF_HIGH = 0.15;
  const CONF_MED = 0.05;
  const MAX_REASONS = 5;
  const MIN_REASONS = 2;

  const TIER_RANK = { Trash: 0, Marginal: 1, Playable: 2, Strong: 3, Premium: 4 };
  const TIER_BLURB = {
    Premium: 'a Premium hand (roughly the top 5% of starting hands)',
    Strong: 'a Strong hand (roughly the top 12%)',
    Playable: 'a Playable hand (top ~25%) — good in the right spot',
    Marginal: 'a Marginal hand — only worth playing cheaply or from late position',
    Trash: 'a Trash hand — folding it saves money over time',
  };
  const POSITION_TIP = {
    Early: 'Early position: most of the table acts after you, so play tight.',
    Middle: 'Middle position: a few players still act behind you — stay fairly selective.',
    Late: 'Late position: few players left behind you, so you can open more hands.',
    Button: 'On the Button you act last after the flop — the best seat to play more hands.',
    Blinds: 'In the blinds you will act first after the flop (out of position), so be careful.',
  };
  const CAT_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  const GRADE_ORDER = ['BLUNDER', 'MISTAKE', 'OK', 'GOOD', 'GREAT'];
  const SUIT_WORD = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  const LESSONS = {
    potOdds: 'Compare your equity to the pot odds before calling: required equity = call ÷ (pot + call). Only call when your chance to win is higher.',
    impliedOdds: 'Drawing hands can call a little light when stacks are deep — if you hit, you can win more later (implied odds).',
    value: 'When you are likely ahead, bet. Checking strong hands lets opponents see free cards and costs you value.',
    semiBluff: 'Betting a strong draw (a semi-bluff) wins two ways: opponents fold now (fold equity) or you hit your outs.',
    preflop: 'Starting-hand selection is the biggest leak for new players: play fewer, stronger hands — especially from early position.',
    position: 'Position is power: acting last lets you see what others do first. Play more hands on the Button, fewer up front.',
    freeFold: 'Never fold when you can check for free — a free card can only help you.',
    nuts: 'With the nuts or near-nuts, never fold — build the pot.',
    bbDefend: 'In the big blind you already have chips in, so you get a discount: defend reasonable hands against small raises.',
    results: 'Judge decisions, not results. A +EV play can lose a hand, and a bad call can get lucky — over many hands the math wins.',
  };

  // ------------------------------------------------------------------ helpers
  const pct = (x) => `${Math.round(x * 100)}%`;
  const money = (n) => `$${Math.round(n)}`;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const handLabel = (hole) => PP.Equity.handLabel(hole);
  const isAggressive = (t) => t === 'bet' || t === 'raise' || t === 'allin';

  function findPlayer(view, id) {
    return (view.players || []).find((p) => p.id === id) || null;
  }

  function activeOpponents(view, heroId) {
    return (view.players || []).filter((p) => p.id !== heroId && !p.folded && !p.out);
  }

  function seatedInOrderAfter(view, seat) {
    const seated = (view.players || []).filter((p) => !p.out).slice().sort((a, b) => a.seat - b.seat);
    const after = seated.filter((p) => p.seat > seat);
    const before = seated.filter((p) => p.seat <= seat);
    return after.concat(before);
  }

  function positionOf(view, heroId) {
    const hero = findPlayer(view, heroId);
    if (!hero) return 'Middle';
    if (hero.seat === view.dealerSeat) return 'Button';
    if (hero.seat === view.sbSeat || hero.seat === view.bbSeat) return 'Blinds';
    const special = [view.dealerSeat, view.sbSeat, view.bbSeat];
    const order = seatedInOrderAfter(view, view.bbSeat).filter((p) => !special.includes(p.seat));
    const idx = order.findIndex((p) => p.id === heroId);
    const fromEnd = order.length - 1 - idx;
    if (fromEnd === 0) return 'Late';
    if (idx === 0 && order.length <= 3) return 'Early';
    return fromEnd <= 2 ? 'Middle' : 'Early';
  }

  function isInPosition(view, heroId) {
    const order = seatedInOrderAfter(view, view.dealerSeat).filter((p) => !p.folded);
    return order.length > 0 && order[order.length - 1].id === heroId;
  }

  function toCallOf(legal) {
    return (legal && (legal.toCall != null ? legal.toCall : legal.callAmount)) || 0;
  }

  function fairShare(nOpp) {
    return 1 / (Math.max(1, nOpp) + 1);
  }

  function valueThreshold(nOpp) {
    return Math.min(VALUE_CAP, fairShare(nOpp) + VALUE_EDGE);
  }

  /**
   * Per-opponent ranges from what each opponent has done this hand. If the view
   * has no history (e.g. tests) but hero faces a bet, the biggest bettor is put
   * on a one-bet range so the coach never treats a bettor as a random hand.
   */
  function opponentRanges(view, heroId, opponents, toCall, street) {
    const E = PP.Equity;
    const pressure = E.pressureFromHistory(view.history, heroId, view.bigBlind || 0, street);
    const pre = street === 'preflop';
    const ranges = opponents.map((p) => {
      const r = pressure.byPlayer[p.id];
      if (!r) return null;
      return E.villainRange(pre ? { preLevel: r.preLevel } : r);
    });
    if (toCall > 0 && !ranges.some(Boolean)) {
      const top = opponents.reduce((a, p) => (!a || (p.bet || 0) > (a.bet || 0) ? p : a), null);
      const facingRaisePre = pre && (view.currentBet || 0) > (view.bigBlind || 0);
      if (top && (!pre || facingRaisePre)) {
        ranges[opponents.indexOf(top)] = E.villainRange(pre ? { preLevel: 1 } : { postLevel: 1 });
      }
    }
    return { ranges: ranges.some(Boolean) ? ranges : null, pressure };
  }

  /** Fraction of possible opponent holdings that beat hero's made hand right now. */
  function beatenFraction(hole, board) {
    if (board.length < 3) return 1;
    const E = PP.Eval;
    const known = hole.concat(board);
    const mine = E.scoreOnly(known);
    const deck = PP.Equity.remainingDeck(known);
    const cards = board.slice();
    let beats = 0;
    let total = 0;
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        total += 1;
        if (E.scoreOnly(cards.concat([deck[i], deck[j]])) > mine) beats += 1;
      }
    }
    return total ? beats / total : 1;
  }

  /** Equity of a hand with no pair facing a bet: its draw, plus a little showdown value. */
  function unpairedCap(s) {
    if (!s.made || s.made.cat >= 1 || s.toCall <= 0) return 1;
    const drawPct = s.board.length < 5 ? PP.Equity.ruleOf2and4(s.outs.count, s.board.length) / 100 : 0;
    return Math.max(drawPct, SHOWDOWN_SHARE);
  }

  function confidenceFor(margin) {
    const m = Math.abs(margin);
    if (m >= CONF_HIGH) return 'high';
    return m >= CONF_MED ? 'med' : 'low';
  }

  // Turn an intended action into a legal one.
  function legalize(intent, legal) {
    const { type } = intent;
    if (isAggressive(type) && (legal.canBet || legal.canRaise)) {
      const lo = legal.minRaiseTo || 0;
      const hi = legal.maxRaiseTo || lo;
      const amount = Math.round(clamp(intent.amount || lo, lo, hi));
      return { type: legal.canBet ? 'bet' : 'raise', amount };
    }
    if (isAggressive(type) || type === 'call') {
      if (legal.canCall && toCallOf(legal) > 0) return { type: 'call' };
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    }
    if (type === 'fold') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  // ------------------------------------------------------------- situation
  function buildSituation(view, legal, heroId, opts) {
    const hero = findPlayer(view, heroId);
    const hole = (hero && hero.hole) || [];
    const board = view.board || [];
    const opponents = activeOpponents(view, heroId);
    const nOpp = Math.max(1, opponents.length);
    const toCall = toCallOf(legal);
    const pot = view.pot || 0;
    const mc = PP.Equity.monteCarlo({
      hero: hole, board, opponents: nOpp,
      iterations: opts.iterations || ADVICE_ITERATIONS, rng: opts.rng,
    });
    const postflop = board.length >= 3;
    const street = view.street || streetFromBoard(board);
    const { ranges, pressure } = opponentRanges(view, heroId, opponents.slice(0, nOpp), toCall, street);
    const rangeEq = ranges ? PP.Equity.monteCarlo({
      hero: hole, board, opponents: nOpp, oppWeight: ranges,
      iterations: Math.round((opts.iterations || ADVICE_ITERATIONS) * RANGE_ITERATIONS / ADVICE_ITERATIONS), rng: opts.rng,
    }).equity : mc.equity;
    const s = {
      view, legal, heroId, hero, hole, board, opponents, nOpp, toCall, pot, street, pressure,
      rangeAware: !!ranges,
      bb: view.bigBlind || 1,
      heroStack: hero ? hero.stack : 0,
      equity: mc.equity,
      adjEquity: rangeEq,
      potOdds: PP.Equity.potOdds(toCall, pot),
      position: positionOf(view, heroId),
      inPosition: isInPosition(view, heroId),
      tier: PP.Equity.preflopTier(hole),
      label: handLabel(hole),
      made: postflop ? PP.Eval.evaluate(hole.concat(board)) : null,
      outs: postflop && board.length < 5 ? PP.Equity.outs(hole, board) : { count: 0, cards: [], draws: [] },
      texture: postflop ? PP.Equity.boardTexture(board) : null,
    };
    s.adjEquity = Math.min(s.adjEquity, unpairedCap(s));
    s.beaten = postflop ? beatenFraction(hole, board) : 1;
    s.nutted = postflop && s.made.cat >= 3 && s.beaten * nOpp <= NUT_BEATEN_MAX;
    return s;
  }

  function streetFromBoard(board) {
    return ['preflop', 'preflop', 'preflop', 'flop', 'turn', 'river'][board.length] || 'river';
  }

  // ------------------------------------------------------- preflop decisions
  function countLimpers(s) {
    const { view, heroId, bb } = s;
    return (view.players || []).filter((p) => p.id !== heroId && !p.folded && !p.out &&
      p.seat !== view.bbSeat && p.seat !== view.sbSeat && p.bet === bb).length;
  }

  /** Heads-up (or blind vs blind) everyone plays far more hands: shift the tier up. */
  function effectiveRank(s, rank) {
    const shortHanded = s.view.players.filter((p) => !p.out).length;
    if (shortHanded <= 2) return Math.min(TIER_RANK.Premium, rank + 2);
    if (shortHanded <= 3) return Math.min(TIER_RANK.Premium, rank + 1);
    return rank;
  }

  function preflopUnopened(s, rank) {
    const late = s.position === 'Late' || s.position === 'Button';
    const headsUp = s.view.players.filter((p) => !p.out).length <= 2;
    if (headsUp && s.toCall > 0 && rank < TIER_RANK.Marginal) {
      // Heads-up small blind: completing is cheap; fold only true junk the price doesn't cover.
      return s.adjEquity >= s.potOdds ? { type: 'call', concept: 'potOdds' } : { type: 'fold', concept: 'preflop' };
    }
    const openTo = s.bb * (OPEN_RAISE_BB + LIMPER_EXTRA_BB * countLimpers(s));
    if (s.toCall === 0) {
      return rank >= TIER_RANK.Strong ? { type: 'raise', amount: openTo, concept: 'value' }
        : { type: 'check', concept: 'freeFold' };
    }
    if (rank >= TIER_RANK.Strong) return { type: 'raise', amount: openTo, concept: 'value' };
    if (rank === TIER_RANK.Playable) {
      const tooEarly = s.position === 'Early' && s.view.players.length >= 6;
      return tooEarly ? { type: 'fold', concept: 'position' } : { type: 'raise', amount: openTo, concept: 'position' };
    }
    if (rank === TIER_RANK.Marginal && late) return { type: 'raise', amount: openTo, concept: 'position' };
    const steal = s.position === 'Button' && countLimpers(s) === 0 && PP.Equity.chenScore(s.hole) >= BUTTON_STEAL_CHEN;
    if (steal) return { type: 'raise', amount: openTo, concept: 'position' };
    return { type: 'fold', concept: 'preflop' };
  }

  function isBigBlind(s) {
    return s.hero && s.hero.seat === s.view.bbSeat;
  }

  function preflopFacingRaise(s, rank) {
    const raiseBB = s.view.currentBet / s.bb;
    const isShove = s.toCall >= s.heroStack * SHOVE_STACK_FRACTION;
    if (isShove) {
      const ok = rank === TIER_RANK.Premium || (rank === TIER_RANK.Strong && s.adjEquity >= s.potOdds);
      return ok ? { type: 'call', concept: 'potOdds' } : { type: 'fold', concept: 'potOdds' };
    }
    if (rank === TIER_RANK.Premium) {
      return { type: 'raise', amount: s.view.currentBet * THREE_BET_MULT, concept: 'value' };
    }
    if (rank === TIER_RANK.Strong && raiseBB <= STRONG_CALL_MAX_BB) return { type: 'call', concept: 'preflop' };
    const goodSeat = s.position !== 'Early' && s.position !== 'Middle';
    if (rank === TIER_RANK.Playable && raiseBB <= PLAYABLE_CALL_MAX_BB && goodSeat) {
      return { type: 'call', concept: 'position' };
    }
    const bbDefend = isBigBlind(s) && raiseBB <= BB_DEFEND_MAX_BB && rank >= TIER_RANK.Marginal &&
      s.adjEquity >= s.potOdds + BB_DEFEND_MARGIN;
    if (bbDefend) return { type: 'call', concept: 'bbDefend' };
    return { type: 'fold', concept: 'preflop' };
  }

  function decidePreflop(s) {
    const baseRank = TIER_RANK[s.tier] != null ? TIER_RANK[s.tier] : 0;
    const facingRaise = (s.view.currentBet || 0) > s.bb;
    const rank = facingRaise ? baseRank : effectiveRank(s, baseRank);
    s.effTier = Object.keys(TIER_RANK).find((k) => TIER_RANK[k] === rank);
    const intent = facingRaise ? preflopFacingRaise(s, rank) : preflopUnopened(s, rank);
    const margin = (rank - 2) / 4 + (s.adjEquity - Math.max(s.potOdds, fairShare(s.nOpp)));
    return withConflictCheck(s, { ...intent, confidence: confidenceFor(margin) });
  }

  /**
   * If the coach says FOLD while the price is right, never claim high confidence:
   * the learner sees the equity bar past the NEED marker and deserves the "why".
   */
  function withConflictCheck(s, intent) {
    if (intent.type !== 'fold' || s.toCall <= 0 || s.adjEquity < s.potOdds) return intent;
    return { ...intent, confidence: 'low', conflict: true };
  }

  // ------------------------------------------------------ postflop decisions
  function postflopNoBet(s) {
    const strong = s.nutted || s.adjEquity >= valueThreshold(s.nOpp);
    if (strong) {
      const frac = s.texture && s.texture.wet ? WET_VALUE_BET_FRACTION : VALUE_BET_FRACTION;
      return { type: 'bet', amount: s.pot * frac, concept: 'value',
        confidence: confidenceFor(s.adjEquity - valueThreshold(s.nOpp) + CONF_MED) };
    }
    const canSemiBluff = s.board.length < 5 && s.outs.count >= BIG_DRAW_OUTS && (s.nOpp <= 2 || s.inPosition);
    if (canSemiBluff) {
      return { type: 'bet', amount: s.pot * SEMI_BLUFF_FRACTION, concept: 'semiBluff', confidence: 'med' };
    }
    return { type: 'check', concept: 'freeFold', confidence: confidenceFor(valueThreshold(s.nOpp) - s.adjEquity) };
  }

  function postflopFacingBet(s) {
    const margin = s.adjEquity - s.potOdds;
    // Facing a raise, only two pair+ (or the nuts) re-raises; one pair just calls or folds.
    const facingRaise = s.pressure && s.pressure.facingRaise;
    const strongEnough = !facingRaise || s.nutted || (s.made && s.made.cat >= 3);
    if (s.nutted || (strongEnough && s.adjEquity >= valueThreshold(s.nOpp) + RAISE_EDGE)) {
      return { type: 'raise', amount: s.view.currentBet * RAISE_MULT, concept: s.nutted ? 'nuts' : 'value', confidence: 'high' };
    }
    if (margin >= 0) return { type: 'call', concept: 'potOdds', confidence: confidenceFor(margin) };
    const implied = s.board.length < 5 && s.outs.count >= BIG_DRAW_OUTS &&
      margin >= -IMPLIED_MARGIN && s.toCall <= s.heroStack * IMPLIED_MAX_STACK_FRACTION;
    if (implied) return { type: 'call', concept: 'impliedOdds', confidence: 'low' };
    return withConflictCheck(s, { type: 'fold', concept: 'potOdds', confidence: confidenceFor(margin) });
  }

  function decidePostflop(s) {
    return s.toCall > 0 ? postflopFacingBet(s) : postflopNoBet(s);
  }

  // ----------------------------------------------------------------- reasons
  function kickerProblem(hole) {
    const [a, b] = hole;
    if (!a || !b || a.r === b.r || a.s === b.s) return false;
    const hi = Math.max(a.r, b.r);
    const lo = Math.min(a.r, b.r);
    return hi >= 12 && lo <= 9;
  }

  function dominatedRisk(hole) {
    const [a, b] = hole;
    if (!a || !b || a.r === b.r || a.s === b.s) return false;
    const hi = Math.max(a.r, b.r);
    const lo = Math.min(a.r, b.r);
    return hi >= 11 && lo >= 10 && !(hi === 14 && lo === 13);
  }

  function preflopHandNote(s, facingRaise) {
    const [a, b] = s.hole;
    if (!a || !b) return null;
    if (a.r === b.r && a.r <= 9) {
      return 'Small pairs mostly win by flopping a set (~12% of the time) — they want a cheap price.';
    }
    if (a.s === b.s && Math.abs(a.r - b.r) <= 2 && Math.max(a.r, b.r) <= 11) {
      return 'Suited connectors make straights and flushes — great cheaply and in position, weak vs big raises.';
    }
    if (facingRaise && kickerProblem(s.hole)) {
      return `Kicker problem: when ${s.label} pairs its big card, a raiser with the same card usually has a better kicker.`;
    }
    if (facingRaise && dominatedRisk(s.hole)) {
      return `Dominated hand: vs a raise, ${s.label} often runs into AK/AQ/KQ that share a card and out-kick you.`;
    }
    return null;
  }

  function tierSentence(s, rec) {
    const playingWeakHand = rec && (rec.type === 'raise' || rec.type === 'bet') && TIER_RANK[s.tier] <= TIER_RANK.Marginal;
    if (playingWeakHand && rec.concept === 'position') {
      return `${s.label} is only ${s.tier} on its own, but it's folded to you on the Button — a raise here wins the blinds often enough to profit with almost any two cards.`;
    }
    if (s.effTier && s.effTier !== s.tier) {
      const table = s.view.players.filter((p) => !p.out).length <= 2 ? 'Heads-up' : 'Three-handed';
      return `${s.label} is only ${s.tier} at a full table, but ${table.toLowerCase()} it plays like a ${s.effTier} hand — with so few opponents, average hands win far more often.`;
    }
    return `${s.label} is ${TIER_BLURB[s.tier] || 'a hand'}.`;
  }

  function preflopReasons(s, rec) {
    const facingRaise = (s.view.currentBet || 0) > s.bb;
    const out = [tierSentence(s, rec)];
    if (facingRaise) out.push(`Someone raised to ${(s.view.currentBet / s.bb).toFixed(1)} BB — raisers usually hold stronger-than-average hands.`);
    out.push(POSITION_TIP[s.position]);
    const note = preflopHandNote(s, facingRaise);
    if (note) out.push(note);
    if (s.toCall > 0 && (facingRaise || rec.type === 'call')) {
      out.push(potOddsSentence(s, rec));
      if (rec.conflict) out.push(conflictReason(s));
    } else out.push(`Vs ${s.nOpp} random hand${s.nOpp > 1 ? 's' : ''} you have ~${pct(s.equity)} equity (fair share ${pct(fairShare(s.nOpp))}).`);
    return out;
  }

  function potOddsSentence(s, rec) {
    const ok = s.adjEquity >= s.potOdds;
    const rangeWord = s.street === 'preflop' ? 'a raising range' : 'a betting range';
    const adj = Math.abs(s.adjEquity - s.equity) >= 0.005 ? ` (~${pct(s.adjEquity)} vs ${rangeWord})` : '';
    let verdict = ok ? 'Calling is +EV.' : 'Calling loses money long-term.';
    if (ok && rec && rec.type === 'fold') verdict = 'The raw odds look OK, but see below for why folding is still better.';
    return `Pot odds: call ${money(s.toCall)} to win ${money(s.pot)} → you need ${pct(s.potOdds)} equity; you have ~${pct(s.equity)}${adj}. ${verdict}`;
  }

  /** Why fold when the price looks right? (shown when withConflictCheck fired) */
  function conflictReason(s) {
    if (s.street === 'preflop') {
      const oop = s.position === 'Blinds' || s.position === 'Early';
      return `Pot odds say call, but ${s.label} ${oop ? 'plays out of position and ' : ''}rarely wins a big pot when it hits — weak hands realise less than their raw equity.`;
    }
    return 'Pot odds say call, but future bets will cost more and your hand rarely improves to a winner — fold and wait for a better spot.';
  }

  function outsSentence(s) {
    if (!s.outs.count) return null;
    const mult = s.board.length === 3 ? 4 : 2;
    const est = PP.Equity.ruleOf2and4(s.outs.count, s.board.length);
    const drawText = s.outs.draws && s.outs.draws.length ? ` (${s.outs.draws.join(' + ')})` : '';
    const rule = mult === 4 ? 'Rule of 4' : 'Rule of 2';
    const when = mult === 4 ? 'by the river' : 'on the river';
    return `You have ${s.outs.count} outs${drawText}. ${rule}: ${s.outs.count}×${mult} ≈ ${Math.round(est)}% to hit ${when}.`;
  }

  function suitCounts(cards) {
    return cards.reduce((acc, c) => ({ ...acc, [c.s]: (acc[c.s] || 0) + 1 }), {});
  }

  /** What a scary board means for the hand hero ACTUALLY has. */
  function holdingWord(madeCat) {
    if (madeCat <= 0) return 'you have nothing yet, so there is little reason to continue';
    if (madeCat === 1) return 'be careful with one pair';
    if (madeCat <= 3) return 'your hand can already be behind';
    if (madeCat <= 5) return 'even your ' + (madeCat === 4 ? 'straight' : 'flush') + ' can lose';
    return 'you are still in great shape';
  }

  function textureDanger(s) {
    const counts = suitCounts(s.board);
    const madeCat = s.made ? s.made.cat : 0;
    const heroSuits = s.hole.map((c) => c.s);
    const flushSuit = Object.keys(counts).find((k) => counts[k] >= 3);
    if (flushSuit && madeCat < 5 && !heroSuits.includes(flushSuit)) {
      const n = counts[flushSuit];
      const word = SUIT_WORD[flushSuit];
      if (n >= 4) return `${n} ${word} on board — any single ${word.slice(0, -1)} in an opponent's hand beats you.`;
      return `Three ${word} on board — anyone holding two ${word} already has a flush.`;
    }
    if (s.texture && s.texture.paired && madeCat < 6) {
      return `Paired board — trips and full houses are possible; ${holdingWord(madeCat)}.`;
    }
    if (s.texture && s.texture.connected && madeCat < 4) {
      return `Connected board — straights are possible; ${holdingWord(madeCat)}.`;
    }
    if (s.texture && s.texture.wet && madeCat >= 1 && madeCat < 4) return 'Wet board (lots of draws) — bet to charge draws rather than give free cards.';
    return null;
  }

  function topPairKickerNote(s) {
    if (!s.made || s.made.cat !== 1) return null;
    const topBoard = Math.max(...s.board.map((c) => c.r));
    const [a, b] = s.hole;
    const paired = [a, b].find((c) => c.r === topBoard);
    if (!paired || a.r === b.r) return null;
    const kicker = paired === a ? b : a;
    return kicker.r <= 9 ? `Top pair, weak kicker (${PP.Cards.rankName(kicker.r)}): if someone else has top pair, their kicker likely beats yours.` : null;
  }

  function nutFlushDrawNote(s) {
    if (s.board.length >= 5 || (s.made && s.made.cat >= 5)) return null;
    const counts = suitCounts(s.board);
    const ace = s.hole.find((c) => c.r === 14);
    if (!ace) return null;
    const heroSuited = s.hole.filter((c) => c.s === ace.s).length;
    return (counts[ace.s] || 0) + heroSuited === 4
      ? 'Nut flush draw: your Ace makes the best possible flush if it comes in.' : null;
  }

  function actionReason(s, rec) {
    switch (rec.concept) {
      case 'nuts': return 'You have (near) the nuts — almost no hand beats you right now, so build the pot.';
      case 'value': return s.nutted
        ? 'You have (near) the nuts — almost no hand beats you right now, so build the pot.'
        : 'You are likely ahead of their range — bet/raise for value so worse hands pay you.';
      case 'semiBluff': return 'Semi-bluff: betting your draw wins if they fold now (fold equity) OR if you hit.';
      case 'impliedOdds': return 'Slightly short on direct odds, but if you hit you can win more later (implied odds).';
      case 'freeFold': return s.toCall === 0 ? 'Checking is free — take the free card rather than putting money in behind.' : null;
      default: return null;
    }
  }

  const PREFLOP_WHY = {
    raise: (s) => `${s.label} plays as a ${s.effTier || s.tier} hand here — strong enough to raise from ${seatWord(s)}.`,
    call: (s) => (s.toCall > 0 && (s.view.currentBet || 0) <= s.bb
      ? `Completing is cheap here: ${pct(s.potOdds)} needed and ${s.label} has ~${pct(s.adjEquity)}.`
      : `${s.label} is worth a call at this price (${pct(s.potOdds)} needed, ~${pct(s.adjEquity)} equity).`),
    check: (s) => `${s.label} isn't strong enough to raise, and checking is free.`,
    fold: (s) => `${s.label} is a ${s.effTier || s.tier} hand; playing it from ${seatWord(s)} loses money over time.`,
  };

  function seatWord(s) {
    if (s.position === 'Blinds') return 'the blinds';
    if (s.position === 'Button') return 'the Button';
    return s.position.toLowerCase() + ' position';
  }

  /** The one sentence that justifies the recommended action (quoted by grade()). */
  function whyFor(s, rec, isPre) {
    if (rec.conflict) return conflictReason(s);
    if (rec.concept === 'bbDefend') return LESSONS.bbDefend;
    if (isPre) {
      const t = isAggressive(rec.type) ? 'raise' : rec.type;
      return (PREFLOP_WHY[t] || PREFLOP_WHY.fold)(s);
    }
    const action = actionReason(s, rec);
    if (action) return action;
    if (s.toCall > 0) {
      return s.adjEquity >= s.potOdds
        ? `Your ~${pct(s.adjEquity)} equity vs their range beats the ${pct(s.potOdds)} price, so calling makes money over time.`
        : `Your ~${pct(s.adjEquity)} equity vs their range is below the ${pct(s.potOdds)} price, so folding saves money.`;
    }
    return LESSONS[rec.concept] || LESSONS.potOdds;
  }

  function postflopReasons(s, rec) {
    const out = [];
    if (s.made) out.push(`You have ${s.made.desc}.`);
    if (s.toCall > 0) {
      out.push(potOddsSentence(s, rec));
      if (rec.conflict) out.push(conflictReason(s));
    } else out.push(`Your equity vs ${s.nOpp} opponent${s.nOpp > 1 ? 's' : ''} is ~${pct(s.equity)} (fair share ${pct(fairShare(s.nOpp))}).`);
    [outsSentence(s), nutFlushDrawNote(s), textureDanger(s), topPairKickerNote(s), actionReason(s, rec)]
      .filter(Boolean).forEach((r) => out.push(r));
    if (s.nOpp >= 3) out.push(`Against ${s.nOpp} opponents someone often has a piece — you need a stronger hand to continue.`);
    if (s.toCall === 0 && s.inPosition) out.push('You are in position (acting last) — you control the pot size.');
    return out;
  }

  function finalizeReasons(list) {
    const unique = list.filter((r, i) => r && list.indexOf(r) === i);
    const trimmed = unique.slice(0, MAX_REASONS);
    return trimmed.length >= MIN_REASONS ? trimmed : trimmed.concat(LESSONS.results).slice(0, MAX_REASONS);
  }

  // ------------------------------------------------------------------- advise
  function advise(view, legal, heroId, opts) {
    const s = buildSituation(view, legal || {}, heroId, opts || {});
    const isPre = s.board.length < 3;
    const intent = isPre ? decidePreflop(s) : decidePostflop(s);
    const recommendation = legalize(intent, s.legal);
    const effective = { ...intent, type: recommendation.type };
    const reasons = finalizeReasons(isPre ? preflopReasons(s, effective) : postflopReasons(s, effective));
    const why = whyFor(s, effective, isPre);
    return Object.freeze({
      street: s.street,
      holeLabel: s.label,
      preflopTier: s.tier,
      made: s.made ? s.made.desc : null,
      madeCat: s.made ? s.made.cat : null,
      equity: s.equity,
      adjEquity: s.adjEquity,
      potOdds: s.potOdds,
      outs: s.outs,
      texture: s.texture,
      position: s.position,
      recommendation,
      confidence: intent.confidence,
      concept: intent.concept,
      toCall: s.toCall,
      pot: s.pot,
      heroStack: s.heroStack,
      opponents: s.nOpp,
      nutted: s.nutted,
      preflopRaised: s.board.length < 3 && (s.view.currentBet || 0) > s.bb,
      bigBlind: s.bb,
      tierRank: TIER_RANK[s.tier] != null ? TIER_RANK[s.tier] : 0,
      why,
      reasons,
    });
  }

  // -------------------------------------------------------------------- grade
  function actionCategory(action, advice) {
    const t = action && action.type;
    if (t === 'fold') return 'fold';
    if (t === 'allin' && (advice.toCall || 0) >= (advice.heroStack || 0)) return 'call';
    if (isAggressive(t)) return 'aggressive';
    return t === 'call' ? 'call' : 'check';
  }

  function recCategory(advice) {
    const t = advice.recommendation.type;
    if (isAggressive(t)) return 'aggressive';
    return t;
  }

  function gradeFold(advice, eq, req) {
    if (advice.toCall <= 0) return { grade: 'MISTAKE', note: 'You folded when checking was free — never fold for free.', concept: 'freeFold' };
    if (advice.nutted) return { grade: 'BLUNDER', note: `You folded ${advice.made || 'a monster'} — almost nothing beats it right now. With the nuts, raise — never fold.`, concept: 'nuts' };
    const edge = eq - req;
    if (edge >= CONF_HIGH) return { grade: 'MISTAKE', note: `Fold gave up a clearly +EV spot: you needed ${pct(req)} and had ~${pct(eq)}.`, concept: advice.concept === 'value' ? 'value' : 'potOdds' };
    if (edge >= CONF_MED) return { grade: 'OK', note: `A bit tight: ~${pct(eq)} equity vs ${pct(req)} needed made calling slightly better.`, concept: 'potOdds' };
    return { grade: 'GOOD', note: 'Disciplined fold — the price was not right.', concept: 'potOdds' };
  }

  function gradeCall(advice, eq, req) {
    const deficit = req - eq;
    const cheapDraw = advice.concept === 'impliedOdds';
    if (deficit >= 0.2) return { grade: 'BLUNDER', note: `Call needed ${pct(req)} equity but you had only ~${pct(eq)} — a big long-term loss.`, concept: 'potOdds' };
    if (deficit >= 0.08 && !cheapDraw) return { grade: 'MISTAKE', note: `Calling needed ${pct(req)} equity; you had ~${pct(eq)}. Folding was better.`, concept: 'potOdds' };
    if (deficit > 0 && !cheapDraw) return { grade: 'OK', note: `Marginal call: ~${pct(eq)} vs ${pct(req)} needed — close to break-even.`, concept: 'potOdds' };
    if (recCategory(advice) === 'aggressive' && advice.nutted) {
      return { grade: 'OK', note: 'Calling is fine, but with a hand this strong a raise builds a bigger pot.', concept: 'value' };
    }
    return { grade: 'GOOD', note: `Calling is +EV: ~${pct(eq)} equity vs ${pct(req)} needed.`, concept: 'potOdds' };
  }

  function gradeCheck(advice) {
    if (recCategory(advice) !== 'aggressive') return null;
    if (advice.nutted || advice.concept === 'value' || advice.concept === 'nuts') {
      return { grade: 'OK', note: 'Check is not terrible, but you were likely ahead — betting gets value from worse hands.', concept: 'value' };
    }
    return { grade: 'GOOD', note: 'Checking a draw is fine; a semi-bluff bet was an option to add fold equity.', concept: 'semiBluff' };
  }

  function gradeAggressive(advice, eq) {
    const share = fairShare(advice.opponents || 1);
    if (recCategory(advice) === 'fold' && eq < share * 0.6) {
      return { grade: 'MISTAKE', note: `Raising with ~${pct(eq)} equity is a pure bluff into ${advice.opponents} player(s) — folding was cheaper.`, concept: advice.street === 'preflop' ? 'preflop' : 'potOdds' };
    }
    if (eq >= share) return { grade: 'GOOD', note: 'Aggression with a decent hand — a fine alternative that can win the pot right away.', concept: 'value' };
    return { grade: 'OK', note: 'Aggressive line with a weak hand — it can work through fold equity, but it is risky.', concept: 'semiBluff' };
  }

  // Preflop: grade by hand tier and the recommendation, not by equity vs random
  // hands (with the whole table still to act that comparison means nothing).
  // Equity vs price is only used heads-up facing a raise or facing an all-in.
  function usesPreflopTiers(advice) {
    if (advice.street !== 'preflop') return false;
    const allInSpot = (advice.toCall || 0) >= (advice.heroStack || 0) * 0.4;
    return !(allInSpot || (advice.preflopRaised && advice.opponents === 1));
  }

  function gradePreflopFold(advice, rec) {
    const tier = advice.tierRank;
    if (rec === 'fold') return { grade: 'GOOD', note: `Disciplined fold: ${advice.why}`, concept: 'preflop' };
    if (tier >= TIER_RANK.Premium) return { grade: 'BLUNDER', note: `You folded ${advice.holeLabel}, a Premium hand — raise it every time.`, concept: 'preflop' };
    if (tier >= TIER_RANK.Strong) return { grade: 'MISTAKE', note: `${advice.holeLabel} is a Strong hand — folding it ${advice.preflopRaised ? 'to one raise ' : ''}gives up a lot.`, concept: 'preflop' };
    return { grade: 'OK', note: `A bit tight: the coach would play ${advice.holeLabel} here. ${advice.why}`, concept: advice.concept === 'bbDefend' ? 'bbDefend' : 'position' };
  }

  function gradePreflopCall(advice, rec) {
    const tier = advice.tierRank;
    const limp = !advice.preflopRaised;
    if (rec === 'aggressive') {
      if (limp && tier >= TIER_RANK.Strong) return { grade: 'MISTAKE', note: `Limping ${advice.holeLabel} wastes a strong hand — raise so weaker hands pay you.`, concept: 'value' };
      return { grade: 'OK', note: limp ? `Playable, but raise instead of limping: raising wins the blinds now or takes the lead.` : `Calling is fine, but ${advice.holeLabel} was strong enough to re-raise.`, concept: limp ? 'preflop' : 'value' };
    }
    if (rec === 'fold') {
      const late = advice.position === 'Button' || advice.position === 'Late';
      if (tier >= TIER_RANK.Marginal || (limp && late)) return { grade: 'OK', note: `A bit loose: ${advice.holeLabel} is ${limp ? 'better folded or raised than limped' : 'hard to play against a raise'} from here.`, concept: 'preflop' };
      return { grade: 'MISTAKE', note: `${advice.holeLabel} is a Trash hand — ${limp ? 'limping' : 'calling a raise'} with it loses money over time.`, concept: 'preflop' };
    }
    return { grade: 'GOOD', note: advice.why, concept: advice.concept };
  }

  function gradePreflopRaise(advice, rec) {
    if (rec === 'aggressive') return { grade: 'GREAT', note: `Matches the coach: ${advice.why}`, concept: advice.concept };
    if (rec === 'call' || rec === 'check') return { grade: 'GOOD', note: 'Raising is a fine alternative — the coach would just call/check here.', concept: 'value' };
    if (advice.tierRank >= TIER_RANK.Marginal) return { grade: 'OK', note: `Aggressive with ${advice.holeLabel}: it works sometimes, but the coach would fold it from here.`, concept: 'position' };
    return { grade: 'MISTAKE', note: `Raising ${advice.holeLabel} (Trash) bloats a pot you will usually lose — fold it.`, concept: 'preflop' };
  }

  function gradePreflop(advice, taken) {
    const rec = recCategory(advice);
    if (taken === 'fold') {
      if ((advice.toCall || 0) <= 0) return { grade: 'MISTAKE', note: 'You folded when checking was free — never fold for free.', concept: 'freeFold' };
      return gradePreflopFold(advice, rec);
    }
    if (taken === 'call') return gradePreflopCall(advice, rec);
    if (taken === 'check') {
      if (rec === 'aggressive') return { grade: advice.tierRank >= TIER_RANK.Strong ? 'MISTAKE' : 'OK', note: `Checking is OK, but ${advice.holeLabel} was worth a raise.`, concept: 'value' };
      return { grade: 'GREAT', note: `Matches the coach: ${advice.why}`, concept: advice.concept };
    }
    return gradePreflopRaise(advice, rec);
  }

  function grade(advice, actionTaken) {
    if (!advice || !advice.recommendation) return { grade: 'OK', note: 'No coach data for this decision.' };
    const eq = advice.adjEquity != null ? advice.adjEquity : advice.equity;
    const req = advice.potOdds || 0;
    const taken = actionCategory(actionTaken, advice);
    const recommended = recCategory(advice);
    if (usesPreflopTiers(advice) && advice.tierRank != null) {
      const pre = gradePreflop(advice, taken);
      const matched = taken === recommended || (taken === 'call' && recommended === 'check');
      if (matched && pre.grade === 'GOOD') return { ...pre, grade: advice.confidence === 'low' ? 'GOOD' : 'GREAT', note: `Matches the coach: ${advice.why}` };
      if (matched && pre.grade === 'GREAT' && advice.confidence === 'low') return { ...pre, grade: 'GOOD' };
      return pre;
    }
    const matches = taken === recommended || (taken === 'call' && recommended === 'check');
    if (matches && taken !== 'call') {
      const g = advice.confidence === 'low' ? 'GOOD' : 'GREAT';
      const why = advice.why || advice.reasons[0];
      return { grade: g, note: `Matches the coach: ${why}`, concept: advice.concept };
    }
    let result;
    if (taken === 'fold') result = gradeFold(advice, eq, req);
    else if (taken === 'call') result = gradeCall(advice, eq, req);
    else if (taken === 'check') result = gradeCheck(advice) || { grade: 'GOOD', note: 'Check is fine here.', concept: advice.concept };
    else result = gradeAggressive(advice, eq);
    if (matches && result.grade === 'GOOD') return { ...result, grade: advice.confidence === 'low' ? 'GOOD' : 'GREAT' };
    return result;
  }

  // --------------------------------------------------------------- reviewHand
  function describeAction(action) {
    if (!action) return '?';
    const name = action.type.charAt(0).toUpperCase() + action.type.slice(1);
    if (action.type === 'bet' || action.type === 'raise') return `${name} to ${money(action.amount || 0)}`;
    if (action.type === 'allin') return 'All-in';
    return name;
  }

  function foldedIds(record) {
    return new Set((record.actions || []).filter((a) => a.type === 'fold').map((a) => a.playerId));
  }

  function handDescFor(hole, board) {
    if (!hole || hole.length < 2) return 'Unknown';
    if (board.length >= 3) return PP.Eval.evaluate(hole.concat(board)).desc;
    return `${PP.Equity.preflopTier(hole)} starting hand`;
  }

  function reasoningFor(botReasonings, id) {
    const list = (botReasonings && botReasonings[id]) || [];
    return Array.isArray(list) ? list.join(' → ') : String(list);
  }

  function buildReveals(record, heroId, botReasonings) {
    const board = record.board || [];
    const folded = foldedIds(record);
    return (record.players || []).filter((p) => p.id !== heroId && p.hole && p.hole.length === 2).map((p) => ({
      name: p.name,
      holeLabel: handLabel(p.hole),
      hole: p.hole,
      handDesc: handDescFor(p.hole, board) + (folded.has(p.id) ? ' (folded)' : ''),
      reasoning: reasoningFor(botReasonings, p.id),
    }));
  }

  function buildHeadline(record, heroId) {
    const hero = (record.players || []).find((p) => p.id === heroId);
    if (!hero) return 'Hand complete.';
    const net = hero.endStack - hero.startStack;
    const board = record.board || [];
    const heroFolded = foldedIds(record).has(heroId);
    const desc = hero.hole && board.length >= 3 ? PP.Eval.evaluate(hero.hole.concat(board)).desc : null;
    if (net > 0) return record.showdown && desc ? `You won ${money(net)} with ${desc}!` : `You won ${money(net)} — everyone else folded.`;
    if (heroFolded) return net < 0 ? `You folded and lost ${money(-net)}.` : 'You folded — no chips lost.';
    if (net < 0) return desc ? `You lost ${money(-net)} with ${desc}.` : `You lost ${money(-net)}.`;
    return 'Split pot — you broke even.';
  }

  function heroWouldHaveWon(record, heroId) {
    const board = record.board || [];
    const hero = (record.players || []).find((p) => p.id === heroId);
    if (board.length < 5 || !hero || !hero.hole || !record.showdown) return false;
    const reveals = record.reveals || [];
    if (!reveals.length) return false;
    const heroScore = PP.Eval.evaluate(hero.hole.concat(board)).score;
    return reveals.every((r) => PP.Eval.evaluate(r.hole.concat(board)).score < heroScore);
  }

  function pickLesson(graded, record, heroId) {
    const worst = graded.reduce((acc, g) => (!acc || GRADE_ORDER.indexOf(g.grade) < GRADE_ORDER.indexOf(acc.grade) ? g : acc), null);
    if (worst && GRADE_ORDER.indexOf(worst.grade) <= GRADE_ORDER.indexOf('MISTAKE')) {
      return LESSONS[worst.concept] || LESSONS.potOdds;
    }
    const heroFolded = foldedIds(record).has(heroId);
    if (heroFolded && heroWouldHaveWon(record, heroId)) {
      return `Your hand would have won at showdown — but ${LESSONS.results.charAt(0).toLowerCase()}${LESSONS.results.slice(1)}`;
    }
    if (!graded.length) return LESSONS.position;
    const hero = (record.players || []).find((p) => p.id === heroId);
    if (hero && hero.endStack < hero.startStack) return LESSONS.results;
    const ok = graded.find((g) => g.grade === 'OK');
    return ok && LESSONS[ok.concept] ? LESSONS[ok.concept] : 'Solid hand. Keep comparing equity to pot odds on every decision — that habit is what wins.';
  }

  function reviewHand(handRecord, heroId, decisions, botReasonings) {
    const record = handRecord || {};
    const graded = (decisions || []).map((d) => ({ ...grade(d.advice, d.action), street: d.advice && d.advice.street, action: d.action }));
    return {
      headline: buildHeadline(record, heroId),
      heroDecisions: graded.map((g) => ({ street: g.street, action: describeAction(g.action), grade: g.grade, note: g.note })),
      reveals: buildReveals(record, heroId, botReasonings),
      lesson: pickLesson(graded, record, heroId),
    };
  }

  // ------------------------------------------------------------------- drills
  const DRILL_KINDS = ['winner', 'nameHand', 'potOdds', 'outs'];
  const MAX_TRIES = 400;
  const POT_SIZES = [40, 60, 80, 100, 120, 150, 200, 240, 300, 400];
  const BET_FRACTIONS = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.5, 2];

  const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
  const cardsText = (cards) => cards.map(PP.Cards.str).join(' ');

  function shuffled(arr, rng) {
    return PP.Cards.shuffle(arr, rng);
  }

  function deal(rng) {
    const deck = PP.Cards.shuffle(PP.Cards.makeDeck(), rng);
    let i = 0;
    return (n) => { const out = deck.slice(i, i + n); i += n; return out; };
  }

  function withChoices(choices, correct, rng) {
    const order = shuffled(choices.map((c, i) => ({ c, i })), rng);
    return { choices: order.map((o) => o.c), answer: order.findIndex((o) => o.i === correct) };
  }

  // winner -------------------------------------------------------------------
  function dealWinnerSpot(rng) {
    for (let t = 0; t < MAX_TRIES; t++) {
      const take = deal(rng);
      const nHands = rng() < 0.6 ? 2 : 3;
      const hands = Array.from({ length: nHands }, (_, i) => ({ label: `Hand ${'ABC'[i]}`, hole: take(2) }));
      const board = take(5);
      const evals = hands.map((h) => PP.Eval.evaluate(h.hole.concat(board)));
      const cats = evals.map((e) => e.cat).sort((a, b) => b - a);
      if (cats[0] === cats[1] || rng() < 0.35) return { hands, board, evals };
    }
    return null;
  }

  function makeWinner(rng) {
    const { hands, board, evals } = dealWinnerSpot(rng);
    const best = Math.max(...evals.map((e) => e.score));
    const winners = evals.map((e, i) => (e.score === best ? i : -1)).filter((i) => i >= 0);
    const options = hands.map((h) => h.label).concat('Split pot');
    const correct = winners.length > 1 ? hands.length : winners[0];
    const lines = hands.map((h, i) => `${h.label}: ${evals[i].desc} (${cardsText(evals[i].best)})`);
    const why = winners.length > 1
      ? 'The best five-card hands are identical in rank, so the pot is split.'
      : explainWin(evals, winners[0], hands);
    return {
      kind: 'winner',
      prompt: 'Which hand wins on this board?',
      cards: { board, hands },
      choices: options,
      answer: correct,
      explanation: `${lines.join('. ')}. ${why}`,
    };
  }

  /** "Pair of Queens, Ace kicker" -> "Pair of Queens" (the part that is not a kicker). */
  function mainPart(desc) {
    return desc.replace(/,[^,]*kickers?$/i, '');
  }

  function explainWin(evals, w, hands) {
    const others = evals.map((e, i) => ({ e, i })).filter((o) => o.i !== w);
    const same = others.filter((o) => o.e.cat === evals[w].cat);
    if (!same.length) {
      return `${hands[w].label} wins: ${evals[w].catName} beats ${others.map((o) => o.e.catName).join(' and ')}.`;
    }
    const rival = same[0];
    const winText = mainPart(evals[w].desc);
    const loseText = mainPart(rival.e.desc);
    if (winText !== loseText) {
      return `${hands[w].label} wins: both have ${evals[w].catName}, but ${winText} beats ${loseText} — the higher ranks decide it.`;
    }
    return `${hands[w].label} wins: both have ${winText}, so the kicker (the next-highest card) decides it.`;
  }

  // nameHand -----------------------------------------------------------------
  function makeNameHand(rng) {
    let spot = null;
    for (let t = 0; t < MAX_TRIES && !spot; t++) {
      const take = deal(rng);
      const hole = take(2);
      const board = take(5);
      const ev = PP.Eval.evaluate(hole.concat(board));
      if (ev.cat >= 1 || rng() < 0.15) spot = { hole, board, ev };
    }
    const { hole, board, ev } = spot;
    const answerName = ev.catName;
    const distractors = nameDistractors(ev.cat, rng);
    const { choices, answer } = withChoices([answerName].concat(distractors), 0, rng);
    return {
      kind: 'nameHand',
      prompt: 'What is your best five-card hand?',
      cards: { board, hands: [{ label: 'You', hole }] },
      choices, answer,
      explanation: `Best five: ${cardsText(ev.best)} → ${ev.desc}. You use the best 5 of all 7 cards (hole + board).`,
    };
  }

  function nameDistractors(cat, rng) {
    const pool = [-2, -1, 1, 2, 3].map((d) => cat + d).filter((c) => c >= 0 && c < CAT_NAMES.length && c !== cat);
    return shuffled(pool, rng).slice(0, 3).map((c) => CAT_NAMES[c]);
  }

  // potOdds ------------------------------------------------------------------
  function makePotOdds(rng) {
    const potBefore = pick(POT_SIZES, rng);
    const bet = Math.max(5, Math.round((potBefore * pick(BET_FRACTIONS, rng)) / 5) * 5);
    const required = PP.Equity.potOdds(bet, potBefore + bet);
    const delta = (0.05 + rng() * 0.2) * (rng() < 0.5 ? -1 : 1);
    const equityPct = Math.round(clamp(required + delta, 0.03, 0.95) * 100);
    const shouldCall = equityPct / 100 > required;
    const choices = ['Call', 'Fold'];
    return {
      kind: 'potOdds',
      prompt: `The pot is ${money(potBefore)}. Your opponent bets ${money(bet)}. You estimate ${equityPct}% equity. Call or fold?`,
      choices,
      answer: shouldCall ? 0 : 1,
      explanation: `Call ${money(bet)} to win ${money(potBefore + bet)}: required equity = ${bet} ÷ (${potBefore + bet} + ${bet}) = ${pct(required)}. ` +
        `Your ${equityPct}% is ${shouldCall ? 'more' : 'less'} than that, so ${shouldCall ? 'calling is +EV' : 'folding saves money'}.`,
      data: { potBefore, bet, equityPct, required },
    };
  }

  // outs ---------------------------------------------------------------------
  function boardPaired(board) {
    return new Set(board.map((c) => c.r)).size < board.length;
  }

  function countDrawOuts(hole, board, deck) {
    const known = hole.concat(board);
    const unseen = deck.filter((c) => !known.some((k) => PP.Cards.same(k, c)));
    const flush = [];
    const straight = [];
    unseen.forEach((c) => {
      const ev = PP.Eval.evaluate(known.concat(c));
      // A card that makes a straight/flush on the board alone just splits the pot: not an out.
      if (board.length === 4 && PP.Eval.evaluate(board.concat(c)).score >= ev.score) return;
      if (ev.cat === 5 || ev.cat === 8) flush.push(c);
      else if (ev.cat === 4) straight.push(c);
    });
    return { flush, straight, total: flush.length + straight.length };
  }

  function dealOutsSpot(rng) {
    const fullDeck = PP.Cards.makeDeck();
    for (let t = 0; t < MAX_TRIES * 5; t++) {
      const take = deal(rng);
      const hole = take(2);
      const board = take(rng() < 0.6 ? 3 : 4);
      if (hole[0].r === hole[1].r || boardPaired(board)) continue;
      if (PP.Eval.evaluate(hole.concat(board)).cat >= 2) continue;
      const outs = countDrawOuts(hole, board, fullDeck);
      if (outs.total >= 4) return { hole, board, outs };
    }
    return null;
  }

  function drawNames(outs) {
    const names = [];
    if (outs.flush.length) names.push(`flush draw (${outs.flush.length})`);
    if (outs.straight.length >= 8) names.push(`open-ended straight draw (${outs.straight.length})`);
    else if (outs.straight.length) names.push(`gutshot / straight draw (${outs.straight.length})`);
    return names;
  }

  function outsDistractors(correct, rng) {
    const pool = [correct - 3, correct - 1, correct + 1, correct + 2, correct + 3, 4, 8, 9, 12, 15]
      .filter((n, i, a) => n > 0 && n !== correct && a.indexOf(n) === i);
    return shuffled(pool, rng).slice(0, 3);
  }

  function makeOuts(rng) {
    const { hole, board, outs } = dealOutsSpot(rng);
    const n = outs.total;
    const street = board.length === 3 ? 'flop' : 'turn';
    const mult = street === 'flop' ? 4 : 2;
    const opts = [n].concat(outsDistractors(n, rng)).map(String);
    const { choices, answer } = withChoices(opts, 0, rng);
    const outCards = outs.flush.concat(outs.straight);
    return {
      kind: 'outs',
      prompt: `On the ${street}, how many outs do you have to make a straight or flush?`,
      cards: { board, hands: [{ label: 'You', hole }] },
      choices, answer,
      explanation: `${n} outs: ${drawNames(outs).join(' + ')} — ${cardsText(outCards)}. ` +
        `${outs.flush.length && outs.straight.length ? 'Cards that complete both draws count once. ' : ''}Rule of ${mult}: ${n}×${mult} ≈ ${Math.min(100, n * mult)}% to hit ${street === 'flop' ? 'by the river' : 'on the river'}.`,
    };
  }

  const MAKERS = { winner: makeWinner, nameHand: makeNameHand, potOdds: makePotOdds, outs: makeOuts };

  function makeQuestion(kind, rng) {
    const r = rng || PP.Cards.rng;
    const maker = MAKERS[kind] || MAKERS[pick(DRILL_KINDS, r)];
    return maker(r);
  }

  PP.Coach = Object.freeze({
    advise,
    grade,
    reviewHand,
    positionOf,
    LESSONS,
    Drills: Object.freeze({ KINDS: DRILL_KINDS, makeQuestion, countDrawOuts }),
  });
})();
