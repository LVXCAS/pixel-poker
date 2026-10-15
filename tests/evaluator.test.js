/* Tests for PP.Eval */
(function () {
  const { Cards, Eval } = PP;
  const t = (name, fn) => TESTS.push({ name: 'eval: ' + name, fn });
  const ev = (s) => Eval.evaluate(Cards.parseMany(s));
  const bestStr = (h) => h.best.map(Cards.str).sort().join(' ');
  const sortStr = (s) => s.split(' ').sort().join(' ');

  t('every category is recognised with correct catName and desc', () => {
    const cases = [
      ['As Ks Qs Js Ts 2d 3c', 8, 'Royal Flush', 'Royal Flush'],
      ['9h 8h 7h 6h 5h Ad Ac', 8, 'Straight Flush', 'Straight Flush, Nine high'],
      ['Ad 2d 3d 4d 5d Kc Kh', 8, 'Straight Flush', 'Straight Flush, Five high (steel wheel)'],
      ['Jc Jd Jh Js 3c 3d 9h', 7, 'Four of a Kind', 'Four of a Kind, Jacks, Nine kicker'],
      ['3c 3d 3h 9s 9c 2d Kh', 6, 'Full House', 'Full House, Threes full of Nines'],
      ['Ah 9h 7h 4h 2h Kc Qd', 5, 'Flush', 'Flush, Ace high'],
      ['9c 8d 7h 6s 5c 2d 2h', 4, 'Straight', 'Straight, Nine high'],
      ['Ac 2d 3h 4s 5c Kd 9h', 4, 'Straight', 'Straight, Five high (the wheel)'],
      ['7c 7d 7h Ks 2c 4d 9h', 3, 'Three of a Kind', 'Three of a Kind, Sevens, King-Nine kickers'],
      ['Kc Kd 7h 7s 2c 4d 9h', 2, 'Two Pair', 'Two Pair, Kings and Sevens, Nine kicker'],
      ['Qc Qd 7h 5s 2c 4d 9h', 1, 'Pair', 'Pair of Queens, Nine-Seven-Five kickers'],
      ['Ac Jd 7h 5s 2c 4d 9h', 0, 'High Card', 'High Card, Ace, Jack-Nine-Seven-Five kickers'],
    ];
    for (const [cards, cat, catName, desc] of cases) {
      const h = ev(cards);
      assert.equal(h.cat, cat, cards);
      assert.equal(h.catName, catName, cards);
      assert.equal(h.desc, desc, cards);
      assert.equal(h.best.length, 5, cards);
    }
  });

  t('best 5 cards are selected correctly', () => {
    assert.equal(bestStr(ev('As Ks Qs Js Ts 2d 3c')), sortStr('As Ks Qs Js Ts'));
    assert.equal(bestStr(ev('Ad 2d 3d 4d 5d 6c Kh')), sortStr('Ad 2d 3d 4d 5d'));
    assert.equal(bestStr(ev('Ac 2d 3h 4s 5c Kd 9h')), sortStr('Ac 2d 3h 4s 5c'));
    assert.equal(bestStr(ev('3c 3d 3h 9s 9c 9d Kh')), sortStr('9s 9c 9d 3c 3d'));
    assert.equal(bestStr(ev('Ah 9h 7h 4h 2h 3h Kc')), sortStr('Ah 9h 7h 4h 3h'));
    assert.equal(bestStr(ev('Kc Kd 7h 7s 2c 2d 9h')), sortStr('Kc Kd 7h 7s 9h'));
  });

  t('wheel loses to six-high straight; steel wheel beats quads', () => {
    assert.ok(ev('Ac 2d 3h 4s 5c').score < ev('2d 3h 4s 5c 6h').score);
    assert.ok(ev('Ad 2d 3d 4d 5d').score > ev('Ac Ad Ah As Kd').score);
    assert.equal(ev('Ad 2d 3d 4d 5d').cat, 8);
  });

  t('flush beats straight when both are present', () => {
    const h = ev('9h 8h 7c 6h 5d 2h Kh');
    assert.equal(h.cat, 5);
    assert.equal(h.desc, 'Flush, King high');
  });

  t('A-K-Q-J-T is the highest straight, no wrap-around', () => {
    assert.equal(ev('Ac Kd Qh Js Tc').desc, 'Straight, Ace high');
    assert.equal(ev('Qc Kd Ah 2s 3c').cat, 0);
  });

  t('kickers decide pairs, two pair, trips, high card', () => {
    assert.ok(ev('Ac Ad Kh 8s 3c').score > ev('As Ah Qh Js Tc').score);
    assert.ok(ev('Kc Kd 7h 7s Ac').score > ev('Ks Kh 7c 7d Qc').score);
    assert.ok(ev('8c 8d 8h As 2c').score > ev('8s 8d 8h Ks Qc').score);
    assert.ok(ev('Ac Qd 9h 7s 3c').score > ev('Ad Qc 9s 7h 2c').score);
  });

  t('two pair with three pairs uses best kicker incl. third pair', () => {
    const h = ev('Kc Kd 7h 7s 5c 5d 2h');
    assert.equal(h.desc, 'Two Pair, Kings and Sevens, Five kicker');
  });

  t('full house with two trips picks higher trips', () => {
    assert.equal(ev('3c 3d 3h 9s 9c 9d Kh').desc, 'Full House, Nines full of Threes');
  });

  t('board plays → exact tie', () => {
    const board = 'Ac Kd Qh Js Tc';
    const a = ev(board + ' 2c 3d');
    const b = ev(board + ' 4h 5s');
    assert.equal(a.score, b.score);
    assert.equal(Eval.compare(a, b), 0);
  });

  t('same hand different suits ties; compare sign', () => {
    const a = ev('Ac Kc 9d 7h 2s');
    const b = ev('Ad Kd 9h 7s 2c');
    assert.equal(Eval.compare(a, b), 0);
    assert.equal(Eval.compare(ev('2c 2d 5h 7s 9c'), a), 1);
    assert.equal(Eval.compare(a, ev('2c 2d 5h 7s 9c')), -1);
  });

  t('quads kicker uses best remaining card, even from a pair', () => {
    assert.equal(ev('5c 5d 5h 5s Kc Kd 2h').desc, 'Four of a Kind, Fives, King kicker');
    const a = ev('9c 9d 9h 9s Ac 2d 3h');
    const b = ev('9c 9d 9h 9s Kc Qd Jh');
    assert.ok(a.score > b.score);
  });

  t('rejects bad input', () => {
    assert.throws(() => ev('Ac Kd Qh Js'));
    assert.throws(() => ev('Ac Kd Qh Js Tc 9c 8c 7c'));
    assert.throws(() => ev('Ac Ac Qh Js Tc'));
    assert.throws(() => Eval.evaluate([{ r: 15, s: 'h' }, ...Cards.parseMany('Kd Qh Js Tc')]));
  });

  t('scoreOnly matches evaluate().score; result immutable', () => {
    const cards = Cards.parseMany('Ac Ad Kh 8s 3c 7d 2h');
    const h = Eval.evaluate(cards);
    assert.equal(Eval.scoreOnly(cards), h.score);
    assert.ok(Object.isFrozen(h));
    assert.ok(Object.isFrozen(h.best));
  });

  // ---- brute-force cross check ----------------------------------------------

  function combos5(cards) {
    const res = [];
    const n = cards.length;
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) res.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    return res;
  }

  t('7-card eval equals best of 21 five-card combos (5000 random hands)', () => {
    const rand = Cards.seededRng(2024);
    const deck = Cards.makeDeck();
    for (let i = 0; i < 5000; i++) {
      const seven = Cards.shuffle(deck, rand).slice(0, 7);
      const h = Eval.evaluate(seven);
      const brute = Math.max(...combos5(seven).map((c) => Eval.scoreOnly(c)));
      assert.equal(h.score, brute, seven.map(Cards.str).join(' '));
      assert.equal(Eval.scoreOnly(h.best), h.score, 'best cards reproduce score');
      assert.equal(new Set(h.best.map(Cards.str)).size, 5);
    }
  });

  t('5-card category frequencies over all 2,598,960 hands match theory', () => {
    const expected = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
    const counts = new Array(9).fill(0);
    const deck = Cards.makeDeck();
    const hand = new Array(5);
    for (let a = 0; a < 52; a++) { hand[0] = deck[a];
      for (let b = a + 1; b < 52; b++) { hand[1] = deck[b];
        for (let c = b + 1; c < 52; c++) { hand[2] = deck[c];
          for (let d = c + 1; d < 52; d++) { hand[3] = deck[d];
            for (let e = d + 1; e < 52; e++) {
              hand[4] = deck[e];
              counts[Math.floor(Eval.scoreOnly(hand) / 1048576)]++;
            } } } } }
    assert.deepEqual(counts, expected);
  });

  t('benchmark: >= 200k 7-card evals/sec', () => {
    const rand = Cards.seededRng(99);
    const deck = Cards.makeDeck();
    const hands = [];
    for (let i = 0; i < 2000; i++) hands.push(Cards.shuffle(deck, rand).slice(0, 7));
    const N = 400000;
    let sink = 0;
    for (let i = 0; i < 20000; i++) sink += Eval.scoreOnly(hands[i % hands.length]);
    const start = performance.now();
    for (let i = 0; i < N; i++) sink += Eval.scoreOnly(hands[i % hands.length]);
    const secs = (performance.now() - start) / 1000;
    const rate = N / secs;
    assert.ok(sink > 0);
    assert.ok(rate >= 200000, 'only ' + Math.round(rate) + ' evals/sec');
  });
})();
