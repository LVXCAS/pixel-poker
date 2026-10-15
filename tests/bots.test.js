/* PP.Bots tests: legality fuzz, rating differentiation, timing. */
(function () {
  'use strict';
  const PP = globalThis.PP;
  const Bots = PP.Bots;
  const RATING_LIST = [1, 2, 3, 4, 5];
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 };
  const FUZZ_SPOTS_PER_RATING = 400;
  const VPIP_SPOTS = 1000;
  const TIME_LIMIT_MS = 40;

  const SUITS = ['s', 'h', 'd', 'c'];
  const deck = () => {
    const cards = [];
    for (let r = 2; r <= 14; r += 1) SUITS.forEach((s) => cards.push({ r, s }));
    return cards;
  };

  function shuffled(rng) {
    const d = deck();
    for (let i = d.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  /** Builds a random but internally consistent (view, legal, me) triple. */
  function syntheticSpot(rng, overrides) {
    const o = overrides || {};
    const n = o.players || randInt(rng, 2, 9);
    const street = o.street || pick(rng, STREETS);
    const bb = pick(rng, [2, 10, 20, 50, 100]);
    const sb = bb / 2;
    const cards = shuffled(rng);
    const board = cards.splice(0, BOARD_SIZE[street]);
    const dealerSeat = randInt(rng, 0, n - 1);
    const meSeat = o.meSeat != null ? o.meSeat : randInt(rng, 0, n - 1);
    const players = [];
    for (let seat = 0; seat < n; seat += 1) {
      const isMe = seat === meSeat;
      players.push({
        id: 'p' + seat, name: 'P' + seat, seat,
        stack: randInt(rng, 0, 300) * bb / 2,
        bet: 0, totalBet: 0, folded: !isMe && rng() < 0.25, allIn: false,
        out: !isMe && rng() < 0.08, isHuman: false, lastAction: null,
        hole: isMe ? cards.splice(0, 2) : null,
      });
    }
    const me = players[meSeat];
    if (me.stack === 0) me.stack = bb;
    const facing = o.facing != null ? o.facing : rng() < 0.6;
    const currentBet = facing ? randInt(rng, 1, 40) * sb : street === 'preflop' ? bb : 0;
    me.bet = Math.min(currentBet, rng() < 0.3 ? randInt(rng, 0, 4) * sb : 0);
    const toCall = Math.max(0, currentBet - me.bet);
    const history = [];
    if (facing) history.push({ street, playerId: 'p' + ((meSeat + 1) % n), type: street === 'preflop' ? 'raise' : 'bet', amount: currentBet, potAfter: 0 });
    const pot = randInt(rng, 1, 60) * bb + currentBet;
    const maxRaiseTo = me.bet + me.stack;
    const minRaiseTo = currentBet === 0 ? bb : currentBet + Math.max(bb, currentBet / 2);
    const legal = {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, me.stack),
      toCall,
      canBet: currentBet === 0 && me.stack > 0,
      canRaise: currentBet > 0 && me.stack > toCall && rng() < 0.9,
      minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
      maxRaiseTo,
    };
    const view = {
      handNumber: 1, street, board, pot, pots: [{ amount: pot, eligible: players.map((p) => p.id) }],
      currentBet, minRaiseTo: legal.minRaiseTo, bigBlind: bb, smallBlind: sb, dealerSeat,
      sbSeat: (dealerSeat + 1) % n, bbSeat: (dealerSeat + 2) % n, toActId: me.id, players, history,
    };
    return { view, legal, me };
  }

  function legalityError(action, legal) {
    if (!action || typeof action.type !== 'string') return 'missing action';
    const amt = action.amount;
    switch (action.type) {
      case 'fold': return legal.canCheck ? 'folded when check was free' : null;
      case 'check': return legal.canCheck ? null : 'checked while facing a bet';
      case 'call': return legal.canCall && amt === legal.callAmount ? null : 'illegal call';
      case 'bet':
      case 'raise': {
        const allowed = action.type === 'bet' ? legal.canBet : legal.canRaise;
        if (!allowed) return action.type + ' not allowed';
        if (!(amt >= legal.minRaiseTo && amt <= legal.maxRaiseTo)) return 'amount ' + amt + ' outside [' + legal.minRaiseTo + ',' + legal.maxRaiseTo + ']';
        return null;
      }
      case 'allin': return legal.canBet || legal.canRaise || legal.canCall ? null : 'allin not allowed';
      default: return 'unknown type ' + action.type;
    }
  }

  RATING_LIST.forEach((rating) => {
    TESTS.push({
      name: `rating ${rating} (${Bots.RATINGS[rating].title}) always returns a legal action (fuzz)`,
      fn: () => {
        const rng = seeded(1000 + rating);
        const bot = Bots.create({ rating, id: 'bot', rng });
        for (let i = 0; i < FUZZ_SPOTS_PER_RATING; i += 1) {
          const { view, legal, me } = syntheticSpot(rng);
          bot.id = me.id;
          const action = bot.decide(view, legal, me);
          const err = legalityError(action, legal);
          assert.equal(err, null, `spot ${i}: ${err} -> ${JSON.stringify(action)} legal=${JSON.stringify(legal)}`);
          assert.ok(typeof bot.lastReasoning === 'string' && bot.lastReasoning.length > 10, 'reasoning missing');
          assert.ok(!/internal error/.test(bot.lastReasoning), bot.lastReasoning);
          assert.ok(!/NaN|undefined/.test(bot.lastReasoning), bot.lastReasoning);
        }
      },
    });
  });

  TESTS.push({
    name: 'bet/raise sizes are rounded to the small blind unless clamped or all-in',
    fn: () => {
      const rng = seeded(77);
      const bot = Bots.create({ rating: 5, id: 'bot', rng });
      let checked = 0;
      for (let i = 0; i < 600; i += 1) {
        const { view, legal, me } = syntheticSpot(rng);
        const a = bot.decide(view, legal, me);
        if ((a.type === 'bet' || a.type === 'raise') && a.amount !== legal.minRaiseTo) {
          assert.equal(a.amount % view.smallBlind, 0, `amount ${a.amount} not a multiple of SB ${view.smallBlind}`);
          checked += 1;
        }
      }
      assert.ok(checked > 10, 'too few sized bets sampled: ' + checked);
    },
  });

  function vpip(rating, seed) {
    const rng = seeded(seed);
    const bot = Bots.create({ rating, id: 'bot', rng });
    let voluntary = 0;
    for (let i = 0; i < VPIP_SPOTS; i += 1) {
      const { view, legal, me } = syntheticSpot(rng, { street: 'preflop', facing: false, players: 6 });
      const a = bot.decide(view, legal, me);
      if (a.type !== 'fold' && a.type !== 'check') voluntary += 1;
    }
    return voluntary / VPIP_SPOTS;
  }

  TESTS.push({
    name: 'VPIP over 1000 unraised preflop spots: Fish > Grinder > Regular > Rookie-ish tightness',
    fn: () => {
      const fish = vpip(1, 5);
      const regular = vpip(3, 5);
      const grinder = vpip(4, 5);
      assert.ok(fish > regular + 0.2, `fish ${fish} vs regular ${regular}`);
      assert.ok(grinder > regular, `grinder ${grinder} vs regular ${regular}`);
      assert.ok(fish > 0.5, 'fish should play most hands: ' + fish);
      assert.ok(regular < 0.4, 'regular should be selective: ' + regular);
    },
  });

  function utgFacingRaiseSpot(hole) {
    const rng = seeded(9);
    const spot = syntheticSpot(rng, { street: 'preflop', facing: true, players: 9, meSeat: 3 });
    const view = Object.assign({}, spot.view, { dealerSeat: 0, currentBet: 60, bigBlind: 20, smallBlind: 10, pot: 90 });
    view.players = view.players.map((p) => Object.assign({}, p, { out: false, folded: false, stack: 2000, hole: p.id === 'p3' ? hole : null }));
    view.history = [{ street: 'preflop', playerId: 'p2', type: 'raise', amount: 60, potAfter: 90 }];
    const me = view.players[3];
    const legal = { canFold: true, canCheck: false, canCall: true, callAmount: 60, toCall: 60, canBet: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 2000 };
    return { view, legal, me };
  }

  TESTS.push({
    name: 'Shark always folds 72o early facing a raise; Fish often continues with weak hands',
    fn: () => {
      const seven2 = [{ r: 7, s: 'h' }, { r: 2, s: 'c' }];
      for (let i = 0; i < 50; i += 1) {
        const shark = Bots.create({ rating: 5, id: 'p3', rng: seeded(i) });
        const { view, legal, me } = utgFacingRaiseSpot(seven2);
        assert.equal(shark.decide(view, legal, me).type, 'fold', shark.lastReasoning);
      }
      const k9 = [{ r: 13, s: 'h' }, { r: 6, s: 'c' }];
      let fishContinues = 0;
      for (let i = 0; i < 50; i += 1) {
        const fish = Bots.create({ rating: 1, id: 'p3', rng: seeded(i) });
        const { view, legal, me } = utgFacingRaiseSpot(k9);
        if (fish.decide(view, legal, me).type !== 'fold') fishContinues += 1;
      }
      assert.ok(fishContinues > 40, 'fish should call K6o vs a raise: ' + fishContinues);
    },
  });

  TESTS.push({
    name: 'Shark and Regular raise AA; reasoning names the hand',
    fn: () => {
      const aces = [{ r: 14, s: 'h' }, { r: 14, s: 's' }];
      [3, 5].forEach((rating) => {
        const bot = Bots.create({ rating, id: 'p3', rng: seeded(rating) });
        const { view, legal, me } = utgFacingRaiseSpot(aces);
        const a = bot.decide(view, legal, me);
        assert.ok(a.type === 'raise' || a.type === 'allin', `rating ${rating}: ${a.type}`);
        assert.ok(/AA/.test(bot.lastReasoning), bot.lastReasoning);
      });
    },
  });

  TESTS.push({
    name: 'Fish chases a flush draw facing a big bet; Rookie folds it',
    fn: () => {
      const base = syntheticSpot(seeded(3), { street: 'flop', facing: true, players: 2, meSeat: 0 });
      const hole = [{ r: 4, s: 'h' }, { r: 9, s: 'h' }];
      const board = [{ r: 14, s: 'h' }, { r: 13, s: 'h' }, { r: 2, s: 'c' }];
      const view = Object.assign({}, base.view, { board, pot: 300, currentBet: 300 });
      view.players = view.players.map((p) => Object.assign({}, p, { folded: false, out: false, stack: 3000, bet: p.id === 'p0' ? 0 : 300, hole: p.id === 'p0' ? hole : null }));
      const me = view.players[0];
      const legal = { canFold: true, canCheck: false, canCall: true, callAmount: 300, toCall: 300, canBet: false, canRaise: true, minRaiseTo: 600, maxRaiseTo: 3000 };
      const fish = Bots.create({ rating: 1, id: 'p0', rng: seeded(1) });
      assert.equal(fish.decide(view, legal, me).type, 'call', fish.lastReasoning);
      assert.ok(/draw/i.test(fish.lastReasoning), fish.lastReasoning);
      const rookie = Bots.create({ rating: 2, id: 'p0', rng: seeded(1) });
      assert.equal(rookie.decide(view, legal, me).type, 'fold', rookie.lastReasoning);
    },
  });

  TESTS.push({
    name: 'decide() stays under ~40ms for every rating (multiway, all streets)',
    fn: () => {
      const rng = seeded(42);
      RATING_LIST.forEach((rating) => {
        const bot = Bots.create({ rating, id: 'bot', rng });
        let worst = 0;
        for (let i = 0; i < 40; i += 1) {
          const { view, legal, me } = syntheticSpot(rng, { players: 9 });
          const t0 = performance.now();
          bot.decide(view, legal, me);
          worst = Math.max(worst, performance.now() - t0);
        }
        assert.ok(worst < TIME_LIMIT_MS * 1.5, `rating ${rating} worst ${worst.toFixed(1)}ms`);
      });
    },
  });

  TESTS.push({
    name: 'create() exposes metadata; randomName avoids used names',
    fn: () => {
      const bot = Bots.create({ rating: 4, id: 'x' });
      assert.equal(bot.title, 'Grinder');
      assert.equal(bot.style, 'Loose-Aggressive');
      assert.ok(bot.name.length > 0);
      const used = Bots.NAMES.slice(0, Bots.NAMES.length - 1);
      assert.equal(Bots.randomName(used), Bots.NAMES[Bots.NAMES.length - 1]);
      const overflow = Bots.randomName(Bots.NAMES.slice());
      assert.ok(!Bots.NAMES.includes(overflow));
      assert.equal(Bots.create({ rating: 99 }).rating, 5);
    },
  });
})();
