/* Tests for PP.Cards */
(function () {
  const Cards = PP.Cards;
  const t = (name, fn) => TESTS.push({ name: 'cards: ' + name, fn });

  t('makeDeck has 52 unique frozen cards', () => {
    const deck = Cards.makeDeck();
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck.map(Cards.str)).size, 52);
    assert.ok(deck.every((c) => Object.isFrozen(c)));
  });

  t('shuffle returns a new permutation and leaves input untouched', () => {
    const deck = Cards.makeDeck();
    const before = deck.map(Cards.str).join(',');
    const shuffled = Cards.shuffle(deck, Cards.seededRng(42));
    assert.notEqual(shuffled, deck);
    assert.equal(deck.map(Cards.str).join(','), before);
    assert.equal(shuffled.length, 52);
    assert.deepEqual(shuffled.map(Cards.str).sort(), deck.map(Cards.str).sort());
    assert.notEqual(shuffled.map(Cards.str).join(','), before);
  });

  t('seededRng is deterministic and in [0,1)', () => {
    const a = Cards.seededRng(7);
    const b = Cards.seededRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
  });

  t('rng returns floats in [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const x = Cards.rng();
      assert.ok(x >= 0 && x < 1);
    }
  });

  t('shuffle is roughly uniform (first position)', () => {
    const rand = Cards.seededRng(123);
    const counts = new Array(52).fill(0);
    const deck = Cards.makeDeck();
    const N = 52000;
    for (let i = 0; i < N; i++) {
      const s = Cards.shuffle(deck, rand);
      counts[deck.indexOf(s[0])]++;
    }
    for (const n of counts) assert.ok(n > 800 && n < 1200, 'bucket ' + n);
  });

  t('parse / str round trip and parseMany', () => {
    for (const c of Cards.makeDeck()) assert.ok(Cards.same(Cards.parse(Cards.str(c)), c));
    assert.deepEqual(Cards.parse('As'), { r: 14, s: 's' });
    assert.deepEqual(Cards.parse('td'), { r: 10, s: 'd' });
    assert.deepEqual(Cards.parse('10h'), { r: 10, s: 'h' });
    assert.equal(Cards.parseMany('As Kd, 2c').map(Cards.str).join(' '), 'As Kd 2c');
    assert.deepEqual(Cards.parseMany(''), []);
    assert.throws(() => Cards.parse('Zx'));
    assert.throws(() => Cards.parse('A'));
  });

  t('rank names and plurals', () => {
    assert.equal(Cards.rankName(14), 'Ace');
    assert.equal(Cards.rankName(10), 'Ten');
    assert.equal(Cards.rankNamePlural(6), 'Sixes');
    assert.equal(Cards.rankNamePlural(13), 'Kings');
  });

  t('isRed, same, SUIT_SYMBOL', () => {
    assert.ok(Cards.isRed(Cards.parse('Ah')));
    assert.ok(Cards.isRed(Cards.parse('Ad')));
    assert.ok(!Cards.isRed(Cards.parse('Ac')));
    assert.ok(Cards.same({ r: 5, s: 'h' }, Cards.parse('5h')));
    assert.ok(!Cards.same(Cards.parse('5h'), Cards.parse('5d')));
    assert.equal(Cards.SUIT_SYMBOL.s, '♠');
    assert.equal(Cards.RANKS, '23456789TJQKA');
  });
})();
