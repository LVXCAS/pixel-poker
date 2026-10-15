/* PIXEL HOLD'EM — app controller: setup, game loop wiring (Engine + Bots + Coach -> UI), drills, stats.
 * Classic script (no modules). Depends on PP.Cards/Eval/Equity/Engine/Bots/Coach/UI per CONTRACT.md. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});
  const UI = PP.UI;

  // ------------------------------------------------------------------ constants
  const HERO_ID = 'hero';
  const HERO_NAME = 'YOU';
  const STORAGE_KEY = 'pixelholdem.v1';
  const MAX_BOTS = 8;
  const STACK_OPTIONS = [500, 1000, 2000, 5000];
  const BLIND_OPTIONS = [[5, 10], [10, 20], [25, 50], [50, 100]];
  const SPEED_OPTIONS = [
    { label: 'SLOW', factor: 1.6 }, { label: 'NORMAL', factor: 1 },
    { label: 'FAST', factor: 0.55 }, { label: 'TURBO', factor: 0.2 },
  ];
  const REVIEW_OPTIONS = ['ALWAYS', 'IF I PLAYED', 'OFF'];
  const CHAMPION_PAUSE_MS = 1300;
  const REVIEW_ALWAYS = 0;
  const REVIEW_IF_PLAYED = 1;
  const DELAY = {
    botThink: 650, thinkJitter: 550, action: 380, blinds: 320, street: 480, showdown: 1300,
    award: 1500, handGap: 2400, handStart: 260, foldedFactor: 0.45,
  };
  const BIG_ALLIN_BB = 15;
  const BIG_WIN_BB = 25;
  const FALLBACK_TITLES = ['Fish', 'Rookie', 'Regular', 'Grinder', 'Shark'];
  const FALLBACK_NAMES = ['ZAPPER', 'PIXEL PETE', 'LUCKY 7', 'BIT QUEEN', 'MEGA MAX', 'GLITCH', 'CHIPTUNE', 'NEON NED'];
  const GRADES = ['GREAT', 'GOOD', 'OK', 'MISTAKE', 'BLUNDER'];
  const DRILL_KINDS = [
    { id: 'mixed', label: 'MIXED' }, { id: 'winner', label: 'WHO WINS' }, { id: 'nameHand', label: 'NAME IT' },
    { id: 'potOdds', label: 'POT ODDS' }, { id: 'outs', label: 'OUTS' },
  ];
  const VERBS = { fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises to', allin: 'goes ALL IN' };
  const REQUIRED_MODULES = ['Cards', 'Eval', 'Equity', 'Engine', 'Bots', 'Coach'];

  // -------------------------------------------------------------------- storage
  const Store = {
    read() {
      try {
        const raw = globalThis.localStorage && localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (err) {
        return {};
      }
    },
    write(data) {
      try {
        if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (err) {
        // Storage blocked (private mode / file:// quirks): keep running with in-memory data.
      }
    },
  };

  function emptyStats() {
    const drills = {};
    DRILL_KINDS.slice(1).forEach((k) => { drills[k.id] = { correct: 0, total: 0 }; });
    const grades = {};
    GRADES.forEach((g) => { grades[g] = 0; });
    return {
      hands: 0, handsWon: 0, net: 0, biggestPot: 0, showdowns: 0, showdownsWon: 0, busts: 0,
      grades, guesses: { count: 0, totalError: 0 }, drills, bestStreak: 0,
    };
  }

  function normalizeStats(raw) {
    const base = emptyStats();
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      ...base, ...s,
      grades: { ...base.grades, ...(s.grades || {}) },
      guesses: { ...base.guesses, ...(s.guesses || {}) },
      drills: Object.keys(base.drills).reduce((acc, k) => ({ ...acc, [k]: { ...base.drills[k], ...((s.drills || {})[k] || {}) } }), {}),
    };
  }

  let saved = Store.read();
  let stats = normalizeStats(saved.stats);

  function persist() { saved = { ...saved, stats, setup: settings }; Store.write(saved); }
  function updateStats(fn) { stats = normalizeStats(fn(stats)); persist(); }

  // ------------------------------------------------------------------- settings
  const DEFAULT_SETTINGS = {
    bots: 3, ratings: [3, 2, 4, 1, 5, 3, 2, 4], names: [],
    stackIdx: 1, blindsIdx: 1, speedIdx: 1, coach: true, guess: false, reviewIdx: REVIEW_IF_PLAYED, autoDeal: false,
  };

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  }

  function sanitizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    return {
      bots: clampInt(s.bots, 1, MAX_BOTS, 3),
      ratings: DEFAULT_SETTINGS.ratings.map((d, i) => clampInt((s.ratings || [])[i], 1, 5, d)),
      names: Array.isArray(s.names) ? s.names.slice(0, MAX_BOTS).map((n) => String(n || '').slice(0, 14)) : [],
      stackIdx: clampInt(s.stackIdx, 0, STACK_OPTIONS.length - 1, 1),
      blindsIdx: clampInt(s.blindsIdx, 0, BLIND_OPTIONS.length - 1, 1),
      speedIdx: clampInt(s.speedIdx, 0, SPEED_OPTIONS.length - 1, 1),
      coach: s.coach !== false,
      guess: !!s.guess,
      reviewIdx: clampInt(s.reviewIdx, 0, REVIEW_OPTIONS.length - 1, REVIEW_IF_PLAYED),
      autoDeal: !!s.autoDeal,
    };
  }

  let settings = sanitizeSettings(saved.setup);

  function setSettings(patch) {
    settings = sanitizeSettings({ ...settings, ...patch });
    UI.setSpeed(SPEED_OPTIONS[settings.speedIdx].factor);
    persist();
  }

  function ratingInfo(r) {
    const R = PP.Bots && PP.Bots.RATINGS;
    let info = null;
    if (Array.isArray(R)) info = R.find((x) => x && x.rating === r) || R[r - 1] || null;
    else if (R) info = R[r] || null;
    return {
      rating: r,
      title: (info && info.title) || FALLBACK_TITLES[r - 1] || 'Bot',
      style: (info && info.style) || '',
      blurb: (info && info.blurb) || '',
    };
  }

  function randomBotName(used) {
    try {
      if (PP.Bots && typeof PP.Bots.randomName === 'function') return String(PP.Bots.randomName(used)).toUpperCase();
    } catch (err) {
      // fall through to the local list
    }
    const free = FALLBACK_NAMES.filter((n) => used.indexOf(n) < 0);
    return free.length ? free[Math.floor(Math.random() * free.length)] : 'BOT ' + (used.length + 1);
  }

  function ensureNames() {
    const names = settings.names.slice();
    for (let i = 0; i < MAX_BOTS; i++) {
      if (!names[i] || names.indexOf(names[i]) !== i) names[i] = randomBotName(names.filter(Boolean));
    }
    settings = { ...settings, names };
  }

  function missingModules() {
    return REQUIRED_MODULES.filter((m) => !PP[m]);
  }

  // -------------------------------------------------------------- setup screen
  function segmented(options, current, onPick) {
    const wrap = UI.el('div', 'seg');
    options.forEach((label, i) => {
      const b = UI.el('button', 'seg-btn' + (i === current ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => onPick(i));
      wrap.appendChild(b);
    });
    return wrap;
  }

  function field(label, control, hint) {
    const box = UI.el('div', 'field');
    box.appendChild(UI.el('label', 'field-label', label));
    box.appendChild(control);
    if (hint) box.appendChild(UI.el('p', 'field-hint', hint));
    return box;
  }

  function stepper(value, min, max, onChange) {
    const wrap = UI.el('div', 'stepper');
    const minus = UI.button('-', 'grey', { small: true, onClick: () => onChange(Math.max(min, value - 1)) });
    const plus = UI.button('+', 'grey', { small: true, onClick: () => onChange(Math.min(max, value + 1)) });
    minus.disabled = value <= min;
    plus.disabled = value >= max;
    wrap.append(minus, UI.el('span', 'stepper-val', value), plus);
    return wrap;
  }

  function renderSetupOptions() {
    const root = UI.clear(UI.byId('setup-options'));
    const update = (patch) => { setSettings(patch); renderSetup(); };
    root.append(
      field('OPPONENTS', stepper(settings.bots, 1, MAX_BOTS, (v) => update({ bots: v })), settings.bots + 1 + '-handed table'),
      field('STARTING STACK', segmented(STACK_OPTIONS.map((v) => UI.money(v)), settings.stackIdx, (i) => update({ stackIdx: i }))),
      field('BLINDS', segmented(BLIND_OPTIONS.map((b) => b[0] + '/' + b[1]), settings.blindsIdx, (i) => update({ blindsIdx: i })),
        Math.round(STACK_OPTIONS[settings.stackIdx] / BLIND_OPTIONS[settings.blindsIdx][1]) + ' big blinds deep'),
      field('SPEED', segmented(SPEED_OPTIONS.map((s) => s.label), settings.speedIdx, (i) => update({ speedIdx: i }))),
      field('COACH', segmented(['ON', 'OFF'], settings.coach ? 0 : 1, (i) => update({ coach: i === 0 })),
        'Live equity, pot odds, outs and a recommendation on every decision.'),
      field('GUESS FIRST', segmented(['ON', 'OFF'], settings.guess ? 0 : 1, (i) => update({ guess: i === 0 })),
        'Hide equity until you type your own estimate. Best for training reads.'),
      field('HAND REVIEW', segmented(REVIEW_OPTIONS, settings.reviewIdx, (i) => update({ reviewIdx: i }))),
    );
  }

  function lineupRow(i) {
    const rating = settings.ratings[i];
    const info = ratingInfo(rating);
    const name = settings.names[i];
    const row = UI.el('div', 'lineup-row rating-' + rating);
    const id = UI.el('div', 'lineup-id');
    const reroll = UI.button('NEW NAME', 'grey', {
      small: true,
      onClick: () => {
        const names = settings.names.slice();
        names[i] = randomBotName(names);
        setSettings({ names });
        renderSetup();
      },
    });
    reroll.title = 'Pick a new name';
    id.append(UI.avatar(name, rating), UI.el('span', 'lineup-name', name), reroll);
    const pick = UI.stars(rating, {
      interactive: true,
      onPick: (r) => {
        const ratings = settings.ratings.slice();
        ratings[i] = r;
        setSettings({ ratings });
        renderSetup();
      },
    });
    const title = UI.el('div', 'lineup-title');
    title.append(UI.el('span', 'lineup-rank', info.title.toUpperCase()), UI.el('span', 'lineup-style', info.style));
    row.append(id, pick, title, UI.el('p', 'lineup-blurb', info.blurb));
    return row;
  }

  function renderLineup() {
    const root = UI.clear(UI.byId('setup-lineup'));
    const quick = UI.el('div', 'quick-set');
    quick.appendChild(UI.el('span', 'field-label', 'SET ALL'));
    [1, 2, 3, 4, 5].forEach((r) => {
      const b = UI.button(r + '★', 'grey', { small: true });
      b.title = 'Every opponent: ' + ratingInfo(r).title;
      b.addEventListener('click', () => { setSettings({ ratings: settings.ratings.map(() => r) }); renderSetup(); });
      quick.appendChild(b);
    });
    quick.appendChild(UI.button('MIX', 'grey', {
      small: true,
      onClick: () => { setSettings({ ratings: settings.ratings.map(() => 1 + Math.floor(Math.random() * 5)) }); renderSetup(); },
    }));
    root.appendChild(quick);
    for (let i = 0; i < settings.bots; i++) root.appendChild(lineupRow(i));
  }

  function renderSetup() {
    ensureNames();
    renderSetupOptions();
    renderLineup();
  }

  function openSetup() {
    renderSetup();
    UI.showScreen('setup');
  }

  // ------------------------------------------------------------------- the game
  let game = null;
  let gameCounter = 0;

  function isLive(g) { return !!g && g.active && game === g; }

  function viewOf(g) { return g.engine.publicView(HERO_ID); }

  function nameOf(g, id) { return g.names[id] || id; }

  function fallbackAction(legal) { return legal && legal.canCheck ? { type: 'check' } : { type: 'fold' }; }

  function createGame(custom) {
    if (custom) return createCustomGame(custom);
    const stack = STACK_OPTIONS[settings.stackIdx];
    const [sb, bb] = BLIND_OPTIONS[settings.blindsIdx];
    const players = [{ id: HERO_ID, name: HERO_NAME, stack, isHuman: true }];
    const bots = {};
    const meta = { [HERO_ID]: { rating: 0 } };
    const names = { [HERO_ID]: HERO_NAME };
    for (let i = 0; i < settings.bots; i++) {
      const id = 'bot' + (i + 1);
      const rating = settings.ratings[i];
      const name = settings.names[i];
      const bot = PP.Bots.create({ rating, id, name });
      const info = ratingInfo(rating);
      bots[id] = bot;
      meta[id] = { rating, title: info.title, style: bot.style || info.style };
      names[id] = name;
      players.push({ id, name, stack, isHuman: false });
    }
    const rng = PP.Cards && typeof PP.Cards.rng === 'function' ? PP.Cards.rng : undefined;
    const engine = new PP.Engine({ players, smallBlind: sb, bigBlind: bb, rng });
    gameCounter += 1;
    const g = {
      id: gameCounter, active: true, engine, bots, meta, names, stack, sb, bb,
      hand: null, lastRecord: null, lastReview: null, next: null, autoTimer: 0,
    };
    engine.actionProvider = (player, view, legal) => provideAction(g, player, view, legal);
    bindEngineEvents(g);
    return g;
  }

  /**
   * Tutorial hook (js/tutorial.js): a game with caller-supplied seats, decision makers and engine options.
   * custom = { players:[{id,name,stack,rating?,title?}], sb, bb, bots:{id:{decide,lastReasoning}}, engineOpts?, tutor? }
   * tutor = { coach?: bool, acceptHero?(action, view, legal) -> bool|Promise, onStart?(engine),
   *           onHandEnd?(record, engine) -> 'next'|'wait'|false (Promise ok), onEnd?() }
   */
  function createCustomGame(c) {
    const names = {};
    const meta = {};
    const players = c.players.map((p) => {
      const isHero = p.id === HERO_ID;
      names[p.id] = p.name;
      meta[p.id] = isHero ? { rating: 0 } : { rating: p.rating || 1, title: p.title || '', style: p.style || '' };
      return { id: p.id, name: p.name, stack: p.stack, isHuman: isHero };
    });
    const engine = new PP.Engine({ players, smallBlind: c.sb, bigBlind: c.bb, ...(c.engineOpts || {}) });
    gameCounter += 1;
    const g = {
      id: gameCounter, active: true, engine, bots: c.bots || {}, meta, names, stack: players[0].stack, sb: c.sb, bb: c.bb,
      hand: null, lastRecord: null, lastReview: null, next: null, autoTimer: 0, tutor: c.tutor || {},
    };
    engine.actionProvider = (player, view, legal) => provideAction(g, player, view, legal);
    bindEngineEvents(g);
    return g;
  }

  function coachEnabled() {
    const t = game && game.tutor;
    return t && typeof t.coach === 'boolean' ? t.coach : settings.coach;
  }

  function newHandState(view) {
    const hero = (view.players || []).find((p) => p.id === HERO_ID);
    return { decisions: [], reasonings: {}, heroFolded: !hero || hero.out, heroActed: false };
  }

  function coachOptions(extra) {
    return { enabled: coachEnabled(), guessMode: settings.guess && !(game && game.tutor), onGuess: recordGuess, ...(extra || {}) };
  }

  function recordGuess(guess, actual) {
    updateStats((s) => ({ ...s, guesses: { count: s.guesses.count + 1, totalError: s.guesses.totalError + Math.abs(guess - actual) } }));
  }

  function safeAdvise(view, legal) {
    try {
      return PP.Coach && typeof PP.Coach.advise === 'function' ? PP.Coach.advise(view, legal, HERO_ID) : null;
    } catch (err) {
      console.error('[coach] advise failed', err);
      return null;
    }
  }

  function liveGrade(advice, action) {
    if (!coachEnabled() || !advice || !PP.Coach || typeof PP.Coach.grade !== 'function') return;
    try {
      const g = PP.Coach.grade(advice, action);
      if (g && g.grade) UI.floatText(HERO_ID, g.grade, 'grade grade-' + g.grade.toLowerCase());
    } catch (err) {
      console.error('[coach] grade failed', err);
    }
  }

  async function heroAction(g, view, legal) {
    const advice = safeAdvise(view, legal);
    UI.renderCoach(advice, coachOptions());
    let action = await UI.requestHumanAction(view, legal);
    while (isLive(g) && g.tutor && g.tutor.acceptHero && !(await g.tutor.acceptHero(action, view, legal))) {
      action = await UI.requestHumanAction(view, legal);
    }
    if (!isLive(g)) return action;
    if (advice) g.hand.decisions.push({ advice, action });
    g.hand.heroActed = true;
    liveGrade(advice, action);
    UI.renderCoach(null, coachOptions({ title: 'NICE', message: 'Watching the table... advice returns on your next turn.' }));
    return action;
  }

  function recordReasoning(g, playerId, street, text) {
    if (!text) return;
    const list = g.hand.reasonings[playerId] || [];
    const label = street ? String(street).charAt(0).toUpperCase() + String(street).slice(1) + ': ' : '';
    g.hand.reasonings = { ...g.hand.reasonings, [playerId]: list.concat(label + text) };
  }

  async function botAction(g, player, view, legal) {
    const bot = g.bots[player.id];
    const factor = g.hand.heroFolded ? DELAY.foldedFactor : 1;
    const think = (DELAY.botThink + Math.random() * DELAY.thinkJitter) * factor;
    UI.setActionMode('waiting', nameOf(g, player.id) + ' is thinking...');
    UI.startTimer(player.id, think);
    await UI.wait(think);
    UI.stopTimers();
    if (!bot || !isLive(g)) return fallbackAction(legal);
    const me = (view.players || []).find((p) => p.id === player.id) || player;
    try {
      const action = bot.decide(view, legal, me);
      recordReasoning(g, player.id, view.street, bot.lastReasoning);
      return action || fallbackAction(legal);
    } catch (err) {
      console.error('[bots] decide failed for', player.id, err);
      return fallbackAction(legal);
    }
  }

  function provideAction(g, player, view, legal) {
    if (!isLive(g)) return Promise.resolve(fallbackAction(legal));
    if (player.id === HERO_ID || player.isHuman) return heroAction(g, view, legal);
    return botAction(g, player, view, legal);
  }

  // ---------------------------------------------------------- engine listeners
  function heroRead(view) {
    if (!settings.coach) return '';
    const hero = (view.players || []).find((p) => p.id === HERO_ID);
    if (!hero || !hero.hole || !hero.hole.length) return '';
    const board = view.board || [];
    try {
      if (board.length >= 3) return PP.Eval.evaluate(hero.hole.concat(board)).catName.toUpperCase();
      return PP.Equity.handLabel(hero.hole) + ' - ' + String(PP.Equity.preflopTier(hero.hole)).toUpperCase();
    } catch (err) {
      return '';
    }
  }

  function who(g, id) { return { t: nameOf(g, id), c: id === HERO_ID ? 'who hero' : 'who' }; }

  async function onHandStart(g, p) {
    const view = viewOf(g);
    g.hand = newHandState(view);
    UI.resetHand();
    UI.setText(UI.byId('tb-hand'), 'HAND #' + p.handNumber);
    UI.log('HAND #' + p.handNumber, 'sep');
    UI.renderView(view);
    UI.setHeroRead('');
    UI.setActionMode('waiting', 'Shuffling up...');
    UI.renderCoach(null, coachOptions({ title: 'NEW HAND', message: 'Cards are coming. Think about your position first.' }));
    await UI.wait(DELAY.handStart);
  }

  async function onBlinds(g, p) {
    (p.posts || []).forEach((post) => {
      const kind = String(post.kind || 'blind').toUpperCase();
      UI.showBubble(post.playerId, kind + ' ' + UI.money(post.amount), 'blind');
      UI.log([who(g, post.playerId), ' posts ' + kind + ' ' + UI.money(post.amount)], 'dim');
    });
    UI.renderView(viewOf(g));
    await UI.wait(DELAY.blinds);
  }

  async function onDeal(g) {
    const view = viewOf(g);
    await UI.dealHoles(view);
    UI.setHeroRead(heroRead(view));
    const hero = (view.players || []).find((pl) => pl.id === HERO_ID);
    if (hero && hero.hole) UI.log(['You hold ', { t: UI.cardsText(hero.hole), c: 'cards' }], 'info');
  }

  function onTurn(g, p) {
    UI.renderView(viewOf(g));
    if (p.playerId !== HERO_ID) UI.setActionMode('waiting', nameOf(g, p.playerId) + ' is thinking...');
  }

  async function onAction(g, p) {
    UI.stopTimers();
    UI.showAction(p.playerId, p.type, p.amount);
    UI.renderView(viewOf(g));
    const amt = p.type === 'fold' || p.type === 'check' ? '' : ' ' + UI.money(p.amount);
    UI.log([who(g, p.playerId), ' ' + (VERBS[p.type] || p.type) + amt], 'act act-' + p.type);
    if (p.playerId === HERO_ID && p.type === 'fold') g.hand.heroFolded = true;
    if (p.type === 'allin') {
      const big = (p.amount || 0) >= BIG_ALLIN_BB * g.bb;
      UI.setMood('danger');
      if (big) { UI.shake(); UI.stamp('ALL IN!', 'danger', p.playerId); }
    }
    await UI.wait(DELAY.action);
  }

  async function onStreet(g, p) {
    await UI.gatherBets();
    UI.clearBubbles();
    const view = viewOf(g);
    UI.renderView(view);
    UI.setHeroRead(heroRead(view));
    const board = p.board || view.board || [];
    UI.log([{ t: String(p.street || '').toUpperCase(), c: 'street' }, ' ', { t: UI.cardsText(board), c: 'cards' }], 'board');
    await UI.wait(DELAY.street + 150 * (p.street === 'flop' ? 3 : 1));
  }

  async function onShowdown(g, p) {
    await UI.gatherBets();
    UI.clearBubbles();
    (p.reveals || []).forEach((r) => {
      UI.revealHole(r.playerId, r.hole);
      const name = r.hand && (r.hand.catName || r.hand.desc);
      UI.showHandLabel(r.playerId, name ? String(name).toUpperCase() : '');
      UI.log([who(g, r.playerId), ' shows ', { t: UI.cardsText(r.hole), c: 'cards' }, r.hand ? ' - ' + r.hand.desc : ''], 'show');
    });
    UI.renderView(viewOf(g));
    await UI.wait(DELAY.showdown);
  }

  async function onPotAwarded(g, p) {
    await UI.gatherBets();
    const awards = p.awards || [];
    UI.celebrate(awards);
    UI.renderView(viewOf(g));
    awards.forEach((a) => {
      const how = a.hand ? ' with ' + a.hand.desc : '';
      UI.log([who(g, a.playerId), ' wins ' + UI.money(a.amount) + how], 'win');
      if (a.playerId === HERO_ID && a.amount > 0) {
        UI.setMood('win');
        if (a.amount >= BIG_WIN_BB * g.bb) UI.stamp('BIG POT!', 'win', a.playerId);
      }
    });
    await UI.wait(DELAY.award);
  }

  function bindEngineEvents(g) {
    const on = (name, fn) => g.engine.on(name, async (payload) => {
      if (!isLive(g)) return;
      try {
        await fn(g, payload || {});
      } catch (err) {
        console.error('[ui] ' + name + ' handler failed', err);
      }
    });
    on('handStart', onHandStart);
    on('blinds', onBlinds);
    on('deal', onDeal);
    on('turn', onTurn);
    on('action', onAction);
    on('street', onStreet);
    on('showdown', onShowdown);
    on('potAwarded', onPotAwarded);
  }

  // ---------------------------------------------------------------- game loop
  function buildReview(g, record) {
    if (!PP.Coach || typeof PP.Coach.reviewHand !== 'function') return null;
    try {
      return PP.Coach.reviewHand(record, HERO_ID, g.hand.decisions, g.hand.reasonings);
    } catch (err) {
      console.error('[coach] reviewHand failed', err);
      return null;
    }
  }

  function recordHandStats(record, review) {
    const hero = (record.players || []).find((p) => p.id === HERO_ID);
    if (!hero || !hero.hole || !hero.hole.length) return;
    const won = (record.awards || []).filter((a) => a.playerId === HERO_ID).reduce((sum, a) => sum + (a.amount || 0), 0);
    const atShowdown = !!record.showdown && (record.reveals || []).some((r) => r.playerId === HERO_ID);
    const grades = (review && review.heroDecisions) || [];
    updateStats((s) => ({
      ...s,
      hands: s.hands + 1,
      handsWon: s.handsWon + (won > 0 ? 1 : 0),
      net: s.net + ((hero.endStack || 0) - (hero.startStack || 0)),
      biggestPot: Math.max(s.biggestPot, won),
      showdowns: s.showdowns + (atShowdown ? 1 : 0),
      showdownsWon: s.showdownsWon + (atShowdown && won > 0 ? 1 : 0),
      grades: grades.reduce((acc, d) => (acc[d.grade] !== undefined ? { ...acc, [d.grade]: acc[d.grade] + 1 } : acc), s.grades),
    }));
  }

  function shouldAutoReview(g, review) {
    if (!review) return false;
    if (settings.reviewIdx === REVIEW_ALWAYS) return true;
    if (settings.reviewIdx !== REVIEW_IF_PLAYED) return false;
    return g.hand.decisions.some((d) => d.action && d.action.type !== 'fold');
  }

  function waitForNextHand(g) {
    return new Promise((resolve) => {
      g.next = () => {
        clearTimeout(g.autoTimer);
        g.next = null;
        resolve();
      };
      if (settings.autoDeal) {
        const ms = DELAY.handGap * SPEED_OPTIONS[settings.speedIdx].factor;
        g.autoTimer = setTimeout(() => g.next && g.next(), ms);
      }
    });
  }

  async function openLastReview(g) {
    if (!g || !g.lastReview) return;
    clearTimeout(g.autoTimer);
    await UI.showReview(g.lastReview, g.lastRecord, HERO_ID, [{ label: 'CLOSE', kind: 'blue', value: 'close', primary: true, kbd: 'SPACE' }]);
  }

  async function afterHand(g, record) {
    g.lastRecord = record;
    const review = buildReview(g, record);
    g.lastReview = review;
    recordHandStats(record, review);
    UI.stopTimers();
    UI.byId('btn-review').disabled = !review;
    const hero = (viewOf(g).players || []).find((p) => p.id === HERO_ID);
    const busted = hero && hero.stack <= 0;
    if (shouldAutoReview(g, review) && !busted) {
      UI.setActionMode('between', '');
      const choice = await UI.showReview(review, record, HERO_ID, [
        { label: 'BACK TO TABLE', kind: 'grey', value: 'table', kbd: 'ESC' },
        { label: 'NEXT HAND', kind: 'orange', value: 'next', primary: true, kbd: 'SPACE' },
      ]);
      if (choice !== 'table' || g.engine.isGameOver()) return;
      // Look at the final board and stacks, then deal when ready (or on AUTO-DEAL).
      UI.setActionMode('between', '');
      await waitForNextHand(g);
      return;
    }
    if (g.engine.isGameOver()) return;
    UI.setActionMode('between', '');
    await waitForNextHand(g);
  }

  async function handleGameOver(g) {
    const hero = (viewOf(g).players || []).find((p) => p.id === HERO_ID);
    const heroBusted = !hero || hero.stack <= 0;
    UI.setActionMode('between', '');
    if (heroBusted) {
      updateStats((s) => ({ ...s, busts: s.busts + 1 }));
      UI.setMood('danger');
      const body = UI.el('p', 'modal-text', 'You are out of chips. Rebuy for ' + UI.money(g.stack) + ' and keep training, or set up a new table.');
      const actions = [{ label: 'REBUY', kind: 'orange', value: 'rebuy', primary: true, kbd: 'SPACE' }];
      if (g.lastReview) actions.unshift({ label: 'REVIEW', kind: 'blue', value: 'review' });
      actions.push({ label: 'NEW TABLE', kind: 'grey', value: 'setup' });
      let choice = await UI.openModal({ title: 'BUSTED!', body, actions, className: 'modal-bust' });
      while (choice === 'review') {
        await openLastReview(g);
        choice = await UI.openModal({ title: 'BUSTED!', body, actions, className: 'modal-bust' });
      }
      if (!isLive(g)) return false;
      if (choice === 'rebuy') {
        g.engine.addChips(HERO_ID, g.stack);
        UI.renderView(viewOf(g));
        UI.log([who(g, HERO_ID), ' rebuys for ' + UI.money(g.stack)], 'win');
        return true;
      }
      endGame();
      openSetup();
      return false;
    }
    UI.setActionMode('waiting', 'TABLE WON!');
    UI.setMood('win');
    UI.stamp('CHAMPION!', 'win');
    await new Promise((resolve) => setTimeout(resolve, CHAMPION_PAUSE_MS));
    if (!isLive(g)) return false;
    const body = UI.el('p', 'modal-text', 'You took every chip at the table. Ready for tougher opponents?');
    const choice = await UI.openModal({
      title: 'YOU WIN THE TABLE!', body, className: 'modal-win',
      actions: [{ label: 'PLAY AGAIN', kind: 'orange', value: 'again', primary: true, kbd: 'SPACE' }, { label: 'NEW TABLE', kind: 'grey', value: 'setup' }],
    });
    endGame();
    if (choice === 'again') startGame();
    else openSetup();
    return false;
  }

  async function reportCrash(err) {
    console.error('[game] hand crashed', err);
    UI.log('Something went wrong: ' + (err && err.message ? err.message : err), 'warn');
    await UI.openModal({
      title: 'TABLE MALFUNCTION',
      body: UI.el('p', 'modal-text', 'The dealer dropped the deck: ' + (err && err.message ? err.message : 'unknown error') + '.'),
      actions: [{ label: 'BACK TO MENU', kind: 'orange', value: 'menu', primary: true }],
    });
  }

  async function runGame(g) {
    while (isLive(g)) {
      let record;
      try {
        record = await g.engine.playHand();
      } catch (err) {
        if (!isLive(g)) return;
        await reportCrash(err);
        endGame();
        UI.showScreen('title');
        return;
      }
      if (!isLive(g)) return;
      if (g.tutor && g.tutor.onHandEnd) {
        const more = await g.tutor.onHandEnd(record || {}, g.engine);
        if (!isLive(g) || !more) return;
        if (more === 'wait') { UI.setActionMode('between', ''); await waitForNextHand(g); }
        continue;
      }
      await afterHand(g, record || {});
      if (!isLive(g)) return;
      if (g.engine.isGameOver() && !(await handleGameOver(g))) return;
    }
  }

  function startGame(custom) {
    const c = custom && Array.isArray(custom.players) ? custom : null;
    const missing = missingModules();
    if (missing.length) { showMissing(missing); return null; }
    endGame();
    ensureNames();
    persist();
    UI.setSpeed(SPEED_OPTIONS[settings.speedIdx].factor);
    let g;
    try {
      g = createGame(c);
    } catch (err) {
      reportCrash(err);
      return null;
    }
    game = g;
    UI.showScreen('table');
    UI.clearLog();
    UI.buildTable(g.engine.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, stack: p.stack })), HERO_ID, g.meta);
    UI.byId('tb-blinds').textContent = 'BLINDS ' + g.sb + '/' + g.bb;
    UI.byId('tb-hand').textContent = 'HAND #0';
    UI.renderCoach(null, coachOptions());
    syncTopbar();
    UI.log('Welcome to the table. Good luck!', 'sep');
    if (g.tutor && g.tutor.onStart) g.tutor.onStart(g.engine);
    runGame(g);
    return g;
  }

  function endGame() {
    const g = game;
    if (!g) return;
    g.active = false;
    game = null;
    clearTimeout(g.autoTimer);
    if (UI.isAwaitingHuman()) UI.cancelHumanAction();
    if (g.next) g.next();
    UI.setMood('calm');
    if (g.tutor && g.tutor.onEnd) g.tutor.onEnd();
  }

  async function leaveTable() {
    if (!game) { UI.showScreen('title'); return; }
    const choice = await UI.openModal({
      title: 'LEAVE TABLE?',
      body: UI.el('p', 'modal-text', 'Your current game will end. Stats so far are saved.'),
      actions: [{ label: 'STAY', kind: 'blue', value: 'stay', primary: true }, { label: 'LEAVE', kind: 'red', value: 'leave' }],
      cancelValue: 'stay',
    });
    if (choice !== 'leave') return;
    endGame();
    UI.showScreen('title');
  }

  // -------------------------------------------------------------------- topbar
  function setToggle(id, on, label) {
    const b = UI.byId(id);
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (label) b.querySelector('.btn-label').textContent = label;
  }

  function syncTopbar() {
    setToggle('tb-coach', settings.coach, 'COACH ' + (settings.coach ? 'ON' : 'OFF'));
    setToggle('tb-guess', settings.guess, 'GUESS ' + (settings.guess ? 'ON' : 'OFF'));
    setToggle('tb-review', settings.reviewIdx !== 2, 'REVIEW: ' + REVIEW_OPTIONS[settings.reviewIdx]);
    setToggle('tb-autodeal', settings.autoDeal, 'AUTO-DEAL ' + (settings.autoDeal ? 'ON' : 'OFF'));
    setToggle('tb-speed', true, SPEED_OPTIONS[settings.speedIdx].label);
  }

  function bindTopbar() {
    const bind = (id, fn) => UI.byId(id).addEventListener('click', () => { fn(); syncTopbar(); });
    UI.byId('tb-menu').addEventListener('click', leaveTable);
    bind('tb-coach', () => {
      setSettings({ coach: !settings.coach });
      UI.renderCoach(null, coachOptions());
      if (game) UI.setHeroRead(heroRead(viewOf(game)));
    });
    bind('tb-guess', () => setSettings({ guess: !settings.guess }));
    bind('tb-review', () => setSettings({ reviewIdx: (settings.reviewIdx + 1) % REVIEW_OPTIONS.length }));
    bind('tb-autodeal', () => {
      setSettings({ autoDeal: !settings.autoDeal });
      if (settings.autoDeal && game && game.next) game.next();
    });
    bind('tb-speed', () => setSettings({ speedIdx: (settings.speedIdx + 1) % SPEED_OPTIONS.length }));
    UI.byId('btn-next').addEventListener('click', () => { if (game && game.next) game.next(); });
    UI.byId('btn-review').addEventListener('click', () => openLastReview(game));
  }

  // -------------------------------------------------------------------- drills
  const drill = { kind: 'mixed', q: null, picked: null, streak: 0, correct: 0, total: 0 };

  function drillRng() { return PP.Cards && typeof PP.Cards.rng === 'function' ? PP.Cards.rng : Math.random; }

  function renderDrillTabs() {
    const root = UI.clear(UI.byId('drill-tabs'));
    root.appendChild(segmented(DRILL_KINDS.map((k) => k.label), DRILL_KINDS.findIndex((k) => k.id === drill.kind), (i) => {
      drill.kind = DRILL_KINDS[i].id;
      renderDrillTabs();
      nextDrill();
    }));
  }

  function renderDrillScore() {
    const root = UI.clear(UI.byId('drill-score'));
    const acc = drill.total ? Math.round((drill.correct / drill.total) * 100) + '%' : '--';
    [['STREAK', drill.streak], ['SCORE', drill.correct + '/' + drill.total], ['ACCURACY', acc], ['BEST', stats.bestStreak]].forEach(([k, v]) => {
      const tile = UI.el('div', 'score-tile');
      tile.append(UI.el('span', 'score-k', k), UI.el('span', 'score-v', v));
      root.appendChild(tile);
    });
  }

  function drillCards(q) {
    const box = UI.el('div', 'drill-cards');
    const cards = q.cards;
    if (!cards) return box;
    if (cards.board && cards.board.length) {
      const g = UI.el('div', 'drill-group board-group');
      g.append(UI.el('span', 'drill-label', 'BOARD'), UI.miniCards(cards.board, 'big'));
      box.appendChild(g);
    }
    (cards.hands || []).forEach((h) => {
      const g = UI.el('div', 'drill-group');
      g.append(UI.el('span', 'drill-label', String(h.label || '').toUpperCase()), UI.miniCards(h.hole, 'big'));
      box.appendChild(g);
    });
    return box;
  }

  function drillChoices(q) {
    const grid = UI.el('div', 'drill-choices');
    q.choices.forEach((choice, i) => {
      let kind = 'grey';
      if (drill.picked !== null) kind = i === q.answer ? 'green' : i === drill.picked ? 'red' : 'grey';
      const b = UI.button(choice, kind, { kbd: String(i + 1) });
      b.disabled = drill.picked !== null && i !== q.answer && i !== drill.picked;
      b.addEventListener('click', () => answerDrill(i));
      grid.appendChild(b);
    });
    return grid;
  }

  function drillFeedback(q) {
    const right = drill.picked === q.answer;
    const box = UI.el('div', 'drill-feedback ' + (right ? 'right' : 'wrong'));
    box.append(UI.el('div', 'drill-verdict', right ? 'CORRECT!' : 'NOT QUITE'), UI.el('p', null, q.explanation || ''));
    box.appendChild(UI.button('NEXT', 'orange', { kbd: 'SPACE', onClick: nextDrill }));
    return box;
  }

  function renderDrill() {
    renderDrillScore();
    const root = UI.clear(UI.byId('drill-body'));
    const q = drill.q;
    if (!q) {
      root.appendChild(UI.el('p', 'muted', 'Drills need the coach module. Make sure js/coach.js loaded.'));
      return;
    }
    root.append(UI.el('h2', 'drill-prompt', q.prompt), drillCards(q), drillChoices(q));
    if (drill.picked !== null) root.appendChild(drillFeedback(q));
  }

  function nextDrill() {
    const Drills = PP.Coach && PP.Coach.Drills;
    drill.picked = null;
    drill.q = null;
    if (Drills && typeof Drills.makeQuestion === 'function') {
      const kinds = DRILL_KINDS.slice(1).map((k) => k.id);
      const kind = drill.kind === 'mixed' ? kinds[Math.floor(Math.random() * kinds.length)] : drill.kind;
      try {
        drill.q = Drills.makeQuestion(kind, drillRng());
      } catch (err) {
        console.error('[drills] makeQuestion failed', err);
      }
    }
    renderDrill();
  }

  function answerDrill(i) {
    const q = drill.q;
    if (!q || drill.picked !== null || i < 0 || i >= q.choices.length) return;
    drill.picked = i;
    const right = i === q.answer;
    drill.total += 1;
    drill.correct += right ? 1 : 0;
    drill.streak = right ? drill.streak + 1 : 0;
    const kind = q.kind;
    updateStats((s) => {
      const prev = s.drills[kind] || { correct: 0, total: 0 };
      return {
        ...s,
        bestStreak: Math.max(s.bestStreak, drill.streak),
        drills: { ...s.drills, [kind]: { correct: prev.correct + (right ? 1 : 0), total: prev.total + 1 } },
      };
    });
    renderDrill();
  }

  function openDrills() {
    drill.streak = 0; drill.correct = 0; drill.total = 0;
    renderDrillTabs();
    nextDrill();
    UI.showScreen('drills');
  }

  // --------------------------------------------------------------------- stats
  function statTile(label, value, cls) {
    const tile = UI.el('div', 'stat-tile' + (cls ? ' ' + cls : ''));
    tile.append(UI.el('span', 'stat-v', value), UI.el('span', 'stat-k', label));
    return tile;
  }

  function barRow(label, count, total, cls, valueText) {
    const row = UI.el('div', 'bar-row');
    const pct = total ? Math.round((count / total) * 100) : 0;
    const bar = UI.el('div', 'bar');
    const fill = UI.el('i', 'bar-fill ' + (cls || ''));
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.append(UI.el('span', 'bar-k', label), bar, UI.el('span', 'bar-v', (valueText || count) + ' (' + pct + '%)'));
    return row;
  }

  function pctText(a, b) { return b ? Math.round((a / b) * 100) + '%' : '--'; }

  function renderStats() {
    const s = stats;
    const root = UI.clear(UI.byId('stats-body'));
    const tiles = UI.el('div', 'stat-tiles');
    tiles.append(
      statTile('HANDS PLAYED', s.hands),
      statTile('HANDS WON', s.handsWon + ' / ' + pctText(s.handsWon, s.hands)),
      statTile('NET CHIPS', UI.money(s.net), s.net >= 0 ? 'pos' : 'neg'),
      statTile('BIGGEST POT', UI.money(s.biggestPot)),
      statTile('SHOWDOWNS WON', pctText(s.showdownsWon, s.showdowns)),
      statTile('EQUITY GUESS ERROR', s.guesses.count ? '±' + Math.round(s.guesses.totalError / s.guesses.count) + '%' : '--'),
    );
    root.appendChild(tiles);
    const cols = UI.el('div', 'stat-cols');
    const decisions = UI.el('div', 'panel stat-panel');
    decisions.appendChild(UI.el('h3', 'section-title', 'DECISION QUALITY'));
    const totalGrades = GRADES.reduce((sum, g) => sum + (s.grades[g] || 0), 0);
    GRADES.forEach((g) => decisions.appendChild(barRow(g, s.grades[g] || 0, totalGrades, 'grade-' + g.toLowerCase())));
    if (!totalGrades) decisions.appendChild(UI.el('p', 'muted', 'Play hands with the coach on to get graded.'));
    const drills = UI.el('div', 'panel stat-panel');
    drills.appendChild(UI.el('h3', 'section-title', 'DRILL ACCURACY'));
    DRILL_KINDS.slice(1).forEach((k) => {
      const d = s.drills[k.id] || { correct: 0, total: 0 };
      drills.appendChild(barRow(k.label, d.correct, d.total, 'grade-good', d.correct + '/' + d.total));
    });
    drills.appendChild(UI.el('p', 'muted', 'Best drill streak: ' + s.bestStreak + '  |  Busts: ' + s.busts));
    cols.append(decisions, drills);
    root.appendChild(cols);
  }

  function openStats() {
    renderStats();
    UI.showScreen('stats');
  }

  async function resetStats() {
    const choice = await UI.openModal({
      title: 'RESET STATS?',
      body: UI.el('p', 'modal-text', 'This wipes hands, grades and drill history. It cannot be undone.'),
      actions: [{ label: 'KEEP', kind: 'blue', value: 'keep', primary: true }, { label: 'RESET', kind: 'red', value: 'reset' }],
      cancelValue: 'keep',
    });
    if (choice !== 'reset') return;
    stats = emptyStats();
    persist();
    renderStats();
  }

  // ------------------------------------------------------------------ keyboard
  const TABLE_KEYS = { f: 'fold', c: 'call', r: 'raise', a: 'allin' };

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    return t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox';
  }

  function onTableKey(e, key) {
    if (TABLE_KEYS[key]) { if (UI.triggerAction(TABLE_KEYS[key])) e.preventDefault(); return; }
    if (key === ' ' || key === 'enter') {
      if (game && game.next) { e.preventDefault(); game.next(); }
      return;
    }
    if (key === 'arrowup' || key === 'arrowright') { if (UI.isAwaitingHuman()) { e.preventDefault(); UI.adjustRaise(1); } return; }
    if (key === 'arrowdown' || key === 'arrowleft') { if (UI.isAwaitingHuman()) { e.preventDefault(); UI.adjustRaise(-1); } return; }
    if (key === 'escape') leaveTable();
  }

  function onDrillKey(e, key) {
    const n = Number(key);
    if (n >= 1 && n <= 9 && drill.picked === null) { e.preventDefault(); answerDrill(n - 1); return; }
    if ((key === ' ' || key === 'enter') && drill.picked !== null) { e.preventDefault(); nextDrill(); return; }
    if (key === 'escape') UI.showScreen('title');
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    if (UI.isModalOpen()) {
      if (key === ' ' || key === 'enter') { e.preventDefault(); UI.modalPrimary(); }
      else if (key === 'escape') { e.preventDefault(); UI.modalCancel(); }
      return;
    }
    const screen = UI.currentScreen();
    if (screen === 'table') onTableKey(e, key);
    else if (screen === 'drills') onDrillKey(e, key);
    else if (screen === 'title' && (key === ' ' || key === 'enter')) { e.preventDefault(); openSetup(); }
    else if ((screen === 'setup' || screen === 'stats') && key === 'escape') UI.showScreen('title');
    else if (screen === 'setup' && key === 'enter') { e.preventDefault(); startGame(); }
  }

  // ---------------------------------------------------------------------- boot
  function showMissing(missing) {
    UI.openModal({
      title: 'MISSING PIECES',
      body: UI.el('p', 'modal-text', 'These game modules did not load: ' + missing.join(', ') + '. Check the js/ folder.'),
      actions: [{ label: 'OK', kind: 'orange', value: 'ok', primary: true }],
    });
  }

  function decorateTitle() {
    const deco = UI.byId('title-cards');
    if (!deco || !PP.Cards || typeof PP.Cards.parse !== 'function') return;
    UI.clear(deco);
    ['As', 'Kh', 'Ad'].forEach((code, i) => {
      try {
        const node = UI.cardNode(PP.Cards.parse(code), { deal: { x: 0, y: -220, delay: 200 + i * 160 } });
        node.classList.add('title-card', 'tc-' + i);
        deco.appendChild(node);
      } catch (err) {
        // decorative only
      }
    });
  }

  function bindNav() {
    const on = (id, fn) => { const n = UI.byId(id); if (n) n.addEventListener('click', fn); };
    on('nav-play', openSetup);
    on('nav-drills', openDrills);
    on('nav-stats', openStats);
    on('setup-back', () => UI.showScreen('title'));
    on('setup-start', startGame);
    on('drills-back', () => UI.showScreen('title'));
    on('stats-back', () => UI.showScreen('title'));
    on('stats-reset', resetStats);
    document.addEventListener('keydown', onKeyDown);
  }

  function boot() {
    if (!UI) return;
    UI.init();
    UI.setSpeed(SPEED_OPTIONS[settings.speedIdx].factor);
    bindNav();
    bindTopbar();
    decorateTitle();
    const missing = missingModules();
    const warn = UI.byId('title-warning');
    if (warn && missing.length) { warn.textContent = 'Missing modules: ' + missing.join(', '); warn.hidden = false; }
    UI.showScreen('title');
  }

  // Hooks for js/tutorial.js: run a scripted or custom table, and leave it.
  PP.App = Object.freeze({
    HERO_ID,
    startCustomGame: (custom) => startGame(custom),
    endGame,
    isPlaying: () => !!game,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
