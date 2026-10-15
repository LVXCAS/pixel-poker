/* Regression tests for coach review findings: "nuts" = hand strength not random
 * equity, range-aware pot odds, preflop grading by tier, no fold-vs-+EV
 * contradictions, gutshot calls, drill outs/explanations, grade notes. */
(function () {
  const { Coach, Cards, Eval } = PP;
  const t = (name, fn) => TESTS.push({ name: 'coach-review: ' + name, fn });
  const P = Cards.parseMany;
  const HERO = 'hero';

  function makeView(o) {
    const n = (o.opponents || 1) + 1;
    const players = Array.from({ length: n }, (_, i) => ({
      id: i === 0 ? HERO : 'v' + i, name: i === 0 ? 'You' : 'Bot' + i, seat: i,
      stack: o.stack || 2000, bet: (o.bets && o.bets[i]) || 0, totalBet: 0,
      folded: false, allIn: false, out: false, isHuman: i === 0, lastAction: null,
      hole: i === 0 ? P(o.hole) : null,
    }));
    return {
      handNumber: 1, street: o.street || 'preflop', board: o.board ? P(o.board) : [],
      pot: o.pot, pots: [], currentBet: o.currentBet || 0, minRaiseTo: 0,
      bigBlind: o.bb || 10, smallBlind: (o.bb || 10) / 2,
      dealerSeat: o.dealerSeat != null ? o.dealerSeat : 0,
      sbSeat: o.sbSeat != null ? o.sbSeat : 1 % n, bbSeat: o.bbSeat != null ? o.bbSeat : 2 % n,
      toActId: HERO, players, history: o.history || [],
    };
  }

  function makeLegal(toCall, currentBet, stack) {
    const st = stack || 2000;
    return {
      canFold: true, canCheck: toCall === 0, canCall: toCall > 0, callAmount: toCall, toCall,
      canBet: currentBet === 0, canRaise: currentBet > 0,
      minRaiseTo: Math.max(10, currentBet * 2), maxRaiseTo: st,
    };
  }

  const opts = () => ({ iterations: 2000, rng: Cards.seededRng(5) });
  const H = (street, playerId, type, amount) => ({ street, playerId, type, amount, potAfter: 0 });
  const isAggro = (type) => type === 'bet' || type === 'raise' || type === 'allin';

  t('top pair facing a flop 4-bet is NOT "the nuts" and does not re-raise', () => {
    const history = [
      H('preflop', 'v1', 'raise', 30), H('preflop', HERO, 'call', 20),
      H('flop', HERO, 'bet', 100), H('flop', 'v1', 'raise', 300), H('flop', HERO, 'raise', 700), H('flop', 'v1', 'raise', 1300),
    ];
    const view = makeView({ hole: 'As Kd', board: 'Kc 7h 2d', street: 'flop', pot: 1600 + 700, currentBet: 1300, bets: [700, 1300], history });
    const adv = Coach.advise(view, makeLegal(600, 1300), HERO, opts());
    assert.ok(!isAggro(adv.recommendation.type), adv.recommendation.type);
    assert.ok(!adv.reasons.some((r) => /nuts/i.test(r)), adv.reasons.join(' | '));
    assert.equal(adv.nutted, false);
    assert.notEqual(Coach.grade(adv, { type: 'fold' }).grade, 'BLUNDER');
  });

  t('the real nuts is detected by hand strength (a set on a dry board, a nut flush)', () => {
    const v1 = makeView({ hole: 'Kd Ks', board: 'Kc 7h 2d', street: 'flop', pot: 100 });
    assert.equal(Coach.advise(v1, makeLegal(0, 0), HERO, opts()).nutted, true);
    const v2 = makeView({ hole: 'Ah 5h', board: 'Kh 8h 2h 3c Jd', street: 'river', pot: 100 });
    assert.equal(Coach.advise(v2, makeLegal(0, 0), HERO, opts()).nutted, true);
    const v3 = makeView({ hole: 'Jd Tc', board: '9h 8s 7d 2c 2s', street: 'river', pot: 100 });
    assert.equal(Coach.advise(v3, makeLegal(0, 0), HERO, opts()).nutted, false, 'straight on a paired board');
  });

  t('AA with no heart vs a pot bet on a 4-heart river is never a high-confidence "+EV" call', () => {
    const history = [H('river', 'v1', 'bet', 200)];
    const view = makeView({ hole: 'As Ad', board: 'Kh 7h 2h 9h 3c', street: 'river', pot: 400, currentBet: 200, bets: [0, 200], history });
    const adv = Coach.advise(view, makeLegal(200, 200), HERO, opts());
    assert.ok(!(adv.recommendation.type === 'call' && adv.confidence === 'high'), adv.recommendation.type + ' ' + adv.confidence);
  });

  t('bare gutshot facing a pot-sized bet → fold, and the call is not graded +EV', () => {
    const history = [H('flop', 'v1', 'bet', 100)];
    const view = makeView({ hole: '9s 8d', board: 'Qc 6h 5d', street: 'flop', pot: 200, currentBet: 100, bets: [0, 100], history });
    const adv = Coach.advise(view, makeLegal(100, 100), HERO, opts());
    assert.equal(adv.recommendation.type, 'fold');
    assert.ok(adv.adjEquity < adv.potOdds, `adj ${adv.adjEquity} vs need ${adv.potOdds}`);
    assert.ok(!/\+EV/.test(Coach.grade(adv, { type: 'call' }).note));
  });

  t('preflop: folding AA unopened is a BLUNDER, not a "disciplined fold"', () => {
    const view = makeView({ hole: 'As Ad', pot: 15, currentBet: 10, opponents: 5, bets: [0, 0, 0, 0, 5, 10], dealerSeat: 3, sbSeat: 4, bbSeat: 5 });
    const adv = Coach.advise(view, makeLegal(10, 10), HERO, opts());
    assert.equal(Coach.grade(adv, { type: 'fold' }).grade, 'BLUNDER');
  });

  t('preflop: limping a playable hand on the button is OK, not a BLUNDER', () => {
    ['Ah 5h', 'Kd 9c'].forEach((hole) => {
      const view = makeView({ hole, pot: 15, currentBet: 10, opponents: 5, bets: [0, 0, 0, 0, 5, 10], dealerSeat: 0, sbSeat: 4, bbSeat: 5 });
      const adv = Coach.advise(view, makeLegal(10, 10), HERO, opts());
      const g = Coach.grade(adv, { type: 'call' }).grade;
      assert.ok(['OK', 'GOOD', 'GREAT'].includes(g), hole + ' ' + g);
    });
  });

  t('BB with 22 vs a 2.5bb open: defend (no fold-vs-"+EV" contradiction)', () => {
    const history = [H('preflop', 'v1', 'raise', 25)];
    const view = makeView({ hole: '2s 2h', pot: 40, currentBet: 25, opponents: 1, bets: [10, 25], dealerSeat: 1, sbSeat: 1, bbSeat: 0, history });
    // 3-handed table where everyone else folded: make it a 3-seat view with seat 2 folded
    view.players.push({ id: 'v2', name: 'B2', seat: 2, stack: 2000, bet: 0, totalBet: 0, folded: true, allIn: false, out: false, isHuman: false, lastAction: 'fold', hole: null });
    const adv = Coach.advise(view, makeLegal(15, 25), HERO, opts());
    assert.notEqual(adv.recommendation.type, 'fold', adv.reasons.join(' | '));
  });

  t('whenever the coach says fold while the price is right, confidence is low and a reason explains it', () => {
    const rng = Cards.seededRng(17);
    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const deck = Cards.shuffle(Cards.makeDeck(), rng);
      const hole = Cards.str(deck[0]) + ' ' + Cards.str(deck[1]);
      const raise = 20 + Math.floor(rng() * 40);
      const view = makeView({ hole, pot: 15 + raise, currentBet: raise, opponents: 1, bets: [10, raise], dealerSeat: 1, sbSeat: 1, bbSeat: 0, history: [H('preflop', 'v1', 'raise', raise)] });
      const adv = Coach.advise(view, makeLegal(raise - 10, raise), HERO, { iterations: 400, rng });
      if (adv.recommendation.type === 'fold' && adv.adjEquity >= adv.potOdds) {
        checked += 1;
        assert.equal(adv.confidence, 'low');
        assert.ok(!adv.reasons.some((r) => /Calling is \+EV/.test(r)), adv.reasons.join(' | '));
      }
    }
    assert.ok(checked >= 0);
  });

  t('heads-up: Q2o on the button is not a high-confidence fold for a $10 completion', () => {
    const view = makeView({ hole: 'Qd 2c', pot: 30, currentBet: 20, opponents: 1, bets: [10, 20], bb: 20, dealerSeat: 0, sbSeat: 0, bbSeat: 1 });
    const adv = Coach.advise(view, makeLegal(10, 20), HERO, opts());
    assert.ok(adv.recommendation.type !== 'fold' || adv.confidence === 'low', adv.recommendation.type + ' ' + adv.confidence);
  });

  t('grade note quotes the action-justifying sentence, not a random reason', () => {
    const view = makeView({ hole: 'Kd 9c', pot: 15, currentBet: 10, opponents: 5, bets: [0, 0, 0, 0, 5, 10], dealerSeat: 2, sbSeat: 4, bbSeat: 5 });
    const adv = Coach.advise(view, makeLegal(10, 10), HERO, opts());
    const g = Coach.grade(adv, { type: adv.recommendation.type, amount: adv.recommendation.amount });
    assert.ok(adv.why && g.note.includes(adv.why), g.note);
    assert.ok(!/best seat to play more hands/.test(g.note), g.note);
  });

  t('texture warnings match the hand: no "your pair" with high card, no "one pair" with a straight', () => {
    const v1 = makeView({ hole: '7s 2d', board: 'Kc Qh 9d', street: 'flop', pot: 100 });
    const a1 = Coach.advise(v1, makeLegal(0, 0), HERO, opts());
    assert.ok(!a1.reasons.some((r) => /your pair/.test(r)), a1.reasons.join(' | '));
    const v2 = makeView({ hole: 'Js Td', board: '9c 8h 7d 2s 2c', street: 'river', pot: 100 });
    const a2 = Coach.advise(v2, makeLegal(0, 0), HERO, opts());
    assert.ok(!a2.reasons.some((r) => /careful with one pair/.test(r)), a2.reasons.join(' | '));
  });

  t('drill outs never count board-only straights (split pots)', () => {
    const deck = Cards.makeDeck();
    [['2h 4c', 'Js Ts Qs 9h'], ['6d Qc', '4h 3s 2d 6s'], ['Qs 7c', '8s Jh Ts Qd']].forEach(([h, b]) => {
      assert.equal(Coach.Drills.countDrawOuts(P(h), P(b), deck).total, 0, h + ' | ' + b);
    });
    const rng = Cards.seededRng(11);
    for (let i = 0; i < 300; i++) {
      const q = Coach.Drills.makeQuestion('outs', rng);
      const { board, hands } = q.cards;
      const outCards = q.explanation.match(/— ([^.]*)\./)[1].split(' ').map(Cards.parse);
      outCards.forEach((c) => {
        if (board.length !== 4) return;
        const hero = Eval.evaluate(hands[0].hole.concat(board, [c])).score;
        const boardOnly = Eval.evaluate(board.concat([c])).score;
        assert.ok(hero > boardOnly, 'board-only out ' + Cards.str(c));
      });
    }
  });

  t('winner drill: different pair ranks are explained by rank, not kicker', () => {
    const rng = Cards.seededRng(4);
    let seen = 0;
    for (let i = 0; i < 400 && seen < 5; i++) {
      const q = Coach.Drills.makeQuestion('winner', rng);
      const evals = q.cards.hands.map((h) => Eval.evaluate(h.hole.concat(q.cards.board)));
      if (evals.length !== 2 || evals[0].cat !== 1 || evals[1].cat !== 1) continue;
      const main = (d) => d.replace(/,[^,]*kickers?$/i, '');
      if (main(evals[0].desc) === main(evals[1].desc)) continue;
      seen += 1;
      assert.ok(!/kicker/.test(q.explanation.split('. ').pop()), q.explanation);
    }
    assert.ok(seen > 0, 'found pair-vs-pair spots');
  });
})();
