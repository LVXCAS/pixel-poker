/* PIXEL HOLD'EM — evaluator.js
 * Poker hand evaluator for 5..7 cards (rank-count + suit-bitmask approach).
 *
 * Score layout: cat * 16^5 + r0 * 16^4 + r1 * 16^3 + r2 * 16^2 + r3 * 16 + r4
 * where r0..r4 are the "significant ranks" for the category (group ranks first,
 * then kickers, high to low). The wheel stores its ace as 1 so A-2-3-4-5 is a
 * five-high straight. Same category => same layout, so plain numeric comparison
 * of scores is exact (kickers included, equal score = true tie).
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const CAT = Object.freeze({
    HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
    FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
  });
  const CATEGORY_NAMES = Object.freeze([
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
  ]);
  const ROYAL_NAME = 'Royal Flush';
  const ACE = 14;
  const LOW_ACE = 1;
  const WHEEL_HIGH = 5;
  const HAND_SIZE = 5;
  const MIN_EVAL_CARDS = 5;
  const MAX_EVAL_CARDS = 7;
  const FIVE_BITS = 0x1f;
  const NIBBLE = 16;
  const CAT_MULT = NIBBLE * NIBBLE * NIBBLE * NIBBLE * NIBBLE;

  // Scratch buffers reused across calls (single-threaded JS => safe).
  const counts = new Int8Array(15);
  const suitCounts = new Int8Array(4);
  const suitMasks = new Int32Array(4);
  const out = new Int8Array(6); // [cat, r0, r1, r2, r3, r4]

  function suitIndex(s) {
    switch (s) {
      case 's': return 0;
      case 'h': return 1;
      case 'd': return 2;
      default: return 3;
    }
  }
  const SUIT_BY_INDEX = ['s', 'h', 'd', 'c'];

  /** Highest straight high-card in a rank bitmask (bit r set for rank r), or 0. */
  function straightHigh(mask) {
    const m = mask | ((mask >> ACE) & 1) << LOW_ACE;
    for (let h = ACE; h >= WHEEL_HIGH; h--) {
      const window = FIVE_BITS << (h - 4);
      if ((m & window) === window) return h;
    }
    return 0;
  }

  function setOut(cat, a, b, c, d, e) {
    out[0] = cat; out[1] = a; out[2] = b; out[3] = c; out[4] = d; out[5] = e;
  }

  function setStraight(cat, high) {
    const low = high === WHEEL_HIGH ? LOW_ACE : high - 4;
    setOut(cat, high, high - 1, high - 2, high - 3, low);
  }

  /** Top `n` ranks present in mask, skipping ranks in `skipA`/`skipB`; written into out[start..]. */
  function fillTop(mask, start, n, skipA, skipB) {
    let pos = start;
    for (let r = ACE; r >= 2 && pos < start + n; r--) {
      if (r !== skipA && r !== skipB && (mask >> r) & 1) out[pos++] = r;
    }
    while (pos < start + n) out[pos++] = 0;
  }

  /** Fills counts/suit tables from cards; returns rank bitmask. */
  function tally(cards) {
    counts.fill(0);
    suitCounts.fill(0);
    suitMasks.fill(0);
    let mask = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const si = suitIndex(c.s);
      counts[c.r]++;
      suitCounts[si]++;
      suitMasks[si] |= 1 << c.r;
      mask |= 1 << c.r;
    }
    return mask;
  }

  function flushSuitIndex() {
    for (let i = 0; i < 4; i++) if (suitCounts[i] >= HAND_SIZE) return i;
    return -1;
  }

  /**
   * Core classification for any number of cards (1..7). Writes into `out`.
   * Returns the flush suit index (or -1) so callers can pick the best cards.
   */
  function classify(cards) {
    const mask = tally(cards);
    const fsi = flushSuitIndex();
    if (fsi >= 0) {
      const sfHigh = straightHigh(suitMasks[fsi]);
      if (sfHigh) {
        setStraight(CAT.STRAIGHT_FLUSH, sfHigh);
        return fsi;
      }
    }
    let quad = 0, trip1 = 0, trip2 = 0, pair1 = 0, pair2 = 0;
    for (let r = ACE; r >= 2; r--) {
      const n = counts[r];
      if (n === 4) quad = r;
      else if (n === 3) { if (!trip1) trip1 = r; else if (!trip2) trip2 = r; }
      else if (n === 2) { if (!pair1) pair1 = r; else if (!pair2) pair2 = r; }
    }
    if (quad) {
      out[0] = CAT.QUADS; out[1] = quad;
      fillTop(mask, 2, 1, quad, 0);
      out[3] = 0; out[4] = 0; out[5] = 0;
      return -1;
    }
    if (trip1 && (trip2 || pair1)) {
      const fullOf = Math.max(trip2, pair1);
      setOut(CAT.FULL_HOUSE, trip1, fullOf, 0, 0, 0);
      return -1;
    }
    if (fsi >= 0) {
      out[0] = CAT.FLUSH;
      fillTop(suitMasks[fsi], 1, HAND_SIZE, 0, 0);
      return fsi;
    }
    const stHigh = straightHigh(mask);
    if (stHigh) {
      setStraight(CAT.STRAIGHT, stHigh);
      return -1;
    }
    if (trip1) {
      out[0] = CAT.TRIPS; out[1] = trip1;
      fillTop(mask, 2, 2, trip1, 0);
      out[4] = 0; out[5] = 0;
      return -1;
    }
    if (pair1 && pair2) {
      out[0] = CAT.TWO_PAIR; out[1] = pair1; out[2] = pair2;
      fillTop(mask, 3, 1, pair1, pair2);
      out[4] = 0; out[5] = 0;
      return -1;
    }
    if (pair1) {
      out[0] = CAT.PAIR; out[1] = pair1;
      fillTop(mask, 2, 3, pair1, 0);
      out[5] = 0;
      return -1;
    }
    out[0] = CAT.HIGH_CARD;
    fillTop(mask, 1, HAND_SIZE, 0, 0);
    return -1;
  }

  function packScore() {
    return out[0] * CAT_MULT +
      out[1] * 65536 + out[2] * 4096 + out[3] * 256 + out[4] * NIBBLE + out[5];
  }

  /** Fast path for Monte Carlo: numeric score only, no allocation. */
  function scoreOnly(cards) {
    classify(cards);
    return packScore();
  }

  /** Category + score for any number of cards (1..7) — used for partial boards/outs. */
  function analyze(cards) {
    classify(cards);
    return { cat: out[0], score: packScore() };
  }

  // ---- Full evaluation (best 5 cards + description) ----------------------

  /** Expected rank sequence of the 5 best cards for the current `out`. */
  function rankPattern() {
    const [cat, a, b, c, d, e] = out;
    switch (cat) {
      case CAT.PAIR: return [a, a, b, c, d];
      case CAT.TWO_PAIR: return [a, a, b, b, c];
      case CAT.TRIPS: return [a, a, a, b, c];
      case CAT.FULL_HOUSE: return [a, a, a, b, b];
      case CAT.QUADS: return [a, a, a, a, b];
      default: return [a, b, c, d, e].map((r) => (r === LOW_ACE ? ACE : r));
    }
  }

  function pickBest(cards, flushSuit) {
    const used = new Array(cards.length).fill(false);
    const best = [];
    for (const r of rankPattern()) {
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        if (used[i] || c.r !== r) continue;
        if (flushSuit && c.s !== flushSuit) continue;
        used[i] = true;
        best.push(c);
        break;
      }
    }
    return best;
  }

  function kickerText(ranks) {
    const names = ranks.filter((r) => r > 0).map((r) => PP.Cards.rankName(r));
    if (names.length === 0) return '';
    if (names.length === 1) return ', ' + names[0] + ' kicker';
    return ', ' + names.join('-') + ' kickers';
  }

  function describe(cat, r, isRoyal) {
    const name = PP.Cards.rankName;
    const plural = PP.Cards.rankNamePlural;
    switch (cat) {
      case CAT.STRAIGHT_FLUSH:
        if (isRoyal) return 'Royal Flush';
        return 'Straight Flush, ' + name(r[0]) + ' high' + (r[0] === WHEEL_HIGH ? ' (steel wheel)' : '');
      case CAT.QUADS: return 'Four of a Kind, ' + plural(r[0]) + kickerText([r[1]]);
      case CAT.FULL_HOUSE: return 'Full House, ' + plural(r[0]) + ' full of ' + plural(r[1]);
      case CAT.FLUSH: return 'Flush, ' + name(r[0]) + ' high';
      case CAT.STRAIGHT:
        return 'Straight, ' + name(r[0]) + ' high' + (r[0] === WHEEL_HIGH ? ' (the wheel)' : '');
      case CAT.TRIPS: return 'Three of a Kind, ' + plural(r[0]) + kickerText([r[1], r[2]]);
      case CAT.TWO_PAIR:
        return 'Two Pair, ' + plural(r[0]) + ' and ' + plural(r[1]) + kickerText([r[2]]);
      case CAT.PAIR: return 'Pair of ' + plural(r[0]) + kickerText([r[1], r[2], r[3]]);
      default: return 'High Card, ' + name(r[0]) + kickerText([r[1], r[2], r[3], r[4]]);
    }
  }

  function validate(cards) {
    if (!Array.isArray(cards) || cards.length < MIN_EVAL_CARDS || cards.length > MAX_EVAL_CARDS) {
      throw new Error('evaluate() needs 5 to 7 cards');
    }
    const seen = new Set();
    for (const c of cards) {
      if (!c || !(c.r >= 2 && c.r <= ACE) || 'shdc'.indexOf(c.s) < 0 || c.s.length !== 1) {
        throw new Error('evaluate(): invalid card ' + JSON.stringify(c));
      }
      const key = c.r + c.s;
      if (seen.has(key)) throw new Error('evaluate(): duplicate card ' + key);
      seen.add(key);
    }
  }

  function evaluate(cards) {
    validate(cards);
    const fsi = classify(cards);
    const cat = out[0];
    const ranks = [out[1], out[2], out[3], out[4], out[5]];
    const score = packScore();
    const isFlushCat = cat === CAT.FLUSH || cat === CAT.STRAIGHT_FLUSH;
    const best = pickBest(cards, isFlushCat ? SUIT_BY_INDEX[fsi] : null);
    const isRoyal = cat === CAT.STRAIGHT_FLUSH && ranks[0] === ACE;
    return Object.freeze({
      cat,
      catName: isRoyal ? ROYAL_NAME : CATEGORY_NAMES[cat],
      score,
      best: Object.freeze(best),
      desc: describe(cat, ranks, isRoyal),
    });
  }

  function compare(a, b) {
    return Math.sign(a.score - b.score);
  }

  PP.Eval = Object.freeze({
    CAT,
    CATEGORY_NAMES,
    evaluate,
    compare,
    scoreOnly,
    analyze,
    straightHigh,
  });
})();
