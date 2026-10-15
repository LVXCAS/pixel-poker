/* Tests for PP.Engine — scripted rule scenarios + randomized fuzz. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'engine: ' + name, fn });

  /* ---------------------------------------------------------------- stubs */
  // Only used if the real modules are absent (never shipped in js/).
  if (!PP.Cards) PP.Cards = makeCardsStub();
  if (!PP.Eval) PP.Eval = makeEvalStub();

  function makeCardsStub() {
    const RANKS = '23456789TJQKA';
    const SUITS = ['s', 'h', 'd', 'c'];
    const card = (r, s) => Object.freeze({ r, s });
    const parse = (str) => card(RANKS.indexOf(str[0]) + 2, str[1]);
    const seededRng = (seed) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = Math.imul(a ^ (a >>> 15), 1 | a);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    };
    const makeDeck = () => SUITS.flatMap((s) => RANKS.split('').map((_, i) => card(i + 2, s)));
    const shuffle = (cards, rng = Math.random) => {
      const out = cards.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };
    const str = (c) => RANKS[c.r - 2] + c.s;
    return {
      makeDeck, shuffle, seededRng, parse, str, rng: Math.random,
      parseMany: (s) => s.trim().split(/\s+/).map(parse),
    };
  }

  function makeEvalStub() {
    const score5 = (cs) => {
      const rs = cs.map((c) => c.r).sort((a, b) => b - a);
      const counts = {};
      rs.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
      const groups = Object.keys(counts).map(Number)
        .sort((a, b) => counts[b] - counts[a] || b - a);
      const flush = cs.every((c) => c.s === cs[0].s);
      const uniq = Array.from(new Set(rs));
      let high = 0;
      if (uniq.length === 5 && rs[0] - rs[4] === 4) high = rs[0];
      if (uniq.join() === '14,5,4,3,2') high = 5;
      const shape = groups.map((g) => counts[g]).join('');
      let cat = 0;
      if (high && flush) cat = 8;
      else if (shape === '41') cat = 7;
      else if (shape === '32') cat = 6;
      else if (flush) cat = 5;
      else if (high) cat = 4;
      else if (shape === '311') cat = 3;
      else if (shape === '221') cat = 2;
      else if (shape === '2111') cat = 1;
      const kick = high ? [high] : groups;
      return kick.reduce((acc, r) => acc * 15 + r, cat) * Math.pow(15, 5 - kick.length);
    };
    const evaluate = (cards) => {
      let best = -1;
      const n = cards.length;
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
        const five = cards.filter((_, i) => i !== a && i !== b).slice(0, 5);
        if (n === 7) best = Math.max(best, score5(five));
      }
      if (n === 5) best = score5(cards);
      return { cat: 0, catName: '', score: best, best: [], desc: '' };
    };
    return { evaluate, compare: (x, y) => Math.sign(x.score - y.score) };
  }

  /* -------------------------------------------------------------- helpers */
  const C = PP.Cards;
  const parseMany = (s) => s.trim().split(/\s+/).map((x) => C.parse(x));
  const key = (c) => c.r + c.s;

  /** Build a rigged deck: holes by player id (dealt order from engine), then burn/board. */
  function riggedDeckFn(eng, holes, board) {
    return () => {
      const n = eng.players.length;
      const order = [];
      for (let k = 1; k <= n; k++) {
        const p = eng.players[(eng.dealerSeat + k) % n];
        if (p.inHand) order.push(p);
      }
      const used = new Set();
      const holeFor = (p) => (holes[p.id] ? parseMany(holes[p.id]) : null);
      Object.values(holes).forEach((h) => parseMany(h).forEach((c) => used.add(key(c))));
      const boardCards = board ? parseMany(board) : [];
      boardCards.forEach((c) => used.add(key(c)));
      const filler = C.makeDeck().filter((c) => !used.has(key(c)));
      const take = () => filler.shift();
      const deck = [];
      for (let pass = 0; pass < 2; pass++) {
        order.forEach((p) => {
          const h = holeFor(p);
          deck.push(h ? h[pass] : take());
        });
      }
      const b = (i) => (boardCards[i] || take());
      deck.push(take(), b(0), b(1), b(2), take(), b(3), take(), b(4));
      return deck.concat(filler);
    };
  }

  function makeEngine(opts) {
    const stacks = opts.stacks;
    const players = stacks.map((stack, i) => ({ id: 'p' + i, name: 'P' + i, stack, isHuman: i === 0 }));
    const eng = new PP.Engine({
      players, smallBlind: opts.sb || 5, bigBlind: opts.bb || 10, ante: opts.ante || 0,
      rng: C.seededRng(opts.seed || 1),
    });
    if (opts.holes) eng.deckFn = riggedDeckFn(eng, opts.holes, opts.board);
    return eng;
  }

  /** Scripted provider: script = [[id, type, amount?], ...]; then auto check/fold. */
  function script(eng, steps) {
    const queue = steps.slice();
    const log = { actors: [], legals: {}, errors: [] };
    eng.actionProvider = (player, view, legal) => {
      log.actors.push(player.id);
      log.legals[log.actors.length - 1] = legal;
      const next = queue.shift();
      if (!next) return legal.canCheck ? { type: 'check' } : { type: 'fold' };
      if (next[0] !== player.id) log.errors.push('expected ' + next[0] + ' got ' + player.id);
      return { type: next[1], amount: next[2] };
    };
    log.remaining = () => queue.length;
    return log;
  }

  const totalChips = (eng) => eng.players.reduce((s, p) => s + p.stack + p.totalBet, 0);
  const stacksOf = (eng) => eng.players.map((p) => p.stack);

  async function play(eng) {
    const before = totalChips(eng);
    const rec = await eng.playHand();
    assert.equal(totalChips(eng), before, 'chip conservation');
    eng.players.forEach((p) => assert.ok(p.stack >= 0, 'no negative stack'));
    return rec;
  }

  function checkScript(log) {
    assert.deepEqual(log.errors, []);
    assert.equal(log.remaining(), 0, 'script fully consumed');
  }

  /* ------------------------------------------------------------ scenarios */

  t('button rotates and skips busted players', async () => {
    const eng = makeEngine({ stacks: [100, 0, 100, 100] });
    const seats = [];
    eng.on('handStart', (e) => seats.push([e.dealerSeat, e.sbSeat, e.bbSeat]));
    script(eng, []);
    await play(eng);
    await play(eng);
    await play(eng);
    assert.deepEqual(seats[0], [0, 2, 3]);
    assert.deepEqual(seats[1], [2, 3, 0]);
    assert.deepEqual(seats[2], [3, 0, 2]);
  });

  t('heads-up: button posts SB, acts first preflop and last postflop', async () => {
    const eng = makeEngine({ stacks: [500, 500] });
    let start;
    eng.on('handStart', (e) => { start = e; });
    const log = script(eng, [['p0', 'call'], ['p1', 'check'], ['p1', 'check'], ['p0', 'check']]);
    await play(eng);
    assert.equal(start.dealerSeat, 0);
    assert.equal(start.sbSeat, 0);
    assert.equal(start.bbSeat, 1);
    assert.deepEqual(log.actors.slice(0, 4), ['p0', 'p1', 'p1', 'p0']);
    assert.deepEqual(log.errors, []);
  });

  t('short-stack BB posts all-in; side pot formed and capped', async () => {
    const eng = makeEngine({
      stacks: [200, 200, 4],
      holes: { p0: 'Kh Kd', p1: 'Qh Qd', p2: 'Ah Ad' },
      board: '2c 7s 9d Jc 3h',
    });
    let blinds;
    eng.on('blinds', (e) => { blinds = e; });
    const log = script(eng, [['p0', 'call'], ['p1', 'call']]);
    const rec = await play(eng);
    assert.deepEqual(log.errors, []);
    assert.deepEqual(blinds.posts.find((x) => x.kind === 'bb'), { playerId: 'p2', amount: 4, kind: 'bb' });
    assert.equal(rec.showdown, true);
    const won = (id) => rec.awards.filter((a) => a.playerId === id).reduce((s, a) => s + a.amount, 0);
    assert.equal(won('p2'), 12, 'BB wins only the main pot (3 x 4)');
    assert.equal(won('p0'), 12, 'kings win the side pot (2 x 6)');
    assert.deepEqual(stacksOf(eng), [202, 190, 12]);
  });

  t('min-raise equals last full raise; undersized raises are clamped up', async () => {
    const eng = makeEngine({ stacks: [1000, 1000] });
    const log = script(eng, [['p0', 'raise', 30], ['p1', 'raise', 40], ['p0', 'raise', 100], ['p1', 'fold']]);
    const rec = await play(eng);
    checkScript(log);
    assert.equal(log.legals[0].minRaiseTo, 20, 'opening min raise = 2BB');
    assert.equal(log.legals[1].minRaiseTo, 50, '30 + last raise 20');
    const p1raise = rec.actions.find((a) => a.playerId === 'p1' && a.type === 'raise');
    assert.equal(p1raise.amount, 50, 'raise to 40 clamped to min 50');
    assert.equal(log.legals[2].minRaiseTo, 70, '50 + last raise 20');
    assert.deepEqual(stacksOf(eng), [1050, 950]);
  });

  t('incomplete all-in raise does not reopen action to players who acted', async () => {
    // dealer p0, sb p1, bb p2 (short 140). Preflop order p0, p1, p2.
    const eng = makeEngine({ stacks: [1000, 1000, 140] });
    const log = script(eng, [
      ['p0', 'raise', 100], ['p1', 'call'], ['p2', 'allin'],
      ['p0', 'raise', 500], ['p1', 'call'],
    ]);
    const rec = await play(eng);
    checkScript(log);
    const p0second = log.legals[3];
    assert.equal(p0second.canRaise, false);
    assert.equal(p0second.canCall, true);
    assert.equal(p0second.toCall, 40);
    assert.equal(log.legals[4].canRaise, false);
    const pre = rec.actions.filter((a) => a.street === 'preflop');
    assert.equal(pre[3].type, 'call', 'raise attempt coerced to call');
    assert.equal(pre[2].type, 'allin');
  });

  t('no raise option when every opponent is all-in or folded', async () => {
    // dealer p0, sb p1, bb p2, utg p3. Order p3, p0, p1, p2.
    const eng = makeEngine({ stacks: [150, 220, 1000, 1000] });
    const log = script(eng, [
      ['p3', 'raise', 100], ['p0', 'allin'], ['p1', 'allin'], ['p2', 'fold'], ['p3', 'call'],
    ]);
    await play(eng);
    checkScript(log);
    const p3second = log.legals[4];
    assert.equal(p3second.canRaise, false, 'no other player can act, so no raise');
    assert.equal(p3second.toCall, 120);
  });

  t('reopen check: facing incomplete raises that sum to a full raise allows re-raise', async () => {
    const eng = makeEngine({ stacks: [150, 220, 1000, 1000, 1000] });
    // dealer p0, sb p1, bb p2, p3, p4. Order p3, p4, p0, p1, p2.
    const log = script(eng, [
      ['p3', 'raise', 100], ['p4', 'call'], ['p0', 'allin'], ['p1', 'allin'],
      ['p2', 'fold'], ['p3', 'raise', 500], ['p4', 'fold'],
    ]);
    await play(eng);
    checkScript(log);
    assert.equal(log.legals[5].canRaise, true, '220 - 100 = 120 >= last full raise 90');
    assert.equal(log.legals[5].minRaiseTo, 310, '220 + 90');
  });

  t('multiple all-ins create correct side pots; uncalled excess returned', async () => {
    const eng = makeEngine({
      stacks: [400, 50, 100, 200],
      holes: { p1: 'Ah Ad', p2: 'Kh Kd', p3: 'Qh Qd', p0: '2h 3d' },
      board: '4c 8s 9d Jc 6h',
    });
    // dealer p0, sb p1, bb p2, order p3, p0, p1, p2
    let pots;
    eng.on('showdown', () => { pots = eng.publicView('p0').pots; });
    const log = script(eng, [['p3', 'allin'], ['p0', 'allin'], ['p1', 'allin'], ['p2', 'allin']]);
    const rec = await play(eng);
    checkScript(log);
    assert.deepEqual(pots.map((p) => p.amount), [200, 150, 200]);
    assert.deepEqual(pots[2].eligible.sort(), ['p0', 'p3']);
    assert.deepEqual(rec.returned, [{ playerId: 'p0', amount: 200, street: 'preflop' }]);
    assert.deepEqual(stacksOf(eng), [200, 200, 150, 200]);
  });

  t('split pot gives odd chip to first winner left of the button', async () => {
    const eng = makeEngine({
      stacks: [100, 100, 100],
      holes: { p0: '2h 3d', p1: '4h 5d', p2: '2c 3s' },
      board: 'As Ks Qs Js Ts',
    });
    // dealer p0, sb p1, bb p2. p0 calls 10, p1 folds (5 dead), p2 checks -> pot 25
    const log = script(eng, [['p0', 'call'], ['p1', 'fold'], ['p2', 'check']]);
    const rec = await play(eng);
    assert.deepEqual(log.errors, []);
    assert.equal(rec.awards.length, 2);
    assert.deepEqual(rec.awards.map((a) => [a.playerId, a.amount]), [['p2', 13], ['p0', 12]]);
    assert.deepEqual(stacksOf(eng), [102, 95, 103]);
  });

  t('win by fold: uncalled bet returned, no reveal, holes hidden', async () => {
    const eng = makeEngine({ stacks: [500, 500, 500] });
    let views = [];
    eng.on('handEnd', () => { views = eng.publicView('p1').players; });
    const log = script(eng, [['p0', 'raise', 60], ['p1', 'fold'], ['p2', 'fold']]);
    const rec = await play(eng);
    checkScript(log);
    assert.equal(rec.showdown, false);
    assert.deepEqual(rec.reveals, []);
    assert.deepEqual(rec.awards, [{ playerId: 'p0', amount: 25, potIndex: 0, hand: null }]);
    assert.deepEqual(rec.returned, [{ playerId: 'p0', amount: 50, street: 'preflop' }]);
    assert.deepEqual(stacksOf(eng), [515, 495, 490]);
    assert.equal(views.find((p) => p.id === 'p0').hole, null);
    assert.ok(views.find((p) => p.id === 'p1').hole, 'own hole visible');
    assert.equal(rec.players.every((p) => p.hole.length === 2), true, 'record has all holes');
  });

  t('all-in preflop runs out the board with street events then showdown', async () => {
    const eng = makeEngine({ stacks: [300, 300] });
    const events = [];
    ['street', 'showdown', 'potAwarded', 'handEnd'].forEach((n) =>
      eng.on(n, (e) => events.push(n + (e && e.street ? ':' + e.street + ':' + e.board.length : ''))));
    const log = script(eng, [['p0', 'allin'], ['p1', 'call']]);
    const rec = await play(eng);
    checkScript(log);
    assert.deepEqual(events, [
      'street:flop:3', 'street:turn:4', 'street:river:5', 'showdown', 'potAwarded', 'handEnd',
    ]);
    assert.equal(rec.board.length, 5);
    assert.equal(rec.reveals.length, 2);
  });

  t('big blind gets the option after limps and may raise', async () => {
    const eng = makeEngine({ stacks: [500, 500, 500] });
    const log = script(eng, [
      ['p0', 'call'], ['p1', 'call'], ['p2', 'raise', 40], ['p0', 'call'], ['p1', 'fold'],
    ]);
    await play(eng);
    assert.deepEqual(log.errors, []);
    const bbLegal = log.legals[2];
    assert.equal(bbLegal.canCheck, true);
    assert.equal(bbLegal.canRaise, true);
    assert.equal(bbLegal.minRaiseTo, 20);
    assert.deepEqual(log.actors.slice(0, 5), ['p0', 'p1', 'p2', 'p0', 'p1']);
  });

  t('publicView hides opponents until showdown reveal', async () => {
    const eng = makeEngine({ stacks: [300, 300] });
    let midView;
    let sdView;
    eng.on('turn', () => { if (!midView) midView = eng.publicView('p0'); });
    eng.on('showdown', () => { sdView = eng.publicView('p0'); });
    script(eng, [['p0', 'call'], ['p1', 'check']]);
    await play(eng);
    assert.ok(midView.players[0].hole && midView.players[0].hole.length === 2);
    assert.equal(midView.players[1].hole, null);
    assert.equal(sdView.street, 'showdown');
    assert.equal(sdView.players[1].hole.length, 2);
  });

  t('invalid / garbage actions are coerced and never deadlock', async () => {
    const eng = makeEngine({ stacks: [500, 500, 500] });
    let calls = 0;
    eng.actionProvider = (player, view, legal) => {
      calls++;
      const junk = [null, { type: 'dance' }, { type: 'raise', amount: 'lots' }, { type: 'check' },
        { type: 'bet', amount: -50 }, undefined];
      if (calls === 7) throw new Error('provider exploded');
      return junk[calls % junk.length];
    };
    for (let i = 0; i < 20; i++) await play(eng);
    assert.ok(calls > 0);
  });

  t('check when facing a bet becomes fold; NaN raise becomes min raise', async () => {
    const eng = makeEngine({ stacks: [500, 500] });
    const log = script(eng, [['p0', 'raise', 'abc'], ['p1', 'check']]);
    const rec = await play(eng);
    checkScript(log);
    assert.equal(rec.actions[0].type, 'raise');
    assert.equal(rec.actions[0].amount, 20);
    assert.equal(rec.actions[1].type, 'fold');
  });

  t('events fire in order and async listeners are awaited', async () => {
    const eng = makeEngine({ stacks: [300, 300] });
    const seq = [];
    let pending = false;
    const slow = (name) => async () => {
      assert.equal(pending, false, 'previous listener finished before ' + name);
      pending = true;
      await new Promise((r) => setTimeout(r, 1));
      seq.push(name);
      pending = false;
    };
    ['handStart', 'blinds', 'deal', 'turn', 'action', 'street', 'showdown', 'potAwarded', 'handEnd']
      .forEach((n) => eng.on(n, slow(n)));
    script(eng, [['p0', 'call'], ['p1', 'check']]);
    await play(eng);
    assert.deepEqual(seq.slice(0, 7), ['handStart', 'blinds', 'deal', 'turn', 'action', 'turn', 'action']);
    assert.equal(seq[7], 'street');
    assert.deepEqual(seq.slice(-3), ['showdown', 'potAwarded', 'handEnd']);
  });

  t('antes are dead money and conserve chips', async () => {
    const eng = makeEngine({ stacks: [300, 300, 3], ante: 5 });
    let blinds;
    eng.on('blinds', (e) => { blinds = e; });
    script(eng, []);
    await play(eng);
    const antes = blinds.posts.filter((x) => x.kind === 'ante');
    assert.equal(antes.length, 3);
    assert.equal(antes.find((x) => x.playerId === 'p2').amount, 3);
  });

  t('isGameOver, gameOver event and addChips rebuy', async () => {
    const eng = makeEngine({ stacks: [10, 300] });
    let over = null;
    eng.on('gameOver', (e) => { over = e; });
    script(eng, [['p0', 'allin'], ['p1', 'call']]);
    eng.deckFn = riggedDeckFn(eng, { p0: '2h 3d', p1: 'Ah Ad' }, '4c 8s 9d Jc Kh');
    await play(eng);
    assert.equal(eng.isGameOver(), true);
    assert.deepEqual(over, { winnerId: 'p1' });
    assert.equal(eng.players[0].out, true);
    assert.equal(eng.addChips('p0', 200), true);
    assert.equal(eng.isGameOver(), false);
    assert.equal(eng.players[0].out, false);
  });

  t('getLegal returns nothing actionable for non-acting players', () => {
    const eng = makeEngine({ stacks: [100, 100] });
    const legal = eng.getLegal('nobody');
    assert.equal(legal.canFold, false);
    assert.equal(legal.canCheck, false);
  });

  /* ----------------------------------------------------------------- fuzz */

  function randomAction(rng, legal) {
    const roll = rng();
    if (roll < 0.03) return { type: 'nonsense' };
    if (roll < 0.15) return { type: 'fold' };
    if (roll < 0.45) return legal.canCheck ? { type: 'check' } : { type: 'call' };
    if (roll < 0.6) return { type: 'call' };
    if (roll < 0.9 && (legal.canBet || legal.canRaise)) {
      const span = Math.max(0, legal.maxRaiseTo - legal.minRaiseTo);
      const amount = legal.minRaiseTo + Math.floor(rng() * rng() * (span + 1));
      return { type: legal.canBet ? 'bet' : 'raise', amount };
    }
    if (roll < 0.95) return { type: 'allin' };
    return { type: 'raise', amount: Math.floor(rng() * 5000) - 100 };
  }

  t('fuzz: 2000 random hands, 2-9 players — conservation, no negatives, terminates', async () => {
    const rng = C.seededRng(20261014);
    const TOTAL_HANDS = 2000;
    const MAX_ACTIONS = 500;
    let hands = 0;
    let showdowns = 0;
    let sidePotHands = 0;
    const peekErrors = [];
    while (hands < TOTAL_HANDS) {
      const n = 2 + Math.floor(rng() * 8);
      const stacks = Array.from({ length: n }, () => 1 + Math.floor(rng() * 400));
      const ante = rng() < 0.25 ? 1 + Math.floor(rng() * 3) : 0;
      const eng = makeEngine({ stacks, sb: 1 + Math.floor(rng() * 3), bb: 4, ante, seed: hands + 1 });
      let startTotal = totalChips(eng);
      let actions = 0;
      eng.actionProvider = (player, view, legal) => {
        actions++;
        if (!view.players.every((p) => p.id === player.id || p.hole === null)) peekErrors.push(player.id);
        return randomAction(rng, legal);
      };
      const midHandErrors = [];
      eng.on('action', (e) => {
        if (e.stack < 0) midHandErrors.push('negative stack');
        if (totalChips(eng) !== startTotal) midHandErrors.push('conservation mid-hand');
      });
      for (let h = 0; h < 40 && hands < TOTAL_HANDS && !eng.isGameOver(); h++) {
        actions = 0;
        const rec = await eng.playHand();
        hands++;
        assert.deepEqual(midHandErrors, []);
        assert.ok(rec, 'hand produced a record');
        assert.ok(actions < MAX_ACTIONS, 'hand terminated with a sane action count');
        assert.equal(totalChips(eng), startTotal, 'conservation after hand');
        eng.players.forEach((p) => {
          assert.ok(p.stack >= 0 && Number.isInteger(p.stack));
          assert.equal(p.totalBet, 0);
        });
        const awarded = rec.awards.reduce((s, a) => s + a.amount, 0);
        const delta = rec.players.reduce((s, p) => s + p.endStack - p.startStack, 0);
        assert.equal(delta, 0, 'record stacks balance');
        assert.ok(awarded >= 0);
        if (rec.showdown) showdowns++;
        if (new Set(rec.awards.map((a) => a.potIndex)).size > 1) sidePotHands++;
        if (rng() < 0.05) {
          eng.players.forEach((p) => { if (p.stack === 0) eng.addChips(p.id, 50); });
          startTotal = totalChips(eng);
        }
      }
    }
    assert.deepEqual(peekErrors, [], 'views never leak opponent holes');
    assert.equal(hands, TOTAL_HANDS);
    assert.ok(showdowns > 100, 'fuzz exercised showdowns');
    assert.ok(sidePotHands > 10, 'fuzz exercised side pots');
  });

  /* ------------------------------------------- dead-button blind order */
  async function positionsAfterBust(nPlayers, bustRole, hands) {
    const eng = makeEngine({ stacks: Array(nPlayers).fill(1000) });
    eng.actionProvider = (pl, view, legal) => (legal.canCheck ? { type: 'check' } : { type: 'fold' });
    const seen = [];
    eng.on('handStart', (e) => { seen.push({ d: e.dealerSeat, sb: e.sbSeat, bb: e.bbSeat }); });
    await eng.playHand();
    const bustSeat = seen[0][bustRole];
    eng.players[bustSeat].stack = 0;
    for (let i = 1; i < hands; i++) await eng.playHand();
    return { seen, bustSeat, eng };
  }

  t('dead button: dealer busts going 3 -> heads-up, last BB does not post BB again', async () => {
    const { seen } = await positionsAfterBust(3, 'd', 3);
    assert.deepEqual(seen[0], { d: 0, sb: 1, bb: 2 });
    assert.notEqual(seen[1].bb, seen[0].bb, 'BB twice in a row');
    assert.equal(seen[1].bb, 1);
    assert.equal(seen[1].sb, 2);
    assert.equal(seen[1].d, 2, 'heads-up: button is SB');
    assert.equal(seen[2].bb, 2);
    assert.equal(seen[2].sb, 1);
  });

  t('dead button: BB busts at 4-handed, nobody skips or repeats the BB', async () => {
    const { seen, bustSeat } = await positionsAfterBust(4, 'bb', 4);
    assert.equal(bustSeat, 2);
    const bbs = seen.map((x) => x.bb);
    assert.deepEqual(bbs, [2, 3, 0, 1], 'BB moves one live seat per hand');
    assert.equal(seen[1].sb, 2, 'dead small blind on the busted seat');
    assert.equal(seen[1].d, 1);
    for (let i = 1; i < bbs.length; i++) assert.notEqual(bbs[i], bbs[i - 1]);
  });

  t('dead button: dead SB posts nothing and chips are conserved', async () => {
    const eng = makeEngine({ stacks: [1000, 1000, 1000, 1000] });
    eng.actionProvider = (pl, view, legal) => (legal.canCheck ? { type: 'check' } : { type: 'fold' });
    const posts = [];
    eng.on('blinds', (e) => { posts.push(e.posts); });
    await eng.playHand();
    eng.players[2].stack = 0;
    const before = eng.players.reduce((a, p) => a + p.stack, 0);
    await eng.playHand();
    const after = eng.players.reduce((a, p) => a + p.stack, 0);
    assert.equal(after, before);
    assert.deepEqual(posts[1].map((x) => x.kind), ['bb']);
  });
})();
