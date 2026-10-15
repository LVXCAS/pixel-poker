/* Tests for the additive multiplayer engine API (MULTIPLAYER.md 6.1): setBlinds + endWhenHumanBusts. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'engine-mp: ' + name, fn });

  const passive = async (player, view, legal) => (legal.canCheck ? { type: 'check' } : { type: 'call' });
  // hero shoves, b1 calls, b2 folds: a coin flip that can bust hero while b2 keeps its chips.
  const heroVsB1 = async (player, view, legal) => {
    if (player.id === 'b2') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    return player.id === 'hero' ? { type: 'allin' } : { type: 'call' };
  };

  function makeEngine(extra) {
    const eng = new PP.Engine(Object.assign({
      players: [
        { id: 'hero', name: 'Hero', stack: 1000, isHuman: true },
        { id: 'b1', name: 'B1', stack: 1000 },
        { id: 'b2', name: 'B2', stack: 1000 },
      ],
      smallBlind: 10, bigBlind: 20, rng: PP.Cards.seededRng(7),
    }, extra || {}));
    eng.actionProvider = passive;
    return eng;
  }

  function captureBlinds(eng) {
    const seen = [];
    eng.on('blinds', (p) => { seen.push({ posts: p.posts, view: eng.publicView('hero') }); });
    return seen;
  }

  t('setBlinds between hands takes effect on the next hand', async () => {
    const eng = makeEngine();
    const seen = captureBlinds(eng);
    await eng.playHand();
    assert.equal(eng.setBlinds(25, 50), true);
    await eng.playHand();
    const amounts = (i, kind) => seen[i].posts.filter((x) => x.kind === kind).map((x) => x.amount);
    assert.deepEqual(amounts(0, 'bb'), [20]);
    assert.deepEqual(amounts(1, 'sb'), [25]);
    assert.deepEqual(amounts(1, 'bb'), [50]);
    assert.equal(seen[1].view.bigBlind, 50);
    assert.equal(seen[1].view.smallBlind, 25);
  });

  t('setBlinds is rejected mid-hand and changes nothing', async () => {
    const eng = makeEngine();
    const results = [];
    eng.on('turn', () => { results.push(eng.setBlinds(500, 1000)); });
    await eng.playHand();
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r === false));
    assert.equal(eng.smallBlind, 10);
    assert.equal(eng.bigBlind, 20);
  });

  t('setBlinds sanitizes values (bb defaults to 2*sb, never below sb; sb >= 1)', () => {
    const eng = makeEngine();
    eng.setBlinds(30, 0);
    assert.deepEqual([eng.smallBlind, eng.bigBlind, eng.ante], [30, 60, 0]);
    eng.setBlinds(40, 10, 5);
    assert.deepEqual([eng.smallBlind, eng.bigBlind, eng.ante], [40, 40, 5]);
    eng.setBlinds(0, 'x', -3);
    assert.deepEqual([eng.smallBlind, eng.bigBlind, eng.ante], [1, 2, 0]);
  });

  t('setBlinds keeps the current ante when omitted and antes are posted', async () => {
    const eng = makeEngine();
    const seen = captureBlinds(eng);
    eng.setBlinds(10, 20, 3);
    eng.setBlinds(15, 30);
    assert.equal(eng.ante, 3);
    await eng.playHand();
    const antes = seen[0].posts.filter((x) => x.kind === 'ante');
    assert.equal(antes.length, 3);
    assert.ok(antes.every((x) => x.amount === 3));
    const total = eng.players.reduce((sum, p) => sum + p.stack, 0);
    assert.equal(total, 3000);
  });

  /** Plays hero-vs-b1 flips across seeds until the human busts while 2+ others still have chips. */
  async function engineWithBustedHero(opts) {
    for (let seed = 1; seed < 60; seed++) {
      const eng = makeEngine(Object.assign({ rng: PP.Cards.seededRng(seed) }, opts));
      eng.actionProvider = heroVsB1;
      for (let i = 0; i < 200; i++) {
        const rec = await eng.playHand();
        if (!rec || eng.byId('hero').stack === 0) break;
      }
      const others = eng.players.filter((p) => p.id !== 'hero' && p.stack > 0);
      if (eng.byId('hero').stack === 0 && others.length >= 2) return eng;
    }
    throw new Error('no seed busts the human first');
  }

  t('default: game is over once the human busts', async () => {
    const eng = await engineWithBustedHero({});
    assert.equal(eng.isGameOver(), true);
  });

  t('endWhenHumanBusts:false keeps the game going after the human busts', async () => {
    const eng = await engineWithBustedHero({ endWhenHumanBusts: false });
    assert.equal(eng.isGameOver(), false);
    const rec = await eng.playHand();
    assert.ok(rec, 'another hand is dealt without the human');
    assert.ok(!rec.players.some((p) => p.id === 'hero'));
  });
})();
