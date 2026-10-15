/* PIXEL HOLD'EM — equity.js
 * Teaching math: Monte Carlo equity, preflop strength (Chen formula), outs,
 * pot odds, board texture, rule of 2 and 4. Pure, DOM-free.
 *
 * OUTS SIMPLIFICATION (documented for the learner):
 *   A card counts as an out when it moves YOUR hand into a higher category AND
 *   that improvement comes from your hole cards, not from the board alone.
 *   Concretely, an unseen card is an out when:
 *     1. your category rises (e.g. pair -> trips, draw -> flush), and
 *     2. your jump in category is bigger than the board's own jump with that card
 *        (so a card that just pairs the board for everyone is not an out), or, on
 *        a 5-card board where the board itself makes the same straight/flush/
 *        full house category, you still beat the board (e.g. a higher straight);
 *        a better kicker alone is never an out, and
 *     3. a plain "high card -> one pair" improvement only counts when you pair
 *        a hole card that is higher than every board card (overcard outs).
 *   We do NOT discount outs that might give an opponent a better hand
 *   (e.g. a flush card that also pairs the board). Real players often "discount"
 *   those by feel; this keeps the count honest and teachable.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const DEFAULT_ITERATIONS = 2000;
  const MAX_RANGE_TRIES = 40;
  const MAX_OPPONENTS = 9;
  const BOARD_SIZE = 5;
  const HOLE_SIZE = 2;
  const FLOP_SIZE = 3;
  const TURN_SIZE = 4;
  const FLUSH_DRAW_COUNT = 4;
  const STRAIGHT_WINDOW = 5;
  const PERCENT = 100;
  const FLOP_MULTIPLIER = 4;
  const TURN_MULTIPLIER = 2;

  // Chen formula constants
  const CHEN_HIGH_CARD = Object.freeze({ 14: 10, 13: 8, 12: 7, 11: 6 });
  const CHEN_MIN_PAIR = 5;
  const CHEN_SUITED_BONUS = 2;
  const CHEN_GAP_PENALTY = Object.freeze([0, 1, 2, 4, 5]);
  const CHEN_MIN = -1;
  const CHEN_MAX = 20;
  const QUEEN = 12;
  const TIER_THRESHOLDS = Object.freeze([
    { min: 12, tier: 'Premium' },
    { min: 9, tier: 'Strong' },
    { min: 7, tier: 'Playable' },
    { min: 5, tier: 'Marginal' },
  ]);
  const TRASH_TIER = 'Trash';
  // Categories where out-drawing an identical board category is a real improvement.
  const BEAT_BOARD_CATS = new Set([4, 5, 6, 8]);

  const C = () => PP.Cards;
  const E = () => PP.Eval;

  // ---- helpers ------------------------------------------------------------

  function key(c) {
    return c.r + c.s;
  }

  function assertCards(cards, what) {
    if (!Array.isArray(cards)) throw new Error(what + ' must be an array of cards');
    for (const c of cards) {
      if (!c || typeof c.r !== 'number' || typeof c.s !== 'string') {
        throw new Error(what + ' contains an invalid card');
      }
    }
  }

  /** Unseen deck: 52 minus every known card. Throws on duplicates. */
  function remainingDeck(known) {
    const seen = new Set();
    for (const c of known) {
      const k = key(c);
      if (seen.has(k)) throw new Error('Duplicate card: ' + C().str(c));
      seen.add(k);
    }
    return C().makeDeck().filter((c) => !seen.has(key(c)));
  }

  // ---- Monte Carlo --------------------------------------------------------

  function validateMonteCarlo(hero, board, opponents) {
    assertCards(hero, 'hero');
    assertCards(board, 'board');
    if (hero.length !== HOLE_SIZE) throw new Error('hero must have exactly 2 cards');
    if (board.length > BOARD_SIZE || board.length === 1 || board.length === 2) {
      throw new Error('board must have 0, 3, 4 or 5 cards');
    }
    if (!(opponents >= 1)) throw new Error('opponents must be >= 1');
  }

  /** oppWeight may be one function (all opponents) or an array (per opponent). */
  function normaliseWeights(oppWeight, opponents) {
    if (typeof oppWeight === 'function') return new Array(opponents).fill(oppWeight);
    if (!Array.isArray(oppWeight)) return null;
    const list = [];
    for (let o = 0; o < opponents; o++) list.push(typeof oppWeight[o] === 'function' ? oppWeight[o] : null);
    return list.some(Boolean) ? list : null;
  }

  /**
   * Plays out `iterations` random runouts against `opponents` random hands.
   * Each iteration does a partial Fisher–Yates over the unseen deck, so every
   * opponent hand and runout is drawn uniformly — no bias.
   * Optional `oppWeight(hole, board) -> 0..1` narrows each opponent to a range
   * (rejection sampling); see `villainRange`.
   */
  function monteCarlo(opts) {
    const hero = opts.hero;
    const board = opts.board || [];
    const dead = opts.dead || [];
    const opponents = Math.min(MAX_OPPONENTS, Math.floor(opts.opponents));
    const iterations = Math.max(1, Math.floor(opts.iterations || DEFAULT_ITERATIONS));
    const rand = opts.rng || C().rng;
    validateMonteCarlo(hero, board, opponents);
    assertCards(dead, 'dead');

    const deck = remainingDeck(hero.concat(board, dead));
    const need = BOARD_SIZE - board.length;
    const draws = need + opponents * HOLE_SIZE;
    if (draws > deck.length) throw new Error('Not enough cards left for that many opponents');

    const heroCards = new Array(HOLE_SIZE + BOARD_SIZE);
    const oppCards = new Array(HOLE_SIZE + BOARD_SIZE);
    heroCards[0] = hero[0];
    heroCards[1] = hero[1];
    for (let i = 0; i < board.length; i++) {
      heroCards[HOLE_SIZE + i] = board[i];
      oppCards[HOLE_SIZE + i] = board[i];
    }

    let wins = 0, ties = 0, tieShare = 0;
    const n = deck.length;
    const weights = normaliseWeights(opts.oppWeight, opponents);
    const weigh = weights ? true : null;
    const oppHole = new Array(HOLE_SIZE);
    const swap = (i, j) => { const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp; };
    // Without a range: runout in deck[0..need), opponents after it. With a range,
    // opponents are drawn first (rejection-sampled by weight), then the runout.
    const runoutAt = weigh ? opponents * HOLE_SIZE : 0;
    const oppAt = weigh ? 0 : need;
    for (let it = 0; it < iterations; it++) {
      if (weigh) {
        for (let o = 0; o < opponents; o++) {
          const at = o * HOLE_SIZE;
          const w = weights[o];
          if (!w) {
            swap(at, at + Math.floor(rand() * (n - at)));
            swap(at + 1, at + 1 + Math.floor(rand() * (n - at - 1)));
            continue;
          }
          for (let attempt = 0; attempt < MAX_RANGE_TRIES; attempt++) {
            swap(at, at + Math.floor(rand() * (n - at)));
            swap(at + 1, at + 1 + Math.floor(rand() * (n - at - 1)));
            oppHole[0] = deck[at];
            oppHole[1] = deck[at + 1];
            if (rand() < w(oppHole, board)) break;
          }
        }
        for (let i = runoutAt; i < runoutAt + need; i++) swap(i, i + Math.floor(rand() * (n - i)));
      } else {
        for (let i = 0; i < draws; i++) swap(i, i + Math.floor(rand() * (n - i)));
      }
      for (let i = 0; i < need; i++) {
        heroCards[HOLE_SIZE + board.length + i] = deck[runoutAt + i];
        oppCards[HOLE_SIZE + board.length + i] = deck[runoutAt + i];
      }
      const heroScore = E().scoreOnly(heroCards);
      let best = -1, tiedOpps = 0;
      for (let o = 0; o < opponents; o++) {
        oppCards[0] = deck[oppAt + o * HOLE_SIZE];
        oppCards[1] = deck[oppAt + o * HOLE_SIZE + 1];
        const s = E().scoreOnly(oppCards);
        if (s > best) { best = s; tiedOpps = 1; } else if (s === best) tiedOpps++;
      }
      if (heroScore > best) wins++;
      else if (heroScore === best) { ties++; tieShare += 1 / (tiedOpps + 1); }
    }
    const win = wins / iterations;
    const tie = ties / iterations;
    return Object.freeze({
      win,
      tie,
      lose: 1 - win - tie,
      equity: (wins + tieShare) / iterations,
      iterations,
    });
  }

  // ---- Preflop ------------------------------------------------------------

  function sortedHole(hole) {
    return hole[0].r >= hole[1].r ? [hole[0], hole[1]] : [hole[1], hole[0]];
  }

  function handLabel(hole) {
    const [hi, lo] = sortedHole(hole);
    const base = C().rankChar(hi.r) + C().rankChar(lo.r);
    if (hi.r === lo.r) return base;
    return base + (hi.s === lo.s ? 's' : 'o');
  }

  function chenHighCard(r) {
    return CHEN_HIGH_CARD[r] || r / 2;
  }

  /** Raw Chen score, -1..20. */
  function chenScore(hole) {
    const [hi, lo] = sortedHole(hole);
    let score = chenHighCard(hi.r);
    if (hi.r === lo.r) return Math.max(CHEN_MIN_PAIR, score * 2);
    if (hi.s === lo.s) score += CHEN_SUITED_BONUS;
    const gap = hi.r - lo.r - 1;
    score -= CHEN_GAP_PENALTY[Math.min(gap, CHEN_GAP_PENALTY.length - 1)];
    if (gap <= 1 && hi.r < QUEEN) score += 1;
    return Math.ceil(score);
  }

  function preflopScore(hole) {
    const raw = chenScore(hole);
    return Math.min(1, Math.max(0, (raw - CHEN_MIN) / (CHEN_MAX - CHEN_MIN)));
  }

  function preflopTier(hole) {
    const raw = chenScore(hole);
    for (const t of TIER_THRESHOLDS) if (raw >= t.min) return t.tier;
    return TRASH_TIER;
  }

  // ---- Outs ---------------------------------------------------------------

  function rankMask(cards) {
    let m = 0;
    for (const c of cards) m |= 1 << c.r;
    return m;
  }

  function suitCount(cards, s) {
    let n = 0;
    for (const c of cards) if (c.s === s) n++;
    return n;
  }

  function detectFlushDraw(hole, all, currentCat) {
    if (currentCat >= E().CAT.FLUSH) return null;
    for (const s of C().SUITS) {
      const holeHas = hole.some((c) => c.s === s);
      if (holeHas && suitCount(all, s) === FLUSH_DRAW_COUNT) return 'Flush draw';
    }
    return null;
  }

  /** Ranks that would complete a straight using at least one hole card. */
  function straightCompletingRanks(hole, board) {
    const all = hole.concat(board);
    const mask = rankMask(all);
    const boardMask = rankMask(board);
    if (E().straightHigh(mask)) return [];
    const ranks = [];
    for (let r = 2; r <= 14; r++) {
      if ((mask >> r) & 1) continue;
      const withR = E().straightHigh(mask | (1 << r));
      if (!withR) continue;
      const boardOnly = E().straightHigh(boardMask | (1 << r));
      if (boardOnly && boardOnly >= withR) continue;
      ranks.push(r);
    }
    return ranks;
  }

  function detectStraightDraw(hole, board) {
    const ranks = straightCompletingRanks(hole, board);
    if (ranks.length >= 2) return 'Open-ended straight draw';
    if (ranks.length === 1) return 'Gutshot';
    return null;
  }

  function detectOvercards(hole, board, currentCat) {
    if (currentCat !== E().CAT.HIGH_CARD) return null;
    const boardMax = Math.max(...board.map((c) => c.r));
    const overs = hole.filter((c) => c.r > boardMax).length;
    if (overs === 2) return 'Overcards';
    if (overs === 1) return 'Overcard';
    return null;
  }

  function isOut(c, ctx) {
    const { hole, board, heroNow, boardNow } = ctx;
    const heroNew = E().analyze(hole.concat(board, [c]));
    if (heroNew.cat <= heroNow.cat) return false;
    const boardNew = E().analyze(board.concat([c]));
    if (heroNew.cat === E().CAT.PAIR) {
      const boardMax = Math.max(...board.map((b) => b.r));
      return c.r > boardMax && hole.some((h) => h.r === c.r);
    }
    const heroJump = heroNew.cat - heroNow.cat;
    const boardJump = boardNew.cat - boardNow.cat;
    if (heroJump > boardJump && heroNew.cat > boardNew.cat) return true;
    // Board alone makes the same straight/flush/full house: hero must still beat it
    // with a hole card (kickers do not count as outs).
    const fullBoard = board.length + 1 === BOARD_SIZE;
    return fullBoard && heroNew.cat === boardNew.cat && BEAT_BOARD_CATS.has(heroNew.cat) &&
      heroNew.score > boardNew.score;
  }

  function detectMadeHandDraw(heroNow, outCards, hole, board) {
    if (!outCards.length) return null;
    const CAT = E().CAT;
    if (heroNow.cat === CAT.TRIPS || heroNow.cat === CAT.TWO_PAIR) return 'Full house draw';
    if (heroNow.cat !== CAT.PAIR) return null;
    if (hole[0].r === hole[1].r) return 'Set draw';
    const pairedHole = hole.some((h) => board.some((c) => c.r === h.r));
    return pairedHole ? 'Two pair / trips draw' : 'Two pair draw';
  }

  /** Groups out cards by the hand they make, e.g. "9 make a Flush, 3 make a Pair". */
  function breakdown(hole, board, outCards) {
    const byCat = new Map();
    for (const c of outCards) {
      const cat = E().analyze(hole.concat(board, [c])).cat;
      byCat.set(cat, (byCat.get(cat) || 0) + 1);
    }
    return [...byCat.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([cat, n]) => n + ' make' + (n === 1 ? 's' : '') + ' ' + E().CATEGORY_NAMES[cat]);
  }

  function outsDesc(count, draws, parts, boardLen) {
    if (count === 0) {
      return 'No clean outs: no single card improves your hand more than it improves the board.';
    }
    const street = boardLen === FLOP_SIZE ? 'flop' : 'turn';
    const pct = ruleOf2and4(count, street);
    const rule = street === 'flop'
      ? 'Rule of 4: ' + count + ' x 4 = about ' + pct + '% to hit by the river.'
      : 'Rule of 2: ' + count + ' x 2 = about ' + pct + '% to hit on the river.';
    const label = draws.length ? ' (' + draws.join(' + ') + ')' : '';
    return count + ' out' + (count === 1 ? '' : 's') + label + ': ' + parts.join(', ') + '. ' + rule;
  }

  /**
   * Counts unseen cards that improve hero's hand (see SIMPLIFICATION at top).
   * Flop/turn only; preflop and river return an empty result.
   * Every unseen card is tested once, so combined draws never double count.
   */
  function outs(hole, board) {
    const b = board || [];
    if (!hole || hole.length !== HOLE_SIZE || (b.length !== FLOP_SIZE && b.length !== TURN_SIZE)) {
      return Object.freeze({ count: 0, cards: Object.freeze([]), draws: Object.freeze([]), desc: '' });
    }
    const all = hole.concat(b);
    const heroNow = E().analyze(all);
    const ctx = { hole, board: b, heroNow, boardNow: E().analyze(b) };
    const cards = remainingDeck(all).filter((c) => isOut(c, ctx));
    const draws = [
      detectFlushDraw(hole, all, heroNow.cat),
      heroNow.cat < E().CAT.STRAIGHT ? detectStraightDraw(hole, b) : null,
      detectOvercards(hole, b, heroNow.cat),
      detectMadeHandDraw(heroNow, cards, hole, b),
    ].filter(Boolean);
    return Object.freeze({
      count: cards.length,
      cards: Object.freeze(cards),
      draws: Object.freeze(draws),
      desc: outsDesc(cards.length, draws, breakdown(hole, b, cards), b.length),
    });
  }

  // ---- Opponent ranges ----------------------------------------------------
  // Facing bets and raises, an opponent's hand is NOT random. These weights are a
  // simple, teachable model of "what a betting range looks like": each level of
  // aggression keeps strong hands and throws away more of the weak ones.

  const RANGE_CLASS = Object.freeze({ STRONG: 0, TOP: 1, MID: 2, DRAW: 3, AIR: 4 });
  // Rows = postflop pressure level (bets/raises), columns = RANGE_CLASS.
  const POSTFLOP_WEIGHTS = Object.freeze([
    null,
    Object.freeze([1, 1, 0.55, 0.6, 0.2]),
    Object.freeze([1, 0.6, 0.2, 0.35, 0.06]),
    Object.freeze([1, 0.25, 0.06, 0.15, 0.03]),
    Object.freeze([1, 0.08, 0.01, 0.05, 0.01]),
  ]);
  // Preflop: Chen score cut-offs for a raising (level 1) / re-raising (level 2+) range.
  const PREFLOP_RANGES = Object.freeze([
    null,
    Object.freeze({ top: 6, mid: 4, midW: 0.4, lowW: 0.1 }),
    Object.freeze({ top: 10, mid: 8, midW: 0.4, lowW: 0.04 }),
  ]);
  const MAX_PRESSURE = POSTFLOP_WEIGHTS.length - 1;
  const AGGRESSIVE = new Set(['bet', 'raise', 'allin']);
  const CALL_PRESSURE = 0.5;
  const RAISE_PRESSURE = 2;

  /** Rough strength class of a hole+board on the KNOWN board (no runout). */
  function handClass(hole, board) {
    const CAT = E().CAT;
    const mine = E().analyze(hole.concat(board));
    const boardOnly = E().analyze(board);
    if (mine.cat >= CAT.TRIPS && mine.cat > boardOnly.cat) return RANGE_CLASS.STRONG;
    if (mine.cat === CAT.TWO_PAIR && boardOnly.cat === CAT.HIGH_CARD) return RANGE_CLASS.STRONG;
    const boardMax = Math.max(...board.map((c) => c.r));
    const drawing = board.length < BOARD_SIZE &&
      (!!detectFlushDraw(hole, hole.concat(board), mine.cat) || straightCompletingRanks(hole, board).length >= 2);
    let pairClass = null;
    if (mine.cat > boardOnly.cat) {
      const pocket = hole[0].r === hole[1].r;
      const hit = hole.filter((h) => board.some((c) => c.r === h.r)).map((h) => h.r);
      const top = (pocket && hole[0].r > boardMax) || hit.includes(boardMax);
      pairClass = top ? RANGE_CLASS.TOP : RANGE_CLASS.MID;
    }
    if (pairClass === RANGE_CLASS.MID && drawing) return RANGE_CLASS.TOP;
    if (pairClass != null) return pairClass;
    return drawing ? RANGE_CLASS.DRAW : RANGE_CLASS.AIR;
  }

  /**
   * Weight function for monteCarlo's `oppWeight`.
   * preLevel: 0 = no preflop raise, 1 = opened/called a raise, 2 = 3-bet+.
   * postLevel: 0..4 postflop pressure (bets/raises, half a level per call).
   * Returns null when no narrowing applies (plain random-hand equity).
   */
  function villainRange(spec) {
    const preLevel = Math.min(PREFLOP_RANGES.length - 1, Math.max(0, Math.floor((spec && spec.preLevel) || 0)));
    const postLevel = Math.min(MAX_PRESSURE, Math.max(0, Math.floor((spec && spec.postLevel) || 0)));
    if (!preLevel && !postLevel) return null;
    const pre = PREFLOP_RANGES[preLevel];
    const post = POSTFLOP_WEIGHTS[postLevel];
    return function weight(hole, board) {
      let w = 1;
      if (pre) {
        const chen = chenScore(hole);
        w = chen >= pre.top ? 1 : chen >= pre.mid ? pre.midW : pre.lowW;
      }
      if (post && board.length >= FLOP_SIZE) w *= post[handClass(hole, board)];
      return w;
    };
  }

  function emptyPressure() {
    return { preLevel: 0, postScore: 0 };
  }

  function freezePressure(p) {
    return Object.freeze({
      preLevel: Math.min(PREFLOP_RANGES.length - 1, p.preLevel),
      postLevel: Math.min(MAX_PRESSURE, Math.floor(p.postScore)),
    });
  }

  /**
   * How much pressure everyone except `heroId` has shown, read from the public
   * action history. Returns the strongest level among opponents plus a per-player
   * breakdown: { preLevel, postLevel, betsThisStreet, facingRaise, byPlayer }.
   * A postflop bet = 1 level, a raise over a bet = 2, a call = half a level.
   */
  function pressureFromHistory(history, heroId, bigBlind, street) {
    const per = {};
    let betsThisStreet = 0;
    let facingRaise = false;
    let level = bigBlind || 0;
    let preRaises = 0;
    let lastStreet = 'preflop';
    (history || []).forEach((h) => {
      if (h.street !== lastStreet) { level = 0; lastStreet = h.street; }
      const amt = Number(h.amount) || 0;
      const isRaise = AGGRESSIVE.has(h.type) && amt > level;
      const overBet = level > 0;
      if (isRaise) level = amt;
      const isCall = !isRaise && (h.type === 'call' || h.type === 'allin');
      if (h.street === 'preflop' && isRaise) preRaises += 1;
      if (h.playerId === heroId) return;
      const p = per[h.playerId] || (per[h.playerId] = emptyPressure());
      if (h.street === 'preflop') {
        if (isRaise) p.preLevel += 1;
        else if (isCall && preRaises > 0) p.preLevel = Math.max(p.preLevel, preRaises);
        return;
      }
      if (isRaise) p.postScore += overBet ? RAISE_PRESSURE : 1;
      else if (isCall) p.postScore += CALL_PRESSURE;
      if (isRaise && h.street === street) {
        betsThisStreet += 1;
        if (overBet) facingRaise = true;
      }
    });
    const byPlayer = {};
    let preLevel = 0;
    let postLevel = 0;
    Object.keys(per).forEach((id) => {
      byPlayer[id] = freezePressure(per[id]);
      preLevel = Math.max(preLevel, byPlayer[id].preLevel);
      postLevel = Math.max(postLevel, byPlayer[id].postLevel);
    });
    return Object.freeze({ preLevel, postLevel, betsThisStreet, facingRaise, byPlayer: Object.freeze(byPlayer) });
  }

  // ---- Pot odds / rule of 2 & 4 ---------------------------------------------

  /** Equity needed to break even on a call: toCall / (pot + toCall). */
  function potOdds(toCall, pot) {
    if (!(toCall > 0)) return 0;
    return toCall / (Math.max(0, pot) + toCall);
  }

  /** Approximate equity % from outs: x4 on the flop (two cards to come), x2 on the turn. */
  function ruleOf2and4(outCount, street) {
    const n = Math.max(0, outCount || 0);
    const onFlop = street === 'flop' || street === FLOP_SIZE;
    const onTurn = street === 'turn' || street === TURN_SIZE;
    if (!onFlop && !onTurn) return 0;
    return Math.min(PERCENT, n * (onFlop ? FLOP_MULTIPLIER : TURN_MULTIPLIER));
  }

  // ---- Board texture --------------------------------------------------------

  function maxSuitCount(board) {
    return Math.max(...C().SUITS.map((s) => suitCount(board, s)));
  }

  /** Max number of distinct board ranks inside any 5-rank window (ace plays low too). */
  function maxRanksInWindow(board) {
    const mask = rankMask(board);
    const m = mask | (((mask >> 14) & 1) << 1);
    let best = 0;
    for (let low = 1; low <= 10; low++) {
      let n = 0;
      for (let r = low; r < low + STRAIGHT_WINDOW; r++) if ((m >> r) & 1) n++;
      best = Math.max(best, n);
    }
    return best;
  }

  function textureDesc(t, board, inWindow) {
    const cards = board.map((c) => C().rankChar(c.r)).join('-');
    const parts = [];
    if (t.paired) parts.push('paired');
    if (t.monotone) parts.push('monotone');
    else if (t.twoTone) parts.push('two-tone');
    else if (t.rainbow) parts.push('rainbow');
    if (t.connected) parts.push('connected');
    const label = parts.length ? parts.join(', ') : 'unconnected';
    const notes = [];
    if (t.flushPossible) notes.push('a flush is possible');
    else if (t.twoTone) notes.push('flush draws are live');
    if (t.straightPossible) notes.push('a straight is possible');
    else if (inWindow === 2) notes.push('straight draws are live');
    if (t.paired) notes.push('full houses and trips are possible');
    const verdict = t.wet ? 'Wet board' : 'Dry board';
    const tail = notes.length ? ': ' + notes.join('; ') + '.' : ': few draws, top pair is often good.';
    return verdict + ' (' + cards + ', ' + label + ')' + tail;
  }

  function boardTexture(board) {
    const b = board || [];
    if (b.length === 0) {
      return Object.freeze({
        paired: false, monotone: false, twoTone: false, rainbow: false, connected: false,
        wet: false, flushPossible: false, straightPossible: false,
        desc: 'No board yet (preflop).',
      });
    }
    const counts = {};
    for (const c of b) counts[c.r] = (counts[c.r] || 0) + 1;
    const maxSuit = maxSuitCount(b);
    const inWindow = maxRanksInWindow(b);
    const t = {
      paired: Object.values(counts).some((n) => n >= 2),
      monotone: b.length >= FLOP_SIZE && maxSuit === b.length,
      twoTone: maxSuit === 2,
      rainbow: maxSuit === 1,
      connected: inWindow >= FLOP_SIZE,
      flushPossible: maxSuit >= FLOP_SIZE,
      straightPossible: inWindow >= FLOP_SIZE,
    };
    const closePair = inWindow >= 2;
    const wet = t.flushPossible || t.connected || (t.twoTone && closePair);
    const full = Object.assign({}, t, { wet });
    return Object.freeze(Object.assign(full, { desc: textureDesc(full, b, inWindow) }));
  }

  PP.Equity = Object.freeze({
    monteCarlo,
    handLabel,
    chenScore,
    preflopScore,
    preflopTier,
    outs,
    potOdds,
    boardTexture,
    ruleOf2and4,
    remainingDeck,
    villainRange,
    pressureFromHistory,
    handClass,
    RANGE_CLASS,
  });
})();
