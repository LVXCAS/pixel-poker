/* Tests for PP.Coach */
(function () {
  const { Coach, Cards, Eval } = PP;
  const t = (name, fn) => TESTS.push({ name: 'coach: ' + name, fn });
  const P = Cards.parseMany;
  const HERO = 'hero';
  const FUZZ_N = 500;

  // Build a minimal publicView. Hero sits at seat 0; villains follow.
  function makeView(o) {
    const n = (o.opponents || 1) + 1;
    const players = Array.from({ length: n }, (_, i) => ({
      id: i === 0 ? HERO : 'v' + i, name: i === 0 ? 'You' : 'Bot' + i, seat: i,
      stack: o.stack || 1000, bet: (o.bets && o.bets[i]) || 0, totalBet: 0,
      folded: false, allIn: false, out: false, isHuman: i === 0, lastAction: null,
      hole: i === 0 ? P(o.hole) : null,
    }));
    return {
      handNumber: 1, street: o.street || 'preflop', board: o.board ? P(o.board) : [],
      pot: o.pot, pots: [], currentBet: o.currentBet || 0, minRaiseTo: 0,
      bigBlind: 10, smallBlind: 5,
      dealerSeat: o.dealerSeat != null ? o.dealerSeat : 0,
      sbSeat: o.sbSeat != null ? o.sbSeat : 1 % n, bbSeat: o.bbSeat != null ? o.bbSeat : 2 % n,
      toActId: HERO, players, history: [],
    };
  }

  function makeLegal(toCall, currentBet, stack) {
    const st = stack || 1000;
    return {
      canFold: true, canCheck: toCall === 0, canCall: toCall > 0, callAmount: toCall, toCall,
      canBet: currentBet === 0, canRaise: currentBet > 0,
      minRaiseTo: Math.max(10, currentBet * 2), maxRaiseTo: st,
    };
  }

  const opts = () => ({ iterations: 3000, rng: Cards.seededRng(7) });
  const isAggro = (type) => type === 'bet' || type === 'raise' || type === 'allin';

  // ------------------------------------------------------------- advise
  t('AA preflop unopened → raise with reasons', () => {
    const view = makeView({ hole: 'As Ad', pot: 15, currentBet: 10, opponents: 5, dealerSeat: 3, sbSeat: 4, bbSeat: 5 });
    const adv = Coach.advise(view, makeLegal(10, 10), HERO, opts());
    assert.equal(adv.recommendation.type, 'raise');
    assert.equal(adv.preflopTier, 'Premium');
    assert.equal(adv.holeLabel, 'AA');
    assert.ok(adv.reasons.length >= 2 && adv.reasons.length <= 5);
    assert.ok(adv.recommendation.amount >= 20);
  });

  t('72o facing a big raise → fold', () => {
    const view = makeView({ hole: '7c 2d', pot: 135, currentBet: 120, opponents: 3, bets: [0, 0, 120, 0], dealerSeat: 3, sbSeat: 1, bbSeat: 2 });
    const adv = Coach.advise(view, makeLegal(120, 120), HERO, opts());
    assert.equal(adv.recommendation.type, 'fold');
    assert.equal(adv.preflopTier, 'Trash');
  });

  t('72o in the big blind with a free option → check (never fold for free)', () => {
    const view = makeView({ hole: '7c 2d', pot: 30, currentBet: 10, opponents: 2, bets: [10, 10, 10], dealerSeat: 1, sbSeat: 2, bbSeat: 0 });
    const adv = Coach.advise(view, makeLegal(0, 10), HERO, opts());
    assert.equal(adv.recommendation.type, 'check');
    assert.equal(adv.position, 'Blinds');
  });

  t('nut flush draw with good odds → call or raise, and outs explained', () => {
    const view = makeView({ hole: 'Ah 5h', board: 'Kh 8h 2c', street: 'flop', pot: 130, currentBet: 30, opponents: 1, bets: [0, 30] });
    const adv = Coach.advise(view, makeLegal(30, 30), HERO, opts());
    assert.ok(['call', 'raise'].includes(adv.recommendation.type), adv.recommendation.type);
    assert.ok(adv.outs.count >= 9);
    assert.ok(adv.reasons.some((r) => /outs/.test(r)), adv.reasons.join(' | '));
    assert.ok(adv.reasons.some((r) => /equity/.test(r)));
  });

  t('weak hand facing a pot-sized river bet → fold', () => {
    const view = makeView({ hole: '4c 3d', board: 'Ks Qh 9d 8c 2s', street: 'river', pot: 400, currentBet: 200, opponents: 1, bets: [0, 200] });
    const adv = Coach.advise(view, makeLegal(200, 200), HERO, opts());
    assert.equal(adv.recommendation.type, 'fold');
  });

  t('the nuts with no bet → bet for value', () => {
    const view = makeView({ hole: 'Ah Kh', board: 'Qh Jh Th 2c', street: 'turn', pot: 100, opponents: 2 });
    const adv = Coach.advise(view, makeLegal(0, 0), HERO, opts());
    assert.equal(adv.recommendation.type, 'bet');
    assert.match(adv.made, /Royal|Straight Flush/);
  });

  t('4-flush board danger is explained', () => {
    const view = makeView({ hole: 'Ks Kd', board: 'Ah 9h 5h 2h', street: 'turn', pot: 100, opponents: 1 });
    const adv = Coach.advise(view, makeLegal(0, 0), HERO, opts());
    assert.ok(adv.reasons.some((r) => /4 hearts/.test(r)), adv.reasons.join(' | '));
  });

  t('position labels: button, blinds, early', () => {
    const base = { hole: 'As Kd', pot: 15, currentBet: 10, opponents: 8, dealerSeat: 0, sbSeat: 1, bbSeat: 2 };
    assert.equal(Coach.advise(makeView(base), makeLegal(10, 10), HERO, opts()).position, 'Button');
    const sb = makeView({ ...base, dealerSeat: 8, sbSeat: 0, bbSeat: 1 });
    const early = makeView({ ...base, dealerSeat: 6, sbSeat: 7, bbSeat: 8 });
    assert.equal(Coach.positionOf(early, HERO), 'Early');
    assert.equal(Coach.positionOf(sb, HERO), 'Blinds');
  });

  t('recommendations are always legal', () => {
    const rng = Cards.seededRng(99);
    for (let i = 0; i < 60; i++) {
      const deck = Cards.shuffle(Cards.makeDeck(), rng);
      const boardLen = [0, 3, 4, 5][i % 4];
      const toCall = [0, 20, 80][i % 3];
      const currentBet = boardLen === 0 ? Math.max(10, toCall) : toCall;
      const view = makeView({ hole: deck.slice(0, 2).map(Cards.str).join(' '), board: deck.slice(2, 2 + boardLen).map(Cards.str).join(' ') || undefined,
        street: ['preflop', 'flop', 'turn', 'river'][[0, 3, 4, 5].indexOf(boardLen)], pot: 100 + toCall, currentBet, opponents: 1 + (i % 4) });
      const legal = makeLegal(toCall, currentBet);
      const rec = Coach.advise(view, legal, HERO, { iterations: 300, rng }).recommendation;
      if (rec.type === 'check') assert.ok(legal.canCheck);
      if (rec.type === 'call') assert.ok(legal.canCall);
      if (rec.type === 'fold') assert.ok(!legal.canCheck, 'never recommend folding for free');
      if (rec.type === 'bet') assert.ok(legal.canBet && rec.amount >= legal.minRaiseTo && rec.amount <= legal.maxRaiseTo);
      if (rec.type === 'raise') assert.ok(legal.canRaise && rec.amount >= legal.minRaiseTo && rec.amount <= legal.maxRaiseTo);
    }
  });

  // -------------------------------------------------------------- grade
  const fakeAdvice = (o) => ({
    street: 'flop', recommendation: { type: o.rec }, confidence: 'high', concept: 'potOdds',
    equity: o.eq, adjEquity: o.eq, potOdds: o.req, toCall: o.toCall != null ? o.toCall : 50,
    heroStack: 1000, opponents: 1, reasons: ['r1', 'r2'], nutted: !!o.nutted,
  });

  t('grade: following the coach is GREAT', () => {
    assert.equal(Coach.grade(fakeAdvice({ rec: 'fold', eq: 0.1, req: 0.3 }), { type: 'fold' }).grade, 'GREAT');
  });

  t('grade: calling far below pot odds is BLUNDER, slightly below is MISTAKE', () => {
    assert.equal(Coach.grade(fakeAdvice({ rec: 'fold', eq: 0.05, req: 0.4 }), { type: 'call' }).grade, 'BLUNDER');
    assert.equal(Coach.grade(fakeAdvice({ rec: 'fold', eq: 0.25, req: 0.35 }), { type: 'call' }).grade, 'MISTAKE');
  });

  t('grade: folding the nuts is BLUNDER; folding for free is MISTAKE', () => {
    assert.equal(Coach.grade(fakeAdvice({ rec: 'raise', eq: 0.97, req: 0.25, nutted: true }), { type: 'fold' }).grade, 'BLUNDER');
    // High equity vs random hands alone is NOT "the nuts" (review finding).
    assert.notEqual(Coach.grade(fakeAdvice({ rec: 'raise', eq: 0.97, req: 0.25 }), { type: 'fold' }).grade, 'BLUNDER');
    assert.equal(Coach.grade(fakeAdvice({ rec: 'check', eq: 0.3, req: 0, toCall: 0 }), { type: 'fold' }).grade, 'MISTAKE');
  });

  t('grade: reasonable alternatives are not punished', () => {
    const g1 = Coach.grade(fakeAdvice({ rec: 'raise', eq: 0.7, req: 0.25 }), { type: 'call' }).grade;
    const g2 = Coach.grade(fakeAdvice({ rec: 'call', eq: 0.6, req: 0.25 }), { type: 'raise', amount: 150 }).grade;
    assert.ok(['OK', 'GOOD', 'GREAT'].includes(g1), g1);
    assert.ok(['OK', 'GOOD', 'GREAT'].includes(g2), g2);
  });

  // --------------------------------------------------------- reviewHand
  t('reviewHand: headline, graded decisions, all reveals, one lesson', () => {
    const record = {
      handNumber: 3, dealerSeat: 0, board: P('Kh 8h 2c 9s 3d'), showdown: true,
      players: [
        { id: HERO, name: 'You', seat: 0, startStack: 1000, endStack: 800, hole: P('Qc Jc') },
        { id: 'v1', name: 'Bot1', seat: 1, startStack: 1000, endStack: 1200, hole: P('Kd Ks') },
        { id: 'v2', name: 'Bot2', seat: 2, startStack: 1000, endStack: 1000, hole: P('7c 2d') },
      ],
      actions: [{ street: 'preflop', playerId: 'v2', type: 'fold' }],
      awards: [], reveals: [{ playerId: 'v1', hole: P('Kd Ks') }, { playerId: HERO, hole: P('Qc Jc') }],
    };
    const decisions = [{ advice: fakeAdvice({ rec: 'fold', eq: 0.05, req: 0.4 }), action: { type: 'call' } }];
    const rev = Coach.reviewHand(record, HERO, decisions, { v1: ['Set of Kings — value raise.'], v2: ['Trash, fold.'] });
    assert.match(rev.headline, /lost \$200/);
    assert.equal(rev.heroDecisions.length, 1);
    assert.equal(rev.heroDecisions[0].grade, 'BLUNDER');
    assert.equal(rev.reveals.length, 2);
    assert.equal(rev.reveals[0].holeLabel, 'KK');
    assert.match(rev.reveals[0].handDesc, /Three of a Kind|Kings/);
    assert.match(rev.reveals[1].handDesc, /folded/);
    assert.equal(rev.reveals[0].reasoning, 'Set of Kings — value raise.');
    assert.equal(typeof rev.lesson, 'string');
    assert.match(rev.lesson, /pot odds|equity/i);
  });

  // ------------------------------------------------------------- drills
  function checkShape(q, kind) {
    assert.equal(q.kind, kind);
    assert.ok(typeof q.prompt === 'string' && q.prompt.length > 0);
    assert.ok(Array.isArray(q.choices) && q.choices.length >= 2);
    assert.equal(new Set(q.choices).size, q.choices.length, 'choices unique');
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length);
    assert.ok(typeof q.explanation === 'string' && q.explanation.length > 10);
  }

  function allUnique(cards) {
    return new Set(cards.map(Cards.str)).size === cards.length;
  }

  t(`drills fuzz: winner (${FUZZ_N})`, () => {
    const rng = Cards.seededRng(1);
    for (let i = 0; i < FUZZ_N; i++) {
      const q = Coach.Drills.makeQuestion('winner', rng);
      checkShape(q, 'winner');
      const { board, hands } = q.cards;
      assert.ok(allUnique(board.concat(...hands.map((h) => h.hole))));
      const scores = hands.map((h) => Eval.evaluate(h.hole.concat(board)).score);
      const best = Math.max(...scores);
      const winners = scores.filter((s) => s === best).length;
      const expected = winners > 1 ? 'Split pot' : hands[scores.indexOf(best)].label;
      assert.equal(q.choices[q.answer], expected);
    }
  });

  t(`drills fuzz: nameHand (${FUZZ_N})`, () => {
    const rng = Cards.seededRng(2);
    for (let i = 0; i < FUZZ_N; i++) {
      const q = Coach.Drills.makeQuestion('nameHand', rng);
      checkShape(q, 'nameHand');
      const cards = q.cards.hands[0].hole.concat(q.cards.board);
      assert.equal(cards.length, 7);
      assert.ok(allUnique(cards));
      assert.equal(q.choices[q.answer], Eval.evaluate(cards).catName);
      assert.ok(q.choices.length === 4);
    }
  });

  t(`drills fuzz: potOdds (${FUZZ_N})`, () => {
    const rng = Cards.seededRng(3);
    for (let i = 0; i < FUZZ_N; i++) {
      const q = Coach.Drills.makeQuestion('potOdds', rng);
      checkShape(q, 'potOdds');
      const m = q.prompt.match(/pot is \$(\d+)\. Your opponent bets \$(\d+)\. You estimate (\d+)% equity/);
      assert.ok(m, q.prompt);
      const [pot, bet, eq] = m.slice(1).map(Number);
      const required = bet / (pot + 2 * bet);
      assert.ok(Math.abs(eq / 100 - required) >= 0.03, 'not a coin-flip ambiguity');
      assert.equal(q.choices[q.answer], eq / 100 > required ? 'Call' : 'Fold');
    }
  });

  // Independent brute-force out counter: unseen cards that make hero a straight or flush (or better via those).
  function bruteOuts(hole, board) {
    const known = hole.concat(board);
    const seen = new Set(known.map(Cards.str));
    return Cards.makeDeck().filter((c) => !seen.has(Cards.str(c)))
      .filter((c) => [4, 5, 8].includes(Eval.evaluate(known.concat([c])).cat))
      // a card that makes the hand on the board alone only splits the pot
      .filter((c) => board.length < 4 || Eval.evaluate(known.concat([c])).score > Eval.evaluate(board.concat([c])).score).length;
  }

  t(`drills fuzz: outs (${FUZZ_N})`, () => {
    const rng = Cards.seededRng(4);
    for (let i = 0; i < FUZZ_N; i++) {
      const q = Coach.Drills.makeQuestion('outs', rng);
      checkShape(q, 'outs');
      const hole = q.cards.hands[0].hole;
      const board = q.cards.board;
      assert.ok(board.length === 3 || board.length === 4);
      assert.ok(allUnique(hole.concat(board)));
      assert.ok(Eval.evaluate(hole.concat(board)).cat < 4, 'not already made');
      const n = bruteOuts(hole, board);
      assert.ok(n >= 4);
      assert.equal(Number(q.choices[q.answer]), n);
    }
  });

  t('drills: unknown kind falls back to a valid question', () => {
    const q = Coach.Drills.makeQuestion('nope', Cards.seededRng(5));
    assert.ok(Coach.Drills.KINDS.includes(q.kind));
  });

  t('advise is fast enough for the UI (< 150ms, 8 opponents)', () => {
    const view = makeView({ hole: 'Ts 9s', board: '8s 7d 2c', street: 'flop', pot: 200, currentBet: 40, opponents: 8 });
    const start = performance.now();
    Coach.advise(view, makeLegal(40, 40), HERO);
    assert.ok(performance.now() - start < 150);
  });

})();
