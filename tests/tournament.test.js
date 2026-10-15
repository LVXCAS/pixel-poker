/* Tests for PP.Tournament — levels, payouts, eliminations, standings, full Sit-n-Go simulations. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'tournament: ' + name, fn });

  if (!PP.Tournament) {
    // tests/run.js adds tournament.js to LOGIC_MODULES (MULTIPLAYER.md section 0, owned by B1).
    t('(skipped: js/tournament.js is not loaded by the harness yet)', () => {});
    return;
  }
  const T = PP.Tournament;

  /* ---------------------------------------------------------------- helpers */

  const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), name: 'P' + (i + 1) }));

  /** Minimal engine double for bookkeeping tests (stack/seat only). */
  function fakeEngine(stacks) {
    const calls = [];
    return {
      calls,
      inHand: false,
      players: Object.keys(stacks).map((id, seat) => ({ id, seat, stack: stacks[id] })),
      setBlinds(sb, bb, ante) { calls.push([sb, bb, ante]); return !this.inHand; },
      set(id, stack) { this.players.find((p) => p.id === id).stack = stack; },
    };
  }

  function recordFor(eng, dealerSeat, startStacks) {
    return { dealerSeat, players: eng.players.map((p) => ({ id: p.id, seat: p.seat, startStack: startStacks[p.id] })) };
  }

  const isStrictlyIncreasing = (xs) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

  /* ---------------------------------------------------------------- levels */

  t('levels(1500) equals the BASE_SB ladder with bb = 2*sb', () => {
    const lv = T.levels({ startingStack: 1500, preset: 'regular' });
    assert.deepEqual(lv.map((l) => l.sb), T.BASE_SB.slice());
    lv.forEach((l, i) => {
      assert.equal(l.bb, 2 * l.sb);
      assert.equal(l.level, i + 1);
      assert.equal(l.handsPerLevel, 10);
      assert.equal(l.ante, 0);
    });
    assert.ok(Object.isFrozen(lv) && Object.isFrozen(lv[0]));
  });

  t('levels for 300/1000/3000/5000 are nice-rounded and strictly increasing', () => {
    [300, 1000, 3000, 5000].forEach((stack) => {
      const sbs = T.levels({ startingStack: stack }).map((l) => l.sb);
      assert.ok(isStrictlyIncreasing(sbs), stack + ': ' + sbs.join(','));
      sbs.forEach((sb) => assert.equal(T.niceRound(sb), sb, stack + ': ' + sb + ' is not nice'));
    });
    assert.deepEqual(T.levels({ startingStack: 1000 }).slice(0, 4).map((l) => l.sb), [7, 10, 15, 35]);
  });

  t('niceRound follows the bands', () => {
    assert.equal(T.niceRound(0.2), 1);
    assert.equal(T.niceRound(6.6), 7);
    assert.equal(T.niceRound(33), 35);
    assert.equal(T.niceRound(147), 145);
    assert.equal(T.niceRound(612), 600);
    assert.equal(T.niceRound(1260), 1300);
  });

  t('antes: 0 for levels 1-2, >= 1 afterwards when enabled; 0 everywhere when disabled', () => {
    const on = T.levels({ startingStack: 1500, antes: true });
    assert.equal(on[0].ante, 0);
    assert.equal(on[1].ante, 0);
    on.slice(2).forEach((l) => assert.ok(l.ante >= 1 && l.ante === Math.max(1, Math.round(l.bb / 10))));
    assert.equal(on[2].ante, 5);
    const tiny = T.levels({ startingStack: 100, antes: true });
    tiny.slice(2).forEach((l) => assert.ok(l.ante >= 1));
    T.levels({ startingStack: 1500, antes: false }).forEach((l) => assert.equal(l.ante, 0));
  });

  t('presets set hands per level; unknown preset falls back to regular', () => {
    assert.equal(T.levels({ preset: 'turbo' })[0].handsPerLevel, 6);
    assert.equal(T.levels({ preset: 'slow' })[0].handsPerLevel, 15);
    assert.equal(T.levels({ preset: 'warp' })[0].handsPerLevel, 10);
  });

  /* --------------------------------------------------------------- payouts */

  t('payouts(n) for n = 2..9 match the table and sum to 100', () => {
    const expected = { 2: [100], 3: [100], 4: [65, 35], 5: [65, 35], 6: [50, 30, 20], 7: [50, 30, 20],
      8: [50, 30, 20], 9: [50, 30, 20] };
    for (let n = 2; n <= 9; n++) {
      assert.deepEqual(T.payouts(n).slice(), expected[n]);
      assert.equal(T.payouts(n).reduce((a, b) => a + b, 0), 100);
    }
  });

  /* ------------------------------------------------------------ beforeHand */

  t('beforeHand changes level exactly at k*handsPerLevel for every preset and calls setBlinds', () => {
    ['turbo', 'regular', 'slow'].forEach((preset) => {
      const tour = T.create({ players: ids(3), startingStack: 1500, preset, antes: true });
      const eng = fakeEngine({ p1: 1500, p2: 1500, p3: 1500 });
      const hpl = T.PRESETS[preset].handsPerLevel;
      const ladder = T.levels({ startingStack: 1500, preset, antes: true });
      for (let hand = 0; hand < hpl * 4; hand++) {
        const r = tour.beforeHand(eng);
        const expectLevel = Math.floor(hand / hpl);
        assert.equal(r.changed, hand % hpl === 0, preset + ' hand ' + hand);
        assert.equal(r.level, expectLevel + 1);
        assert.deepEqual([r.sb, r.bb, r.ante], [ladder[expectLevel].sb, ladder[expectLevel].bb, ladder[expectLevel].ante]);
        tour.afterHand(eng, recordFor(eng, 0, { p1: 1500, p2: 1500, p3: 1500 }));
      }
      assert.deepEqual(eng.calls.map((c) => c[1]), ladder.slice(0, 4).map((l) => l.bb));
    });
  });

  t('beforeHand during a hand (setBlinds rejected) retries on the next call', () => {
    const tour = T.create({ players: ids(2), startingStack: 1500, preset: 'turbo' });
    const eng = fakeEngine({ p1: 1500, p2: 1500 });
    eng.inHand = true;
    assert.equal(tour.beforeHand(eng).changed, false);
    eng.inHand = false;
    assert.equal(tour.beforeHand(eng).changed, true);
    assert.equal(tour.beforeHand(eng).changed, false);
  });

  t('after the last level the last level repeats', () => {
    const tour = T.create({ players: ids(2), startingStack: 1500, preset: 'turbo' });
    const eng = fakeEngine({ p1: 1500, p2: 1500 });
    const last = T.BASE_SB[T.BASE_SB.length - 1];
    for (let i = 0; i < 6 * (T.BASE_SB.length + 3); i++) {
      tour.beforeHand(eng);
      tour.afterHand(eng, recordFor(eng, 0, { p1: 1500, p2: 1500 }));
    }
    const r = tour.beforeHand(eng);
    assert.equal(r.sb, last);
    assert.equal(r.level, T.BASE_SB.length);
    assert.equal(tour.state().next, null);
    assert.equal(tour.state().handsToNext, 0);
  });

  /* ---------------------------------------------------------- eliminations */

  t('eliminations: single bust, double bust by start stack, seat tiebreak, winner, points', () => {
    const start = { p1: 1000, p2: 1000, p3: 1000, p4: 1000, p5: 1000, p6: 1000 };
    const tour = T.create({ players: ids(6), startingStack: 1000, preset: 'turbo' });
    const eng = fakeEngine(start);
    tour.beforeHand(eng);
    // hand 1: p1 busts alone -> 6th
    eng.set('p1', 0); eng.set('p2', 2000);
    let r = tour.afterHand(eng, recordFor(eng, 0, start));
    assert.deepEqual(r.eliminated.map((e) => [e.id, e.place, e.points]), [['p1', 6, 0]]);
    assert.equal(r.complete, false);
    // hand 2: p2 (start 2000) and p3 (start 1000) bust together -> p3 5th, p2 4th
    const s2 = { p1: 0, p2: 2000, p3: 1000, p4: 1000, p5: 1000, p6: 1000 };
    eng.set('p2', 0); eng.set('p3', 0); eng.set('p4', 4000);
    r = tour.afterHand(eng, recordFor(eng, 1, s2));
    assert.deepEqual(r.eliminated.map((e) => [e.id, e.place]), [['p3', 5], ['p2', 4]]);
    // hand 3: p4 (seat 3) and p6 (seat 5) bust with equal start stacks; button seat 4 ->
    // p6 is first left of the button (closer) so p6 finishes higher (2nd), p4 3rd.
    const s3 = { p1: 0, p2: 0, p3: 0, p4: 2000, p5: 2000, p6: 2000 };
    eng.set('p4', 0); eng.set('p6', 0); eng.set('p5', 6000);
    r = tour.afterHand(eng, recordFor(eng, 4, s3));
    assert.deepEqual(r.eliminated.map((e) => [e.id, e.place, e.points]), [['p4', 3, 20], ['p6', 2, 30]]);
    assert.equal(r.complete, true);
    assert.equal(tour.isComplete(), true);
    const res = tour.results();
    assert.deepEqual(res.map((x) => [x.id, x.place, x.points]),
      [['p5', 1, 50], ['p6', 2, 30], ['p4', 3, 20], ['p2', 4, 0], ['p3', 5, 0], ['p1', 6, 0]]);
    assert.equal(res[0].stack, 6000);
  });

  t('equal start stacks, button between them: seat order wraps clockwise', () => {
    const start = { p1: 500, p2: 500, p3: 500 };
    const tour = T.create({ players: ids(3), startingStack: 500 });
    const eng = fakeEngine(start);
    eng.set('p1', 0); eng.set('p3', 0); eng.set('p2', 1500);
    // button on seat 1 (p2): p3 (seat 2) is first to its left -> finishes higher than p1 (seat 0).
    const r = tour.afterHand(eng, recordFor(eng, 1, start));
    assert.deepEqual(r.eliminated.map((e) => [e.id, e.place]), [['p1', 3], ['p3', 2]]);
    assert.equal(tour.results()[0].id, 'p2');
  });

  t('results() before completion ranks the living by stack (host ended early)', () => {
    const tour = T.create({ players: ids(4), startingStack: 100 });
    const eng = fakeEngine({ p1: 100, p2: 100, p3: 100, p4: 100 });
    eng.set('p1', 0); eng.set('p2', 250); eng.set('p3', 40); eng.set('p4', 110);
    tour.afterHand(eng, recordFor(eng, 0, { p1: 100, p2: 100, p3: 100, p4: 100 }));
    const res = tour.results();
    assert.deepEqual(res.map((x) => [x.id, x.place, x.points]), [['p2', 1, 65], ['p4', 2, 35], ['p3', 3, 0], ['p1', 4, 0]]);
    assert.equal(tour.isComplete(), false);
  });

  t('create validates players', () => {
    assert.throws(() => T.create({ players: ids(1) }));
    assert.throws(() => T.create({ players: [{ id: 'a' }, { id: 'a' }] }));
    assert.throws(() => T.create({}));
  });

  /* ----------------------------------------------------------------- state */

  t('state() is frozen, JSON-safe, and standings are alive-by-stack then busted-by-place', () => {
    const tour = T.create({ players: ids(4), startingStack: 100, preset: 'turbo', antes: true });
    const eng = fakeEngine({ p1: 100, p2: 100, p3: 100, p4: 100 });
    tour.beforeHand(eng);
    eng.set('p1', 0); eng.set('p2', 30); eng.set('p3', 200); eng.set('p4', 170);
    tour.afterHand(eng, recordFor(eng, 0, { p1: 100, p2: 100, p3: 100, p4: 100 }));
    const st = tour.state();
    assert.ok(Object.isFrozen(st) && Object.isFrozen(st.standings) && Object.isFrozen(st.standings[0]));
    assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
    assert.deepEqual(st.standings.map((x) => x.id), ['p3', 'p4', 'p2', 'p1']);
    assert.deepEqual(st.standings.map((x) => x.place), [null, null, null, 4]);
    assert.equal(st.alive, 3);
    assert.equal(st.entrants, 4);
    assert.equal(st.handsPlayed, 1);
    assert.equal(st.handsToNext, 5);
    assert.deepEqual(st.next, { sb: T.levels({ startingStack: 100 })[1].sb, bb: T.levels({ startingStack: 100 })[1].bb, ante: 0 });
    assert.deepEqual(st.payouts.slice(), [65, 35]);
    assert.deepEqual(st.eliminated.map((e) => e.id), ['p1']);
    assert.equal(st.complete, false);
    assert.equal(st.preset, 'turbo');
  });

  /* ----------------------------------------------------- full simulations */

  const HAND_CAP = 3000;

  /**
   * Plays a complete SNG with the real engine. `decide(id)` gives each seat's action provider.
   * Checks chip conservation and blind schedule every hand; returns a summary.
   */
  async function simulate({ n, stack, preset, antes, seed, decide }) {
    const players = ids(n);
    const tour = T.create({ players, startingStack: stack, preset, antes });
    const eng = new PP.Engine({ players: players.map((p) => ({ ...p, stack, isHuman: false })),
      smallBlind: 1, bigBlind: 2, rng: PP.Cards.seededRng(seed), endWhenHumanBusts: false });
    eng.actionProvider = (player, view, legal) => decide(player.id)(view, legal, player);
    const ladder = T.levels({ startingStack: stack, preset, antes });
    const hpl = T.PRESETS[preset].handsPerLevel;
    const blindsSeen = [];
    eng.on('blinds', () => { blindsSeen.push(eng.bigBlind); });
    const elimOrder = [];
    let hands = 0;
    let lastLevel = 0;
    while (!tour.isComplete() && hands < HAND_CAP) {
      const before = tour.beforeHand(eng);
      assert.ok(before.level >= lastLevel, 'level never decreases');
      lastLevel = before.level;
      const expected = ladder[Math.min(Math.floor(hands / hpl), ladder.length - 1)];
      const record = await eng.playHand();
      assert.ok(record, 'engine dealt a hand');
      assert.equal(blindsSeen[blindsSeen.length - 1], expected.bb, 'blinds on schedule at hand ' + hands);
      assert.equal(record.bigBlind, expected.bb);
      const total = eng.players.reduce((s, p) => s + p.stack, 0);
      assert.equal(total, n * stack, 'chips conserved at hand ' + hands);
      const after = tour.afterHand(eng, record);
      after.eliminated.forEach((e) => elimOrder.push(e));
      hands += 1;
    }
    return { tour, eng, hands, elimOrder, lastLevel };
  }

  function assertFinished(sim, n, stack) {
    const { tour, eng, elimOrder } = sim;
    assert.equal(tour.isComplete(), true, 'tournament completed within ' + HAND_CAP + ' hands');
    const res = tour.results();
    assert.equal(res.length, n);
    assert.deepEqual(res.map((r) => r.place), Array.from({ length: n }, (_, i) => i + 1));
    assert.equal(res.filter((r) => r.stack > 0).length, 1, 'exactly one winner holds chips');
    assert.equal(res[0].stack, n * stack, 'winner holds every chip');
    assert.equal(eng.players.find((p) => p.stack > 0).id, res[0].id);
    // eliminated strictly in decreasing place order: n, n-1, ..., 2
    assert.deepEqual(elimOrder.map((e) => e.place), Array.from({ length: n - 1 }, (_, i) => n - i));
    const st = tour.state();
    assert.deepEqual(st.eliminated.map((e) => e.id), elimOrder.map((e) => e.id));
    assert.deepEqual(st.standings.map((s) => s.id), res.map((r) => r.id));
    assert.equal(st.alive, 1);
    assert.equal(st.complete, true);
    const pays = T.payouts(n);
    assert.deepEqual(res.map((r) => r.points), res.map((r) => pays[r.place - 1] || 0));
    assert.equal(res.reduce((s, r) => s + r.points, 0), 100);
  }

  const botDecider = (n, seed, ratings) => {
    const bots = {};
    for (let i = 1; i <= n; i++) {
      const id = 'p' + i;
      bots[id] = PP.Bots.create({ rating: ratings[(i - 1) % ratings.length], id, rng: PP.Cards.seededRng(seed * 31 + i) });
    }
    return (id) => (view, legal, me) => bots[id].decide(view, legal, me);
  };

  t('full SNG: 6 real bots, turbo, 300 chips completes; chips conserved; blinds on schedule', async () => {
    const sim = await simulate({ n: 6, stack: 300, preset: 'turbo', antes: false, seed: 6,
      decide: botDecider(6, 6, [1, 2, 3, 4, 5]) });
    assertFinished(sim, 6, 300);
    assert.ok(sim.lastLevel >= 1);
  });

  t('full SNG: heads-up (2 real bots), turbo with antes', async () => {
    const sim = await simulate({ n: 2, stack: 300, preset: 'turbo', antes: true, seed: 2,
      decide: botDecider(2, 2, [3, 4]) });
    assertFinished(sim, 2, 300);
  });

  t('full SNG: 9 real bots, turbo with antes', async () => {
    const sim = await simulate({ n: 9, stack: 300, preset: 'turbo', antes: true, seed: 9,
      decide: botDecider(9, 9, [1, 2, 3, 4, 5]) });
    assertFinished(sim, 9, 300);
  });

  t('full SNG: 9 seats of aggressive shovers (many same-hand busts), regular', async () => {
    const rng = PP.Cards.seededRng(99);
    const shoveOrFold = () => (view, legal) => (rng() < 0.45 ? { type: 'allin' } : legal.canCheck ? { type: 'check' } : { type: 'fold' });
    for (let seed = 1; seed <= 5; seed++) {
      const sim = await simulate({ n: 9, stack: 500, preset: 'regular', antes: false, seed, decide: shoveOrFold });
      assertFinished(sim, 9, 500);
    }
  });
})();
