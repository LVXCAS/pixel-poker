/* Tests for LEARN mode (js/tutorial.js): every scripted lesson hand is replayed through the real engine.
 * run.js loads only the logic modules, so this file loads js/tutorial.js itself (its top half is DOM-free). */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'tutorial: ' + name, fn });

  /* The vm sandbox has no require; reach the host's fs through a host function's constructor. */
  function loadTutorial() {
    if (PP.Tutorial) return PP.Tutorial;
    const proc = setTimeout.constructor('return process')();
    const req = proc.getBuiltinModule ? proc.getBuiltinModule : proc.mainModule.require;
    const fs = req('node:fs');
    const path = req('node:path');
    const file = path.join(proc.cwd(), 'js', 'tutorial.js');
    const src = fs.readFileSync(fs.existsSync(file) ? file : path.join(__dirnameGuess(proc, path), 'js', 'tutorial.js'), 'utf8');
    (0, eval)(src); // indirect eval: runs in this context's global scope, like a classic <script>
    return PP.Tutorial;
  }
  function __dirnameGuess(proc, path) { return path.resolve(path.dirname(proc.argv[1] || '.'), '..'); }

  const T = loadTutorial();
  const C = PP.Cards;
  const key = (c) => c.r + c.s;
  const tableLessons = T.LESSONS.filter((l) => l.kind === 'table');

  t('module loads DOM-free and lists 8 lessons in order', () => {
    assert.ok(T, 'PP.Tutorial exported');
    assert.deepEqual(T.LESSONS.map((l) => l.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    T.LESSONS.forEach((l) => {
      assert.ok(l.title && l.blurb, 'lesson ' + l.id + ' has copy');
      assert.ok(['table', 'board', 'game'].includes(l.kind));
    });
  });

  t('every preset deck is 52 unique cards and deals the scripted holes and board', () => {
    tableLessons.forEach((l) => {
      const ids = l.table.players.map((p) => p.id);
      l.table.hands.forEach((h, i) => {
        const deck = T.buildDeck(ids, h.dealer, h.holes, h.board);
        assert.equal(deck.length, 52, 'lesson ' + l.id + ' hand ' + i);
        assert.equal(new Set(deck.map(key)).size, 52, 'lesson ' + l.id + ' hand ' + i + ' unique');
        deck.forEach((c) => assert.ok(c.r >= 2 && c.r <= 14 && 'shdc'.includes(c.s)));
      });
    });
  });

  t('copy is plain: no emoji, no marketing words', () => {
    const banned = /\b(unlock|elevate|seamless|supercharge|effortless|journey|master the)\b/i;
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    const texts = [];
    T.LESSONS.forEach((l) => {
      texts.push(l.title, l.blurb);
      (l.beats || []).forEach((b) => { texts.push(b.say || ''); if (b.ask) texts.push(b.ask.prompt, b.ask.explain, ...b.ask.choices); });
    });
    T.LADDER.forEach((r) => texts.push(r.note));
    texts.forEach((s) => { assert.ok(!banned.test(s), s); assert.ok(!emoji.test(s), s); });
  });

  /** Plays one scripted lesson through PP.Engine: scripted bots, the canonical hero line, and a beat cursor. */
  async function playLesson(l) {
    const tb = l.table;
    const ids = tb.players.map((p) => p.id);
    const players = tb.players.map((p) => ({ id: p.id, name: p.name, stack: p.stack, isHuman: p.id === 'hero' }));
    let handIdx = -1;
    let heroTurn = 0;
    let bots = {};
    const eng = new PP.Engine({
      players, smallBlind: tb.sb, bigBlind: tb.bb,
      deckFn: (n) => { const h = tb.hands[n - 1]; return T.buildDeck(ids, h.dealer, h.holes, h.board); },
    });
    const problems = [];
    const legalFor = (a, legal) => {
      if (a.type === 'fold') return legal.canFold;
      if (a.type === 'check') return legal.canCheck;
      if (a.type === 'call') return legal.canCall;
      if (a.type === 'bet') return legal.canBet && a.amount >= legal.minRaiseTo && a.amount <= legal.maxRaiseTo;
      if (a.type === 'raise') return legal.canRaise && a.amount >= legal.minRaiseTo && a.amount <= legal.maxRaiseTo;
      return false;
    };
    let beat = 0;
    const fire = (name, payload) => {
      const ev = { name, payload, street: eng.street };
      if (T.matchBeat(l.beats[beat], ev)) beat++; // the runner advances at most one beat per event
    };
    ['blinds', 'deal', 'turn', 'action', 'street', 'showdown', 'potAwarded'].forEach((n) => eng.on(n, (p) => fire(n, p)));
    eng.on('handStart', (p) => {
      handIdx++; heroTurn = 0;
      const spec = tb.hands[handIdx];
      assert.equal(p.dealerSeat, spec.dealer, 'lesson ' + l.id + ' hand ' + handIdx + ' button seat');
      bots = {};
      ids.filter((id) => id !== 'hero').forEach((id) => { bots[id] = { queue: (spec.bots[id] || []).map(T.parseAction) }; });
      fire('handStart', p);
    });
    eng.on('deal', () => {
      const spec = tb.hands[handIdx];
      Object.keys(spec.holes).forEach((id) => {
        assert.deepEqual(eng.byId(id).hole.map(key), C.parseMany(spec.holes[id]).map(key), 'lesson ' + l.id + ' ' + id + ' hole');
      });
    });
    eng.actionProvider = async (player, view, legal) => {
      const spec = tb.hands[handIdx];
      if (player.id === 'hero') {
        heroTurn++;
        const entry = spec.hero[heroTurn - 1];
        if (!entry) { problems.push('lesson ' + l.id + ': hero has no scripted action at turn ' + heroTurn); return { type: 'fold' }; }
        const want = T.heroExpect(entry);
        if (!legalFor(want.play, legal)) problems.push('lesson ' + l.id + ': hero ' + entry + ' illegal on ' + view.street);
        if (T.checkHero(entry, want.play, tb.heroMax)) problems.push('lesson ' + l.id + ': canonical hero play fails its own gate: ' + entry);
        want.types.forEach((ty) => {
          const ok = ty === 'fold' ? legal.canFold : ty === 'call' ? legal.canCall : ty === 'check' ? legal.canCheck : ty === 'bet' ? legal.canBet : legal.canRaise;
          if (!ok) problems.push('lesson ' + l.id + ': accepted hero type ' + ty + ' not legal');
        });
        return want.play;
      }
      const a = bots[player.id].queue.shift();
      if (!a) { problems.push('lesson ' + l.id + ': ' + player.id + ' ran out of script on ' + view.street); return { type: 'fold' }; }
      if (!legalFor(a, legal)) problems.push('lesson ' + l.id + ': ' + player.id + ' ' + a.type + ' ' + (a.amount || '') + ' illegal on ' + view.street);
      return a;
    };
    const records = [];
    for (let i = 0; i < tb.hands.length; i++) {
      records.push(await eng.playHand());
      fire('handEnd', { record: records[i] });
    }
    Object.keys(bots).forEach((id) => {
      if (bots[id].queue.length) problems.push('lesson ' + l.id + ': ' + id + ' has unused script ' + JSON.stringify(bots[id].queue));
    });
    const lastSpec = tb.hands[tb.hands.length - 1];
    if (heroTurn !== lastSpec.hero.length) problems.push('lesson ' + l.id + ': hero acted ' + heroTurn + ' times, script has ' + lastSpec.hero.length);
    return { records, problems, beatsUsed: beat, beatsTotal: l.beats.length, eng };
  }

  tableLessons.forEach((l) => {
    t('lesson ' + l.id + ' script: every action legal, every beat fires in order', async () => {
      const r = await playLesson(l);
      assert.deepEqual(r.problems, []);
      assert.equal(r.beatsUsed, r.beatsTotal, 'beats consumed (stuck at #' + r.beatsUsed + ': ' + JSON.stringify(l.beats[r.beatsUsed] || null) + ')');
      const chips = r.eng.players.reduce((s, p) => s + p.stack, 0);
      assert.equal(chips, l.table.players.reduce((s, p) => s + p.stack, 0), 'chips conserved');
    });
  });

  t('lesson outcomes match what the dealer says', async () => {
    const byId = (id) => T.LESSONS.find((l) => l.id === id);
    const won = (rec, id) => rec.awards.filter((a) => a.playerId === id).reduce((s, a) => s + a.amount, 0);
    const l1 = (await playLesson(byId(1))).records[0];
    assert.ok(l1.showdown && won(l1, 'hero') > 0, 'lesson 1: hero wins at showdown');
    assert.equal(l1.reveals.find((x) => x.playerId === 'hero').hand.cat, 1, 'lesson 1: a pair of queens');
    const l4 = (await playLesson(byId(4))).records[0];
    assert.ok(!l4.showdown && won(l4, 'hero') > 0, 'lesson 4: hero takes it without a showdown');
    const l6 = (await playLesson(byId(6))).records[0];
    assert.equal(l6.reveals.find((x) => x.playerId === 'hero').hand.catName, 'Flush', 'lesson 6: river flush');
    assert.ok(won(l6, 'hero') > 0);
    const l7 = (await playLesson(byId(7))).records[0];
    const duke = l7.players.find((p) => p.id === 'b1');
    const board = l7.board;
    assert.equal(board.length, 5);
    assert.equal(PP.Eval.evaluate(duke.hole.concat(board)).catName, 'Flush', 'lesson 7: DUKE rivers a flush');
    const riverBet = l7.actions.find((a) => a.street === 'river' && a.playerId === 'b1');
    assert.equal(riverBet.type, 'bet');
    assert.equal(riverBet.amount, 300, 'lesson 7 copy says he bets 300');
  });

  t('lesson 6 slip numbers: 9 outs, rule of 2 = 18, price 17', async () => {
    const l = T.LESSONS.find((x) => x.id === 6);
    const h = l.table.hands[0];
    const board = C.parseMany(h.board).slice(0, 4);
    const outs = PP.Equity.outs(C.parseMany(h.holes.hero), board);
    assert.equal(outs.count, 9, 'a clean flush draw');
    assert.equal(Math.round(PP.Equity.ruleOf2and4(outs.count, 'turn')), 18);
    assert.equal(Math.round(PP.Equity.ruleOf2and4(outs.count, 'flop')), 36, 'flop copy says about 36%');
    // Pot at the turn decision: 60 + 60 preflop, checked flop, DUKE bets 30.
    assert.equal(Math.round(PP.Equity.potOdds(30, 150) * 100), 17);
    // The call is right: exact equity beats the price.
    assert.ok(9 / 46 > 30 / 180);
  });

  t('lesson 2 ladder examples are the hands they claim to be', () => {
    T.LADDER.forEach((rung) => {
      assert.equal(PP.Eval.evaluate(C.parseMany(rung.ex)).catName, rung.name, rung.ex);
    });
    const cats = T.LADDER.map((r) => PP.Eval.evaluate(C.parseMany(r.ex)).score);
    for (let i = 1; i < cats.length; i++) assert.ok(cats[i - 1] > cats[i], 'ladder is ordered at rung ' + i);
  });

  t('lesson 2 "which wins" answers verified with PP.Eval', () => {
    assert.equal(T.WHO_WINS.length, 3);
    T.WHO_WINS.forEach((q) => {
      const board = C.parseMany(q.board);
      const all = board.concat(C.parseMany(q.a), C.parseMany(q.b));
      assert.equal(new Set(all.map(key)).size, 9, 'no duplicate cards in ' + q.board);
      const d = PP.Eval.compare(PP.Eval.evaluate(C.parseMany(q.a).concat(board)), PP.Eval.evaluate(C.parseMany(q.b).concat(board)));
      const expected = d > 0 ? 0 : d < 0 ? 1 : 2;
      assert.equal(q.answer, expected, q.board + ': ' + q.a + ' vs ' + q.b);
    });
  });

  t('lesson 5 tier answers verified with PP.Equity.preflopTier', () => {
    T.TIER_QUIZ.forEach((q) => assert.equal(PP.Equity.preflopTier(C.parseMany(q.hand)), q.answer, q.hand));
    T.TIER_QUIZ.forEach((q) => assert.ok(T.TIERS.includes(q.answer)));
    const shown = new Set(T.TIER_EXAMPLES.map((h) => PP.Equity.preflopTier(C.parseMany(h))));
    T.TIERS.forEach((tier) => assert.ok(shown.has(tier), 'tier chart has an example of ' + tier));
  });

  t('lesson 5 domination: 76s does better than KQ against AK', () => {
    const d = T.DOMINATION;
    const rng = C.seededRng(d.seed);
    const eq = d.options.map((o) => T.headsUp(C.parseMany(o), C.parseMany(d.villain), d.iterations, rng));
    assert.ok(eq[0] > 0.2 && eq[0] < 0.32, 'KQ vs AK about 26%: ' + eq[0]);
    assert.ok(eq[1] > 0.34 && eq[1] < 0.46, '76s vs AK about 40%: ' + eq[1]);
    assert.equal(eq.indexOf(Math.max(...eq)), d.answer);
    assert.equal(PP.Equity.handLabel(C.parseMany(d.options[1])), '76s');
  });

  t('hero gate accepts the asked-for move and refuses others or oversize bets', () => {
    assert.equal(T.checkHero('call', { type: 'call' }), null);
    assert.equal(T.checkHero('call', { type: 'fold' }), 'type');
    assert.equal(T.checkHero('fold|call', { type: 'fold' }), null);
    assert.equal(T.checkHero('fold|call', { type: 'call' }), null);
    assert.equal(T.checkHero('raise 180', { type: 'raise', amount: 300 }, 300), null);
    assert.equal(T.checkHero('raise 180', { type: 'raise', amount: 301 }, 300), 'size');
    assert.equal(T.checkHero('bet 60', { type: 'allin' }, 300), 'type');
  });

  t('scripted bot plays its list then falls back to check or fold', () => {
    const b = T.scriptedBot(['raise 60', 'call']);
    assert.deepEqual(b.decide({}, {}), { type: 'raise', amount: 60 });
    assert.deepEqual(b.decide({}, {}), { type: 'call' });
    assert.deepEqual(b.decide({}, { canCheck: true }), { type: 'check' });
    assert.deepEqual(b.decide({}, { canCheck: false }), { type: 'fold' });
  });

  t('engine: preset deck is dealt in order, and a bad deck is refused', async () => {
    const ids = ['a', 'b', 'c'];
    const deck = T.buildDeck(ids, 0, { a: 'As Ad', b: 'Kh Kd', c: '2c 7d' }, 'Qs Js Ts 3h 4h');
    const eng = new PP.Engine({ players: ids.map((id) => ({ id, stack: 1000 })), smallBlind: 5, bigBlind: 10, deck });
    eng.actionProvider = async (p, v, legal) => (legal.canCheck ? { type: 'check' } : { type: 'call' });
    const rec = await eng.playHand();
    assert.deepEqual(rec.players.find((p) => p.id === 'a').hole.map(key), ['14s', '14d']);
    assert.deepEqual(rec.players.find((p) => p.id === 'c').hole.map(key), ['2c', '7d']);
    assert.deepEqual(rec.board.map(key), C.parseMany('Qs Js Ts 3h 4h').map(key));
    assert.throws(() => new PP.Engine({ players: [{ id: 'x', stack: 1 }, { id: 'y', stack: 1 }], deck: deck.slice(0, 51) }), /52 unique/);
    const dup = deck.slice(); dup[51] = dup[0];
    assert.throws(() => new PP.Engine({ players: [{ id: 'x', stack: 1 }, { id: 'y', stack: 1 }], deck: dup }), /52 unique/);
  });
})();
