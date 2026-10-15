/* Regression tests for bot strength ordering and range-aware equity
 * (review findings: Shark lost to Regular/Grinder; one pair stacked off; made-hand
 * "draws" got implied odds; BB defended any two cards). */
(function () {
  'use strict';
  const t = (name, fn) => TESTS.push({ name: 'strength: ' + name, fn });
  const C = PP.Cards;
  const P = (s) => C.parseMany(s);

  /** Heads-up spot: bot 'b' (seat 1) vs villain 'v' (seat 0). */
  function spot(o) {
    const bb = 20;
    const players = [
      { id: 'v', name: 'V', seat: 0, stack: o.villainStack != null ? o.villainStack : 1500, bet: o.villainBet || 0, totalBet: 0,
        folded: false, allIn: false, out: false, isHuman: false, lastAction: null, hole: null },
      { id: 'b', name: 'B', seat: 1, stack: o.stack != null ? o.stack : 1500, bet: o.myBet || 0, totalBet: 0,
        folded: false, allIn: false, out: false, isHuman: false, lastAction: null, hole: P(o.hole) },
    ];
    const view = {
      handNumber: 1, street: o.street, board: o.board ? P(o.board) : [], pot: o.pot, pots: [],
      currentBet: o.currentBet, minRaiseTo: o.currentBet * 2, bigBlind: bb, smallBlind: bb / 2,
      dealerSeat: o.dealerSeat != null ? o.dealerSeat : 0, sbSeat: 0, bbSeat: 1, toActId: 'b',
      players, history: o.history || [],
    };
    const toCall = Math.max(0, o.currentBet - (o.myBet || 0));
    const legal = {
      canFold: true, canCheck: toCall === 0, canCall: toCall > 0, callAmount: Math.min(toCall, players[1].stack),
      canBet: o.currentBet === 0, canRaise: o.currentBet > 0 && players[1].stack > toCall,
      minRaiseTo: Math.max(bb, o.currentBet * 2), maxRaiseTo: (o.myBet || 0) + players[1].stack, toCall,
    };
    return { view, legal, me: players[1] };
  }

  function decideMany(rating, o, n) {
    const counts = {};
    const reasons = [];
    for (let i = 0; i < n; i++) {
      const bot = PP.Bots.create({ rating, id: 'b', rng: C.seededRng(100 + i) });
      const s = spot(o);
      const a = bot.decide(s.view, s.legal, s.me);
      counts[a.type] = (counts[a.type] || 0) + 1;
      reasons.push(bot.lastReasoning);
    }
    return { counts, reasons };
  }

  const H = (street, playerId, type, amount) => ({ street, playerId, type, amount, potAfter: 0 });

  t('range equity: top pair vs a raise range is far below its random-hand equity', () => {
    const hero = P('Ks Qd');
    const board = P('Kc 7h 2d');
    const rng = C.seededRng(3);
    const random = PP.Equity.monteCarlo({ hero, board, opponents: 1, iterations: 3000, rng }).equity;
    const range = PP.Equity.villainRange({ preLevel: 1, postLevel: 3 });
    const vsRange = PP.Equity.monteCarlo({ hero, board, opponents: 1, iterations: 3000, rng, oppWeight: range }).equity;
    assert.ok(random > 0.8, 'random ' + random);
    assert.ok(vsRange < random - 0.15, `vs range ${vsRange} should be far below ${random}`);
  });

  t('range equity: no pressure means no narrowing', () => {
    assert.equal(PP.Equity.villainRange({ preLevel: 0, postLevel: 0 }), null);
  });

  t('pressureFromHistory: bet = 1 level, raise over a bet = 2, per player', () => {
    const hist = [
      H('preflop', 'v', 'raise', 60), H('preflop', 'b', 'call', 40),
      H('flop', 'b', 'bet', 80), H('flop', 'v', 'raise', 300),
    ];
    const p = PP.Equity.pressureFromHistory(hist, 'b', 20, 'flop');
    assert.equal(p.byPlayer.v.preLevel, 1);
    assert.equal(p.byPlayer.v.postLevel, 2);
    assert.equal(p.facingRaise, true);
    assert.equal(p.byPlayer.b, undefined, 'hero is excluded');
  });

  t('Shark folds one pair (T3o) to a flop raise and turn shove line', () => {
    const history = [
      H('preflop', 'v', 'raise', 60), H('preflop', 'b', 'call', 40),
      H('flop', 'b', 'bet', 80), H('flop', 'v', 'raise', 300), H('flop', 'b', 'call', 220),
      H('turn', 'v', 'bet', 1100),
    ];
    const { counts } = decideMany(5, {
      hole: 'Ts 3c', board: 'Td 9h Ks 2c', street: 'turn', pot: 720 + 1100, currentBet: 1100, myBet: 0,
      stack: 1100, history,
    }, 10);
    assert.ok((counts.fold || 0) >= 8, JSON.stringify(counts));
  });

  t('bots never re-raise a flop raise with one pair', () => {
    const history = [
      H('preflop', 'v', 'raise', 60), H('preflop', 'b', 'call', 40),
      H('flop', 'b', 'bet', 80), H('flop', 'v', 'raise', 300),
    ];
    [2, 3, 4, 5].forEach((rating) => {
      const { counts } = decideMany(rating, {
        hole: 'As Kd', board: 'Kc 7h 2d', street: 'flop', pot: 120 + 80 + 300, currentBet: 300, myBet: 80, history,
      }, 10);
      assert.equal((counts.raise || 0) + (counts.allin || 0), 0, `rating ${rating}: ${JSON.stringify(counts)}`);
    });
  });

  t('made-hand improvement outs never count as implied-odds draws', () => {
    const history = [H('preflop', 'v', 'raise', 60), H('preflop', 'b', 'call', 40), H('flop', 'v', 'bet', 80)];
    [3, 4, 5].forEach((rating) => {
      const { reasons } = decideMany(rating, {
        hole: 'Ts 3c', board: 'Td 9h Ks', street: 'flop', pot: 200, currentBet: 80, myBet: 0, history,
      }, 6);
      reasons.forEach((r) => assert.ok(!/implied/i.test(r), `rating ${rating}: ${r}`));
    });
  });

  t('Shark big blind folds trash (T3o, 72o) to a 2.5bb open', () => {
    ['Ts 3c', '7d 2c'].forEach((hole) => {
      const { counts } = decideMany(5, {
        hole, street: 'preflop', pot: 10 + 20 + 50, currentBet: 50, myBet: 20,
        history: [H('preflop', 'v', 'raise', 50)],
      }, 8);
      assert.equal(counts.fold, 8, hole + ' ' + JSON.stringify(counts));
    });
  });

  t('Shark reasoning does not claim random-hand equity is "vs the raiser\'s range"', () => {
    const { reasons } = decideMany(5, {
      hole: 'Ah Qd', street: 'preflop', pot: 80, currentBet: 50, myBet: 20,
      history: [H('preflop', 'v', 'raise', 50)],
    }, 3);
    reasons.forEach((r) => assert.ok(!/raiser's range/.test(r), r));
  });

  async function headsUp(ratingA, ratingB, hands, seed) {
    const rng = C.seededRng(seed);
    const START = 2000;
    const bots = { A: PP.Bots.create({ rating: ratingA, id: 'A', rng }), B: PP.Bots.create({ rating: ratingB, id: 'B', rng }) };
    const eng = new PP.Engine({
      players: [{ id: 'A', name: 'A', stack: START }, { id: 'B', name: 'B', stack: START }],
      smallBlind: 10, bigBlind: 20, rng,
    });
    eng.actionProvider = (p, view, legal) => bots[p.id].decide(view, legal, p);
    let net = 0;
    for (let h = 0; h < hands; h++) {
      eng.players.forEach((p) => { p.stack = START; p.out = false; });
      const rec = await eng.playHand();
      const a = rec.players.find((p) => p.id === 'A');
      net += a.endStack - a.startStack;
    }
    return (net / 20 / hands) * 100; // bb/100 for A
  }

  t('Shark is no longer a big loser heads-up vs Regular (was -130 bb/100)', async () => {
    const bb100 = await headsUp(5, 3, 600, 11);
    assert.ok(bb100 > -40, 'Shark bb/100 vs Regular = ' + bb100.toFixed(1));
  });

  t('Fish loses heads-up to the Shark', async () => {
    const bb100 = await headsUp(5, 1, 400, 12);
    assert.ok(bb100 > 0, 'Shark bb/100 vs Fish = ' + bb100.toFixed(1));
  });
})();
