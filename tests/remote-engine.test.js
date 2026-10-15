/* Tests for PP.RemoteEngine — event mirroring, id alias, act/actCancel, playHand, legal. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'remote-engine: ' + name, fn });
  const tick = () => new Promise((r) => setImmediate(r));
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };

  const LEGAL = { canFold: true, canCheck: false, canCall: true, callAmount: 20, canBet: false, canRaise: true,
    minRaiseTo: 40, maxRaiseTo: 1000, toCall: 20 };

  function wireView(handNumber, extra) {
    return {
      handNumber, street: 'preflop', board: [], pot: 30,
      pots: [{ amount: 30, eligible: ['hero', 'h2', 'b1'] }],
      currentBet: 20, minRaiseTo: 40, bigBlind: 20, smallBlind: 10, dealerSeat: 0, sbSeat: 1, bbSeat: 2,
      toActId: 'h2',
      players: [
        { id: 'hero', name: 'host', seat: 0, stack: 1000, bet: 0, totalBet: 0, folded: false, allIn: false, out: false,
          isHuman: true, lastAction: null, hole: null },
        { id: 'h2', name: 'me', seat: 1, stack: 990, bet: 10, totalBet: 10, folded: false, allIn: false, out: false,
          isHuman: true, lastAction: null, hole: [{ r: 14, s: 's' }, { r: 13, s: 's' }] },
        { id: 'b1', name: 'bot', seat: 2, stack: 980, bet: 20, totalBet: 20, folded: false, allIn: false, out: false,
          isHuman: false, lastAction: null, hole: null },
      ],
      history: [{ street: 'preflop', playerId: 'hero', type: 'call', amount: 20, potAfter: 50 }],
      ...(extra || {}),
    };
  }

  function make(selfId) {
    const sent = [];
    const cancelled = [];
    const re = new PP.RemoteEngine({ selfId, send: (m) => sent.push(m), onTurnCancelled: (i) => cancelled.push(i) });
    return { re, sent, cancelled };
  }

  t('ev messages emit the same names/payloads, awaiting async listeners in order', async () => {
    const { re } = make('h2');
    const order = [];
    re.on('handStart', async (p) => {
      order.push('start-a:' + p.handNumber);
      await settle();
      order.push('start-a-done');
    });
    re.on('handStart', () => order.push('start-b'));
    re.on('action', (p) => order.push('action:' + p.type));
    re.receive({ t: 'ev', n: 1, name: 'handStart', payload: { handNumber: 4, dealerSeat: 0, sbSeat: 1, bbSeat: 2 }, view: wireView(4) });
    re.receive({ t: 'ev', n: 2, name: 'action', payload: { playerId: 'b1', type: 'call', amount: 20, stack: 980, pot: 50 }, view: wireView(4) });
    await settle();
    await settle();
    assert.deepEqual(order, ['start-a:4', 'start-a-done', 'start-b', 'action:call']);
  });

  t('alias: own seat appears as hero, host appears as the own wire id, everywhere', async () => {
    const { re } = make('h2');
    let payload = null;
    re.on('showdown', (p) => {
      payload = p;
    });
    let record = null;
    re.on('handEnd', (p) => {
      record = p.record;
    });
    const reveals = [{ playerId: 'h2', hole: [{ r: 14, s: 's' }] }, { playerId: 'hero', hole: [{ r: 2, s: 'c' }] }];
    re.receive({ t: 'ev', n: 1, name: 'showdown', payload: { reveals }, view: wireView(1) });
    re.receive({ t: 'ev', n: 2, name: 'handEnd', view: wireView(1), payload: { record: {
      players: [{ id: 'hero' }, { id: 'h2' }], awards: [{ playerId: 'h2', amount: 30 }], reveals,
      actions: [{ playerId: 'hero', type: 'call' }],
    } } });
    re.receive({ t: 'end', results: { standings: [{ id: 'h2', place: 1 }, { id: 'hero', place: 2 }] } });
    let over = null;
    re.on('gameOver', (p) => {
      over = p;
    });
    await settle();
    const v = re.publicView('hero');
    assert.deepEqual(v.players.map((p) => p.id), ['h2', 'hero', 'b1']);
    assert.equal(v.toActId, 'hero');
    assert.deepEqual(v.pots[0].eligible, ['h2', 'hero', 'b1']);
    assert.equal(v.history[0].playerId, 'h2');
    assert.deepEqual(payload.reveals.map((r) => r.playerId), ['hero', 'h2']);
    assert.deepEqual(record.players.map((p) => p.id), ['h2', 'hero']);
    assert.equal(record.awards[0].playerId, 'hero');
    assert.equal(record.actions[0].playerId, 'h2');
    assert.equal(over.winnerId, 'hero');
    assert.equal(re.toLocalId('h2'), 'hero');
    assert.equal(re.toLocalId('hero'), 'h2');
    assert.equal(re.toWireId('hero'), 'h2');
    assert.equal(re.toLocalId('b1'), 'b1');
  });

  t('spectator (selfId null): no swap', async () => {
    const { re } = make(null);
    re.receive({ t: 'ev', n: 1, name: 'deal', payload: {}, view: wireView(1) });
    await settle();
    assert.deepEqual(re.publicView().players.map((p) => p.id), ['hero', 'h2', 'b1']);
    assert.equal(re.publicView().toActId, 'h2');
  });

  t('publicView() inside a listener equals that event\'s view; views are frozen', async () => {
    const { re } = make('h2');
    const seen = [];
    re.on('action', () => seen.push(re.publicView('hero').pot));
    re.receive({ t: 'ev', n: 1, name: 'action', payload: { playerId: 'b1' }, view: wireView(1, { pot: 50 }) });
    re.receive({ t: 'ev', n: 2, name: 'action', payload: { playerId: 'hero' }, view: wireView(1, { pot: 70 }) });
    await settle();
    assert.deepEqual(seen, [50, 70]);
    assert.ok(Object.isFrozen(re.publicView()));
    assert.ok(Object.isFrozen(re.publicView().players[0]));
  });

  t('act -> actionProvider gets aliased player/view/legal; result sent with the same seq', async () => {
    const { re, sent } = make('h2');
    let args = null;
    re.actionProvider = async (player, view, legal) => {
      args = { player, view, legal };
      assert.equal(re.getLegal('hero').minRaiseTo, 40);
      return { type: 'raise', amount: 60.7, sneaky: 'x' };
    };
    const me = wireView(2).players[1];
    re.receive({ t: 'act', seq: 7, player: me, view: wireView(2), legal: LEGAL, timeMs: 30000 });
    await settle();
    assert.equal(args.player.id, 'hero');
    assert.equal(args.view.toActId, 'hero');
    assert.equal(args.legal.callAmount, 20);
    assert.deepEqual(sent, [{ v: 1, t: 'action', seq: 7, action: { type: 'raise', amount: 60 } }]);
    assert.equal(re.getLegal('hero'), PP.RemoteEngine.NO_LEGAL);
  });

  t('provider throwing -> check/fold sent', async () => {
    const { re, sent } = make('h2');
    re.actionProvider = () => {
      throw new Error('ui broke');
    };
    re.receive({ t: 'act', seq: 1, player: {}, view: wireView(1), legal: LEGAL, timeMs: 0 });
    re.receive({ t: 'act', seq: 2, player: {}, view: wireView(1), legal: { ...LEGAL, canCheck: true, canCall: false }, timeMs: 0 });
    await settle();
    assert.deepEqual(sent.map((m) => [m.seq, m.action.type]), [[1, 'fold'], [2, 'check']]);
  });

  t('actCancel for the pending turn: onTurnCancelled fires, late result NOT sent, queue continues', async () => {
    const { re, sent, cancelled } = make('h2');
    let release;
    re.actionProvider = () => new Promise((r) => {
      release = r;
    });
    const after = [];
    re.on('action', (p) => after.push(p.type));
    re.receive({ t: 'act', seq: 3, player: {}, view: wireView(1), legal: LEGAL, timeMs: 30000 });
    re.receive({ t: 'ev', n: 9, name: 'action', payload: { playerId: 'h2', type: 'fold' }, view: wireView(1) });
    await settle();
    re.receive({ t: 'actCancel', seq: 3, reason: 'timeout' });
    await settle();
    release({ type: 'call' });
    await settle();
    assert.deepEqual(cancelled, [{ reason: 'timeout', seq: 3 }]);
    assert.deepEqual(sent, []);
    assert.deepEqual(after, ['fold']);
  });

  t('actCancel for a queued (not yet processed) act: provider never called for it', async () => {
    const { re, sent } = make('h2');
    const asked = [];
    let release;
    re.on('handStart', () => new Promise((r) => {
      release = r;
    }));
    re.actionProvider = (p, v, l) => {
      asked.push(l.minRaiseTo);
      return { type: 'call' };
    };
    re.receive({ t: 'ev', n: 1, name: 'handStart', payload: {}, view: wireView(1) });
    re.receive({ t: 'act', seq: 5, player: {}, view: wireView(1), legal: LEGAL, timeMs: 0 });
    await settle();
    re.receive({ t: 'actCancel', seq: 5, reason: 'disconnect' });
    release();
    await settle();
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, []);
  });

  t('playHand() resolves with the next handEnd record; end -> isGameOver, playHand null', async () => {
    const { re } = make('h2');
    const p1 = re.playHand();
    re.receive({ t: 'ev', n: 1, name: 'handStart', payload: { handNumber: 1 }, view: wireView(1) });
    await settle();
    assert.equal(re.inHand, true);
    re.receive({ t: 'ev', n: 2, name: 'handEnd', payload: { record: { handNumber: 1, players: [{ id: 'h2' }] } }, view: wireView(1) });
    const rec = await p1;
    assert.equal(rec.handNumber, 1);
    assert.equal(rec.players[0].id, 'hero');
    assert.equal(re.inHand, false);
    assert.equal(re.isGameOver(), false);
    const p2 = re.playHand();
    re.receive({ t: 'end', results: { reason: 'host-ended', standings: [] } });
    assert.equal(await p2, null);
    assert.equal(re.isGameOver(), true);
    assert.equal(await re.playHand(), null);
  });

  t('getLegal / addChips / players / getters', async () => {
    const { re } = make('h2');
    assert.equal(re.getLegal('hero'), PP.RemoteEngine.NO_LEGAL);
    assert.equal(re.addChips('hero', 100), false);
    re.receive({ t: 'ev', n: 1, name: 'deal', payload: {}, view: wireView(3) });
    await settle();
    assert.equal(re.handNumber, 3);
    assert.equal(re.bigBlind, 20);
    assert.equal(re.smallBlind, 10);
    assert.equal(re.dealerSeat, 0);
    const players = re.players;
    assert.equal(players.find((p) => p.id === 'hero').stack, 990);
    players[0].stack = -1; // copies: never mutates the view
    assert.notEqual(re.publicView().players[0].stack, -1);
    assert.equal(re.getLegal('b1'), PP.RemoteEngine.NO_LEGAL);
  });

  t('sync replaces the view, emits sync, then processes pendingAct', async () => {
    const { re, sent } = make('h2');
    const seen = [];
    re.on('sync', (p) => seen.push(p.view.handNumber));
    re.actionProvider = () => ({ type: 'call' });
    re.receive({ t: 'sync', view: wireView(9), pendingAct: { seq: 4, player: {}, view: wireView(9), legal: LEGAL, timeMs: 5000 } });
    await settle();
    assert.deepEqual(seen, [9]);
    assert.deepEqual(sent.map((m) => m.seq), [4]);
  });

  t('a throwing listener never stalls the queue', async () => {
    const { re } = make('h2');
    const got = [];
    re.on('street', () => {
      throw new Error('boom');
    });
    re.on('street', (p) => got.push(p.street));
    const err = console.error;
    console.error = () => {};
    try {
      re.receive({ t: 'ev', n: 1, name: 'street', payload: { street: 'flop' }, view: wireView(1) });
      re.receive({ t: 'ev', n: 2, name: 'street', payload: { street: 'turn' }, view: wireView(1) });
      await settle();
    } finally {
      console.error = err;
    }
    assert.deepEqual(got, ['flop', 'turn']);
  });
})();
