/* Tests for PP.Equity */
(function () {
  const { Cards, Equity } = PP;
  const P = Cards.parseMany;
  const t = (name, fn) => TESTS.push({ name: 'equity: ' + name, fn });
  const near = (actual, expected, tol, msg) =>
    assert.ok(Math.abs(actual - expected) <= tol, (msg || '') + ' expected ~' + expected + ', got ' + actual.toFixed(4));
  const outStr = (o) => o.cards.map(Cards.str).sort().join(' ');

  const MC_ITER = 40000;
  const MC_TOL = 0.015;

  // Reference equities (well-known published values) vs N random hands.
  t('Monte Carlo: AA vs 1 random ≈ 85.2%', () => {
    const r = Equity.monteCarlo({ hero: P('As Ah'), board: [], opponents: 1, iterations: MC_ITER, rng: Cards.seededRng(1) });
    near(r.equity, 0.852, MC_TOL, 'AA');
    near(r.win + r.tie + r.lose, 1, 1e-9);
  });

  t('Monte Carlo: 72o vs 1 random ≈ 34.6%', () => {
    const r = Equity.monteCarlo({ hero: P('7c 2d'), board: [], opponents: 1, iterations: MC_ITER, rng: Cards.seededRng(2) });
    near(r.equity, 0.346, MC_TOL, '72o');
  });

  t('Monte Carlo: AKs vs 2 random ≈ 50.7%, vs 3 random ≈ 41.4%', () => {
    const r2 = Equity.monteCarlo({ hero: P('As Ks'), board: [], opponents: 2, iterations: MC_ITER, rng: Cards.seededRng(3) });
    near(r2.equity, 0.507, MC_TOL, 'AKs v2');
    const r3 = Equity.monteCarlo({ hero: P('As Ks'), board: [], opponents: 3, iterations: MC_ITER, rng: Cards.seededRng(4) });
    near(r3.equity, 0.414, MC_TOL, 'AKs v3');
  });

  t('Monte Carlo: exact cases on a full board', () => {
    const royal = Equity.monteCarlo({ hero: P('As Ks'), board: P('Qs Js Ts 2d 3c'), opponents: 3, iterations: 500 });
    assert.equal(royal.equity, 1);
    assert.equal(royal.win, 1);
    const boardPlays = Equity.monteCarlo({ hero: P('2c 3d'), board: P('Ah Kh Qh Jh Th'), opponents: 2, iterations: 500 });
    assert.equal(boardPlays.tie, 1);
    near(boardPlays.equity, 1 / 3, 1e-9, 'three-way chop');
  });

  t('Monte Carlo: flop draw vs one hand-ish sanity and dead cards respected', () => {
    const r = Equity.monteCarlo({
      hero: P('Ah 5h'), board: P('Kh 9h 4c'), opponents: 1, iterations: 20000,
      dead: P('2h 3h'), rng: Cards.seededRng(5),
    });
    assert.ok(r.equity > 0.4 && r.equity < 0.75, 'nut flush draw equity ' + r.equity);
  });

  t('Monte Carlo: rejects invalid input', () => {
    assert.throws(() => Equity.monteCarlo({ hero: P('As'), opponents: 1 }));
    assert.throws(() => Equity.monteCarlo({ hero: P('As As'), opponents: 1 }));
    assert.throws(() => Equity.monteCarlo({ hero: P('As Ks'), board: P('As 2c 3d'), opponents: 1 }));
    assert.throws(() => Equity.monteCarlo({ hero: P('As Ks'), board: P('2c'), opponents: 1 }));
    assert.throws(() => Equity.monteCarlo({ hero: P('As Ks'), opponents: 0 }));
  });

  t('handLabel', () => {
    assert.equal(Equity.handLabel(P('Ks As')), 'AKs');
    assert.equal(Equity.handLabel(P('Jd Qc')), 'QJo');
    assert.equal(Equity.handLabel(P('7h 7c')), '77');
    assert.equal(Equity.handLabel(P('2c Td')), 'T2o');
  });

  t('Chen score, preflopScore and tiers', () => {
    assert.equal(Equity.chenScore(P('As Ah')), 20);
    assert.equal(Equity.chenScore(P('Ks Kh')), 16);
    assert.equal(Equity.chenScore(P('2s 2h')), 5);
    assert.equal(Equity.chenScore(P('As Ks')), 12);
    assert.equal(Equity.chenScore(P('7c 2d')), -1);
    assert.equal(Equity.chenScore(P('Jh Th')), 9);
    assert.equal(Equity.preflopScore(P('As Ah')), 1);
    assert.equal(Equity.preflopScore(P('7c 2d')), 0);
    assert.equal(Equity.preflopTier(P('As Ah')), 'Premium');
    assert.equal(Equity.preflopTier(P('As Ks')), 'Premium');
    assert.equal(Equity.preflopTier(P('Ts Th')), 'Strong');
    assert.equal(Equity.preflopTier(P('Ah Kd')), 'Strong');
    assert.equal(Equity.preflopTier(P('8h 7h')), 'Playable');
    assert.equal(Equity.preflopTier(P('7c 2d')), 'Trash');
  });

  t('outs: nut flush draw + overcard = 12, no double counting', () => {
    const o = Equity.outs(P('Ah 5h'), P('Kh 9h 4c'));
    assert.equal(o.count, 12);
    assert.equal(o.cards.length, new Set(o.cards.map(Cards.str)).size);
    assert.deepEqual([...o.draws], ['Flush draw', 'Overcard']);
    assert.match(o.desc, /12 outs/);
    assert.match(o.desc, /Rule of 4/);
  });

  t('outs: open-ended straight draw = 8', () => {
    const o = Equity.outs(P('8c 7d'), P('6h 5s Kd'));
    assert.equal(o.count, 8);
    assert.equal(outStr(o), '4c 4d 4h 4s 9c 9d 9h 9s');
    assert.deepEqual([...o.draws], ['Open-ended straight draw']);
  });

  t('outs: gutshot = 4', () => {
    const o = Equity.outs(P('9c 8d'), P('Qh 5s Jd'));
    assert.equal(o.count, 4);
    assert.ok(o.draws.includes('Gutshot'));
  });

  t('outs: combo draw (flush + OESD) = 15, not 17', () => {
    const o = Equity.outs(P('9h 8h'), P('Th 7c 2h'));
    assert.equal(o.count, 15);
    assert.ok(o.draws.includes('Flush draw') && o.draws.includes('Open-ended straight draw'));
  });

  t('outs: two overcards = 6', () => {
    const o = Equity.outs(P('Ac Qd'), P('9h 7s 2c'));
    assert.equal(o.count, 6);
    assert.deepEqual([...o.draws], ['Overcards']);
  });

  t('outs: cards that only pair the board are excluded', () => {
    // Hero AK on a paired turn: a 7 or 9 gives everyone two pair; only A/K count.
    const o = Equity.outs(P('Ac Kd'), P('2c 2d 7h 9s'));
    assert.equal(o.count, 6);
    assert.ok(o.cards.every((c) => c.r === 14 || c.r === 13));
  });

  t('outs: kicker-only improvements are not outs', () => {
    const o = Equity.outs(P('3c 4d'), P('Ah Ad Kc Ks'));
    assert.equal(o.count, 0, outStr(o));
    assert.match(o.desc, /No clean outs/);
  });

  t('outs: board straight cards only count when hero beats the board', () => {
    // Board 5-6-7-8: a 4 gives the board a straight (not an out), a 9 gives hero a J-high straight.
    const o = Equity.outs(P('Tc Jd'), P('5h 6s 7d 8c'));
    const straightOuts = o.cards.filter((c) => c.r === 9 || c.r === 4).map(Cards.str).sort().join(' ');
    assert.equal(straightOuts, '9c 9d 9h 9s');
    assert.equal(o.count, 10, 'four 9s + six overcard outs (T, J)');
  });

  t('outs: set draw with a pocket pair = 2', () => {
    const o = Equity.outs(P('5c 5d'), P('Kh 7s 2c'));
    assert.equal(o.count, 2);
    assert.ok(o.draws.includes('Set draw'));
  });

  t('outs: empty on preflop and river', () => {
    assert.equal(Equity.outs(P('Ah Kh'), []).count, 0);
    assert.equal(Equity.outs(P('Ah Kh'), P('2c 3c 4c 5c 9d')).count, 0);
  });

  t('potOdds', () => {
    assert.equal(Equity.potOdds(0, 100), 0);
    near(Equity.potOdds(50, 100), 1 / 3, 1e-12);
    near(Equity.potOdds(100, 100), 0.5, 1e-12);
  });

  t('ruleOf2and4', () => {
    assert.equal(Equity.ruleOf2and4(9, 'flop'), 36);
    assert.equal(Equity.ruleOf2and4(9, 'turn'), 18);
    assert.equal(Equity.ruleOf2and4(30, 'flop'), 100);
    assert.equal(Equity.ruleOf2and4(9, 'river'), 0);
  });

  t('boardTexture', () => {
    const dry = Equity.boardTexture(P('Kh 7s 2c'));
    assert.ok(dry.rainbow && !dry.wet && !dry.paired && !dry.connected);
    assert.match(dry.desc, /^Dry board/);

    const wet = Equity.boardTexture(P('Jh Th 9h'));
    assert.ok(wet.monotone && wet.connected && wet.wet && wet.flushPossible);
    assert.match(wet.desc, /^Wet board/);

    const paired = Equity.boardTexture(P('8c 8d 3h'));
    assert.ok(paired.paired && paired.rainbow);

    const twoTone = Equity.boardTexture(P('Kh 9h 4c'));
    assert.ok(twoTone.twoTone && !twoTone.monotone);

    const wheelish = Equity.boardTexture(P('Ac 2d 4h'));
    assert.ok(wheelish.connected, 'ace plays low for connectivity');

    const pre = Equity.boardTexture([]);
    assert.equal(pre.wet, false);
    assert.match(pre.desc, /preflop/);
  });
})();
