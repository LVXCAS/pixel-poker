/* PIXEL HOLD'EM — cards.js
 * Card primitives: deck, shuffle, RNGs, parsing/formatting, rank names.
 * Card = frozen { r: 2..14, s: 's'|'h'|'d'|'c' }. Pure, DOM-free.
 */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const RANKS = '23456789TJQKA';
  const SUITS = Object.freeze(['s', 'h', 'd', 'c']);
  const SUIT_SYMBOL = Object.freeze({ s: '♠', h: '♥', d: '♦', c: '♣' });
  const MIN_RANK = 2;
  const MAX_RANK = 14;
  const UINT32_RANGE = 4294967296;
  const RNG_BUFFER_SIZE = 256;

  const RANK_NAMES = Object.freeze({
    2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
    9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
  });
  const RANK_PLURALS = Object.freeze({
    2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
    9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
  });

  // Canonical frozen card instances: one object per card, shared everywhere.
  const CANONICAL = {};
  for (const s of SUITS) {
    for (let r = MIN_RANK; r <= MAX_RANK; r++) {
      CANONICAL[r + s] = Object.freeze({ r, s });
    }
  }

  function card(r, s) {
    const c = CANONICAL[r + s];
    if (!c) throw new Error('Invalid card: rank=' + r + ' suit=' + s);
    return c;
  }

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) {
      for (let r = MIN_RANK; r <= MAX_RANK; r++) deck.push(CANONICAL[r + s]);
    }
    return deck;
  }

  // ---- RNG ----------------------------------------------------------------

  function makeCryptoRng() {
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return null;
    const buf = new Uint32Array(RNG_BUFFER_SIZE);
    let idx = RNG_BUFFER_SIZE;
    return function cryptoRng() {
      if (idx >= RNG_BUFFER_SIZE) {
        cryptoObj.getRandomValues(buf);
        idx = 0;
      }
      return buf[idx++] / UINT32_RANGE;
    };
  }

  const rng = makeCryptoRng() || function mathRng() { return Math.random(); };

  /** mulberry32 — small, fast, deterministic. For tests and replays. */
  function seededRng(seed) {
    let a = (Number(seed) >>> 0) || 0x9e3779b9;
    return function seeded() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    };
  }

  /** Fisher–Yates; returns a new array, input untouched. */
  function shuffle(cards, rand) {
    const next = rand || PP.Cards.rng;
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // ---- Formatting / parsing ----------------------------------------------

  function rankChar(r) {
    return RANKS[r - MIN_RANK];
  }

  function str(c) {
    return rankChar(c.r) + c.s;
  }

  function parse(text) {
    const t = String(text).trim();
    if (t.length !== 2 && !(t.length === 3 && t.startsWith('10'))) {
      throw new Error('Cannot parse card: "' + text + '"');
    }
    const rankPart = t.length === 3 ? 'T' : t[0].toUpperCase();
    const suitPart = t[t.length - 1].toLowerCase();
    const idx = RANKS.indexOf(rankPart);
    if (idx < 0 || SUITS.indexOf(suitPart) < 0) {
      throw new Error('Cannot parse card: "' + text + '"');
    }
    return card(idx + MIN_RANK, suitPart);
  }

  function parseMany(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    return t.split(/[\s,]+/).map(parse);
  }

  function rankName(r) {
    return RANK_NAMES[r] || String(r);
  }

  function rankNamePlural(r) {
    return RANK_PLURALS[r] || String(r) + 's';
  }

  function isRed(c) {
    return c.s === 'h' || c.s === 'd';
  }

  function same(a, b) {
    return !!a && !!b && a.r === b.r && a.s === b.s;
  }

  PP.Cards = Object.freeze({
    RANKS,
    SUITS,
    SUIT_SYMBOL,
    card,
    makeDeck,
    shuffle,
    rng,
    seededRng,
    str,
    parse,
    parseMany,
    rankChar,
    rankName,
    rankNamePlural,
    isRed,
    same,
  });
})();
