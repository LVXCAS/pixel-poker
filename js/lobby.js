/* PIXEL HOLD'EM — PP.Lobby: multiplayer screens (hub, join, host/waiting lobby, errors) and the in-game
 * overlay (level bar, players, chat + emotes, toasts, podium). See MULTIPLAYER.md section 7.
 * Classic script, attaches PP.Lobby. Touches the DOM only inside mount(). All peer-provided text is set with
 * textContent (via UI.el / setText); nothing here parses HTML. Play chips only — no money, ever.
 * One file by contract (index.html loads a single lobby script); sections: helpers, storage, screens, flows,
 * overlay, podium, mount. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});

  // ------------------------------------------------------------------ constants
  const STORE_KEY = 'pixelholdem.mp.v1';
  const REJOIN_MAX_MS = 6 * 60 * 60 * 1000;
  const HISTORY_MAX = 20;
  const AVATAR_SEEDS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const NAME_MAX = 12;
  const CHAT_MAX = 140;
  const CHAT_LINES = 50;
  const TOAST_MS = 3000;
  const COPY_FLASH_MS = 1600;
  const ARM_MS = 3000;
  const EMOTE_COOLDOWN_MS = 2000;
  const CONNECTING_AFTER_MS = 1400;
  const OFFLINE_BOTS = [2, 3, 3, 4, 5];
  // Connection setting (PP.Net transport): auto = direct first + relay backup, direct = PeerJS only,
  // relay = the WebSocket relay only (school wi-fi that blocks peer-to-peer).
  const TRANSPORTS = ['auto', 'direct', 'relay'];
  const TRANSPORT_NOTE = { auto: 'direct + relay backup', direct: 'peer-to-peer only', relay: 'relay only' };
  const EMOTES = ['nh', 'gg', 'wow', 'lol', 'ouch', 'think', 'fire', 'ty'];
  const EMOTE_LABEL = { nh: 'nice hand', gg: 'gg', wow: 'wow', lol: 'lol', ouch: 'ouch', think: 'hmm...', fire: 'on fire', ty: 'ty' };
  const OPTIONS = Object.freeze({
    cashStacks: [500, 1000, 2000, 5000],
    cashBlinds: [[5, 10], [10, 20], [25, 50], [50, 100]],
    sngStacks: [1000, 1500, 3000, 5000],
    presets: ['turbo', 'regular', 'slow'],
    handsPerLevel: { turbo: 6, regular: 10, slow: 15 },
    turnSeconds: [0, 15, 30, 60],
    maxSeats: [2, 3, 4, 5, 6, 7, 8, 9],
  });
  const BASE_SB = [10, 15, 25, 50, 75, 100];
  const ERRORS = {
    'room-not-found': ['no such table', (c) => 'no table with code ' + (c || '?????') + '. check the code with your host. if it is right: the host should refresh the page, set connection to auto or relay, and host again — their lobby must say "relay on".'],
    'host-left': ['the table closed', () => "the host closed the table. the game lives in the host's browser, so it can't continue without them."],
    'network-blocked': ['network blocked', () => "found the table, but this network blocks direct connections and our backup relay couldn't get through either — common on school/work wi-fi. try again in a few minutes, or switch to a phone hotspot."],
    'service-unreachable': ['server unreachable', () => 'check your connection — single-player still works offline.'],
    'room-full': ['table is full', () => 'every seat and every spot on the rail is taken. ask the host to make room.'],
    locked: ['table is locked', () => "they aren't letting anyone new in right now. ask them to unlock it."],
    'version-mismatch': ['versions differ', () => 'you and the host are on different versions — both refresh.'],
    kicked: ['removed by the host', () => 'the host took you off the table. ask them before you rejoin.'],
    'browser-unsupported': ['browser unsupported', () => 'peer-to-peer needs a recent chrome, firefox, safari or edge. single-player still works here.'],
    timeout: ['timed out', () => "the table didn't answer in time. try again in a moment."],
    'room-taken': ['no free code', () => 'the matchmaking server kept saying the code was taken. try again.'],
    closed: ['connection closed', () => 'the link to the table dropped. try again.'],
    'network-blocked-direct': ['network blocked', () => 'found the table, but this network blocks direct connections. switch connection to auto or relay (on the hub or the join screen) and try again.'],
    'relay-offline': ['relay is offline', () => 'relay is offline — try auto or direct. (connection setting, below the cards on the hub.)'],
  };

  // -------------------------------------------------------------- tiny helpers
  function ordinal(n) {
    const v = Math.abs(Math.round(n)) % 100;
    const sfx = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
    return n + sfx;
  }
  function chips(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function cleanName(s) {
    const t = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ._!?'-]/gu, '').trim();
    return t.slice(0, NAME_MAX);
  }
  function artSeed(name, avatar) { return avatar ? String(name) + '|' + avatar : String(name); }
  function errCode(err) {
    const c = err && (err.code || err.message);
    return ERRORS[c] ? c : 'closed';
  }
  function ladder(stack, preset, antes, Tournament) {
    if (Tournament && Tournament.levels) {
      try { return Tournament.levels({ startingStack: stack, preset, antes }); } catch (e) { console.error(e); }
    }
    const hpl = OPTIONS.handsPerLevel[preset] || 10;
    return BASE_SB.map((sb, i) => {
      const v = Math.max(1, Math.round(sb * stack / 1500 / 5) * 5 || 1);
      return { level: i + 1, sb: v, bb: v * 2, ante: antes && i >= 2 ? Math.max(1, Math.round(v / 5)) : 0, handsPerLevel: hpl };
    });
  }

  // --------------------------------------------------------------------- storage
  function normalizeProfile(p) {
    const o = p && typeof p === 'object' ? p : {};
    return {
      name: typeof o.name === 'string' ? cleanName(o.name) : '',
      avatar: AVATAR_SEEDS.includes(o.avatar) ? o.avatar : 'a0',
    };
  }
  function normalizeStore(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const r = o.rejoin && typeof o.rejoin === 'object' ? o.rejoin : null;
    const rejoin = r && typeof r.code === 'string' && /^[0-9a-f]{32}$/.test(String(r.token)) && Number.isFinite(r.ts)
      ? { code: r.code, token: r.token, name: cleanName(r.name), avatar: normalizeProfile(r).avatar, ts: r.ts } : null;
    return {
      profile: normalizeProfile(o.profile),
      rejoin,
      history: Array.isArray(o.history) ? o.history.slice(-HISTORY_MAX) : [],
      transport: TRANSPORTS.includes(o.transport) ? o.transport : 'auto',
    };
  }
  function makeStore(storage) {
    let cache = null;
    function read() {
      if (cache) return cache;
      let raw = null;
      try { raw = storage ? JSON.parse(storage.getItem(STORE_KEY) || 'null') : null; } catch (e) { raw = null; }
      cache = normalizeStore(raw);
      return cache;
    }
    function write(patch) {
      cache = Object.freeze(Object.assign({}, read(), patch));
      try { if (storage) storage.setItem(STORE_KEY, JSON.stringify(cache)); } catch (e) { /* private mode: keep in memory */ }
      return cache;
    }
    return { read, write };
  }

  // ============================================================================ mount
  function mount(rootEl, depsIn) {
    const deps = Object.assign({}, depsIn);
    const UI = deps.UI || {};
    const doc = rootEl.ownerDocument || document;
    const store = makeStore(deps.storage || null);
    let S = null;          // the live session: { kind, room|client, offs[], inGame, spec, ... }
    let screen = 'hub';
    let flow = 0;          // bumps on every navigation so stale async results are ignored
    let O = null;          // overlay state

    // ----------------------------------------------------------- dom helpers
    function el(tag, cls, text) {
      if (UI.el) return UI.el(tag, cls, text);
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    }
    function btn(label, kind, onClick, opts) {
      const o = opts || {};
      const b = UI.button ? UI.button(label, kind, { kbd: o.kbd, small: o.small }) : el('button', 'btn btn-' + kind, label);
      b.type = 'button';
      if (o.key) b.dataset.key = o.key;
      if (o.cls) b.classList.add(...o.cls.split(' '));
      if (onClick) b.addEventListener('click', onClick);
      return b;
    }
    /** A button whose label ends in an uppercase room code. */
    function codeBtn(label, code, kind, onClick, key) {
      const b = btn(label + ' ', kind, onClick, { key });
      (b.querySelector('.btn-label') || b).appendChild(el('span', 'mp-upper', code));
      return b;
    }
    function setLabel(b, text) { const l = b.querySelector('.btn-label') || b; l.textContent = text; }
    function face(name, avatar, size) {
      const w = el('span', 'mp-av' + (size ? ' mp-av-' + size : ''));
      w.setAttribute('aria-hidden', 'true');
      if (UI.avatar) w.appendChild(UI.avatar(artSeed(name, avatar)));
      return w;
    }
    function stars(r, opts) {
      if (UI.stars) return UI.stars(r, opts);
      return el('span', 'stars', r + '/5');
    }
    function conn(c) {
      const word = c === 'bot' ? 'bot' : c === 'away' ? 'away' : c === 'offline' ? 'offline' : 'online';
      const n = el('span', 'mp-conn');
      n.dataset.conn = c || 'online';
      n.append(el('i', 'mp-dot'), el('span', null, word));
      return n;
    }
    function tag(text, kind) { const t = el('span', 'mp-tag', text); if (kind) t.dataset.kind = kind; return t; }
    function seg(name, options, current, onPick, readOnly) {
      const g = el('div', 'mp-seg');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', name);
      options.forEach((o) => {
        const b = el('button', null, o.label);
        b.type = 'button';
        b.dataset.key = 'seg-' + name + '-' + o.label;
        b.setAttribute('aria-pressed', String(o.value === current));
        if (readOnly) b.disabled = true;
        else b.addEventListener('click', () => { if (o.value !== current) onPick(o.value); });
        g.appendChild(b);
      });
      return g;
    }
    function armed(b, label, armedLabel, onConfirm) {
      let t = 0;
      b.addEventListener('click', () => {
        if (b.dataset.armed === 'true') { clearTimeout(t); onConfirm(); return; }
        b.dataset.armed = 'true';
        setLabel(b, armedLabel);
        t = setTimeout(() => { b.dataset.armed = 'false'; setLabel(b, label); }, ARM_MS);
      });
      return b;
    }

    // ------------------------------------------------------------ screen frame
    /** Swaps the lobby sheet, keeping focus on the control with the same data-key. */
    function paint(name, build) {
      const active = doc.activeElement;
      const key = active && rootEl.contains(active) && active.dataset ? active.dataset.key : null;
      screen = name;
      const frame = el('div', 'mp-frame mp-s-' + name);
      build(frame);
      rootEl.replaceChildren(frame);
      const again = key ? rootEl.querySelector('[data-key="' + CSS.escape(key) + '"]') : null;
      if (again) again.focus({ preventScroll: true });
      return frame;
    }
    function head(title, note, onBack, backLabel) {
      const h = el('header', 'mp-head');
      const back = el('button', 'tab', backLabel || 'back');
      back.type = 'button';
      back.dataset.key = 'back';
      back.addEventListener('click', onBack);
      const board = el('div', 'mp-board dmd');
      board.append(el('h2', 'dmd-text', title));
      if (note) board.append(el('span', 'mp-board-note', note));
      h.append(back, board);
      return h;
    }
    function profile() { return store.read().profile; }
    function saveProfile(patch) { store.write({ profile: normalizeProfile(Object.assign({}, profile(), patch)) }); }
    function freshRejoin(code) {
      const r = store.read().rejoin;
      if (!r || Date.now() - r.ts > REJOIN_MAX_MS) return null;
      return !code || r.code === code ? r : null;
    }

    function transportPref() { return store.read().transport; }
    /**
     * "connection: auto · direct · relay" + a one-line hint. Picking re-renders only this control
     * (typed join fields survive) and persists the choice.
     */
    function connectionPick(cls) {
      const box = el('div', 'mp-connpick' + (cls ? ' ' + cls : ''));
      const current = transportPref();
      const pick = (v) => {
        store.write({ transport: v });
        const next = connectionPick(cls);
        box.replaceWith(next);
        const b = next.querySelector('[data-key="seg-connection-' + v + '"]');
        if (b) b.focus({ preventScroll: true });
      };
      const line = el('span', 'mp-connpick-line');
      line.append(el('span', 'mp-label', 'connection'),
        seg('connection', TRANSPORTS.map((v) => ({ label: v, value: v })), current, pick));
      box.append(line, el('span', 'mp-hint', 'relay = school wi-fi'));
      return box;
    }
    /** Host lobby: the connection this table was opened with (picked on the hub before hosting). */
    function connectionInUse() {
      const row = el('p', 'mp-connuse');
      row.title = 'set on the multiplayer hub before you host';
      row.append(el('span', 'mp-label', 'connection'), el('span', null, transportPref() + ' · ' + TRANSPORT_NOTE[transportPref()]));
      const status = el('span', 'mp-relay-status');
      row.append(status);
      paintRelayStatus(status);
      return row;
    }

    const RELAY_STATUS_TEXT = { on: ' · relay on ✓', connecting: ' · relay connecting…', off: ' · relay off: school wi-fi players cannot join' };
    const RELAY_STATUS_POLL_MS = 1000;
    function paintRelayStatus(node) {
      const ep = S && S.endpoint;
      const read = () => (ep && typeof ep.relayStatus === 'function' ? ep.relayStatus() : null);
      const update = () => {
        if (!node.isConnected) return false;
        const st = read();
        node.textContent = st ? RELAY_STATUS_TEXT[st] || '' : '';
        node.dataset.state = st || '';
        return true;
      };
      update();
      const timer = setInterval(() => { if (!update()) clearInterval(timer); }, RELAY_STATUS_POLL_MS);
    }

    // ===================================================================== hub
    function openHub() {
      if (PP.Update) PP.Update.ensureFresh(true); // a stale tab can't find friends' rooms
      flow += 1;
      if (S && !S.inGame) teardown();
      paint('hub', (f) => {
        f.append(head('play with friends', 'play chips only', () => deps.showScreen && deps.showScreen('title')));
        const body = el('div', 'mp-body');
        body.append(hostCard(), joinCard(), sngCard());
        f.append(body, hubBar());
      });
      showMp();
    }
    function hostCard() {
      const c = el('section', 'mp-card paper');
      c.setAttribute('aria-label', 'host a table');
      const strip = el('div', 'mp-felt-strip');
      const p = profile();
      strip.appendChild(face(p.name || 'you', p.avatar, 2));
      ['k7|a1', 'qz|a4', 'mx|a2', 'rr|a6'].forEach((s) => strip.appendChild(face(s, '', 2)));
      c.append(el('h3', 'mp-big', 'host a table'), strip,
        el('p', null, 'Deal a cash game for up to 8 friends. They join with a 5-letter code; bots fill empty seats.'),
        btn('host cash game', 'orange', () => openHost({ mode: 'cash' }), { key: 'hub-host' }));
      return c;
    }
    function joinCard() {
      const c = el('section', 'mp-card paper');
      c.setAttribute('aria-label', 'join a table');
      const cells = el('div', 'mp-cells dmd');
      for (let i = 0; i < 5; i++) cells.appendChild(el('i'));
      cells.setAttribute('aria-hidden', 'true');
      c.append(el('h3', 'mp-big', 'join'), cells,
        el('p', null, 'Got a code or a link from the host? Type the five letters.'),
        btn('enter a code', 'grey', () => openJoin(), { key: 'hub-join' }));
      return c;
    }
    function sngCard() {
      const c = el('section', 'mp-card paper');
      c.setAttribute('aria-label', 'sit-n-go tournament');
      const list = el('ol', 'mp-ladder');
      ladder(1500, 'regular', false, deps.Tournament).slice(0, 3).forEach((l) => {
        const li = el('li');
        li.append(el('span', null, 'lv' + l.level), el('span', null, l.sb + '/' + l.bb));
        list.appendChild(li);
      });
      c.append(el('h3', 'mp-big', 'sit-n-go'), list,
        el('p', null, 'Blinds climb every 10 hands. Top 3 score points.'),
        btn('with friends', 'grey', () => openHost({ mode: 'sng' }), { key: 'hub-sng' }),
        btn('practice vs bots', 'grey', () => openOfflineSng(), { key: 'hub-offline' }));
      return c;
    }
    function hubBar() {
      const bar = el('footer', 'mp-bar mp-hub-bar');
      bar.append(profileRow(false));
      const r = freshRejoin();
      if (r) {
        const box = el('div', 'mp-rejoin');
        box.append(el('span', 'mp-note', 'last table'), codeBtn('rejoin', r.code, 'orange', () => openJoin(r.code), 'hub-rejoin'));
        bar.append(box);
      }
      bar.append(connectionPick('mp-hub-conn' + (r ? ' mp-hub-conn-row' : '')));
      const foot = el('p', 'mp-foot mp-hub-foot');
      foot.append(el('b', null, 'play chips only — no real money, ever.'), doc.createTextNode(" the host's browser deals."));
      bar.append(foot);
      return bar;
    }
    function profileRow(editing) {
      const p = profile();
      const row = el('div', 'mp-profile');
      if (!editing) {
        row.append(face(p.name || 'you', p.avatar, 2), el('span', 'mp-note', 'playing as'),
          el('span', 'mp-profile-name', p.name || 'no name yet'),
          btn('change', 'grey', () => row.replaceWith(profileRow(true)), { small: true, key: 'hub-profile' }));
        return row;
      }
      const input = nameInput(p.name, 'hub-name');
      const done = () => { saveProfile({ name: input.value }); openHub(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
      row.append(input, btn('done', 'grey', done, { small: true, key: 'hub-done' }));
      setTimeout(() => input.focus(), 0);
      return row;
    }
    function nameInput(value, key) {
      const i = el('input', 'mp-input');
      Object.assign(i, { type: 'text', value: value || '', maxLength: NAME_MAX, placeholder: 'your name', autocomplete: 'nickname', spellcheck: false });
      i.dataset.key = key;
      i.setAttribute('aria-label', 'your name');
      return i;
    }
    function showMp() { if (deps.showScreen) deps.showScreen('mp'); }

    // ==================================================================== join
    function openJoin(codeIn) {
      flow += 1;
      if (S && !S.inGame) teardown();
      const code = codeIn && deps.Net && deps.Net.normalizeCode ? deps.Net.normalizeCode(codeIn) || '' : (codeIn || '');
      const r = freshRejoin(code || null);
      const p = r && code ? { name: r.name, avatar: r.avatar } : profile();
      const J = { code, name: p.name, avatar: p.avatar, rejoin: r && code === r.code ? r : null, status: null };
      paint('join', (f) => buildJoin(f, J));
      showMp();
      const first = rootEl.querySelector(code ? '[data-key="join-btn"]' : '[data-key="join-code"]');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 0);
    }
    function buildJoin(f, J) {
      f.append(head('join a table', 'play chips only', () => openHub()));
      const body = el('div', 'mp-body');
      const left = el('section', 'mp-panel slate');
      const code = el('input', 'mp-code-input');
      Object.assign(code, { type: 'text', value: J.code, maxLength: 5, placeholder: '·····', autocomplete: 'off', spellcheck: false });
      code.setAttribute('autocapitalize', 'characters');
      code.setAttribute('inputmode', 'text');
      code.setAttribute('aria-label', 'table code');
      code.dataset.key = 'join-code';
      const name = nameInput(J.name, 'join-name');
      const status = el('p', 'mp-status');
      status.setAttribute('aria-live', 'polite');
      const f1 = el('label', 'mp-field');
      f1.append(el('span', 'mp-label', 'table code'), code, el('span', 'mp-hint', '5 characters · no O, I, L, 0 or 1'));
      const f2 = el('label', 'mp-field');
      f2.append(el('span', 'mp-label', 'your name'), name);
      left.append(f1, f2, connectionPick('mp-field'), el('div', 'mp-rule'), status);
      if (J.rejoin) setStatus(status, 'you had a seat here — joining puts you back in it.', 'ok');
      const faces = facePicker(J, name);
      body.append(left, faces.node);
      const go = btn(J.rejoin ? 'rejoin' : 'join', 'orange', () => submitJoin(J, code, name, status, go), { key: 'join-btn', cls: 'btn-xl', kbd: 'enter' });
      const bar = el('footer', 'mp-bar');
      bar.append(el('span', 'mp-grow mp-foot', 'the table lives in the host’s browser.'), go);
      f.append(body, bar);
      code.addEventListener('input', () => {
        const v = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
        if (v !== code.value) code.value = v;
        code.removeAttribute('aria-invalid');
      });
      name.addEventListener('input', () => faces.refresh(name.value));
      [code, name].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); }));
    }
    function facePicker(J, nameEl) {
      const wrap = el('section', 'mp-faces-wrap paper');
      const grid = el('div', 'mp-faces');
      grid.setAttribute('role', 'radiogroup');
      grid.setAttribute('aria-label', 'pick a face');
      const prev = el('div', 'mp-you-preview');
      wrap.append(el('h3', 'mp-big', 'pick a face'), el('p', 'mp-hint', 'Your name shapes the face, so it stays the same for everyone.'), grid, prev);
      function refresh(nameVal) {
        const n = cleanName(nameVal) || 'you';
        grid.replaceChildren();
        AVATAR_SEEDS.forEach((seed, i) => grid.appendChild(faceOption(J, seed, i, n, () => refresh(nameEl.value))));
        prev.replaceChildren(face(n, J.avatar, 3), el('span', 'mp-big', cleanName(nameVal) || 'your name'));
      }
      refresh(J.name);
      return { node: wrap, refresh };
    }
    function faceOption(J, seed, i, name, rerender) {
      const b = el('button', 'mp-face');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(J.avatar === seed));
      b.setAttribute('aria-label', 'face ' + (i + 1));
      b.tabIndex = J.avatar === seed ? 0 : -1;
      b.dataset.key = 'face-' + seed;
      b.appendChild(face(name, seed, 2));
      const pick = (s) => { J.avatar = s; rerender(); const n = b.parentNode && b.parentNode.parentNode && b.parentNode.parentNode.querySelector('[data-key="face-' + s + '"]'); if (n) n.focus(); };
      b.addEventListener('click', () => pick(seed));
      b.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 4, ArrowLeft: -1, ArrowUp: -4 }[e.key];
        if (!d) return;
        e.preventDefault();
        pick(AVATAR_SEEDS[(i + d + AVATAR_SEEDS.length) % AVATAR_SEEDS.length]);
      });
      return b;
    }
    function setStatus(node, text, tone) {
      if (!node) return;
      node.textContent = text || '';
      if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
    }
    async function submitJoin(J, codeEl, nameEl, status, go) {
      const Net = deps.Net || {};
      const code = Net.normalizeCode ? Net.normalizeCode(codeEl.value) : codeEl.value;
      if (!code) {
        codeEl.setAttribute('aria-invalid', 'true');
        setStatus(status, "that code doesn't look right: 5 characters, no O, I, L, 0 or 1.", 'bad');
        codeEl.focus();
        return;
      }
      const name = cleanName(nameEl.value) || 'player';
      saveProfile({ name, avatar: J.avatar });
      const r = freshRejoin(code);
      const my = ++flow;
      go.disabled = true;
      setStatus(status, 'finding table…', 'busy');
      const slow = setTimeout(() => { if (my === flow) setStatus(status, 'connecting…', 'busy'); }, CONNECTING_AFTER_MS);
      try {
        const client = await deps.Room.joinRoom({ code, name, avatar: J.avatar, token: r ? r.token : undefined,
          transport: transportPref() });
        clearTimeout(slow);
        if (my !== flow) { client.leave(); return; }
        setStatus(status, 'joined', 'ok');
        startClient(client, code, name, J.avatar);
      } catch (err) {
        clearTimeout(slow);
        if (my !== flow) return;
        const c = errCode(err);
        if (c === 'room-not-found' || c === 'kicked' || c === 'locked') store.write({ rejoin: null });
        showError(c, code, () => openJoin(code));
      }
    }

    // ============================================================ host flows
    async function openHost(opts) {
      const mode = opts && opts.mode === 'sng' ? 'sng' : 'cash';
      teardown();
      const my = ++flow;
      paintBusy('opening a table…', transportPref() === 'relay' ? 'getting a code from the relay'
        : 'getting a code from the matchmaking server', () => openHub());
      showMp();
      try {
        const endpoint = await deps.Net.createHost({ transport: transportPref() });
        if (my !== flow) { endpoint.close(); return; }
        startHost(endpoint, mode);
      } catch (err) {
        if (my === flow) showError(errCode(err), null, () => openHost(opts));
      }
    }
    function openOfflineSng() {
      teardown();
      flow += 1;
      startHost(null, 'sng');
      OFFLINE_BOTS.forEach((r) => S.room.addBot(r));
      renderLobby();
      showMp();
    }
    function startHost(endpoint, mode) {
      const p = profile();
      const room = new deps.Room.HostRoom({ endpoint, hostName: p.name || 'host', hostAvatar: p.avatar, settings: { mode } });
      S = { kind: 'host', room, endpoint, offline: !endpoint, offs: [], inGame: false, spec: null };
      S.offs.push(
        room.on('lobby', () => { if (!S.inGame && screen === 'lobby') renderLobby(); }),
        room.on('end', (res) => onEnd(res)),
        room.on('error', (err) => onHostNetError(err)),
      );
      bindTableEvents(room);
      renderLobby();
    }
    function startClient(client, code, name, avatar) {
      teardown();
      S = { kind: 'client', client, code, offs: [], inGame: false, spec: null };
      store.write({ rejoin: { code, token: client.token, name, avatar, ts: Date.now() } });
      S.offs.push(
        client.on('lobby', () => { if (!S.inGame && screen === 'lobby') renderLobby(); }),
        client.on('start', (spec) => enterGame(spec || client.tableSpec())),
        client.on('end', (res) => onEnd(res)),
        client.on('closed', (m) => onSessionError({ code: (m && m.reason) === 'kicked' ? 'kicked' : 'host-left' })),
        client.on('error', (err) => onSessionError(err)),
        client.on('status', (st) => setBanner(st === 'reconnecting')),
      );
      bindTableEvents(client);
      renderLobby();
      if (client.engine && client.lobby && client.lobby.phase === 'playing') enterGame(client.tableSpec());
    }
    /** Host-side NetErrors (signaling hiccups) are not fatal: open data channels keep working. */
    function onHostNetError(err) {
      if (!S) return;
      const c = errCode(err);
      const text = c === 'service-unreachable'
        ? 'matchmaking server hiccup: players already seated stay connected; new joins may fail for a moment.'
        : 'connection problem (' + c + '). players already seated stay connected.';
      if (O) sysLine(text);
      else if (screen === 'lobby') {
        const st = rootEl.querySelector('.mp-lobby-bar .mp-count');
        if (st) st.textContent = text;
      }
    }
    function onSessionError(err) {
      const c = errCode(err);
      if (!S) return;
      if (UI.isModalOpen && UI.isModalOpen() && UI.closeModal) UI.closeModal('replaced');
      if (c === 'host-left' || c === 'kicked' || c === 'closed') store.write({ rejoin: null });
      const wasIn = S.inGame;
      const code = S.code || null;
      if (wasIn) quietEndNetGame();
      teardown();
      showError(c, code, () => (code ? openJoin(code) : openHub()));
    }
    function teardown() {
      if (!S) return;
      S.offs.forEach((off) => { try { if (typeof off === 'function') off(); } catch (e) { console.error(e); } });
      S.offs = [];
      unmountOverlay();
      S = null;
    }
    function lobbyState() {
      if (!S) return null;
      return S.kind === 'host' ? S.room.lobbyState() : S.client.lobby;
    }

    // ============================================================== lobby view
    function renderLobby() {
      const L = lobbyState();
      if (!L) return openHub();
      const isHost = S.kind === 'host';
      paint('lobby', (f) => {
        const back = isHost ? (S.offline ? 'back' : 'close table') : 'leave';
        f.append(head(isHost ? (S.offline ? 'practice sit-n-go' : 'your table') : (L.hostName || 'host') + "'s table",
          L.settings.mode === 'sng' ? 'sit-n-go' : 'cash game', () => leaveLobby(), back));
        const body = el('div', 'mp-body');
        const left = el('div', 'mp-left');
        left.append(codePanel(L, isHost), seatsPanel(L, isHost));
        if (isHost && !S.offline) left.append(connectionInUse());
        body.append(left, rulesCard(L, isHost));
        f.append(body, lobbyBar(L, isHost));
      });
    }
    function leaveLobby() {
      if (S && S.kind === 'host') S.room.close();
      else if (S && S.client) S.client.leave();
      store.write({ rejoin: null });
      teardown();
      openHub();
    }
    function codePanel(L, isHost) {
      const wrap = el('div', 'mp-codewrap');
      const panel = el('div', 'mp-code dmd');
      const k = el('span', 'mp-code-k');
      if (S.offline) {
        k.append(el('span', null, 'offline'), el('span', null, 'vs bots'));
        panel.append(k, el('span', 'mp-code-v mp-word', 'practice'));
        wrap.append(panel);
        return wrap;
      }
      k.append(el('span', null, 'table code'));
      const v = el('span', 'mp-code-v', L.code || '');
      v.setAttribute('aria-label', 'table code ' + String(L.code || '').split('').join(' '));
      panel.append(k, v);
      wrap.append(panel);
      return wrap;
    }
    function inviteRow(code, linkOnly) {
      const row = el('div', 'mp-invite');
      const Net = deps.Net || {};
      const url = Net.inviteUrl ? Net.inviteUrl(code, deps.location) : '?room=' + code;
      const a = btn('copy invite link', 'grey', () => copy(url, a, row), { key: 'copy-link' });
      row.append(a);
      if (!linkOnly) { const b = btn('copy code', 'grey', () => copy(code, b, row), { key: 'copy-code' }); row.append(b); }
      return row;
    }
    async function copy(text, b, row) {
      let ok = false;
      try {
        const nav = globalThis.navigator;
        if (nav && nav.clipboard && nav.clipboard.writeText) { await nav.clipboard.writeText(text); ok = true; }
      } catch (e) { ok = false; }
      if (ok) {
        const before = (b.querySelector('.btn-label') || b).textContent;
        setLabel(b, 'copied ✓');
        setTimeout(() => setLabel(b, before), COPY_FLASH_MS);
        return;
      }
      let f = row.querySelector('.mp-copy-fallback');
      if (!f) {
        f = el('input', 'mp-input mp-copy-fallback');
        f.readOnly = true;
        f.setAttribute('aria-label', 'copy this');
        row.appendChild(f);
      }
      f.value = text;
      f.focus();
      f.select();
    }
    function seatsPanel(L, isHost) {
      const p = el('section', 'mp-panel slate');
      p.setAttribute('aria-label', 'seats');
      const max = L.settings.maxSeats;
      const ph = el('div', 'mp-panel-head');
      const watching = L.spectators && L.spectators.length ? ' · ' + L.spectators.length + ' watching' : '';
      ph.append(el('h3', 'mp-h', 'seats'), el('span', 'mp-k', L.seats.length + ' / ' + max + watching));
      const list = el('ul', 'mp-seats');
      L.seats.forEach((s) => list.appendChild(seatRow(s, isHost)));
      for (let i = L.seats.length; i < max; i++) list.appendChild(openSeatRow(isHost && i === L.seats.length, isHost));
      p.append(ph, list);
      return p;
    }
    function seatRow(s, isHost) {
      const li = el('li', 'mp-seat');
      const you = isHost ? s.id === 'hero' : !!s.isYou;
      const nm = el('span', 'mp-seat-name');
      nm.append(el('span', 'mp-seat-text', s.name));
      if (you) nm.append(tag('you', 'you'));
      else if (s.kind === 'host') nm.append(tag('host', 'host'));
      const right = s.kind === 'bot'
        ? stars(s.rating, isHost ? { interactive: true, onPick: (r) => { S.room.setBotRating(s.id, r); renderLobby(); } } : {})
        : conn(s.conn);
      if (s.kind === 'bot') right.title = botTitle(s.rating);
      li.append(face(s.name, s.avatar), nm, right);
      if (isHost && s.id !== 'hero') li.append(removeBtn(s));
      else li.append(el('span'));
      return li;
    }
    function botTitle(r) {
      const R = deps.Bots && deps.Bots.RATINGS && deps.Bots.RATINGS[r];
      return R ? String(R.title).toLowerCase() : 'bot';
    }
    function removeBtn(s) {
      const b = el('button', 'mp-x', '✕');
      b.type = 'button';
      b.dataset.key = 'rm-' + s.id;
      b.setAttribute('aria-label', 'remove ' + s.name);
      if (s.kind === 'bot') b.addEventListener('click', () => { S.room.removeSeat(s.id); renderLobby(); });
      else armed(b, '✕', 'remove?', () => { S.room.removeSeat(s.id); renderLobby(); });
      return b;
    }
    let addRating = 3;
    /** An empty chair. The first one, for the host, seats a bot at the picked skill. */
    function openSeatRow(withBot, isHost) {
      const li = el('li', 'mp-seat mp-seat-empty');
      if (!withBot) {
        li.append(el('i'), el('span', null, isHost && !S.offline ? 'open — send the code' : 'open seat'));
        return li;
      }
      li.classList.add('mp-seat-add');
      const pick = stars(addRating, { interactive: true, onPick: (r) => { addRating = r; renderLobby(); } });
      pick.setAttribute('aria-label', 'skill of the next bot');
      li.append(el('i'), el('span', 'mp-addbot-title', 'open seat'), pick,
        btn('+ bot', 'grey', () => { S.room.addBot(addRating); renderLobby(); }, { small: true, key: 'add-bot' }));
      return li;
    }

    // ------------------------------------------------------------ house rules
    function rulesCard(L, isHost) {
      const c = el('section', 'mp-rules paper');
      c.setAttribute('aria-label', 'house rules');
      c.append(el('h3', 'mp-big', 'house rules'));
      const st = L.settings;
      const ro = !isHost;
      const set = (patch) => { S.room.updateSettings(patch); renderLobby(); };
      if (!S.offline) c.append(rule('game', seg('game', [{ label: 'cash', value: 'cash' }, { label: 'sit-n-go', value: 'sng' }], st.mode, (v) => set({ mode: v }), ro)));
      c.append(rule('seats', seg('seats', OPTIONS.maxSeats.map((n) => ({ label: String(n), value: n })), st.maxSeats, (v) => set({ maxSeats: v }), ro)));
      const stacks = st.mode === 'sng' ? OPTIONS.sngStacks : OPTIONS.cashStacks;
      c.append(rule('chips', seg('chips', stacks.map((n) => ({ label: String(n), value: n })), st.startingStack, (v) => set({ startingStack: v }), ro)));
      if (st.mode === 'sng') sngRules(c, st, ro, set);
      else cashRules(c, st, ro, set);
      c.append(rule('timer', seg('turn timer', OPTIONS.turnSeconds.map((n) => ({ label: n ? n + 's' : 'off', value: n })), st.turnSeconds, (v) => set({ turnSeconds: v }), ro)));
      c.append(rule('coach', seg('coach', [{ label: 'allowed', value: true }, { label: 'hidden', value: false }], st.coachAllowed, (v) => set({ coachAllowed: v }), ro),
        'fair play: off for all'));
      if (!S.offline) {
        c.append(rule('dropped', seg('if a player drops', [{ label: 'auto-fold', value: 'autofold' }, { label: 'bot plays', value: 'bot' }], st.disconnectPolicy, (v) => set({ disconnectPolicy: v }), ro)));
        c.append(rule('room', seg('room', [{ label: 'open', value: false }, { label: 'locked', value: true }], st.locked, (v) => set({ locked: v }), ro)));
      }
      return c;
    }
    function rule(label, control, note) {
      const r = el('div', 'mp-rule-row');
      r.append(el('span', 'mp-k', label), control);
      if (note) r.append(el('span', 'mp-rule-note', note));
      return r;
    }
    function cashRules(c, st, ro, set) {
      const cur = OPTIONS.cashBlinds.findIndex((b) => b[0] === st.sb && b[1] === st.bb);
      c.append(rule('blinds', seg('blinds', OPTIONS.cashBlinds.map((b, i) => ({ label: b[0] + '/' + b[1], value: i })), cur,
        (i) => set({ sb: OPTIONS.cashBlinds[i][0], bb: OPTIONS.cashBlinds[i][1] }), ro)));
      c.append(rule('rebuys', seg('rebuys', [{ label: 'on', value: true }, { label: 'off', value: false }], st.rebuys, (v) => set({ rebuys: v }), ro),
        null));
    }
    function sngRules(c, st, ro, set) {
      const lv = ladder(st.startingStack, st.sngPreset, st.antes, deps.Tournament);
      const l1 = lv[0] || { sb: 10, bb: 20, handsPerLevel: 10 };
      c.append(rule('speed', seg('speed', OPTIONS.presets.map((p) => ({ label: p, value: p })), st.sngPreset, (v) => set({ sngPreset: v }), ro),
        'level 1: ' + l1.sb + '/' + l1.bb + ' · up every ' + l1.handsPerLevel + ' hands'));
      c.append(rule('antes', seg('antes', [{ label: 'off', value: false }, { label: 'from lv3', value: true }], st.antes, (v) => set({ antes: v }), ro)));
    }
    function lobbyBar(L, isHost) {
      const bar = el('footer', 'mp-bar mp-lobby-bar');
      if (!isHost) {
        const role = S.client && S.client.role === 'spectator';
        bar.append(el('p', 'mp-waiting mp-grow', role ? "you're watching — the table is full or already playing." : 'waiting for the host to deal…'));
        if (L.code) bar.append(inviteRow(L.code, true));
        return bar;
      }
      if (!S.offline && L.code) bar.append(inviteRow(L.code, false));
      const n = L.seats.length;
      const count = el('span', 'mp-count mp-grow');
      count.append(el('b', null, n + ' seated'), doc.createTextNode(n < 2 ? ' · need at least 2' : ' · ready'));
      const start = btn('deal', 'orange', () => hostStart(start), { key: 'start', cls: 'btn-xl', kbd: 'enter' });
      start.disabled = n < 2;
      bar.append(count, start);
      return bar;
    }
    function hostStart(b) {
      let spec;
      try { spec = S.room.start(); } catch (err) { console.error(err); setLabel(b, "can't start"); return; }
      enterGame(spec);
      Promise.resolve(S.room.run()).catch((err) => console.error(err));
    }

    // ============================================================ error + busy
    function showError(code, roomCode, retry) {
      // 'direct' never tries the relay, so the generic "relay couldn't get through either" would mislead.
      const direct = code === 'network-blocked' && transportPref() === 'direct';
      const def = direct ? ERRORS['network-blocked-direct'] : ERRORS[code] || ERRORS.closed;
      paint('error', (f) => {
        f.append(head('connection', null, () => openHub()));
        const body = el('div', 'mp-body');
        const p = el('section', 'mp-error mp-panel slate');
        p.setAttribute('role', 'alert');
        const acts = el('div', 'mp-error-actions');
        acts.append(btn('try again', 'orange', retry, { key: 'err-retry' }), btn('back', 'grey', () => openHub(), { key: 'err-back' }));
        p.append(el('h3', 'mp-error-title', def[0]), el('p', 'mp-error-text', def[1](roomCode)), el('p', 'mp-error-code', 'code: ' + code), acts);
        body.append(p);
        f.append(body, el('footer', 'mp-bar'));
      });
      showMp();
      const r = rootEl.querySelector('[data-key="err-retry"]');
      if (r) r.focus({ preventScroll: true });
    }
    function paintBusy(title, sub, onBack) {
      paint('error', (f) => {
        f.append(head('connection', null, onBack));
        const body = el('div', 'mp-body');
        const p = el('section', 'mp-error mp-panel slate mp-busy');
        const s = el('p', 'mp-status', title);
        s.dataset.tone = 'busy';
        s.setAttribute('aria-live', 'polite');
        p.append(s, el('p', 'mp-hint', sub));
        body.append(p);
        f.append(body, el('footer', 'mp-bar'));
      });
    }

    // ============================================================ game entry
    function enterGame(spec) {
      if (!S || !spec) return;
      if (S.inGame && S.spec && S.spec.engine === spec.engine) return;
      if (S.inGame) quietEndNetGame();
      if (UI.isModalOpen && UI.isModalOpen() && UI.closeModal) UI.closeModal('replaced');
      const session = S;
      const g = Object.assign({}, spec, { onLeave: () => onTableLeft(session) });
      S.inGame = true;
      S.spec = g;
      S.ended = false;
      if (deps.startNetGame) deps.startNetGame(g);
      mountOverlay();
    }
    let quiet = false;
    function quietEndNetGame() {
      quiet = true;
      try { if (deps.endNetGame) deps.endNetGame(); } catch (err) { console.error(err); }
      quiet = false;
      if (S) { S.inGame = false; S.spec = null; }
      unmountOverlay();
    }
    /** main.js tore the table down (its leave button): leave the room for real. */
    function onTableLeft(session) {
      if (quiet || session !== S) return;
      if (S.kind === 'host') S.room.close(); else S.client.leave();
      store.write({ rejoin: null });
      S.inGame = false;
      teardown();
      openHub();
    }
    function onEnd(results) {
      if (!S || !results) return;
      const code = S.kind === 'host' ? S.room.code : S.code;
      const hist = store.read().history.concat([Object.assign({}, results, { code, ts: Date.now() })]).slice(-HISTORY_MAX);
      store.write({ history: hist });
      S.ended = true;
      showPodium(results);
    }
    function leave() {
      if (!S) return Promise.resolve();
      if (S.kind === 'host') S.room.close(); else if (S.client) S.client.leave();
      store.write({ rejoin: null });
      if (S.inGame) quietEndNetGame();
      teardown();
      openHub();
      return Promise.resolve();
    }

    // ================================================================ overlay
    function bindTableEvents(src) {
      S.offs.push(
        src.on('seats', (seats) => { if (O) { O.seats = seats || []; renderPlayers(); renderMine(); paintSeatStatus(); } }),
        src.on('tourney', (t) => onTourney(t)),
        src.on('chat', (m) => onChat(m)),
        src.on('emote', (m) => onEmote(m)),
        src.on('timer', (t) => { try { if (UI.startTimer && t) UI.startTimer(t.playerId, t.ms); } catch (e) { console.error(e); } }),
        src.on('eliminated', (e) => onEliminated(e)),
      );
    }
    function mountOverlay() {
      const root = deps.overlayRoot;
      if (!root || !S) return;
      const L = lobbyState() || { seats: [], settings: {} };
      O = { root, fr: el('div', 'mp-ofr'), seats: L.seats || [], tourney: null, lines: [], unread: 0, open: null, lastLevel: 0 };
      O.level = el('div', 'mp-level dmd');
      O.level.hidden = true;
      O.level.setAttribute('aria-live', 'polite');
      O.tabs = el('div', 'mp-tabs');
      O.tabPlayers = tabBtn('players', () => toggleDrawer('players'));
      O.tabChat = tabBtn('chat', () => toggleDrawer('chat'));
      O.tabs.append(O.tabPlayers, O.tabChat);
      O.players = drawer('players');
      O.chat = chatDrawer();
      O.toasts = el('div', 'mp-toasts');
      O.toasts.setAttribute('aria-live', 'polite');
      O.mine = el('div', 'mp-mine slate');
      O.mine.hidden = true;
      O.banner = el('div', 'mp-banner', 'reconnecting… hold tight');
      O.banner.setAttribute('role', 'status');
      O.banner.hidden = true;
      O.fr.append(O.level, O.tabs, O.players, O.chat, O.mine, O.banner, O.toasts);
      root.replaceChildren(O.fr);
      root.classList.add('mp-overlay');
      root.hidden = false;
      root.addEventListener('keydown', overlayKeys);
      renderPlayers();
      renderMine();
    }
    function unmountOverlay() {
      if (!O) return;
      O.root.removeEventListener('keydown', overlayKeys);
      O.root.replaceChildren();
      O.root.hidden = true;
      O = null;
    }
    function overlayKeys(e) {
      if (e.key !== 'Escape' || !O || !O.open) return;
      e.stopPropagation();
      const tab = O.open === 'chat' ? O.tabChat : O.tabPlayers;
      toggleDrawer(O.open);
      tab.focus();
    }
    function tabBtn(label, onClick) {
      const b = el('button', 'mp-tab');
      b.type = 'button';
      b.setAttribute('aria-expanded', 'false');
      b.append(el('span', 'mp-tab-label', label), el('span', 'mp-badge'));
      b.lastChild.hidden = true;
      b.addEventListener('click', onClick);
      return b;
    }
    function setTab(b, label, badge) {
      b.querySelector('.mp-tab-label').textContent = label;
      const bd = b.querySelector('.mp-badge');
      bd.textContent = badge ? String(badge) : '';
      bd.hidden = !badge;
    }
    function drawer(name) {
      const d = el('section', 'mp-drawer slate');
      d.setAttribute('aria-label', name);
      d.hidden = true;
      return d;
    }
    function toggleDrawer(name) {
      if (!O) return;
      O.open = O.open === name ? null : name;
      O.players.hidden = O.open !== 'players';
      O.chat.hidden = O.open !== 'chat';
      O.tabPlayers.setAttribute('aria-expanded', String(O.open === 'players'));
      O.tabChat.setAttribute('aria-expanded', String(O.open === 'chat'));
      if (O.open === 'chat') {
        O.unread = 0;
        renderChatTab();
        const i = O.chat.querySelector('input');
        if (i) setTimeout(() => i.focus({ preventScroll: true }), 0);
        scrollChat();
      }
    }
    function drawerHead(title, sub) {
      const h = el('div', 'mp-drawer-head');
      const close = el('button', 'mp-drawer-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', 'close ' + title);
      close.addEventListener('click', () => toggleDrawer(O.open));
      const t = el('h3', 'mp-h', title);
      if (sub) t.append(el('span', 'mp-k', ' ' + sub));
      h.append(t, close);
      return h;
    }
    /** Presence on the table seats themselves (ui.js setSeatStatus, added at integration). */
    function paintSeatStatus() {
      if (!O || typeof UI.setSeatStatus !== 'function') return;
      O.seats.forEach((s) => {
        const st = s.place ? null : s.sittingOut ? 'sittingOut' : s.conn === 'away' || s.conn === 'offline' ? s.conn : null;
        try { UI.setSeatStatus(s.id, st); } catch (e) { console.error(e); }
      });
    }
    function isMe(s) { return S && (S.kind === 'host' ? s.id === 'hero' : !!s.isYou); }

    // ---------------------------------------------------------------- players
    function orderedSeats() {
      const seats = O.seats.slice();
      const T = O.tourney;
      if (!T || !T.standings) return seats;
      const rank = new Map(T.standings.map((x, i) => [x.id, i]));
      return seats.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 99) - (rank.has(b.id) ? rank.get(b.id) : 99));
    }
    function renderPlayers() {
      if (!O) return;
      const L = lobbyState() || { settings: {} };
      const max = (L.settings && L.settings.maxSeats) || O.seats.length;
      const alive = O.seats.filter((s) => !s.place).length;
      setTab(O.tabPlayers, 'players ' + alive + '/' + max, 0);
      const list = el('ul', 'mp-plist');
      orderedSeats().forEach((s) => list.appendChild(playerRow(s)));
      const parts = [drawerHead(O.tourney ? 'standings' : 'players'), list];
      if (O.tourney && O.tourney.payouts) parts.push(el('p', 'mp-payouts', 'points: ' + O.tourney.payouts.map((p, i) => ordinal(i + 1) + ' ' + p).join(' · ')));
      parts.push(drawerFoot());
      O.players.replaceChildren(...parts);
    }
    function playerRow(s) {
      const li = el('li', 'mp-prow' + (s.place ? ' is-out' : ''));
      const pl = el('span', 'mp-prow-pl');
      pl.appendChild(face(s.name, s.avatar));
      li.append(pl, el('span', 'mp-prow-name', s.name),
        el('span', 'mp-prow-stack', s.place ? ordinal(s.place) : s.stack == null ? '' : chips(s.stack)));
      const sub = el('span', 'mp-prow-sub');
      if (s.kind !== 'bot') sub.append(conn(s.conn));
      if (isMe(s)) sub.append(tag('you', 'you'));
      if (s.sittingOut) sub.append(tag('sitting out', 'sit'));
      if (s.place) sub.append(tag('out', 'out'));
      if (S.kind === 'host' && s.kind === 'human') {
        const k = el('button', 'mp-x mp-prow-act', 'kick');
        k.type = 'button';
        k.setAttribute('aria-label', 'kick ' + s.name);
        armed(k, 'kick', 'sure?', () => S.room.kick(s.id, 'kicked'));
        sub.append(k);
      }
      if (sub.childNodes.length) li.append(sub);
      return li;
    }
    function drawerFoot() {
      const f = el('div', 'mp-drawer-foot');
      const me = O.seats.find(isMe);
      if (me && !me.place) {
        const on = !me.sittingOut;
        f.append(btn(on ? 'sit out' : "i'm back", 'grey', () => setSitOut(on), { small: true }));
      }
      if (S.kind === 'host') {
        const end = btn('end game', 'grey', null, { small: true });
        armed(end, 'end game', 'end for all?', () => S.room.endGame());
        f.append(end);
      }
      return f;
    }
    function setSitOut(on) {
      if (S.kind === 'host') S.room.setSittingOut('hero', on); else S.client.setSittingOut(on);
    }
    function renderMine() {
      if (!O) return;
      const me = O.seats.find(isMe);
      const L = lobbyState() || { settings: {} };
      const st = L.settings || {};
      O.mine.replaceChildren();
      let show = true;
      if (S.kind === 'client' && S.client.role === 'spectator') {
        O.mine.append(el('p', 'mp-mine-text', "you're watching. hole cards stay hidden until showdown."));
      } else if (me && me.sittingOut) {
        O.mine.append(el('p', 'mp-mine-text', "you're sitting out — the table checks or folds for you."),
          btn("i'm back", 'orange', () => setSitOut(false), { key: 'im-back' }));
      } else if (me && me.stack === 0 && !me.place && st.mode === 'cash' && st.rebuys) {
        O.mine.append(el('p', 'mp-mine-text', 'out of chips. buy back in for ' + chips(st.startingStack) + ' play chips?'),
          btn('rebuy', 'orange', () => rebuy(), { key: 'rebuy' }));
      } else if (me && me.place) {
        O.mine.append(el('p', 'mp-mine-text', 'you finished ' + ordinal(me.place) + '. stay and watch the rest.'));
      } else show = false;
      O.mine.hidden = !show;
    }
    function rebuy() { if (S.kind === 'host') S.room.requestRebuy('hero'); else S.client.requestRebuy(); }

    // ------------------------------------------------------------- tournament
    function onTourney(t) {
      if (!O || !t) return;
      const changed = O.tourney && O.tourney.level !== t.level;
      O.tourney = t;
      O.level.hidden = false;
      O.level.classList.toggle('is-low', topCentreTaken());
      const next = t.next ? t.next.sb + '/' + t.next.bb + ' in ' + t.handsToNext : 'final level';
      O.level.replaceChildren(el('span', 'mp-level-lv', 'lv ' + t.level), el('span', 'mp-level-now', t.sb + '/' + t.bb + (t.ante ? ' a' + t.ante : '')),
        el('i', 'mp-level-sep'), el('span', 'mp-level-next', t.next ? 'next ' + next : next));
      O.level.setAttribute('aria-label', 'level ' + t.level + ', blinds ' + t.sb + ' ' + t.bb + (t.next ? ', next ' + t.next.sb + ' ' + t.next.bb + ' in ' + t.handsToNext + ' hands' : ''));
      if (changed && !(UI.reduced && UI.reduced())) {
        O.level.classList.remove('flash');
        void O.level.offsetWidth;
        O.level.classList.add('flash');
      }
      const tb = UI.byId ? UI.byId('tb-blinds') : doc.getElementById('tb-blinds');
      if (tb) tb.textContent = 'BLINDS ' + t.sb + '/' + t.bb;
      renderPlayers();
    }
    /** ui.js SEAT_ORDER puts an opponent top-centre unless there are 2, 4 or 5 of them. */
    function topCentreTaken() {
      const n = O.seats.length - (S.kind === 'client' && S.client.role === 'spectator' ? 0 : 1);
      return !(n === 2 || n === 4 || n === 5);
    }
    function onEliminated(e) {
      if (!O || !e) return;
      const me = O.seats.find(isMe);
      const who = me && me.id === e.id ? 'you' : e.name;
      const t = el('div', 'mp-toast');
      t.append(doc.createTextNode(who + ' finish' + (who === 'you' ? ' ' : 'es ')), el('b', null, ordinal(e.place)));
      if (e.points) t.append(doc.createTextNode(' · ' + e.points + ' pts'));
      O.toasts.replaceChildren(t);
      setTimeout(() => t.remove(), TOAST_MS);
      sysLine(who + ' finished ' + ordinal(e.place));
    }

    // -------------------------------------------------------------------- chat
    function chatDrawer() {
      const d = drawer('chat');
      const log = el('ol', 'mp-chat-log');
      log.setAttribute('aria-live', 'polite');
      const form = el('form', 'mp-chat-form');
      const input = el('input', 'mp-input');
      Object.assign(input, { type: 'text', maxLength: CHAT_MAX, placeholder: 'say hi', autocomplete: 'off' });
      input.setAttribute('aria-label', 'chat message');
      form.append(input, btn('send', 'grey', null, { small: true }));
      form.lastChild.type = 'submit';
      form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(input); });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      const emotes = el('div', 'mp-emotes');
      emotes.setAttribute('aria-label', 'emotes');
      EMOTES.forEach((id) => {
        const b = el('button', 'mp-emote', EMOTE_LABEL[id]);
        b.type = 'button';
        b.addEventListener('click', () => sendEmote(id, emotes));
        emotes.appendChild(b);
      });
      d.append(drawerHead('chat'), log, form, emotes);
      d._log = log;
      renderLog(log);
      return d;
    }
    function sendChat(input) {
      const text = String(input.value || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!text) return;
      if (S.kind === 'host') S.room.sendChat(text); else S.client.sendChat(text);
      input.value = '';
    }
    function sendEmote(id, box) {
      if (S.kind === 'host') S.room.sendEmote(id); else S.client.sendEmote(id);
      box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      setTimeout(() => box.querySelectorAll('button').forEach((b) => { b.disabled = false; }), EMOTE_COOLDOWN_MS);
    }
    function onChat(m) {
      if (!O || !m || !m.from) return;
      const mine = S.kind === 'host' ? m.from.seatId === 'hero' : !!(O.seats.find((s) => s.isYou && s.id === m.from.seatId));
      pushLine({ who: String(m.from.name || '?'), text: String(m.text || ''), mine });
    }
    function onEmote(m) {
      if (!m || !m.from || !EMOTE_LABEL[m.id]) return;
      try { if (UI.floatText && m.from.seatId) UI.floatText(m.from.seatId, EMOTE_LABEL[m.id], 'emote'); } catch (e) { console.error(e); }
      if (O) pushLine({ who: String(m.from.name || '?'), text: EMOTE_LABEL[m.id], emote: true });
    }
    function sysLine(text) { if (O) pushLine({ sys: true, text }); }
    function pushLine(line) {
      O.lines = O.lines.concat([line]).slice(-CHAT_LINES);
      if (O.open !== 'chat' && !line.sys) O.unread += 1;
      renderLog(O.chat._log);
      renderChatTab();
      scrollChat();
    }
    function renderChatTab() { setTab(O.tabChat, 'chat', O.unread); }
    function renderLog(log) {
      if (!O || !log) return;
      if (!O.lines.length) { log.replaceChildren(el('li', 'mp-chat-empty', 'No messages yet. Be nice, it’s play chips.')); return; }
      log.replaceChildren(...O.lines.map((l) => {
        if (l.sys) return el('li', 'mp-chat-sys', '— ' + l.text);
        const li = el('li', l.emote ? 'mp-chat-sys' : null);
        li.append(el('span', 'mp-chat-who' + (l.mine ? ' is-you' : ''), l.who + (l.emote ? ' ' : ': ')), doc.createTextNode(l.text));
        return li;
      }));
    }
    function scrollChat() { const log = O && O.chat._log; if (log) log.scrollTop = log.scrollHeight; }
    function setBanner(on) { if (O) O.banner.hidden = !on; }

    // ================================================================= podium
    function showPodium(results) {
      if (!UI.openModal) return;
      const isHost = S.kind === 'host';
      const standings = (results.standings || []).slice().sort((a, b) => a.place - b.place);
      const sng = results.mode === 'sng';
      const body = el('div', 'mp-podium-body');
      const sub = results.reason === 'host-ended' ? 'The host ended the game.' : sng ? 'One player has every chip.' : 'The table is settled.';
      body.append(el('p', 'mp-podium-sub', sub), pedestals(standings, sng), standingsList(standings, sng));
      const actions = isHost
        ? [{ label: S.offline ? 'play again' : 'run it back', kind: 'orange', value: 'again', primary: true }, { label: S.offline ? 'done' : 'close room', kind: 'grey', value: 'close' }]
        : [{ label: 'back to lobby', kind: 'orange', value: 'lobby', primary: true }, { label: 'leave', kind: 'grey', value: 'leave' }];
      const session = S;
      UI.openModal({ title: sng ? 'final standings' : 'game over', body, wide: true, className: 'mp-modal mp-podium', actions, cancelValue: actions[0].value })
        .then((v) => { if (session === S) afterPodium(v); });
      // with 4+ players the list scrolls inside the modal: make sure your own row is on screen
      const mine = body.querySelector('.mp-standings .is-you');
      if (mine && mine.scrollIntoView) setTimeout(() => mine.scrollIntoView({ block: 'nearest' }), 0);
    }
    function seatMeta(id) { return (O && O.seats.find((s) => s.id === id)) || (lobbyState() && lobbyState().seats.find((s) => s.id === id)) || null; }
    function pedestals(standings, sng) {
      const row = el('div', 'mp-steps');
      [2, 1, 3].forEach((place) => {
        const s = standings.find((x) => x.place === place);
        const col = el('div', 'mp-step' + (s ? '' : ' mp-step-empty'));
        col.dataset.place = String(place);
        if (s) {
          const m = seatMeta(s.id);
          col.append(face(s.name, m && m.avatar, 3), el('span', 'mp-step-name', s.name),
            el('span', 'mp-step-pts', sng && s.points != null ? s.points + ' pts' : chips(s.stack) + ' chips'));
        }
        const blk = el('div', 'mp-step-block', ordinal(place));
        blk.setAttribute('aria-hidden', 'true');
        col.append(blk);
        row.appendChild(col);
      });
      return row;
    }
    function standingsList(standings, sng) {
      const ol = el('ol', 'mp-standings');
      const h = el('li', 'mp-st-head');
      h.append(el('span', null, 'place'), el('span'), el('span', null, 'player'), el('span', 'mp-st-num', 'chips'), el('span', 'mp-st-num', sng ? 'points' : ''));
      ol.append(h);
      standings.forEach((s) => {
        const m = seatMeta(s.id);
        const li = el('li', m && isMe(m) ? 'is-you' : null);
        li.append(el('span', null, ordinal(s.place)), face(s.name, m && m.avatar), el('span', 'mp-st-name', s.name + (m && isMe(m) ? ' (you)' : '')),
          el('span', 'mp-st-num', chips(s.stack)), el('span', 'mp-st-num', sng && s.points != null ? String(s.points) : ''));
        ol.append(li);
      });
      return ol;
    }
    function afterPodium(v) {
      if (v === 'replaced' || !S) return;
      if (v === 'again') {
        quietEndNetGame();
        S.room.backToLobby();
        renderLobby();
        showMp();
      } else if (v === 'lobby') {
        quietEndNetGame();
        renderLobby();
        showMp();
      } else leave();
    }

    // ================================================================== mount
    function onKey(e) {
      if (!rootEl.isConnected || rootEl.offsetParent === null || e.defaultPrevented) return;
      if (UI.isModalOpen && UI.isModalOpen()) return;
      const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === 'Escape' && (screen === 'hub' || screen === 'join' || screen === 'error')) {
        e.preventDefault();
        if (screen === 'hub') { if (deps.showScreen) deps.showScreen('title'); } else openHub();
      } else if (e.key === 'Enter' && !typing && screen === 'lobby' && S && S.kind === 'host') {
        const b = rootEl.querySelector('[data-key="start"]');
        if (b && !b.disabled && doc.activeElement === doc.body) { e.preventDefault(); b.click(); }
      }
    }
    doc.addEventListener('keydown', onKey);
    rootEl.classList.add('mp');

    function handleInviteLink() {
      const Net = deps.Net || {};
      const code = Net.codeFromLocation && deps.location ? Net.codeFromLocation(deps.location) : null;
      if (!code) return false;
      openJoin(code);
      return true;
    }
    function destroy() {
      leave();
      doc.removeEventListener('keydown', onKey);
      rootEl.replaceChildren();
    }

    return Object.freeze({
      openHub, openJoin, openHost, openOfflineSng, handleInviteLink, destroy, leave,
      isInGame: () => !!(S && S.inGame),
    });
  }

  PP.Lobby = Object.freeze({ mount, STORE_KEY, EMOTES: Object.freeze(EMOTES.slice()), ordinal, cleanName, normalizeStore });
})();
