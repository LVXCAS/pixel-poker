/* Regression: a client whose connection drops MID-HAND and reconnects (same seat; host resends
 * start + sync) must see the CURRENT hand at once: its own hole cards, the current board, the right
 * player to act, and never anyone else's hole cards. Before the fix the client table was rebuilt on
 * `start` (hand state reset) and the `sync` snapshot could not restore the dealt hole cards, so the
 * client sat on a board with no cards until the next hand.
 *
 * Test 1 covers the wire (HostRoom -> ClientRoom -> RemoteEngine). Test 2 drives the real js/ui.js +
 * js/main.js render path (startNetGame) against a minimal fake DOM. */
(function () {
  const t = (name, fn) => TESTS.push({ name: 'mp-rejoin: ' + name, fn });
  const Net = PP.Net;
  const Room = PP.Room;
  const CODE = 'RJN42';
  const realTick = () => new Promise((r) => setTimeout(r, 1));

  async function makeEnv() {
    const clock = Net.createManualClock();
    const hub = Net.Loopback.createHub({ clock });
    const ep = await Net.createHost({ hub, clock, code: CODE });
    const room = new Room.HostRoom({
      endpoint: ep, hostName: 'host', hostAvatar: 'a3', clock,
      settings: { turnSeconds: 0, coachAllowed: false }, rng: PP.Cards.seededRng(5), handGapMs: 0,
    });
    const env = { clock, hub, ep, room, held: null };
    env.join = (name) => Room.joinRoom({ code: CODE, name, avatar: 'a1', hub, clock });
    env.pump = async (extra) => {
      await hub.flush();
      if (extra) extra();
      await realTick();
    };
    env.until = async (cond, label, extra) => {
      for (let i = 0; i < 600; i++) {
        if (cond()) return;
        await env.pump(extra);
      }
      throw new Error('condition never met: ' + label);
    };
    return env;
  }

  const passive = (legal) => (legal.canCheck ? { type: 'check' } : { type: 'call' });

  /** Host checks/calls, except it HOLDS its first decision on the flop (the hand stays mid-flop). */
  function holdHostOnFlop(env) {
    env.room.setLocalActionProvider((player, view, legal) => {
      if (view.street !== 'flop' || env.released) return Promise.resolve(passive(legal));
      return new Promise((resolve) => {
        env.held = () => resolve(passive(legal));
      });
    });
  }

  function walk(v, fn) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
    else if (v && typeof v === 'object') {
      fn(v);
      Object.keys(v).forEach((k) => walk(v[k], fn));
    }
  }

  /** Every hole card a peer saw must be its own seat's or revealed at this hand's showdown. */
  function assertNoLeak(env, peerId, seatId) {
    let revealed = new Set();
    env.hub.log.filter((e) => e.to === peerId).map((e) => e.msg).forEach((msg) => {
      if (msg.t === 'ev' && msg.name === 'handStart') revealed = new Set();
      if (msg.t === 'ev' && msg.name === 'showdown') msg.payload.reveals.forEach((r) => revealed.add(r.playerId));
      walk(msg, (obj) => {
        if (!Array.isArray(obj.hole) || obj.hole.length === 0) return;
        const owner = obj.id !== undefined ? obj.id : obj.playerId;
        if (owner !== seatId) assert.ok(revealed.has(owner), 'LEAK in ' + msg.t + '/' + (msg.name || '') + ' of ' + owner);
      });
    });
  }

  async function dropAndReconnect(env, client) {
    env.hub.drop(client.endpoint.peerId);
    await env.hub.flush();
    assert.equal(env.room.seat(client.selfId).conn, 'offline');
    await env.clock.advance(1000);
    await env.until(() => env.room.seat(client.selfId).conn === 'online', 'seat back online');
  }

  t('wire: after a mid-flop drop the resync carries own hole cards, current board, to-act; no foreign cards', async () => {
    const env = await makeEnv();
    const ann = await env.join('ann');
    const bob = await env.join('bob');
    const syncs = [];
    let annTurns = 0;
    [ann, bob].forEach((c) => c.on('start', (spec) => {
      spec.engine.actionProvider = (p, v, legal) => {
        if (c === ann) annTurns += 1;
        return passive(legal);
      };
      if (c === ann) spec.engine.on('sync', (p) => syncs.push(p.view));
    }));
    holdHostOnFlop(env);
    env.room.start();
    env.room.run();
    await env.until(() => env.held, 'host holding on the flop');
    const hand = env.room.engine.handNumber;
    const board = env.room.engine.publicView('hero').board;
    assert.equal(board.length, 3);
    const annHole = env.room.engine.players.find((p) => p.id === ann.selfId).hole;
    const annWire = ann.selfId;
    const syncsBefore = syncs.length;

    await dropAndReconnect(env, ann);
    await env.until(() => syncs.length > syncsBefore, 'sync after reconnect');
    const v = syncs[syncs.length - 1];
    assert.equal(ann.selfId, annWire, 'same seat after reconnect');
    assert.equal(v.handNumber, hand);
    assert.equal(v.street, 'flop');
    assert.deepEqual(v.board, board, 'current board');
    const me = v.players.find((p) => p.id === 'hero');
    assert.deepEqual(me.hole, annHole, 'own hole cards in the resync');
    v.players.filter((p) => p.id !== 'hero').forEach((p) => assert.equal(p.hole, null, 'foreign hole of ' + p.id));
    assert.equal(v.toActId, annWire, 'the host (aliased to ann\'s wire id) is to act');
    assert.equal(ann.engine.publicView().handNumber, hand);
    assert.ok(ann.engine.inHand);

    const turnsBefore = annTurns;
    env.released = true;
    env.held();
    await env.until(() => env.room.engine.handNumber > hand, 'hand finishes after the reconnect');
    assert.ok(annTurns > turnsBefore || ann.engine.publicView().handNumber > hand, 'ann keeps playing');
    assertNoLeak(env, ann.endpoint.peerId, annWire);
    assertNoLeak(env, bob.endpoint.peerId, bob.selfId);
    env.room.endGame();
    await env.hub.flush();
    env.room.close();
    ann.close();
    bob.close();
  });

  /* ------------------------------------------------------------ fake DOM */

  function makeFakeDom() {
    class Node {
      constructor(tag) {
        this.tagName = tag ? String(tag).toUpperCase() : '#text';
        this.nodeType = tag ? 1 : 3;
        this.childNodes = [];
        this.parentNode = null;
        this.className = '';
        this.dataset = {};
        this.attrs = {};
        this.text = '';
        this.listeners = {};
        const props = {};
        this.style = {
          setProperty: (k, val) => { props[k] = val; },
          removeProperty: (k) => { delete props[k]; },
          getPropertyValue: (k) => props[k] || '',
        };
        const self = this;
        this.classList = {
          list: () => self.className.split(/\s+/).filter(Boolean),
          contains: (c) => self.classList.list().includes(c),
          add: (...cs) => { const l = self.classList.list(); cs.forEach((c) => { if (!l.includes(c)) l.push(c); }); self.className = l.join(' '); },
          remove: (...cs) => { self.className = self.classList.list().filter((c) => !cs.includes(c)).join(' '); },
          toggle: (c, force) => {
            const on = force === undefined ? !self.classList.contains(c) : !!force;
            if (on) self.classList.add(c); else self.classList.remove(c);
            return on;
          },
        };
      }
      get id() { return this.attrs.id || ''; }
      set id(v) { this.attrs.id = String(v); }
      get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
      get firstChild() { return this.childNodes[0] || null; }
      get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map((n) => n.textContent).join(''); }
      set textContent(v) {
        if (this.nodeType === 3) { this.text = String(v); return; }
        this.replaceChildren();
        if (v !== '' && v != null) this.appendChild(new Node(null)).text = String(v);
      }
      appendChild(n) {
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes.push(n);
        return n;
      }
      append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'string' ? Object.assign(new Node(null), { text: n }) : n)); }
      insertBefore(n, ref) {
        if (!ref) return this.appendChild(n);
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
        return n;
      }
      removeChild(n) {
        const i = this.childNodes.indexOf(n);
        if (i >= 0) this.childNodes.splice(i, 1);
        n.parentNode = null;
        return n;
      }
      remove() { if (this.parentNode) this.parentNode.removeChild(this); }
      replaceChildren(...ns) {
        this.childNodes.slice().forEach((n) => this.removeChild(n));
        this.append(...ns);
      }
      closest(sel) {
        const c = parseCompound(sel);
        for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, c)) return x;
        return null;
      }
      contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
      setAttribute(k, v) { this.attrs[k] = String(v); }
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
      removeAttribute(k) { delete this.attrs[k]; }
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
      removeEventListener() {}
      focus() {}
      blur() {}
      getContext() { return null; }
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
      get offsetWidth() { return 0; }
      get scrollHeight() { return 0; }
      descendants() { return this.children.flatMap((c) => [c].concat(c.descendants())); }
      querySelectorAll(sel) { return querySelectorAll(this, sel); }
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    }

    /** Descendant selectors of compounds: tag#id.class.class:not(.class) — enough for ui.js. */
    function parseCompound(src) {
      const not = [];
      const body = src.replace(/:not\(([^)]*)\)/g, (m, inner) => { not.push(parseCompound(inner)); return ''; });
      const m = /^([a-z0-9]*)/i.exec(body);
      return { tag: m[1] ? m[1].toUpperCase() : null, id: (/#([\w-]+)/.exec(body) || [])[1] || null,
        classes: (body.match(/\.[\w-]+/g) || []).map((c) => c.slice(1)), not };
    }
    function matches(n, c) {
      if (c.tag && n.tagName !== c.tag) return false;
      if (c.id && n.id !== c.id) return false;
      if (!c.classes.every((k) => n.classList.contains(k))) return false;
      return !c.not.some((x) => matches(n, x));
    }
    function querySelectorAll(root, sel) {
      return String(sel).split(',').flatMap((one) => {
        const parts = one.trim().split(/\s+/).map(parseCompound);
        return root.descendants().filter((n) => {
          if (!matches(n, parts[parts.length - 1])) return false;
          let i = parts.length - 2;
          for (let x = n.parentNode; x && i >= 0; x = x.parentNode) if (x !== root.parentNode && x.nodeType === 1 && matches(x, parts[i])) i -= 1;
          return i < 0;
        });
      });
    }

    const html = new Node('html');
    const body = new Node('body');
    html.appendChild(body);
    const doc = {
      readyState: 'loading', hidden: false, activeElement: null, documentElement: html, body,
      createElement: (tag) => new Node(tag),
      createElementNS: (ns, tag) => new Node(tag),
      createTextNode: (text) => Object.assign(new Node(null), { text: String(text) }),
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: (sel) => querySelectorAll(html, sel),
      querySelector: (sel) => querySelectorAll(html, sel)[0] || null,
      getElementById(id) {
        const found = html.descendants().find((n) => n.id === id);
        if (found) return found;
        const n = new Node('div');
        n.id = id;
        body.appendChild(n);
        return n;
      },
    };
    // Structure ui.js / main.js expect to exist (not lazily creatable): the board slots, topbar labels.
    const board = doc.getElementById('board');
    for (let i = 0; i < 5; i++) board.appendChild(Object.assign(new Node('div'), { className: 'board-slot' }));
    ['tb-coach', 'tb-guess', 'tb-review', 'tb-autodeal', 'tb-speed'].forEach((id) => {
      doc.getElementById(id).appendChild(Object.assign(new Node('span'), { className: 'btn-label' }));
    });
    return doc;
  }

  /** PP.Art stand-in: every drawing call returns a blank canvas; only CHIP_W is numeric. */
  function fakeArt(doc) {
    return new Proxy({}, {
      get: (target, key) => (key === 'CHIP_W' ? 14 : key === 'SLIP' ? { w: 40, base: 100 } : () => doc.createElement('canvas')),
    });
  }

  const GLOBALS = ['document', 'window', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
    'innerWidth', 'innerHeight', 'localStorage'];

  async function withFakeUi(fn) {
    const saved = {};
    GLOBALS.forEach((k) => { saved[k] = Object.prototype.hasOwnProperty.call(globalThis, k) ? globalThis[k] : undefined; });
    const savedPP = { UI: PP.UI, App: PP.App, Art: PP.Art };
    const doc = makeFakeDom();
    Object.assign(globalThis, {
      document: doc, window: globalThis, innerWidth: 1280, innerHeight: 860, localStorage: undefined,
      matchMedia: () => ({ matches: true }),   // reduced motion: no card animations
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    });
    PP.Art = fakeArt(doc);
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
    try {
      loadScript('ui.js');
      loadScript('main.js');
      PP.UI.setSpeed(0.001);
      await fn(doc, errors);
    } finally {
      try { if (PP.App) PP.App.endNetGame(); } catch (e) { /* torn down */ }
      for (let i = 0; i < 20; i++) await realTick();
      console.error = origError;
      Object.assign(PP, savedPP);
      GLOBALS.forEach((k) => { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; });
    }
  }

  const cardKey = (c) => PP.UI.cardKey(c);
  function tableState(doc) {
    const keys = (root) => root.querySelectorAll('.card').map((c) => (c.classList.contains('face') ? c.dataset.card : 'back'));
    const seats = doc.querySelectorAll('.seat');
    const hero = seats.find((s) => s.classList.contains('hero'));
    return {
      hand: doc.getElementById('tb-hand').textContent,
      hole: hero ? keys(hero.querySelector('.seat-cards')) : [],
      board: keys(doc.getElementById('board')),
      others: seats.filter((s) => s !== hero).map((s) => ({ id: s.dataset.id, cards: keys(s.querySelector('.seat-cards')) })),
      acting: seats.filter((s) => s.classList.contains('acting')).map((s) => s.dataset.id),
      mode: doc.getElementById('action-bar').dataset.mode,
    };
  }

  t('ui: after a mid-flop reconnect the client table shows own hole cards, current board, to-act; others face down', async () => {
    await withFakeUi(async (doc, errors) => {
      const env = await makeEnv();
      const ann = await env.join('ann');
      const bob = await env.join('bob');
      let starts = 0;
      ann.on('start', (spec) => { starts += 1; PP.App.startNetGame(spec); });   // what the Lobby does
      bob.on('start', (spec) => { spec.engine.actionProvider = (p, v, legal) => passive(legal); });
      const answerAnn = () => { if (PP.UI.isAwaitingHuman()) PP.UI.triggerAction('call'); };
      holdHostOnFlop(env);
      env.room.start();
      env.room.run();
      await env.until(() => env.held && tableState(doc).board.length === 3 && ann.engine.queue.length === 0
        && !ann.engine.processing, 'host holding on the flop, ann idle', answerAnn);
      const hand = env.room.engine.handNumber;
      const annHole = env.room.engine.players.find((p) => p.id === ann.selfId).hole.map(cardKey);
      const board = env.room.engine.publicView('hero').board.map(cardKey);
      const live = env.room.engine.players.filter((p) => !p.folded && !p.out).map((p) => ann.engine.toLocalId(p.id));
      const before = tableState(doc);
      assert.deepEqual(before.hole, annHole, 'sanity: hole cards shown before the drop');
      assert.deepEqual(before.board, board);

      await dropAndReconnect(env, ann);
      await env.until(() => starts === 2 && ann.engine.queue.length === 0 && !ann.engine.processing
        && ann.engine.publicView().handNumber === hand, 'client resynced');
      await env.pump();
      const after = tableState(doc);
      assert.equal(after.hand, 'HAND #' + hand, 'hand number restored');
      assert.deepEqual(after.hole, annHole, 'own hole cards shown face up after the reconnect');
      assert.deepEqual(after.board, board, 'current board shown');
      after.others.forEach((o) => {
        assert.ok(o.cards.every((c) => c === 'back'), 'opponent ' + o.id + ' cards stay face down: ' + o.cards);
        assert.equal(o.cards.length, live.includes(o.id) ? 2 : 0, 'opponent ' + o.id + ' card backs');
      });
      assert.deepEqual(after.acting, [ann.engine.toLocalId('hero')], 'the host seat is marked to act');
      assert.notEqual(after.mode, 'hero', 'not our turn');

      // The hand carries on: when the action reaches ann, the action bar asks her.
      env.released = true;
      env.held();
      let asked = false;
      await env.until(() => asked || env.room.engine.handNumber > hand, 'hand continues', () => {
        if (PP.UI.isAwaitingHuman()) { asked = true; assert.deepEqual(tableState(doc).hole, annHole); }
        answerAnn();
      });
      assert.deepEqual(errors, [], 'no render errors');
      env.room.endGame();
      await env.hub.flush();
      env.room.close();
      ann.close();
      bob.close();
    });
  });
})();
