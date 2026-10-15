/* PIXEL HOLD'EM — LEARN mode: 8 short lessons taught by the dealer on a chalk slate.
 * Classic script (no modules). Attaches PP.Tutorial.
 * The top half (scripts, deck building, beat matching, answers) is DOM-free so tests/tutorial.test.js
 * can run every scripted hand through the real engine. The DOM half only boots in a browser.
 * Table lessons drive a real game through PP.App.startCustomGame (main.js) with a preset deck,
 * scripted bots and a gate on the hero's action. Size note: one file by ownership (data + runner);
 * the lesson scripts are most of it. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  const HERO = 'hero';
  const STORE_KEY = 'pixelholdem.tutorial.v1';
  const SEATS_STACK = 1000;
  const TIERS = ['Premium', 'Strong', 'Playable', 'Marginal', 'Trash'];
  const GRAD_HANDS = 3;

  // ============================================================ pure helpers
  const cards = (str) => PP.Cards.parseMany(str);
  const key = (c) => c.r + c.s;

  /** Seat indexes in deal order: one left of the button first, the button last. */
  function dealOrder(n, dealer) {
    return Array.from({ length: n }, (_, k) => (dealer + 1 + k) % n);
  }

  /**
   * Build the exact 52-card deck the engine draws from (engine.js: hole cards one at a time from left of
   * the button, two passes; then burn+3, burn+1, burn+1). Unnamed cards come from a fixed filler order.
   */
  function buildDeck(seatIds, dealer, holes, board) {
    const used = new Set();
    const take = (list) => list.map((c) => { used.add(key(c)); return c; });
    const holeCards = {};
    Object.keys(holes || {}).forEach((id) => { holeCards[id] = take(cards(holes[id])); });
    const boardCards = take(board ? cards(board) : []);
    const filler = PP.Cards.makeDeck().filter((c) => !used.has(key(c)));
    const next = () => filler.shift();
    const order = dealOrder(seatIds.length, dealer).map((s) => seatIds[s]);
    const deck = [];
    for (let pass = 0; pass < 2; pass++) {
      order.forEach((id) => deck.push((holeCards[id] && holeCards[id][pass]) || next()));
    }
    [3, 1, 1].forEach((n) => {
      deck.push(next());
      for (let i = 0; i < n; i++) deck.push(boardCards.shift() || next());
    });
    return deck.concat(filler);
  }

  /** 'bet 60' -> { type:'bet', amount:60 }; 'call' -> { type:'call' }. */
  function parseAction(str) {
    const [type, amt] = String(str).trim().split(/\s+/);
    return amt ? { type, amount: Number(amt) } : { type };
  }

  /** A bot that plays a fixed list of actions, in order. Out of script it checks or folds. */
  function scriptedBot(list) {
    const queue = (list || []).map(parseAction);
    return {
      style: 'Scripted', lastReasoning: '',
      decide(view, legal) {
        const a = queue.shift();
        this.lastReasoning = a ? 'Scripted for the lesson.' : '';
        return a || (legal && legal.canCheck ? { type: 'check' } : { type: 'fold' });
      },
    };
  }

  /** Hero script entry 'fold|call' or 'raise 180' -> accepted types + the canonical play (tests use it). */
  function heroExpect(entry) {
    const parts = String(entry).split('|');
    return { types: parts.map((p) => parseAction(p).type), play: parseAction(parts[0]) };
  }

  /** Is `action` what this step asks for? Returns null when fine, else the reason it is not. */
  function checkHero(entry, action, maxTo) {
    const want = heroExpect(entry);
    const type = action && action.type;
    if (!want.types.includes(type)) return 'type';
    if ((type === 'bet' || type === 'raise') && maxTo && Number(action.amount) > maxTo) return 'size';
    return null;
  }

  /** Does a beat fire on this engine event? ev = { name, payload, heroTurn } */
  function matchBeat(beat, ev) {
    if (!beat) return false;
    const p = ev.payload || {};
    if (beat.on === 'hero') return ev.name === 'turn' && p.playerId === HERO;
    if (beat.on !== ev.name) return false;
    if (beat.on === 'street') return !beat.street || beat.street === p.street;
    if (beat.on === 'action') {
      return (!beat.who || beat.who === p.playerId) && (!beat.type || beat.type === p.type) && (!beat.street || beat.street === ev.street);
    }
    return true;
  }

  /** Heads-up equity of hole a vs hole b by Monte Carlo over random boards. */
  function headsUp(a, b, iterations, rng) {
    const dead = new Set(a.concat(b).map(key));
    const rest = PP.Cards.makeDeck().filter((c) => !dead.has(key(c)));
    const rand = rng || PP.Cards.rng;
    let win = 0;
    let tie = 0;
    for (let i = 0; i < iterations; i++) {
      const pool = rest.slice();
      const board = [];
      for (let k = 0; k < 5; k++) board.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      const d = PP.Eval.compare(PP.Eval.evaluate(a.concat(board)), PP.Eval.evaluate(b.concat(board)));
      if (d > 0) win++; else if (d === 0) tie++;
    }
    return (win + tie / 2) / iterations;
  }

  // ============================================================ lesson data
  const P = (id, name, rating) => ({ id, name, stack: SEATS_STACK, rating: rating || 1, title: 'Plays the lesson script' });
  const YOU = { id: HERO, name: 'YOU', stack: SEATS_STACK };
  const seat = (id) => '.seat[data-id="' + id + '"]';
  const HERO_CARDS = '.seat.hero .seat-cards';
  const BTN = { fold: '#btn-fold', call: '#btn-call', raise: '#btn-raise' };

  const LADDER = [
    { name: 'Royal Flush', ex: 'As Ks Qs Js Ts', note: 'A-K-Q-J-10, all one suit. The best hand there is.' },
    { name: 'Straight Flush', ex: '9h 8h 7h 6h 5h', note: 'Five in a row, all one suit.' },
    { name: 'Four of a Kind', ex: 'Qc Qd Qh Qs 4d', note: 'Four cards of the same rank.' },
    { name: 'Full House', ex: '7s 7h 7d Kc Kh', note: 'Three of a kind plus a pair.' },
    { name: 'Flush', ex: 'Ad Jd 8d 6d 2d', note: 'Five cards of one suit, any order.' },
    { name: 'Straight', ex: 'Tc 9d 8s 7h 6c', note: 'Five in a row, mixed suits. A can be high or low.' },
    { name: 'Three of a Kind', ex: '5c 5d 5h Ks 9d', note: 'Three cards of the same rank.' },
    { name: 'Two Pair', ex: 'Jh Jc 4s 4d Ac', note: 'Two different pairs.' },
    { name: 'Pair', ex: 'Ts Td Ah 7c 3s', note: 'Two cards of the same rank.' },
    { name: 'High Card', ex: 'Ah Qd 9s 6c 3h', note: 'Nothing else: your highest card plays.' },
  ];

  const WHO_WINS = [
    { board: 'Ks 9d 4c 2h 7s', a: 'Ah Ad', b: 'Kd 9c', answer: 1,
      explain: 'Two pair beats one pair, even a pair of aces.' },
    { board: '6h 7h 8s Jh 2c', a: '9c Td', b: 'Ah 3h', answer: 1,
      explain: 'A flush beats a straight. Count the hearts: five of them with A-3.' },
    { board: 'Ac Kd 8s 8h 3c', a: 'As 5d', b: 'Ad Qs', answer: 2,
      explain: 'Both make aces and eights with the king from the board as the fifth card. Only five cards play, so the pot is split.' },
  ];

  const TIER_EXAMPLES = ['As Ad', 'Kh Kd', 'Ah Kh', 'Qs Qd', 'Ad Kc', 'Td Tc', 'Kh Qh', 'Ah Jh', '9h 8h', 'Qs Jd',
    '7h 6h', 'Ks Qd', '5s 5d', 'Ac 4d', 'Kd 7c', 'Jc 3d', '7c 2d', '9d 4s'];
  const TIER_QUIZ = [
    { hand: 'Ah Kh', answer: 'Premium', explain: 'Ace-king suited: big cards that make top pair and the nut flush.' },
    { hand: 'Kd 7c', answer: 'Trash', explain: 'A king with a weak kicker. When it pairs, it is often beaten by a better king.' },
    { hand: '9h 8h', answer: 'Playable', explain: 'Suited connectors make straights and flushes. Playable, best in position.' },
  ];
  const DOMINATION = { villain: 'As Kc', options: ['Kd Qh', '7h 6h'], answer: 1, iterations: 4000, seed: 7 };

  /* Table lessons. hands[] run in order; seat order = players order; dealer is the button seat
   * (the engine starts at seat 0 and moves it one seat left each hand). heroMax caps raise-to amounts. */
  const LESSONS = [
    {
      id: 1, title: 'How a hand works', blurb: 'Blinds, the deal, four betting rounds, showdown.', kind: 'table',
      table: {
        players: [P('b1', 'MAVIS'), P('b2', 'OTTO'), YOU], sb: 10, bb: 20,
        hands: [{
          dealer: 0, holes: { hero: 'Qh Jd', b1: 'Ts 9s', b2: '5c 3c' }, board: 'Qs 8c 4d 2h 7s',
          bots: { b1: ['call', 'bet 40', 'check', 'check'], b2: ['call', 'check', 'fold'] },
          hero: ['check', 'check', 'call', 'check', 'check'],
        }],
      },
      beats: [
        { on: 'handStart', wait: true, say: 'I\'m the dealer. We\'ll play one hand together, start to finish. You sit at the bottom of the table.' },
        { on: 'blinds', wait: true, ring: [seat('b2'), seat(HERO)], say: 'Before any cards, two players post forced bets: the small blind (10) and the big blind (20). You are the big blind this hand. Blinds mean there is always something to win.' },
        { on: 'deal', wait: true, ring: HERO_CARDS, say: 'Everyone gets two cards face down. These are yours, queen-jack. Nobody else can see them.' },
        { on: 'hero', ring: BTN.call, say: 'Betting round 1, preflop. MAVIS and OTTO both called 20. Nobody raised, so you owe nothing more. Press CHECK to see the flop.' },
        { on: 'street', street: 'flop', wait: true, ring: '#board', say: 'Round 2, the flop: three shared cards. Everyone makes a hand from their two cards plus the board. Your queen pairs the queen here.' },
        { on: 'hero', ring: BTN.call, say: 'OTTO checked, which means he bet nothing. You can do the same. Press CHECK.' },
        { on: 'action', who: 'b1', wait: true, ring: seat('b1'), say: 'MAVIS bets 40. Everyone after her has to call 40, raise, or fold.' },
        { on: 'hero', ring: BTN.call, say: 'OTTO folded. A pair of queens is a good hand here. Press CALL to match the 40.' },
        { on: 'street', street: 'turn', wait: true, ring: '#board', say: 'Round 3, the turn: a fourth shared card.' },
        { on: 'hero', ring: BTN.call, say: 'You act first now. Press CHECK.' },
        { on: 'street', street: 'river', wait: true, ring: '#board', say: 'Round 4, the river: the fifth and last card, then the last betting round.' },
        { on: 'hero', ring: BTN.call, say: 'Press CHECK. If MAVIS checks too, the cards get turned over.' },
        { on: 'showdown', wait: true, ring: [seat(HERO), seat('b1'), '#board'], say: 'Showdown. Each player\'s best five cards, from their two plus the five on the board, are compared. Your pair of queens beats her queen-high: she was hoping for a straight that never came.' },
        { on: 'handEnd', wait: true, ring: '#pot', say: 'That is a whole hand: blinds, the deal, four betting rounds, showdown. Every hand of hold\'em has this shape.' },
      ],
    },
    {
      id: 2, title: 'Hand rankings', blurb: 'Which five-card hands beat which.', kind: 'board', steps: ['ladder', 'whoWins'],
    },
    {
      id: 3, title: 'Your actions', blurb: 'Fold, check, call, bet and raise, on the real buttons.', kind: 'table',
      table: {
        players: [YOU, P('b1', 'PELLY', 2), P('b2', 'OTTO')], sb: 10, bb: 20, heroMax: 300,
        hands: [
          {
            dealer: 0, holes: { hero: '7c 2d', b1: '9c 4h', b2: 'Jd 6s' }, board: 'Ac Kc 5h 8d Qs',
            bots: { b1: ['fold'] }, hero: ['fold'],
          },
          {
            dealer: 1, holes: { hero: '8h 8d', b1: 'Ks Jc', b2: '6d 2s' }, board: '8s Kc 3d 4h 2c',
            bots: { b1: ['raise 60', 'bet 60', 'call', 'fold'], b2: ['fold'] },
            hero: ['call', 'check', 'raise 180', 'bet 200'],
          },
        ],
      },
      beats: [
        { on: 'handStart', wait: true, say: 'This lesson is the buttons. There are five moves: fold, check, call, bet and raise. I\'ll ask for each one, and the table waits until you press the one I name.' },
        { on: 'deal', wait: true, ring: HERO_CARDS, say: 'Seven-two in different suits: the weakest starting hand in the game.' },
        { on: 'hero', ring: BTN.fold, say: 'FOLD throws your cards away. It costs nothing more, and you are out of this hand. Press FOLD.' },
        { on: 'handEnd', wait: true, say: 'Folded for free. Folding weak hands is the most common good decision in poker. Next hand, the button moves one seat left.' },
        { on: 'deal', wait: true, ring: HERO_CARDS, say: 'Pocket eights this time. A real hand.' },
        { on: 'action', who: 'b1', wait: true, ring: seat('b1'), say: 'PELLY raises to 60. A raise makes everyone pay more to stay in.' },
        { on: 'hero', ring: BTN.call, say: 'CALL matches the bet in front of you: 40 more, because your big blind already put in 20. Press CALL.' },
        { on: 'street', street: 'flop', wait: true, ring: ['#board', HERO_CARDS], say: 'An eight on the flop gives you three of a kind. That is called a set.' },
        { on: 'hero', ring: BTN.call, say: 'Nobody has bet yet, so you can CHECK: stay in without adding chips. Let PELLY bet for you. Press CHECK.' },
        { on: 'action', who: 'b1', wait: true, ring: seat('b1'), say: 'PELLY bets 60. She took the bait.' },
        { on: 'hero', ring: ['#btn-raise', '.raise-box'], say: 'RAISE means putting in more than her bet. Pick a size with the slider or a preset (anything up to 300), then press RAISE.' },
        { on: 'hero', ring: BTN.raise, say: 'She called. Now nobody has bet on the turn, so putting chips in is a BET. Pick a size up to 300 and press BET.' },
        { on: 'handEnd', wait: true, ring: '#pot', say: 'She folded and the pot is yours. Fold, check, call, bet, raise: that is every move in the game.' },
      ],
    },
    {
      id: 4, title: 'Position', blurb: 'Why acting last is power. The button and the blinds.', kind: 'table',
      table: {
        players: [YOU, P('b1', 'PELLY', 2), P('b2', 'DUKE', 3), P('b3', 'ROSA', 2)], sb: 10, bb: 20, heroMax: 200,
        hands: [{
          dealer: 0, holes: { hero: '9s 8s', b1: 'Qd 3c', b2: 'Jh 4s', b3: 'Ah 6d' }, board: 'Kd 7s 2c 4h Jc',
          bots: { b3: ['call', 'check', 'fold'], b1: ['fold'], b2: ['check', 'check', 'fold'] },
          hero: ['call', 'bet 60'],
        }],
      },
      beats: [
        { on: 'handStart', wait: true, ring: '#dealer-chip', say: 'The disc marked D is the dealer button. This hand it sits in front of you. It moves one seat left every hand, so everyone gets a turn on it.' },
        { on: 'blinds', wait: true, ring: [seat('b1'), seat('b2')], say: 'The two players left of the button post the blinds. They put chips in before seeing a card, and that is the price of their seat this hand.' },
        { on: 'action', who: 'b3', wait: true, ring: seat('b3'), say: 'Preflop, the player left of the big blind acts first, with no idea what anyone behind her will do. That seat is called under the gun. ROSA calls.' },
        { on: 'hero', ring: BTN.call, say: 'You have nine-eight of spades. On the button it is worth a call, because you will act last on every street from here. Press CALL.' },
        { on: 'street', street: 'flop', wait: true, ring: '#board', say: 'After the flop, action starts left of the button, so the button always acts last. That is you.' },
        { on: 'hero', ring: [seat('b2'), seat('b3')],
          ask: {
            prompt: 'Who acts last on the flop, turn and river at this table?',
            choices: ['ROSA, under the gun', 'DUKE, the big blind', 'YOU, on the button', 'PELLY, the small blind'], answer: 2,
            explain: 'The button acts last after the flop. You get to see what everyone did before you decide.',
          },
          say: 'DUKE and ROSA both checked. Two checks often mean two weak hands. Take the pot with a bet: press BET (half the pot is plenty, up to 200).' },
        { on: 'handEnd', wait: true, ring: '#pot', say: 'Both folded. You won without a showdown, because you acted with information they didn\'t have. Play more hands on the button and fewer from the blinds and early seats.' },
      ],
    },
    {
      id: 5, title: 'Starting hands', blurb: 'Hand tiers, and why AK crushes KQ.', kind: 'board', steps: ['tiers', 'tierQuiz', 'domination'],
    },
    {
      id: 6, title: 'Pot odds & outs', blurb: 'Count your outs, read the price, decide.', kind: 'table',
      table: {
        players: [YOU, P('b1', 'DUKE', 3)], sb: 10, bb: 20, heroMax: 300,
        hands: [{
          dealer: 0, holes: { hero: '6h 5h', b1: 'Kc Qd' }, board: 'Kh 9h 2c Ts 4h',
          bots: { b1: ['raise 60', 'check', 'bet 30', 'check', 'call'] },
          hero: ['call', 'call', 'check', 'call', 'bet 100'],
        }],
      },
      beats: [
        { on: 'deal', wait: true, ring: HERO_CARDS, say: 'Heads-up against DUKE. You have six-five of hearts. Small cards, but suited.' },
        { on: 'hero', ring: BTN.call, say: 'You are on the button, which is also the small blind heads-up. Press CALL to complete to 20.' },
        { on: 'hero', ring: BTN.call, say: 'DUKE raised to 60. Suited cards play well enough to see a flop. Press CALL.' },
        { on: 'street', street: 'flop', wait: true, ring: ['#board', HERO_CARDS], say: 'Four hearts: two in your hand, two on the board. One more heart makes a flush. There are 13 hearts and you can see 4, so 9 are left. Those 9 cards are your outs.' },
        { on: 'hero', ring: BTN.call, say: 'The rule of 2 and 4: outs x 4 is roughly your chance with two cards to come, outs x 2 with one card to come. 9 x 4 = about 36% by the river. DUKE checked, so take the free card: press CHECK.' },
        { on: 'action', who: 'b1', street: 'turn', wait: true, ring: [seat('b1'), '#pot'], say: 'The turn missed you. DUKE bets 30. Now seeing the river costs something.' },
        { on: 'hero', slip: true, ring: BTN.call, say: 'Ink above the line: the call makes money over time. Press CALL.' },
        { on: 'street', street: 'river', wait: true, ring: ['#board', HERO_CARDS], say: 'The four of hearts. You made your flush.' },
        { on: 'hero', ring: BTN.raise, say: 'DUKE checked. Bet: he will often call with his king. Pick a size up to 300 and press BET.' },
        { on: 'handEnd', wait: true, ring: '#pot', say: 'You will hit this about 1 time in 5. But you paid 30 to win 150, so the times you hit pay for the times you miss. That is pot odds.' },
      ],
    },
    {
      id: 7, title: 'Reading a hand', blurb: 'Let the betting narrow down what they hold.', kind: 'table',
      table: {
        players: [YOU, P('b1', 'DUKE', 3)], sb: 10, bb: 20, heroMax: 200,
        hands: [{
          dealer: 0, holes: { hero: 'As Kd', b1: 'Qh Jh' }, board: 'Kh 8h 3c 5s 2h',
          bots: { b1: ['call', 'check', 'call', 'check', 'call', 'bet 300'] },
          hero: ['raise 60', 'bet 80', 'bet 200', 'fold|call'],
        }],
      },
      beats: [
        { on: 'deal', wait: true, ring: HERO_CARDS, say: 'Ace-king. A strong hand. This lesson is about DUKE\'s cards, not yours. Watch what he does on each street.' },
        { on: 'hero', ring: BTN.raise, say: 'Raise to 60 with the presets or slider (up to 200 is fine), then press RAISE.' },
        { on: 'street', street: 'flop', wait: true, ring: '#board', say: 'King, eight, three, with two hearts. You have top pair, best kicker. DUKE called preflop, so he has some kind of playable hand.' },
        { on: 'hero', ring: BTN.raise, say: 'DUKE checked. Bet for value: about half the pot. Press BET.' },
        { on: 'action', who: 'b1', street: 'flop', type: 'call', wait: true, ring: seat('b1'), say: 'He just calls. Strong hands like a set would often raise. Calling fits a medium king, a pair, or a draw.' },
        { on: 'hero', ring: BTN.raise, say: 'The five of spades changes nothing. He checks again. Bet again, up to 200.' },
        { on: 'action', who: 'b1', street: 'turn', type: 'call', wait: true, ring: seat('b1'), say: 'Another call. Weak pairs start to give up here. Draws keep calling.' },
        { on: 'action', who: 'b1', street: 'river', wait: true, ring: ['#board', seat('b1')], say: 'The two of hearts: the third heart. DUKE, who only checked and called, suddenly bets 300.' },
        { on: 'hero', ring: [BTN.fold, BTN.call],
          ask: {
            prompt: 'What is DUKE most likely holding?',
            choices: ['A worse king', 'A flush', 'Nothing, a bluff', 'A set of eights'], answer: 1,
            explain: 'He called twice without raising, which is how draws play. He only bet when the third heart came. A set would have raised earlier, and a worse king would check and hope.',
          },
          say: 'Your call. If you believe the read, folding top pair is fine here. Press FOLD or CALL.' },
        { on: 'handEnd', wait: true, reveal: 'b1', say: 'He had queen-jack of hearts: a flush. Reading hands is this process: start with everything he could have, then cross off what his bets rule out.' },
      ],
    },
    {
      id: 8, title: 'Graduation', blurb: 'Three real hands against two Fish, coach on.', kind: 'game',
      table: { players: [YOU, P('b1', 'FISH 1'), P('b2', 'FISH 2')], sb: 10, bb: 20, hands: GRAD_HANDS },
    },
  ];

  // ============================================================ progress (localStorage, never trusted)
  const Store = {
    read() {
      try {
        const raw = globalThis.localStorage && localStorage.getItem(STORE_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v === 'object' ? { done: Array.isArray(v.done) ? v.done.filter(Number.isInteger) : [], offered: !!v.offered } : null;
      } catch (err) {
        return null;
      }
    },
    write(v) {
      try { if (globalThis.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (err) { /* storage blocked */ }
    },
  };

  const api = { LESSONS, LADDER, WHO_WINS, TIER_QUIZ, TIER_EXAMPLES, DOMINATION, TIERS, buildDeck, dealOrder, parseAction,
    scriptedBot, heroExpect, checkHero, matchBeat, headsUp, STORE_KEY };

  if (typeof document === 'undefined') { PP.Tutorial = Object.freeze(api); return; }

  // ============================================================ DOM
  const UI = PP.UI;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function btn(label, cls, onClick, kbd) {
    const b = el('button', 'tut-btn ' + (cls || ''));
    b.type = 'button';
    b.append(el('span', null, label));
    if (kbd) b.append(el('kbd', null, kbd));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function cardRow(list) {
    const cs = typeof list === 'string' ? cards(list) : list;
    if (UI && typeof UI.miniCards === 'function') {
      try { return UI.miniCards(cs, 'big'); } catch (err) { /* fall back to text */ }
    }
    return el('span', 'tut-cards-text', cs.map((c) => PP.Cards.str(c)).join(' '));
  }
  function tok(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  let progress = Store.read() || { done: [], offered: false };
  function saveProgress(patch) { progress = { ...progress, ...patch }; Store.write(progress); }
  function markDone(id) { if (!progress.done.includes(id)) saveProgress({ done: progress.done.concat(id).sort((a, b) => a - b) }); }

  // ------------------------------------------------------------ dot-matrix scoreboard (C's DMD, 3x5 face)
  const F35 = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'],
    D: ['##.', '#.#', '#.#', '#.#', '##.'], E: ['###', '#..', '##.', '#..', '###'], L: ['#..', '#..', '#..', '#..', '###'],
    N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['.#.', '#.#', '#.#', '#.#', '.#.'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'], 0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'], 4: ['#.#', '#.#', '###', '..#', '..#'],
    5: ['###', '#..', '##.', '..#', '##.'], 6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '##.'], '/': ['..#', '..#', '.#.', '#..', '#..'],
    ' ': ['...', '...', '...', '...', '...'],
  };
  function glyph(ch) { return (F35[ch] || F35[' ']).join(''); }
  /** Draws lines of text as lit dots on an unlit dot grid. 1 dot = 2 canvas px; CSS scales it. */
  function dmd(lines, cols) {
    const cv = el('canvas', 'dmd tut-dmd');
    const rows = lines.length;
    const W = cols * 4 * 2 + 2;
    const H = rows * 7 * 2;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = tok('--dmd-bg', '#120907'); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = tok('--dmd-off', '#2c130b');
    for (let y = 1; y < H; y += 2) for (let x = 1; x < W; x += 2) ctx.fillRect(x, y, 1, 1);
    ctx.fillStyle = tok('--dmd-on', '#ff8a30');
    lines.forEach((line, r) => {
      const s = String(line).toUpperCase().slice(0, cols);
      const x0 = 1 + 2 * 4 * Math.floor((cols - s.length) / 2);
      [...s].forEach((ch, i) => {
        const g = glyph(ch);
        for (let j = 0; j < 5; j++) for (let k = 0; k < 3; k++) {
          if (g[j * 3 + k] === '#') ctx.fillRect(x0 + (i * 4 + k) * 2, 1 + (r * 7 + j + 1) * 2, 1, 1);
        }
      });
    });
    cv.style.setProperty('--dmd-w', W);
    cv.style.setProperty('--dmd-h', H);
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', lines.join(', '));
    return cv;
  }

  // ------------------------------------------------------------ overlay: dim, chalk rings, leader, dealer slate
  const O = {};
  function buildOverlay() {
    O.root = el('div', 'tut-root');
    O.root.hidden = true;
    O.dim = el('div', 'tut-dim');
    O.rings = el('div', 'tut-rings');
    O.lead = el('div', 'tut-lead');
    O.lead.append(el('i', 'h'), el('i', 'v'));
    O.stage = el('div', 'tut-stage');
    O.stage.hidden = true;
    O.dealer = el('section', 'tut-dealer slate');
    O.dealer.setAttribute('aria-live', 'polite');
    O.dealer.hidden = true;
    O.root.append(O.dim, O.rings, O.lead, O.stage, O.dealer);
    document.body.appendChild(O.root);
    window.addEventListener('resize', () => layout());
    window.addEventListener('keydown', onKey, true);
    makeChalkMask();
  }

  /** A tiny hashed noise tile: knocked-out pixels make DOM text and lines read as chalk. */
  function makeChalkMask() {
    // Heavy for big chalk (titles, ring lines), light for reading text so digits never lose a stroke.
    [['--tut-chalk-mask', 9, 2], ['--tut-chalk-light', 3, 1]].forEach(([name, pct, cell]) => {
      try {
        const c = el('canvas'); c.width = 24; c.height = 24;
        const x = c.getContext('2d');
        x.fillStyle = '#000'; x.fillRect(0, 0, 24, 24);
        const n = 24 / cell;
        for (let i = 0; i < n * n; i++) {
          let h = Math.imul(i ^ 0x9e37, 2654435761) >>> 0; h ^= h >>> 15;
          if ((h % 100) < pct) x.clearRect((i % n) * cell, ((i / n) | 0) * cell, cell, cell);
        }
        document.documentElement.style.setProperty(name, 'url(' + c.toDataURL() + ')');
      } catch (err) { /* plain text is fine */ }
    });
  }

  const S = { ring: [], blocking: null, keyHandler: null, layoutTimer: 0 };

  function targets(spec) {
    const sels = spec ? [].concat(spec) : [];
    return sels.map((s) => (typeof s === 'string' ? document.querySelector(s) : s))
      .filter((n) => n && n.getClientRects().length && n.getBoundingClientRect().width > 0);
  }
  function setRing(spec) {
    S.ring = spec ? [].concat(spec) : [];
    clearInterval(S.layoutTimer);
    if (S.ring.length) S.layoutTimer = setInterval(layout, 300);
    layout();
  }
  function union(rects) {
    return rects.reduce((u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top),
      right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }
  const PAD = 6;
  function layout() {
    if (!O.root || O.root.hidden) return;
    const nodes = targets(S.ring);
    O.rings.replaceChildren();
    const rects = nodes.map((n) => n.getBoundingClientRect());
    rects.forEach((r, i) => {
      const ring = el('div', 'tut-ring');
      ring.style.cssText = `left:${r.left - PAD}px;top:${r.top - PAD}px;width:${r.width + PAD * 2}px;height:${r.height + PAD * 2}px`;
      ring.dataset.v = String(i % 3);
      ring.append(el('i', 't'), el('i', 'r'), el('i', 'b'), el('i', 'l'));
      O.rings.appendChild(ring);
    });
    const u = rects.length ? union(rects) : null;
    O.dim.classList.toggle('on', !!u);
    if (u) O.dim.style.cssText = `left:${u.left - PAD - 4}px;top:${u.top - PAD - 4}px;width:${u.right - u.left + PAD * 2 + 8}px;height:${u.bottom - u.top + PAD * 2 + 8}px`;
    placeDealer(u);
  }


  /** Overlap area of two rects (0 when apart). */
  function overlapArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function rectOf(sel) {
    const n = typeof sel === 'string' ? document.querySelector(sel) : sel;
    const r = n && n.getClientRects().length ? n.getBoundingClientRect() : null;
    return r && r.width > 0 ? r : null;
  }

  /**
   * Park the slate where it covers the least of what matters, re-chosen every step: the ringed object,
   * the board, the hero's cards and the action bar are hard no-go zones; other seats are a soft cost.
   */
  function placeDealer(u) {
    const d = O.dealer;
    if (d.hidden || d.classList.contains('centered')) { O.lead.classList.remove('on'); return; }
    const bar = rectOf('#action-bar');
    const w = d.offsetWidth;
    const h = d.offsetHeight;
    const m = 12;
    const bottomLimit = bar ? Math.max(h + 2 * m, bar.top) : innerHeight;
    const hard = [u, rectOf('#board'), rectOf(HERO_CARDS), bar].filter(Boolean);
    const soft = Array.from(document.querySelectorAll('.seat:not(.hero)')).map(rectOf).filter(Boolean);
    const xs = [innerWidth - w - m, m, (innerWidth - w) / 2];
    const ys = [m, bottomLimit - h - m, (bottomLimit - h) / 2];
    const spots = [];
    ys.forEach((y) => xs.forEach((x) => {
      const left = Math.max(m, Math.min(innerWidth - w - m, x));
      const top = Math.max(m, Math.min(innerHeight - h - m, y));
      spots.push({ left, top, right: left + w, bottom: top + h });
    }));
    const score = (p) => hard.reduce((s, r) => s + overlapArea(p, r) * 100, 0) + soft.reduce((s, r) => s + overlapArea(p, r), 0);
    const best = spots.reduce((acc, p) => (score(p) < score(acc) ? p : acc), spots[0]);
    d.style.left = best.left + 'px';
    d.style.top = best.top + 'px';
    drawLead(best, u);
  }

  /** A 1u leader line, horizontal then vertical, from the slate to the ringed object. */
  function drawLead(p, u) {
    if (!u) { O.lead.classList.remove('on'); return; }
    const toRight = u.left > p.right;
    const toLeft = u.right < p.left;
    const sx = toRight ? p.right : toLeft ? p.left : (p.left + p.right) / 2;
    const sy = toRight || toLeft ? p.top + 22 : (u.top > p.bottom ? p.bottom : p.top);
    const ex = Math.max(u.left - PAD, Math.min(u.right + PAD, (u.left + u.right) / 2));
    const ey = u.top > sy ? u.top - PAD : u.bottom < sy ? u.bottom + PAD : sy;
    const [h, v] = O.lead.children;
    const hx = toRight || toLeft ? Math.min(sx, ex) : sx;
    h.style.cssText = `left:${hx}px;top:${sy}px;width:${toRight || toLeft ? Math.abs(ex - sx) : 0}px`;
    const vx = toRight || toLeft ? ex : sx;
    v.style.cssText = `left:${vx}px;top:${Math.min(sy, ey)}px;height:${Math.abs(ey - sy)}px`;
    O.lead.classList.add('on');
  }

  /**
   * Show the dealer slate. opts: { head, say, body (Node), actions:[{label, primary, kbd, value, quiet}],
   * centered }. Resolves with the chosen action's value when actions are given.
   */
  function dealer(opts) {
    const d = O.dealer;
    d.replaceChildren();
    d.classList.toggle('centered', !!opts.centered);
    d.classList.toggle('wide', !!opts.wide);
    const head = el('header', 'tut-head');
    head.append(el('span', 'tut-voice', 'DEALER'), el('span', 'tut-where', opts.head || ''));
    d.append(head);
    if (opts.say) d.append(el('p', 'tut-say', opts.say));
    if (opts.body) d.append(opts.body);
    d.hidden = false;
    O.root.hidden = false;
    S.blocking = null;
    let done = Promise.resolve(null);
    if (opts.actions && opts.actions.length) {
      const row = el('div', 'tut-actions');
      done = new Promise((resolve) => {
        const finish = (v) => { S.blocking = null; resolve(v); };
        opts.actions.forEach((a) => {
          const b = btn(a.label, a.primary ? 'paper go' : 'quiet', () => finish(a.value), a.kbd);
          row.appendChild(b);
          if (a.primary) S.blocking = () => finish(a.value);
        });
        S.cancelBlocking = () => finish('abort');
      });
      d.append(row);
    }
    if (!reduced) { d.classList.remove('in'); void d.offsetWidth; d.classList.add('in'); }
    layout();
    return done;
  }
  function hideDealer() { O.dealer.hidden = true; S.blocking = null; layout(); }

  function onKey(e) {
    if (O.root.hidden) return;
    const k = e.key;
    if (S.keyHandler && S.keyHandler(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if ((k === ' ' || k === 'Enter') && S.blocking && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) {
      e.preventDefault(); e.stopPropagation(); S.blocking();
      return;
    }
    if (!O.stage.hidden && (k === ' ' || k === 'Enter' || k === 'Escape')) {
      e.stopPropagation();
      if (k === 'Escape') { e.preventDefault(); if (run) openMenu(); else closeAll(); }
    }
  }

  // ------------------------------------------------------------ questions (chalk choices)
  /** Blocking multiple choice. Wrong picks get a chalk strike and stay wrong; resolves on the right one. */
  function question(container, q, onRight) {
    const box = el('div', 'tut-q');
    box.append(el('p', 'tut-prompt', q.prompt));
    const list = el('ol', 'tut-choices');
    const verdict = el('p', 'tut-verdict');
    let solved = false;
    return new Promise((resolve) => {
      S.cancelBlocking = () => { S.keyHandler = null; resolve(false); };
      const pick = (i, li) => {
        if (solved || li.classList.contains('struck')) return;
        if (i !== q.answer) {
          li.classList.add('struck');
          verdict.textContent = q.wrong ? q.wrong(i) : 'Not that one. Look again.';
          return;
        }
        solved = true;
        li.classList.add('right');
        list.classList.add('solved');
        verdict.textContent = q.explain || 'Right.';
        S.keyHandler = null;
        if (onRight) onRight();
        resolve(true);
      };
      q.choices.forEach((c, i) => {
        const li = el('li', 'tut-choice');
        const b = el('button', null);
        b.type = 'button';
        b.append(el('kbd', null, String(i + 1)), el('span', null, c));
        b.addEventListener('click', () => pick(i, li));
        li.appendChild(b);
        list.appendChild(li);
      });
      S.keyHandler = (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= q.choices.length) { pick(n - 1, list.children[n - 1]); return true; }
        return false;
      };
      box.append(list, verdict);
      container.appendChild(box);
    });
  }

  // ------------------------------------------------------------ the slip (DESIGN.md section 5), lesson 6
  const SLIP = { w: 36, h: 108, base: 104 };
  const FLIP = [1, 0.66, 0.33, 0, 0, 0.33, 0.66, 1];
  function slipScale() { return Math.max(2, Math.min(4, Math.floor(Math.min(innerWidth / 480, innerHeight / 300)))); }

  /** Resolves { read } after the player nicks the slip and it flips and pours to `have`. */
  function slip(container, need, have) {
    const s = slipScale();
    const wrap = el('div', 'tut-slip-wrap');
    const cv = el('canvas', 'tut-slip');
    cv.width = SLIP.w; cv.height = SLIP.h + 2;
    cv.style.width = SLIP.w * s + 'px';
    cv.style.height = (SLIP.h + 2) * s + 'px';
    cv.setAttribute('role', 'slider');
    cv.setAttribute('aria-label', 'Your read: click where you think your chance is, or type two digits');
    const price = el('div', 'tut-price');
    price.append(el('b', null, need), el('span', null, '%'));
    price.style.top = (SLIP.base - need - 9) * s + 'px';
    price.style.left = (SLIP.w + 3) * s + 'px';
    wrap.style.setProperty('--s', s + 'px');
    wrap.append(cv, price);
    container.appendChild(wrap);
    const ctx = cv.getContext('2d');
    const C = {
      paper: tok('--paper', '#f0e1c0'), shade: tok('--paper-2', '#d8c6a0'), ink: tok('--ink', '#1d130e'),
      price: tok('--price-ink', '#8c4b12'), loss: tok('--loss', '#a8291d'), dim: tok('--text-dim', '#a08f76'),
    };
    const y = (p) => SLIP.base - p;
    const st = { read: null, hover: null, face: false, pour: 0, flip: -1, typed: '' };
    function face(o) {
      ctx.clearRect(0, 0, SLIP.w, SLIP.h + 2);
      const r = (x, yy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, yy, w, h); };
      r(1, 0, SLIP.w - 2, SLIP.h, C.paper); r(0, 1, SLIP.w, SLIP.h - 2, C.paper);
      r(SLIP.w - 1, 1, 1, SLIP.h - 2, C.shade); r(1, SLIP.h - 1, SLIP.w - 2, 1, C.shade);
      for (let i = 1; i < SLIP.w - 1; i += 3) r(i, 2, 1, 1, C.shade);
      if (o.face && o.pour > 0) r(1, y(o.pour), SLIP.w - 2, o.pour, C.ink);
      if (o.face && o.pour >= have && have < need) {
        for (let p = have + 1; p < need - 1; p++) for (let i = 1; i < SLIP.w - 1; i++) if ((i + p) % 3 === 0) r(i, y(p), 1, 1, C.loss);
      }
      for (let p = 0; p <= 100; p += 5) r(1, y(p), p % 10 === 0 ? 5 : 3, 1, o.face && p <= o.pour ? C.shade : C.ink);
      r(6, y(need) - 1, SLIP.w - 6, 2, o.face && need <= o.pour ? C.shade : C.price);
      if (!o.face && o.hover !== null && o.read === null) r(7, y(o.hover), SLIP.w - 9, 1, C.dim);
      if (o.read !== null) {
        [[-3, 1], [-2, 3], [-1, 5], [0, 6], [1, 5], [2, 3], [3, 1]].forEach(([dy, len]) => {
          ctx.clearRect(0, y(o.read) + dy, len, 1); r(len, y(o.read) + dy, 1, 1, C.shade);
        });
      }
    }
    function draw() {
      if (st.flip < 0) { face(st); return; }
      const k = FLIP[Math.min(st.flip, FLIP.length - 1)];
      face({ ...st, face: st.flip >= 4 });
      if (k < 1) {
        const img = ctx.getImageData(0, 0, SLIP.w, SLIP.h + 2);
        const off = el('canvas'); off.width = SLIP.w; off.height = SLIP.h + 2;
        off.getContext('2d').putImageData(img, 0, 0);
        ctx.clearRect(0, 0, SLIP.w, SLIP.h + 2);
        const dw = Math.max(1, Math.round(SLIP.w * k));
        if (k > 0.01) ctx.drawImage(off, 0, 0, SLIP.w, SLIP.h + 2, Math.round((SLIP.w - dw) / 2), 0, dw, SLIP.h + 2);
      }
    }
    draw();
    const at = (ev) => {
      const b = cv.getBoundingClientRect();
      return Math.max(0, Math.min(100, Math.round(SLIP.base - ((ev.clientY - b.top) / b.height) * (SLIP.h + 2))));
    };
    return new Promise((resolve) => {
      S.cancelBlocking = () => { S.keyHandler = null; resolve(null); };
      const commit = (v) => {
        if (st.read !== null) return;
        st.read = v;
        S.keyHandler = null;
        cv.classList.add('done');
        price.classList.add('hide');
        const step = () => {
          if (st.flip < FLIP.length - 1) { st.flip += 1; draw(); return setTimeout(step, 1000 / 60 * 2); }
          st.face = true;
          if (st.pour < have) { st.pour = Math.min(have, st.pour + 2); draw(); return setTimeout(step, 1000 / 60); }
          price.classList.remove('hide');
          price.classList.add('lit');
          draw();
          resolve({ read: v });
          return null;
        };
        if (reduced) { st.flip = FLIP.length - 1; st.face = true; st.pour = have; draw(); price.classList.remove('hide'); resolve({ read: v }); return; }
        st.flip = 0; draw(); setTimeout(step, 50);
      };
      cv.addEventListener('pointermove', (ev) => { if (st.read === null) { st.hover = at(ev); draw(); } });
      cv.addEventListener('pointerleave', () => { st.hover = null; if (st.read === null) draw(); });
      cv.addEventListener('click', (ev) => commit(at(ev)));
      S.keyHandler = (e) => {
        if (!/^\d$/.test(e.key)) return false;
        st.typed += e.key;
        if (st.typed.length === 2) commit(Number(st.typed));
        return true;
      };
    });
  }

  // ------------------------------------------------------------ table lessons
  let run = null;

  function headFor(lesson) { return lesson.id + '/8 · ' + lesson.title.toUpperCase(); }

  async function startTable(lesson) {
    const t = lesson.table;
    const seatIds = t.players.map((p) => p.id);
    const scripted = Array.isArray(t.hands);
    const r = {
      lesson, beat: 0, hand: -1, heroTurn: 0, aborted: false, ending: false, handsPlayed: 0, engine: null,
      record: null, waits: [],
    };
    run = r;
    const bots = {};
    const handBots = {};
    if (scripted) {
      seatIds.filter((id) => id !== HERO).forEach((id) => {
        bots[id] = { style: 'Scripted', lastReasoning: '', decide: (view, legal, me) => handBots[id].decide(view, legal, me) };
      });
    } else {
      t.players.filter((p) => p.id !== HERO).forEach((p) => { bots[p.id] = PP.Bots.create({ rating: p.rating || 1, id: p.id, name: p.name }); });
    }
    const engineOpts = scripted ? {
      deckFn: (n) => {
        const h = t.hands[n - 1];
        return h ? buildDeck(seatIds, h.dealer, h.holes, h.board) : null;
      },
    } : {};
    if (!scripted) {
      O.stage.hidden = true;
      const go = await dealer({ head: headFor(lesson), centered: true, say: 'Last lesson: a real game against two Fish, players who call too much. The coach is on and suggests a move every turn. Play ' + GRAD_HANDS + ' hands your way.', actions: [{ label: 'DEAL ME IN', primary: true, kbd: 'SPACE', value: 'go' }, { label: 'ALL LESSONS', value: 'menu' }] });
      hideDealer();
      if (run !== r) return;
      if (go !== 'go') { run = null; if (go === 'menu') openMenu(); return; }
    }
    const tutor = {
      coach: !scripted,
      onStart: (engine) => {
        r.engine = engine;
        // The hand counter and fresh bot scripts must be in place before any beat sees the hand.
        engine.on('handStart', () => {
          r.hand += 1; r.heroTurn = 0;
          if (!scripted) { hideDealer(); return; }
          const spec = t.hands[r.hand] || { bots: {} };
          seatIds.forEach((id) => { if (id !== HERO) handBots[id] = scriptedBot((spec.bots || {})[id]); });
        });
        ['handStart', 'blinds', 'deal', 'turn', 'action', 'street', 'showdown', 'potAwarded']
          .forEach((name) => engine.on(name, (payload) => dispatch(r, name, payload)));
      },
      acceptHero: scripted ? (action) => gateHero(r, action) : undefined,
      onHandEnd: (record) => handEnd(r, record),
      onEnd: () => { if (!r.ending) abort(r); },
    };
    // The handStart counter must run before beats see the event, so it is registered first (in onStart).
    const g = PP.App.startCustomGame({ players: t.players, sb: t.sb, bb: t.bb, bots, engineOpts, tutor });
    if (!g) { run = null; return; }
    O.stage.hidden = true;
    O.root.hidden = false;
  }

  function heroEntry(r) {
    const spec = r.lesson.table.hands[r.hand];
    return spec && spec.hero[r.heroTurn - 1];
  }

  async function gateHero(r, action) {
    const entry = heroEntry(r);
    if (!entry || r.aborted) return true;
    const why = checkHero(entry, action, r.lesson.table.heroMax);
    if (!why) { setRing(null); hideDealer(); return true; }
    const want = heroExpect(entry).types.map((x) => x.toUpperCase()).join(' or ');
    const say = why === 'size'
      ? 'A bit smaller for this lesson: keep it to ' + r.lesson.table.heroMax + ' or less.'
      : 'Not that one this time. This step wants ' + want + '.';
    dealer({ head: headFor(r.lesson), say });
    return false;
  }

  /** Run the next beat if it matches this engine event. */
  async function dispatch(r, name, payload) {
    if (r.aborted || run !== r || !Array.isArray(r.lesson.beats)) return;
    if (name === 'turn' && payload && payload.playerId === HERO) r.heroTurn += 1;
    const ev = { name, payload, street: r.engine ? r.engine.street : null };
    // One engine event moves the script by at most one beat, so two hero beats in a row wait for two turns.
    if (r.aborted || !matchBeat(r.lesson.beats[r.beat], ev)) return;
    const beat = r.lesson.beats[r.beat];
    r.beat += 1;
    await runBeat(r, beat, payload);
  }

  async function runBeat(r, beat, payload) {
    const head = headFor(r.lesson);
    setRing(beat.ring || null);
    if (beat.ask) {
      const body = el('div', 'tut-body');
      dealer({ head, body });
      await track(r, question(body, beat.ask));
      if (r.aborted) return;
      await waitGo(r, head, body);
    }
    if (beat.slip) await runSlip(r, payload);
    if (r.aborted) return;
    if (beat.wait) {
      const body = beat.reveal ? revealBody(r, beat.reveal) : null;
      setRing(beat.ring || null);
      await track(r, dealer({ head, say: beat.say, body, actions: [{ label: 'GO ON', primary: true, kbd: 'SPACE', value: 'go' }] }));
      if (!r.aborted) { setRing(null); hideDealer(); }
      return;
    }
    setRing(beat.ring || null);
    dealer({ head, say: beat.say });
  }

  function track(r, promise) { r.waits.push(S.cancelBlocking); return promise; }

  async function waitGo(r, head, body) {
    const row = el('div', 'tut-actions');
    const go = new Promise((resolve) => {
      const b = btn('GO ON', 'paper go', () => { S.blocking = null; resolve('go'); }, 'SPACE');
      row.appendChild(b);
      S.blocking = () => { S.blocking = null; resolve('go'); };
      S.cancelBlocking = () => resolve('abort');
    });
    body.appendChild(row);
    layout();
    await track(r, go);
  }

  async function runSlip(r) {
    const view = r.engine.publicView(HERO);
    const legal = r.engine.getLegal(HERO);
    const hero = view.players.find((p) => p.id === HERO);
    const outs = PP.Equity.outs(hero.hole, view.board);
    const need = Math.round(PP.Equity.potOdds(legal.toCall, view.pot) * 100);
    const have = Math.round(PP.Equity.ruleOf2and4(outs.count, view.street));
    const exact = Math.round((outs.count / (52 - 2 - view.board.length)) * 100);
    const head = headFor(r.lesson);
    const body = el('div', 'tut-body tut-slip-body');
    const text = el('div', 'tut-slip-text');
    text.append(
      el('p', 'tut-say', 'This paper slip is your decision. The amber line is the PRICE: calling ' + legal.toCall + ' into a pot of ' + view.pot +
        ' needs ' + need + '% (' + legal.toCall + ' / ' + (view.pot + legal.toCall) + ').'),
      el('p', 'tut-say', 'Before it turns over, click the slip at the height you think your chance is. Bottom is 0%, top is 100%. Or type two digits.'));
    body.appendChild(text);
    setRing(null);
    dealer({ head, body, wide: true });
    const res = await track(r, slip(body, need, have));
    if (r.aborted || !res) return;
    const off = Math.abs(res.read - have);
    text.replaceChildren(
      el('p', 'tut-say', 'You read ' + res.read + '%. Rule of 2: ' + outs.count + ' outs x 2 = ' + have + '% (exactly ' + outs.count + ' of ' + (52 - 2 - view.board.length) + ' cards, ' + exact + '%).'),
      el('p', 'tut-say', (off <= 5 ? 'Close read. ' : 'Off by ' + off + '. It gets easier with reps. ') +
        'The ink rose past the amber line: you have more than the price.'));
    await waitGo(r, head, body);
  }

  function revealBody(r, id) {
    const p = r.record && (r.record.players || []).find((x) => x.id === id);
    const box = el('div', 'tut-reveal');
    if (p && p.hole && p.hole.length) box.append(el('span', 'tut-label', p.name), cardRow(p.hole));
    return box;
  }

  async function handEnd(r, record) {
    r.record = record;
    r.handsPlayed += 1;
    if (r.aborted) return false;
    await dispatch(r, 'handEnd', { record });
    if (r.aborted) return false;
    const t = r.lesson.table;
    const total = Array.isArray(t.hands) ? t.hands.length : t.hands;
    const over = r.engine && r.engine.isGameOver();
    if (r.handsPlayed < total && !over) {
      if (Array.isArray(t.hands)) return 'next';
      dealer({ head: headFor(r.lesson), say: 'Hand ' + r.handsPlayed + ' of ' + total + ' done.',
        actions: [{ label: 'next hand', primary: true, kbd: 'SPACE', value: 'next' }] })
        .then((v) => { const n = document.getElementById('btn-next'); if (v === 'next' && n && run === r) n.click(); });
      return 'wait';
    }
    finishLesson(r);
    return false;
  }

  async function finishLesson(r) {
    markDone(r.lesson.id);
    setRing(null);
    const next = LESSONS.find((l) => l.id === r.lesson.id + 1);
    const grad = r.lesson.kind === 'game';
    const say = grad
      ? 'That\'s graduation. You know the whole loop now: position, starting hands, pot odds, reading bets. From here, PLAY sets up a table with any opponents, and DRILLS sharpen one skill at a time.'
      : 'Lesson ' + r.lesson.id + ' done.' + (next ? ' Next: ' + next.title.toLowerCase() + '.' : '');
    const actions = [];
    if (next) actions.push({ label: 'NEXT LESSON', primary: true, kbd: 'SPACE', value: 'next' });
    actions.push({ label: 'ALL LESSONS', primary: !next, kbd: next ? null : 'SPACE', value: 'menu' });
    const choice = await dealer({ head: headFor(r.lesson), say, actions, centered: true, body: doneStamp(r.lesson) });
    leaveRun(r);
    if (choice === 'next' && next) startLesson(next.id);
    else if (choice !== 'abort') openMenu();
  }

  function doneStamp(lesson) {
    return dmd(['LESSON ' + lesson.id, progress.done.length + '/8 DONE'], 11);
  }

  function leaveRun(r) {
    r.ending = true;
    r.aborted = true;
    if (run === r) run = null;
    if (PP.App.isPlaying()) PP.App.endGame();
    setRing(null);
    hideDealer();
    O.root.hidden = O.stage.hidden;
  }

  /** The game ended from outside (MENU / Esc): release any waiting beat so the engine can finish. */
  function abort(r) {
    r.aborted = true;
    if (run === r) run = null;
    r.waits.forEach((f) => { if (typeof f === 'function') f(); });
    if (S.cancelBlocking) S.cancelBlocking();
    S.keyHandler = null;
    setRing(null);
    hideDealer();
    O.root.hidden = O.stage.hidden;
  }

  // ------------------------------------------------------------ board lessons (2, 5): drawn on a big slate
  async function startBoard(lesson) {
    const r = { lesson, aborted: false };
    run = r;
    for (const step of lesson.steps) {
      if (r.aborted) return;
      const ok = await BOARD_STEPS[step](r);
      if (!ok || r.aborted) return;
    }
    markDone(lesson.id);
    run = null;
    const next = LESSONS.find((l) => l.id === lesson.id + 1);
    const frame = boardFrame(lesson, 'Lesson ' + lesson.id + ' done.');
    frame.body.append(doneStamp(lesson));
    const choice = await frame.actions([next && { label: 'NEXT LESSON', primary: true, value: 'next' },
      { label: 'ALL LESSONS', primary: !next, value: 'menu' }].filter(Boolean));
    if (choice === 'next' && next) startLesson(next.id);
    else if (choice !== 'abort') openMenu();
  }

  /** A full-screen slate for board lessons and the menu. Returns { body, actions(list) -> Promise }. */
  function boardFrame(lesson, title, sub) {
    O.stage.replaceChildren();
    O.stage.hidden = false;
    O.root.hidden = false;
    hideDealer();
    setRing(null);
    const board = el('section', 'tut-board slate');
    const head = el('header', 'tut-board-head');
    const titles = el('div');
    titles.append(el('span', 'tut-where', lesson ? headFor(lesson) : 'LEARN'), el('h2', 'tut-title chalk-text', title));
    if (sub) titles.append(el('p', 'tut-sub', sub));
    head.append(titles);
    const leave = btn('LEAVE', 'quiet', () => { if (run) run.aborted = true; run = null; finish('abort'); openMenu(); }, 'ESC');
    head.append(leave);
    const body = el('div', 'tut-board-body');
    const foot = el('footer', 'tut-actions');
    board.append(head, body, foot);
    O.stage.append(board, el('div', 'tut-ledge'));
    let finish = () => {};
    return {
      board, body, head,
      actions(list) {
        foot.replaceChildren();
        return new Promise((resolve) => {
          finish = (v) => { S.blocking = null; resolve(v); };
          list.forEach((a) => {
            const b = btn(a.label, a.primary ? 'paper go' : 'quiet', () => finish(a.value), a.primary ? 'SPACE' : null);
            foot.appendChild(b);
            if (a.primary) S.blocking = () => finish(a.value);
          });
        });
      },
    };
  }

  const BOARD_STEPS = {
    async ladder(r) {
      const f = boardFrame(r.lesson, 'Hand rankings', 'Best at the top. Your best five cards (from your two plus the five on the board) make your hand. Click a rung.');
      const wrap = el('div', 'tut-ladder');
      const rungs = el('ol', 'tut-rungs');
      const show = el('div', 'tut-rung-show paper');
      const pick = (i) => {
        [...rungs.children].forEach((li, j) => li.classList.toggle('on', j === i));
        rungs.children[i].classList.add('seen');
        const h = LADDER[i];
        show.replaceChildren(el('h3', 'tut-rung-name', h.name), cardRow(h.ex), el('p', 'tut-rung-note', h.note),
          el('p', 'tut-rung-rank', 'Beats everything below it. ' + (i < LADDER.length - 1 ? 'Rung ' + (i + 1) + ' of 10.' : 'The bottom rung.')));
      };
      LADDER.forEach((h, i) => {
        const li = el('li', 'tut-rung');
        const b = el('button', null);
        b.type = 'button';
        b.append(el('span', 'n', String(i + 1).padStart(2, '0')), el('span', null, h.name));
        b.addEventListener('click', () => pick(i));
        b.addEventListener('mouseenter', () => pick(i));
        li.appendChild(b);
        rungs.appendChild(li);
      });
      S.keyHandler = (e) => {
        const cur = [...rungs.children].findIndex((li) => li.classList.contains('on'));
        if (e.key === 'ArrowDown') { pick(Math.min(LADDER.length - 1, cur + 1)); return true; }
        if (e.key === 'ArrowUp') { pick(Math.max(0, cur - 1)); return true; }
        return false;
      };
      wrap.append(rungs, show);
      f.body.append(wrap);
      pick(0);
      const v = await f.actions([{ label: 'GO ON', primary: true, value: 'go' }]);
      S.keyHandler = null;
      return v === 'go';
    },

    async whoWins(r) {
      let score = 0;
      for (let i = 0; i < WHO_WINS.length; i++) {
        const q = WHO_WINS[i];
        const f = boardFrame(r.lesson, 'Which hand wins?', 'Question ' + (i + 1) + ' of ' + WHO_WINS.length + '. Both players share the board.');
        const sb = dmd(['SCORE', score + '/' + WHO_WINS.length], 7);
        f.head.insertBefore(sb, f.head.lastChild);
        const table = el('div', 'tut-hands');
        const group = (label, hole) => { const g = el('div', 'tut-hand'); g.append(el('span', 'tut-label', label), cardRow(hole)); return g; };
        table.append(group('BOARD', q.board), group('HAND A', q.a), group('HAND B', q.b));
        f.body.append(table);
        const board = cards(q.board);
        const ea = PP.Eval.evaluate(cards(q.a).concat(board));
        const eb = PP.Eval.evaluate(cards(q.b).concat(board));
        let firstTry = true;
        await question(f.body, {
          prompt: 'Which hand wins?', choices: ['HAND A', 'HAND B', 'SPLIT POT'], answer: q.answer,
          wrong: () => { firstTry = false; return 'Not quite. A has ' + ea.desc + '. B has ' + eb.desc + '.'; },
          explain: 'A: ' + ea.desc + '. B: ' + eb.desc + '. ' + q.explain,
        });
        if (firstTry) score += 1;
        if (run !== r) return false;
        const v = await f.actions([{ label: i < WHO_WINS.length - 1 ? 'NEXT' : 'GO ON', primary: true, value: 'go' }]);
        if (v !== 'go') return false;
      }
      return true;
    },

    async tiers(r) {
      const f = boardFrame(r.lesson, 'Starting hands', 'Most two-card hands lose money. Good players fold most of them and play the top tiers harder.');
      const grid = el('div', 'tut-tiers');
      TIERS.forEach((tier) => {
        const col = el('div', 'tut-tier');
        col.append(el('h3', null, tier.toUpperCase()));
        const list = el('ul');
        TIER_EXAMPLES.filter((h) => PP.Equity.preflopTier(cards(h)) === tier)
          .forEach((h) => list.append(el('li', null, PP.Equity.handLabel(cards(h)))));
        col.append(list);
        grid.append(col);
      });
      f.body.append(grid, el('p', 'tut-note', '"s" means suited (same suit), "o" offsuit. Pairs, high cards and suited, connected cards are what you want.'));
      return (await f.actions([{ label: 'GO ON', primary: true, value: 'go' }])) === 'go';
    },

    async tierQuiz(r) {
      for (let i = 0; i < TIER_QUIZ.length; i++) {
        const q = TIER_QUIZ[i];
        const f = boardFrame(r.lesson, 'Which tier?', 'Question ' + (i + 1) + ' of ' + TIER_QUIZ.length + '.');
        const hand = el('div', 'tut-hand');
        hand.append(el('span', 'tut-label', 'YOU HOLD'), cardRow(q.hand));
        f.body.append(hand);
        const tier = PP.Equity.preflopTier(cards(q.hand));
        await question(f.body, { prompt: 'Which tier is this hand?', choices: TIERS.map((t) => t.toUpperCase()), answer: TIERS.indexOf(tier), explain: q.explain });
        if (run !== r) return false;
        if ((await f.actions([{ label: 'GO ON', primary: true, value: 'go' }])) !== 'go') return false;
      }
      return true;
    },

    async domination(r) {
      const d = DOMINATION;
      const f = boardFrame(r.lesson, 'Dominated hands', 'King-queen looks pretty. Against ace-king it is in big trouble: they share a king, and the ace outkicks the queen.');
      const table = el('div', 'tut-hands');
      const group = (label, hole) => { const g = el('div', 'tut-hand'); g.append(el('span', 'tut-label', label), cardRow(hole)); return g; };
      table.append(group('THEY HOLD', d.villain), group('OPTION 1', d.options[0]), group('OPTION 2', d.options[1]));
      f.body.append(table);
      const rng = PP.Cards.seededRng(d.seed);
      const eq = d.options.map((o) => Math.round(headsUp(cards(o), cards(d.villain), d.iterations, rng) * 100));
      await question(f.body, {
        prompt: 'They hold ace-king. Which hand would you rather have?',
        choices: [PP.Equity.handLabel(cards(d.options[0])), PP.Equity.handLabel(cards(d.options[1]))], answer: d.answer,
        explain: 'KQ wins about ' + eq[0] + '% against AK. 76s wins about ' + eq[1] + '%: it shares no card with AK, so any pair or straight is live. A hand that shares a card and has the worse kicker is dominated.',
      });
      if (run !== r) return false;
      return (await f.actions([{ label: 'GO ON', primary: true, value: 'go' }])) === 'go';
    },
  };

  // ------------------------------------------------------------ menu, launch, first-run offer
  function startLesson(id) {
    const lesson = LESSONS.find((l) => l.id === id);
    if (!lesson) return;
    if (run) { run.aborted = true; run = null; }
    if (PP.App && PP.App.isPlaying()) PP.App.endGame();
    O.stage.hidden = true;
    if (lesson.kind === 'board') { startBoard(lesson); return; }
    startTable(lesson);
  }

  function nextLessonId() {
    const n = LESSONS.find((l) => !progress.done.includes(l.id));
    return n ? n.id : 1;
  }

  async function openMenu() {
    if (run) { run.aborted = true; run = null; }
    if (UI && UI.currentScreen && UI.currentScreen() === 'table') UI.showScreen('title');
    const f = boardFrame(null, 'Learn the game', 'Eight short lessons with the dealer. Each one takes a few minutes. Replay any of them.');
    f.head.insertBefore(dmd(['LESSONS', progress.done.length + '/8 DONE'], 9), f.head.lastChild);
    const list = el('ol', 'tut-lessons');
    const nextId = nextLessonId();
    let chosen = null;
    LESSONS.forEach((l) => {
      const done = progress.done.includes(l.id);
      const li = el('li', 'tut-lesson' + (done ? ' done' : '') + (l.id === nextId && progress.done.length < 8 ? ' next' : ''));
      const b = el('button', null);
      b.type = 'button';
      b.append(el('span', 'n', String(l.id)), el('span', 't', l.title), el('span', 'd', l.blurb),
        el('span', 'st', done ? 'DONE' : l.id === nextId ? 'NEXT' : ''));
      b.addEventListener('click', () => { chosen = l.id; S.blocking = null; finishMenu('pick'); });
      li.appendChild(b);
      list.appendChild(li);
    });
    f.body.append(list);
    let finishMenu = () => {};
    const actions = [{ label: progress.done.length ? 'CONTINUE: LESSON ' + nextId : 'START LESSON 1', primary: true, value: 'start' },
      { label: 'BACK', value: 'back' }];
    if (progress.done.length) actions.push({ label: 'RESET PROGRESS', value: 'reset' });
    const p = f.actions(actions);
    const picked = new Promise((resolve) => { finishMenu = resolve; });
    S.keyHandler = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 8) { chosen = n; finishMenu('pick'); return true; }
      return false;
    };
    const v = await Promise.race([p, picked]);
    S.keyHandler = null;
    if (v === 'pick' && chosen) { startLesson(chosen); return; }
    if (v === 'start') { startLesson(nextId); return; }
    if (v === 'reset') { saveProgress({ done: [] }); openMenu(); return; }
    closeAll();
  }

  function closeAll() {
    if (run) { const r = run; r.aborted = true; run = null; if (r.engine && PP.App.isPlaying()) PP.App.endGame(); }
    S.keyHandler = null;
    S.blocking = null;
    O.stage.hidden = true;
    O.stage.replaceChildren();
    hideDealer();
    setRing(null);
    O.root.hidden = true;
    if (UI && UI.showScreen && UI.currentScreen() !== 'title') UI.showScreen('title');
  }

  async function offerFirstRun() {
    saveProgress({ offered: true });
    O.stage.hidden = true;
    const v = await dealer({
      head: 'FIRST TIME HERE', centered: true,
      say: 'New to hold\'em, or rusty? I can teach you the game in 8 short lessons on a real table. You can skip any of them.',
      actions: [{ label: 'TEACH ME', primary: true, kbd: 'SPACE', value: 'yes' }, { label: 'NOT NOW', value: 'no' }],
    });
    hideDealer();
    O.root.hidden = true;
    if (v === 'yes') openMenu();
  }

  function bindLaunch() {
    let nav = document.getElementById('nav-learn');
    if (!nav) {
      // Fallback when the title menu has no LEARN item: add one next to the others.
      const menu = document.querySelector('.title-menu') || document.getElementById('screen-title');
      if (menu) {
        nav = el('button', 'btn tut-nav-fallback');
        nav.type = 'button';
        nav.id = 'nav-learn';
        nav.append(el('span', 'btn-label', 'LEARN'));
        menu.appendChild(nav);
      }
    }
    if (nav && !nav.dataset.tutBound) {
      nav.dataset.tutBound = '1';
      nav.addEventListener('click', (e) => { e.preventDefault(); openMenu(); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'l' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!O.root.hidden || (UI && UI.isModalOpen && UI.isModalOpen())) return;
      if (UI && UI.currentScreen && UI.currentScreen() === 'title') { e.preventDefault(); openMenu(); }
    });
  }

  function boot() {
    if (!PP.App || !PP.Cards) return;
    buildOverlay();
    bindLaunch();
    if (!progress.offered && !progress.done.length) offerFirstRun();
  }

  /** Read-only: which lesson is running and the move it is waiting for (used by the browser check). */
  function current() {
    if (!run) return null;
    const scripted = run.lesson.kind === 'table';
    return Object.freeze({ id: run.lesson.id, expect: scripted && run.hand >= 0 ? heroEntry(run) || null : null, heroMax: (run.lesson.table || {}).heroMax || null });
  }

  PP.Tutorial = Object.freeze({ ...api, open: () => openMenu(), start: (id) => startLesson(id), close: () => closeAll(), current });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
