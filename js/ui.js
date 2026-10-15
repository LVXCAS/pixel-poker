/* PIXEL HOLD'EM — UI layer: DOM rendering, the room, the slip, human input.
 * Direction "Smoke & Felt": a tungsten-lit card room drawn at one unit (u) per art pixel.
 * Every table object is placed in frame units (480x300); CSS scales by --u. Pixel art lives in PP.Art.
 * Classic script (no modules). Attaches PP.UI. Holds no game rules — main.js drives it. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});
  const Art = PP.Art;

  // ------------------------------------------------------------------ constants
  const FRAME = { w: 480, h: 300 };
  const RANK_CHARS = '23456789TJQKA';
  const SUIT_TEXT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const NAME_CELLS = 12;
  const FOLD_CONFIRM_MS = 2200;
  const LOG_LIMIT = 150;
  const TICK_MS = 520;
  const SHAKE_MS = 480;
  const DEAL_STAGGER_MS = 85;
  const BOARD_STAGGER_MS = 150;
  const MUCK_MS = 140;
  const FLOAT_MS = 1500;
  const STAMP_MS = 1150;
  const FLY_CHIPS = 6;
  const FLY_MS = 420;
  const AWARD_MS = 520;
  const MOOD_RESET_MS = 2600;
  const FRAME_MS = 1000 / 60;
  const SMOKE_EVERY = 2;
  const DMD_FLASH_MS = 2200;
  const TITLE_CATCH_MS = 650;
  const ACTION_LABEL = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL IN' };
  const SHORT_VERB = { fold: 'fold', check: 'check', call: 'call', bet: 'bet', raise: 'raise', allin: 'all in', blind: '' };
  const DMD_VERB = { fold: 'FOLDS', check: 'CHECKS', call: 'CALLS', bet: 'BETS', raise: 'RAISES', allin: 'ALL IN' };
  const DMD_VERB_YOU = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', allin: 'ALL IN' };
  const GRADE_CLASS = { GREAT: 'great', GOOD: 'good', OK: 'ok', MISTAKE: 'mistake', BLUNDER: 'blunder' };
  const CONCEPT_TAG = {
    impliedOdds: 'implied odds', semiBluff: 'semi-bluff', value: 'value', position: 'position',
    preflop: 'starting hand', nuts: 'nuts', freeFold: 'free card', bbDefend: 'big blind defence',
  };
  const CONF_WORD = { high: 'clear', med: 'leaning', low: 'close call' };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PIXEL_ART = {
    s: ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '..###..'],
    h: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
    d: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
    c: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
    star: ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],
  };

  // Table layout in frame units. Seats run clockwise from the hero (bottom centre).
  // bet: tower left x + base y, label side. dealer: the button's top-left.
  const HERO_SEAT = { x: 124, y: 170, bet: { x: 104, y: 204, side: 'top' }, dealer: { x: 110, y: 228 } };
  const ANCHORS = {
    BL: { x: 2, y: 216, bet: { x: 62, y: 206, side: 'top' }, dealer: { x: 84, y: 202 } },
    LL: { x: 0, y: 140, bet: { x: 98, y: 168, side: 'right' }, dealer: { x: 88, y: 152 } },
    LU: { x: 0, y: 62, bet: { x: 70, y: 124, side: 'right' }, dealer: { x: 88, y: 98 } },
    TL: { x: 24, y: 2, bet: { x: 66, y: 62, side: 'right' }, dealer: { x: 104, y: 36 } },
    TC: { x: 130, y: 2, bet: { x: 150, y: 62, side: 'right' }, dealer: { x: 214, y: 36 } },
    TR: { x: 236, y: 2, bet: { x: 246, y: 60, side: 'right' }, dealer: { x: 228, y: 40 } },
    RU: { x: 240, y: 62, bet: { x: 296, y: 124, side: 'left' }, dealer: { x: 244, y: 100 } },
    BR: { x: 244, y: 216, bet: { x: 316, y: 212, side: 'left' }, dealer: { x: 232, y: 222 } },
  };
  const SEAT_ORDER = {
    1: ['TC'], 2: ['LU', 'RU'], 3: ['LU', 'TC', 'RU'], 4: ['LL', 'TL', 'TR', 'RU'],
    5: ['LL', 'LU', 'TL', 'TR', 'RU'], 6: ['LL', 'LU', 'TL', 'TC', 'TR', 'RU'],
    7: ['BL', 'LL', 'LU', 'TL', 'TC', 'TR', 'RU'], 8: ['BL', 'LL', 'LU', 'TL', 'TC', 'TR', 'RU', 'BR'],
  };
  const BOARD_POS = { x: 101, y: 70 };
  const POT_POS = { x: 134, y: 106 };
  const POT_CENTER = { x: 157, y: 120 };
  const DECK_POS = { x: 92, y: 66 };
  const SLIP_POS = { x: 184, y: 108 };
  const CENTER = { x: 168, y: 128 };

  const reducedMQ = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let speed = 1;

  // ---------------------------------------------------------------- dom helpers
  function byId(id) { return document.getElementById(id); }

  const NUM_RE = /\$?\d[\d,.]*%?/g;
  const NO_NUMIFY = new Set(['c-rank']);

  /** Sets text, wrapping every number in <span class="num"> (DOM nodes only — no HTML parsing). */
  function setText(node, text) {
    if (!node) return node;
    const str = text === undefined || text === null ? '' : String(text);
    if (!/\d/.test(str) || NO_NUMIFY.has(node.className)) { node.textContent = str; return node; }
    node.replaceChildren();
    let last = 0;
    str.replace(NUM_RE, (m, offset) => {
      if (offset > last) node.appendChild(document.createTextNode(str.slice(last, offset)));
      const span = document.createElement('span');
      span.className = 'num';
      span.textContent = m;
      node.appendChild(span);
      last = offset + m.length;
      return m;
    });
    if (last < str.length) node.appendChild(document.createTextNode(str.slice(last)));
    return node;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) setText(node, text);
    return node;
  }

  function clear(node) { if (node) node.replaceChildren(); return node; }

  function button(label, kind, opts) {
    const o = opts || {};
    const b = el('button', 'btn btn-' + (kind || 'grey') + (o.small ? ' btn-sm' : ''));
    b.type = 'button';
    b.appendChild(el('span', 'btn-label', label));
    if (o.kbd) b.appendChild(el('kbd', null, o.kbd));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }

  function money(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
  }

  /** Table amounts are chips, not dollars: "1,240". */
  function chips(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US');
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function reduced() { return !!reducedMQ.matches; }

  function setSpeed(f) {
    speed = f > 0 ? f : 1;
    document.documentElement.style.setProperty('--speed', String(speed));
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms * speed))); }

  /** Fractions (0..1) become percentages; values already >1 are treated as percentages. */
  function toPct(x) {
    const n = Number(x);
    if (x === null || x === undefined || !isFinite(n)) return null;
    return n <= 1 ? n * 100 : n;
  }

  function rankLabel(r) { return r === 10 ? '10' : RANK_CHARS[r - 2] || '?'; }
  function cardKey(c) { return c && c.r ? RANK_CHARS[c.r - 2] + c.s : ''; }
  function cardText(c) { return c && c.r ? rankLabel(c.r) + (SUIT_TEXT[c.s] || '') : '??'; }
  function cardsText(cards) { return (cards || []).map(cardText).join(' '); }

  function actionText(a) {
    if (!a) return '-';
    if (typeof a === 'string') return a.toUpperCase();
    const label = ACTION_LABEL[a.type] || String(a.type || '').toUpperCase();
    const showAmt = a.amount > 0 && a.type !== 'fold' && a.type !== 'check';
    return showAmt ? label + ' ' + money(a.amount) : label;
  }

  /** Units -> CSS length. */
  function U(n) { return 'calc(' + n + ' * var(--u))'; }
  function place(node, x, y) { node.style.left = U(x); node.style.top = U(y); return node; }

  /** Long names keep their " N" suffix and clip the base: "scanline sa. 2". */
  function seatName(name) {
    const s = String(name || '');
    if (s.length <= NAME_CELLS) return s;
    const m = s.match(/^(.*?)( \d+)$/);
    const suffix = m ? m[2] : '';
    const base = m ? m[1] : s;
    return base.slice(0, NAME_CELLS - suffix.length - 1) + '.' + suffix;
  }

  // --------------------------------------------------------------- pixel icons
  const pathCache = {};
  function bitmapPath(name) {
    if (pathCache[name]) return pathCache[name];
    let d = '';
    PIXEL_ART[name].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '#') d += 'M' + x + ' ' + y + 'h1v1h-1z';
    });
    pathCache[name] = d;
    return d;
  }

  function pixelIcon(name, cls) {
    const key = PIXEL_ART[name] ? name : 'star';
    const rows = PIXEL_ART[key];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + rows[0].length + ' ' + rows.length);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'px-icon' + (cls ? ' ' + cls : ''));
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', bitmapPath(key));
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function stars(rating, opts) {
    const o = opts || {};
    const wrap = el('div', 'stars');
    for (let i = 1; i <= 5; i++) {
      const s = el(o.interactive ? 'button' : 'span', 'star' + (i <= rating ? ' on' : ''));
      if (o.interactive) {
        s.type = 'button';
        s.setAttribute('aria-label', i + ' star' + (i > 1 ? 's' : ''));
        s.addEventListener('click', () => o.onPick && o.onPick(i));
      }
      s.appendChild(pixelIcon('star'));
      wrap.appendChild(s);
    }
    return wrap;
  }

  /** A 12x12 person drawn from the name (same name, same person, everywhere). */
  function avatar(seed) {
    const wrap = el('span', 'avatar');
    if (!Art) return wrap;
    const front = Art.personCanvas(seed, false);
    front.classList.add('av-front');
    const back = Art.personCanvas(seed, true);
    back.classList.add('av-back');
    wrap.append(front, back);
    return wrap;
  }

  // ------------------------------------------------------------- scale + room
  // One unit = s device pixels, s an integer: the frame is 480x300 units, centred, and the
  // room continues outward. --u is the unit in CSS px; --ox/--oy place the frame.
  const G = { s: 1, dpr: 1, u: 1, W: FRAME.w, H: FRAME.h, ox: 0, oy: 0 };

  function computeScale() {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.max(1, Math.floor(Math.min(innerWidth * dpr / FRAME.w, innerHeight * dpr / FRAME.h)));
    G.dpr = dpr;
    G.s = s;
    G.u = s / dpr;
    G.W = Math.ceil(innerWidth * dpr / s);
    G.H = Math.ceil(innerHeight * dpr / s);
    G.ox = Math.floor((G.W - FRAME.w) / 2);
    G.oy = Math.floor((G.H - FRAME.h) / 2);
    const root = document.documentElement.style;
    root.setProperty('--u', G.u + 'px');
    root.setProperty('--ox', (G.ox * G.u) + 'px');
    root.setProperty('--oy', (G.oy * G.u) + 'px');
    root.setProperty('--scale', String(s));
  }

  function unitsToPx(dx, dy) { return { x: dx * G.u, y: dy * G.u }; }

  const ROOM = {
    canvas: null, ctx: null, scene: 'title', mood: 'calm', cache: {}, smoke: null, smokeImg: null,
    ticks: 0, last: 0, resetTimer: 0, raf: 0, lit: false, catchAt: -1, needsPaint: true,
  };
  const CATCH = ['calm', 'out', 'out', 'brownout', 'brownout', 'brownout', 'calm'];

  function sceneFor(screen) {
    if (screen === 'title') return 'title';
    if (screen === 'stats' || screen === 'mp') return 'room';
    return 'table';
  }

  function roomImage(scene, mood) {
    const key = scene + '|' + mood;
    if (!ROOM.cache[key]) ROOM.cache[key] = Art.paintRoom(ROOM.ctx, G, scene, mood);
    return ROOM.cache[key];
  }

  function currentMood() {
    if (ROOM.scene === 'title' && !ROOM.lit) return 'out';
    if (ROOM.scene === 'title' && ROOM.catchAt >= 0) {
      const n = Math.floor((ROOM.ticks - ROOM.catchAt) / 3);
      if (n < CATCH.length) return CATCH[n];
    }
    return ROOM.mood;
  }

  function smokeGain(mood) {
    if (mood === 'out') return 0.3;
    if (mood === 'warm') return 1.25;
    if (mood === 'brownout') return 0.7;
    return ROOM.scene === 'title' ? 0.85 : 1;
  }

  function paintSmokeLayer(t, mood) {
    if (!ROOM.smoke) return;
    const sctx = ROOM.smoke.getContext('2d');
    if (!ROOM.smokeImg || ROOM.smokeImg.width !== G.W || ROOM.smokeImg.height !== G.H) ROOM.smokeImg = sctx.createImageData(G.W, G.H);
    Art.paintSmoke(ROOM.smokeImg, G, ROOM.scene, t, smokeGain(mood));
    sctx.putImageData(ROOM.smokeImg, 0, 0);
  }

  function drawRoom() {
    if (!ROOM.ctx || !Art) return;
    const mood = currentMood();
    ROOM.ctx.putImageData(roomImage(ROOM.scene, mood), 0, 0);
    if (ROOM.smoke) ROOM.ctx.drawImage(ROOM.smoke, 0, 0);
    if (ROOM.scene === 'title') Art.drawTitleProps(ROOM.ctx, G, mood, reduced() ? 0 : ROOM.ticks);
  }

  function resizeRoom() {
    computeScale();
    if (!ROOM.canvas) return;
    ROOM.canvas.width = G.W;
    ROOM.canvas.height = G.H;
    ROOM.canvas.style.width = (G.W * G.u) + 'px';
    ROOM.canvas.style.height = (G.H * G.u) + 'px';
    ROOM.ctx.imageSmoothingEnabled = false;
    ROOM.cache = {};
    if (!ROOM.smoke) ROOM.smoke = document.createElement('canvas');
    ROOM.smoke.width = G.W;
    ROOM.smoke.height = G.H;
    ROOM.smokeImg = null;
    paintSmokeLayer(300 + ROOM.ticks, currentMood());
    applyTextures();
    drawRoom();
    renderSlip();
  }

  function loop(now) {
    ROOM.raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - ROOM.last < FRAME_MS - 2) return;
    ROOM.last = now;
    ROOM.ticks += 1;
    const moving = !reduced();
    if (moving && ROOM.ticks % SMOKE_EVERY === 0) paintSmokeLayer(300 + ROOM.ticks, currentMood());
    if (moving || ROOM.needsPaint || (ROOM.scene === 'title' && ROOM.catchAt >= 0)) {
      drawRoom();
      ROOM.needsPaint = false;
    }
  }

  function startBackground(canvas) {
    if (!canvas || !canvas.getContext || !Art) return;
    ROOM.canvas = canvas;
    ROOM.ctx = canvas.getContext('2d');
    if (!ROOM.ctx) return;
    resizeRoom();
    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(resizeRoom, 60); });
    if (!ROOM.raf) ROOM.raf = requestAnimationFrame(loop);
  }

  function setScene(scene) {
    if (ROOM.scene === scene) return;
    ROOM.scene = scene;
    ROOM.needsPaint = true;
    paintSmokeLayer(300 + ROOM.ticks, currentMood());
    drawRoom();
  }

  /** 'calm' | 'danger' (brownout) | 'win' (the lamp warms) | 'out'. Non-calm moods fade back. */
  function setMood(mood) {
    clearTimeout(ROOM.resetTimer);
    const m = mood === 'danger' ? 'brownout' : mood === 'win' ? 'warm' : mood === 'out' ? 'out' : 'calm';
    ROOM.mood = m;
    ROOM.needsPaint = true;
    document.body.dataset.mood = mood || 'calm';
    if (m !== 'calm' && m !== 'out') ROOM.resetTimer = setTimeout(() => setMood('calm'), MOOD_RESET_MS);
    drawRoom();
  }

  function catchBulb() {
    if (ROOM.lit) return;
    ROOM.lit = true;
    ROOM.catchAt = reduced() ? -1 : ROOM.ticks;
    document.body.classList.add('lit');
    ROOM.needsPaint = true;
    drawRoom();
  }

  // Textures for the shared .slate / .paper / .chalk-text / .dmd classes.
  let texturesSet = false;
  function applyTextures() {
    if (!Art) return;
    const root = document.documentElement.style;
    if (!texturesSet) {
      const t = Art.textures();
      const url = (d) => (d ? 'url("' + d + '")' : 'none');
      root.setProperty('--tex-slate', url(t.slate));
      root.setProperty('--tex-wood', url(t.wood));
      root.setProperty('--tex-wood-v', url(t.woodV));
      root.setProperty('--tex-paper', url(t.paper));
      root.setProperty('--tex-dots', url(t.dots));
      root.setProperty('--tex-stitch', url(t.stitch));
      root.setProperty('--tex-felt', url(t.felt));
      root.setProperty('--tex-hatch', url(t.hatch));
      root.setProperty('--tex-chalk-dash', url(t.chalkDash));
      texturesSet = true;
    }
    // Masks are not pixelated by the browser: build them at device scale.
    const s = G.s;
    const chalk = maskTile(64, s, (x, y) => Art.hash(x, y, 77) > 0.05);
    const dots = maskTile(2, s, (x, y) => x === 0 && y === 0);
    if (chalk) root.setProperty('--mask-chalk', 'url("' + chalk + '")');
    if (dots) root.setProperty('--mask-dots', 'url("' + dots + '")');
  }
  function maskTile(n, s, on) {
    const c = document.createElement('canvas');
    c.width = n * s; c.height = n * s;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (on(x, y)) ctx.fillRect(x * s, y * s, s, s);
    try { return c.toDataURL('image/png'); } catch (err) { return ''; }
  }

  // --------------------------------------------------------------------- cards
  function cardFace(card, size, tone) {
    const sz = size === 'S' ? 'S' : 'M';
    const red = card.s === 'h' || card.s === 'd';
    const face = el('div', 'card face card-' + sz + ' ' + (red ? 'red' : 'black'));
    face.dataset.card = cardKey(card);
    face.setAttribute('role', 'img');
    face.setAttribute('aria-label', cardText(card));
    if (Art) face.appendChild(Art.cardCanvas(card, sz, tone ? Art.col(tone) : undefined));
    else face.textContent = cardText(card);
    return face;
  }

  function cardBack(size) {
    const sz = size === 'S' ? 'S' : 'M';
    const back = el('div', 'card back card-' + sz);
    back.setAttribute('role', 'img');
    back.setAttribute('aria-label', 'face-down card');
    if (Art) back.appendChild(Art.cardCanvas(null, sz));
    return back;
  }

  /**
   * Builds a card inside an animation wrapper.
   * opts: { faceDown, size: 'M'|'S', tone: css token, deal: {x, y, delay} (px offsets), flip, delay }
   */
  function cardNode(card, opts) {
    const o = opts || {};
    const wrap = el('div', 'card-wrap');
    const inner = !card || o.faceDown ? cardBack(o.size) : cardFace(card, o.size, o.tone);
    wrap.appendChild(inner);
    if (reduced()) return wrap;
    if (o.deal) {
      wrap.classList.add('dealing');
      wrap.style.setProperty('--from-x', Math.round(o.deal.x) + 'px');
      wrap.style.setProperty('--from-y', Math.round(o.deal.y) + 'px');
      wrap.style.setProperty('--deal-delay', Math.round((o.deal.delay || 0) * speed) + 'ms');
    } else if (o.flip) {
      wrap.classList.add('flipping');
      wrap.style.setProperty('--deal-delay', Math.round((o.delay || 0) * speed) + 'ms');
    }
    return wrap;
  }

  // --------------------------------------------------------------------- table
  const T = {
    heroId: null, order: [], seats: new Map(), bets: new Map(), pos: new Map(), layout: new Map(),
    holeKeys: new Map(), revealed: new Map(), boardKeys: [], dealt: false, meta: {}, verbs: new Map(),
    bb: 1, view: null,
  };

  function layoutFor(ids, heroId) {
    const heroIdx = Math.max(0, ids.indexOf(heroId));
    const n = ids.length;
    const bots = SEAT_ORDER[clamp(n - 1, 1, 8)] || SEAT_ORDER[8];
    const out = new Map();
    ids.forEach((id, i) => {
      const k = (i - heroIdx + n) % n;
      if (k === 0) out.set(id, { key: 'HERO', ...HERO_SEAT });
      else out.set(id, { key: bots[k - 1] || 'TC', ...ANCHORS[bots[k - 1] || 'TC'] });
    });
    return out;
  }

  function seatCenter(L) {
    if (!L) return CENTER;
    return L.key === 'HERO' ? { x: L.x + 25, y: L.y + 17 } : { x: L.x + 40, y: L.y + 14 };
  }

  function buildSeat(p, L) {
    const isHero = p.id === T.heroId;
    const meta = T.meta[p.id] || {};
    const root = el('div', 'seat' + (isHero ? ' hero' : ' seat-' + L.key.toLowerCase()) + (L.y < 30 ? ' top' : ''));
    place(root, L.x, L.y);
    root.dataset.id = p.id;
    root.dataset.anchor = L.key;
    const label = el('div', 'seat-hand');
    const cards = el('div', 'seat-cards');
    const plate = el('div', 'seat-plate');
    const head = el('div', 'seat-head');
    const badge = el('span', 'seat-badge');
    const av = avatar(meta.avatar ? p.name + '|' + meta.avatar : p.name);
    head.append(av, el('span', 'seat-name', isHero ? 'you' : seatName(p.name)), badge);
    const stack = el('div', 'seat-stack', chips(p.stack));
    const sub = el('div', 'seat-sub');
    if (!isHero) sub.appendChild(meta.kind === 'human' || meta.kind === 'host' ? el('span', 'seat-tag', 'player') : stars(meta.rating || 0));
    const timer = el('div', 'seat-timer');
    timer.appendChild(el('i'));
    plate.append(head, stack, sub, timer);
    const bubble = el('div', 'seat-bubble bubble-' + L.bet.side);
    place(bubble, L.bet.x - L.x + (L.bet.side === 'left' ? -46 : L.bet.side === 'top' ? -14 : 16), L.bet.y - L.y - 14);
    const lammer = el('div', 'lammer seat-allin', 'all in');
    root.append(label, cards, plate, bubble, lammer);
    if (meta.title) root.title = meta.title + (meta.style ? ' - ' + meta.style : '');
    T.seats.set(p.id, { root, cards, stack, badge, sub, timer, bubble, label, isHero });
    return root;
  }

  function buildBet(id, L) {
    const b = L.bet;
    const root = el('div', 'bet bet-' + b.side);
    if (b.side === 'left') {
      root.style.right = U(FRAME.w - b.x - Art.CHIP_W);
    } else if (b.side === 'top') {
      root.style.left = U(b.x + Art.CHIP_W / 2);
    } else {
      root.style.left = U(b.x);
    }
    root.style.bottom = U(FRAME.h - b.y - 1);
    const chipsBox = el('span', 'chip-stack');
    const amount = el('span', 'bet-amt', '0');
    root.append(chipsBox, amount);
    T.bets.set(id, { root, amount, chips: chipsBox, at: { x: b.x + 7, y: b.y - 8 }, shown: 0 });
    return root;
  }

  /** players: [{id, name, seat, stack}], meta: {id: {rating, title, style}} */
  function buildTable(players, heroId, meta) {
    const seatsLayer = clear(byId('seats'));
    const betsLayer = clear(byId('bets'));
    T.heroId = heroId;
    T.meta = meta || {};
    T.seats.clear();
    T.bets.clear();
    T.verbs.clear();
    const ordered = players.slice().sort((a, b) => (a.seat || 0) - (b.seat || 0));
    T.order = ordered.map((p) => p.id);
    T.layout = layoutFor(T.order, heroId);
    T.pos = new Map(T.order.map((id) => [id, seatCenter(T.layout.get(id))]));
    ordered.forEach((p) => {
      const L = T.layout.get(p.id);
      seatsLayer.appendChild(buildSeat(p, L));
      betsLayer.appendChild(buildBet(p.id, L));
    });
    const dealer = el('div', 'dealer-chip', 'd');
    dealer.id = 'dealer-chip';
    dealer.title = 'Dealer button';
    seatsLayer.appendChild(dealer);
    clear(byId('fx-layer'));
    resetHand();
  }

  /** Presence on a seat in net games: 'online'|'away'|'offline'|'sittingOut'|null (CSS in multiplayer.css). */
  function setSeatStatus(id, status) {
    const s = T.seats.get(id);
    if (!s) return;
    ['away', 'offline', 'sittingOut'].forEach((k) => s.root.classList.toggle('mp-' + k, status === k));
  }

  function resetHand() {
    T.dealt = false;
    T.holeKeys.clear();
    T.revealed.clear();
    T.verbs.clear();
    T.boardKeys = [];
    T.seats.forEach((s) => {
      clear(s.cards);
      s.root.classList.remove('winner', 'acting', 'allin', 'folded', 'has-bet');
      s.bubble.className = s.bubble.className.replace(/\s*(show|act-\S+)/g, '');
      s.label.className = 'seat-hand';
      s.label.textContent = '';
    });
    T.bets.forEach((b) => {
      b.root.classList.remove('show', 'gather');
      b.amount.dataset.value = '0';
      b.shown = 0;
      clear(b.chips);
    });
    document.querySelectorAll('#board .board-slot').forEach((slot) => clear(slot));
    const pot = byId('pot');
    if (pot) pot.classList.remove('glow', 'show');
    clear(byId('pot-pile'));
    POT.shown = 0;
    const sd = byId('showdown-name');
    if (sd) { sd.className = 'showdown-name'; clear(sd); }
    stopTimers();
    hideSlip(true);
    DM.flash = null;
    DM.last = '';
    updateDMD();
  }

  function holeKeyFor(p) {
    if (!T.dealt || p.out) return '';
    const hole = T.revealed.get(p.id) || p.hole;
    if (hole && hole.length) return hole.map(cardKey).join(' ');
    if (p.folded) return '';
    return 'XX XX';
  }

  function dealOrigin(id, delay) {
    const L = T.layout.get(id);
    const at = L ? (L.key === 'HERO' ? { x: L.x, y: L.y } : { x: L.x + 62, y: L.y + 14 }) : CENTER;
    const px = unitsToPx(DECK_POS.x - at.x, DECK_POS.y - at.y);
    return { x: px.x, y: px.y, delay };
  }

  function muck(container) {
    const wraps = Array.from(container.children);
    if (!wraps.length) return;
    if (reduced()) { clear(container); return; }
    wraps.forEach((w) => w.classList.add('mucking'));
    setTimeout(() => wraps.forEach((w) => w.remove()), MUCK_MS * speed + 30);
  }

  function renderHole(p, dealDelay) {
    const s = T.seats.get(p.id);
    if (!s) return;
    const key = holeKeyFor(p);
    const prev = T.holeKeys.get(p.id) || '';
    if (key === prev) return;
    T.holeKeys.set(p.id, key);
    if (!key) { muck(s.cards); return; }
    const wasBack = prev.indexOf('XX') === 0;
    const hole = T.revealed.get(p.id) || p.hole;
    const cards = hole && hole.length ? hole : [null, null];
    const size = s.isHero ? 'M' : 'S';
    clear(s.cards);
    cards.forEach((c, i) => {
      const opts = { faceDown: !c, size, tone: s.isHero ? 'paper' : 'paper-2' };
      if (!prev) opts.deal = dealOrigin(p.id, (dealDelay || 0) + i * DEAL_STAGGER_MS * T.order.length);
      else if (wasBack && c) { opts.flip = true; opts.delay = i * 117; }
      s.cards.appendChild(cardNode(c, opts));
    });
  }

  function blindBadge(p, view) {
    if ((!T.dealt && !view.handNumber) || p.out) return '';
    if (p.seat === view.bbSeat) return 'BB';
    if (p.seat === view.sbSeat) return 'SB';
    return '';
  }

  function betLabel(id, amount) {
    const verb = T.verbs.get(id) || '';
    const amt = chips(amount);
    const full = verb ? verb + ' ' + amt : amt;
    return full.length <= 9 ? full : amt;
  }

  function renderBet(id, amount) {
    const b = T.bets.get(id);
    if (!b) return;
    const show = amount > 0;
    b.root.classList.toggle('show', show);
    const s = T.seats.get(id);
    if (s) s.root.classList.toggle('has-bet', show);
    if (!show) { b.amount.dataset.value = '0'; if (b.shown) { clear(b.chips); b.shown = 0; } return; }
    setText(b.amount, betLabel(id, amount));
    b.amount.dataset.value = String(amount);
    if (b.shown === amount) return;
    const grew = amount > b.shown;
    b.shown = amount;
    const draw = () => {
      if (b.shown !== amount) return;
      clear(b.chips).appendChild(Art.towersCanvas(Art.towersFor(amount, T.bb, 1)));
      if (grew && !reduced()) {
        b.chips.classList.remove('land');
        void b.chips.offsetWidth;
        b.chips.classList.add('land');
      }
    };
    if (grew && !reduced() && T.layout.get(id)) {
      const L = T.layout.get(id);
      const from = L.key === 'HERO' ? { x: L.x + 20, y: L.y + 40 } : { x: L.x + 30, y: L.y + 20 };
      slideChips(from, { x: L.bet.x, y: L.bet.y - 6 }, 3, 'r');
      setTimeout(draw, 200 * speed);
    } else draw();
  }

  function renderSeat(p, view) {
    const s = T.seats.get(p.id);
    if (!s) return;
    const cl = s.root.classList;
    cl.toggle('folded', !!p.folded);
    cl.toggle('allin', !!p.allIn && !p.folded);
    cl.toggle('out', !!p.out);
    cl.toggle('acting', view.toActId === p.id && view.street !== 'showdown');
    tick(s.stack, p.stack, chips);
    const badge = blindBadge(p, view);
    setText(s.badge, badge.toLowerCase());
    s.badge.className = 'seat-badge' + (badge ? ' on badge-' + badge.toLowerCase() : '');
    renderBet(p.id, p.bet || 0);
    renderHole(p, 0);
  }

  function renderBoard(board) {
    const slots = document.querySelectorAll('#board .board-slot');
    const keys = (board || []).map(cardKey);
    const diverged = keys.length < T.boardKeys.length || T.boardKeys.some((k, i) => keys[i] !== k);
    if (diverged) { slots.forEach((slot) => clear(slot)); T.boardKeys = []; }
    const start = T.boardKeys.length;
    for (let i = start; i < keys.length && i < slots.length; i++) {
      clear(slots[i]);
      const delay = (i - start) * BOARD_STAGGER_MS;
      const from = unitsToPx(DECK_POS.x - (BOARD_POS.x + i * 28), DECK_POS.y - BOARD_POS.y);
      slots[i].appendChild(cardNode(board[i], { size: 'M', tone: 'paper-2', deal: { x: from.x, y: from.y, delay } }));
    }
    T.boardKeys = keys;
    return keys.length - start;
  }

  const POT = { shown: 0 };
  function renderPot(view) {
    const pot = byId('pot');
    if (!pot) return;
    const total = view.pot || 0;
    T.bb = view.bigBlind || T.bb;
    pot.classList.toggle('show', total > 0);
    tick(byId('pot-amount'), total, chips);
    const side = byId('pot-side');
    const pots = view.pots || [];
    if (side) setText(side, pots.length > 1 ? pots.map((pt, i) => (i ? 'side ' : 'main ') + chips(pt.amount)).join(' · ') : '');
    // The pile shows what has been gathered (the pot without this street's bets).
    const inBets = (view.players || []).reduce((sum, p) => sum + (p.bet || 0), 0);
    const gathered = Math.max(0, total - inBets);
    if (gathered !== POT.shown) {
      POT.shown = gathered;
      const pile = byId('pot-pile');
      if (pile) {
        clear(pile);
        if (gathered > 0) pile.appendChild(Art.towersCanvas(Art.towersFor(gathered, T.bb, 3)));
      }
    }
    DM.pot = total;
    updateDMD();
  }

  function renderDealer(view) {
    const chip = byId('dealer-chip');
    if (!chip) return;
    const dealer = (view.players || []).find((p) => p.seat === view.dealerSeat);
    const L = dealer && T.layout.get(dealer.id);
    chip.classList.toggle('show', !!L && (T.dealt || view.handNumber > 0));
    if (!L) return;
    place(chip, L.dealer.x, L.dealer.y);
  }

  function renderView(view) {
    if (!view || !view.players) return;
    T.view = view;
    if (view.bigBlind) T.bb = view.bigBlind;
    view.players.forEach((p) => renderSeat(p, view));
    renderBoard(view.board || []);
    renderPot(view);
    renderDealer(view);
  }

  /** Deal hole cards with a staggered animation around the table. Resolves when done. */
  async function dealHoles(view) {
    T.dealt = true;
    const players = (view.players || []).filter((p) => !p.out);
    const ordered = players.slice().sort((a, b) => a.seat - b.seat);
    const firstIdx = Math.max(0, ordered.findIndex((p) => p.seat > view.dealerSeat));
    const rotated = ordered.slice(firstIdx).concat(ordered.slice(0, firstIdx));
    rotated.forEach((p, i) => {
      renderHole(p, i * DEAL_STAGGER_MS);
      const s = T.seats.get(p.id);
      if (s) renderSeat(p, view);
    });
    renderPot(view);
    renderDealer(view);
    if (!reduced()) await wait(rotated.length * 2 * DEAL_STAGGER_MS + 300);
  }

  function revealHole(playerId, hole) {
    if (!hole || !hole.length) return;
    T.revealed.set(playerId, hole);
    renderHole({ id: playerId, hole, folded: false, out: false }, 0);
  }

  /** Slide every visible bet into the pot (constant acceleration: pushed from rest). */
  async function gatherBets() {
    let any = false;
    hideSlip(false);
    T.bets.forEach((b) => {
      if (!b.root.classList.contains('show')) return;
      any = true;
      const d = unitsToPx(POT_CENTER.x - b.at.x, POT_CENTER.y - b.at.y);
      b.root.style.setProperty('--gx', Math.round(d.x) + 'px');
      b.root.style.setProperty('--gy', Math.round(d.y) + 'px');
      b.root.classList.add('gather');
    });
    const done = () => T.bets.forEach((b) => {
      b.root.classList.remove('show', 'gather');
      b.amount.dataset.value = '0';
      b.shown = 0;
      clear(b.chips);
    });
    T.seats.forEach((s) => s.root.classList.remove('has-bet'));
    T.verbs.clear();
    if (!any || reduced()) { done(); return; }
    await wait(140);
    done();
  }

  function verbOf(text, kind) {
    if (SHORT_VERB[kind] !== undefined && kind !== 'blind') return SHORT_VERB[kind];
    return String(text || '').replace(/\$?[\d,]+/g, '').trim().toLowerCase();
  }

  function showBubble(playerId, text, kind) {
    const s = T.seats.get(playerId);
    if (!s) return;
    const verb = verbOf(text, kind);
    T.verbs.set(playerId, verb);
    setText(s.bubble, verb);
    const side = (s.bubble.className.match(/bubble-\S+/) || ['bubble-right'])[0];
    s.bubble.className = 'seat-bubble ' + side;
    void s.bubble.offsetWidth;
    s.bubble.className = 'seat-bubble ' + side + ' show act-' + (kind || 'info');
    const b = T.bets.get(playerId);
    if (b && b.shown > 0) setText(b.amount, betLabel(playerId, b.shown));
  }

  function showAction(playerId, type, amount) {
    showBubble(playerId, actionText({ type, amount }), type);
    const name = playerId === T.heroId ? 'YOU' : seatName((T.view && (T.view.players || []).find((p) => p.id === playerId) || {}).name || '');
    const amt = amount > 0 && type !== 'fold' && type !== 'check' ? ' ' + chips(amount) : '';
    const verbs = playerId === T.heroId ? DMD_VERB_YOU : DMD_VERB;
    DM.last = (name + ' ' + (verbs[type] || String(type).toUpperCase()) + amt).trim();
    updateDMD();
  }

  function clearBubbles() {
    T.seats.forEach((s) => { s.bubble.className = s.bubble.className.replace(/\s*(show|act-\S+)/g, ''); });
  }

  function showHandLabel(playerId, text, kind) {
    const s = T.seats.get(playerId);
    if (!s || !text) return;
    setText(s.label, text);
    s.label.className = 'seat-hand show' + (kind ? ' ' + kind : '');
  }

  /** The hero's read of their own hand: "AKs · premium", "two pair". */
  function setHeroRead(text) {
    const s = T.seats.get(T.heroId);
    if (!s) return;
    const str = String(text || '');
    const parts = str.split(' - ');
    const out = parts.length > 1 ? parts[0] + ' · ' + parts.slice(1).join(' ').toLowerCase() : str.toLowerCase();
    setText(s.sub, out);
  }

  function startTimer(playerId, ms) {
    stopTimers();
    const s = T.seats.get(playerId);
    if (!s) return;
    s.timer.style.setProperty('--t', Math.max(100, Math.round(ms * speed)) + 'ms');
    s.timer.classList.add('run');
  }

  function stopTimers() { T.seats.forEach((s) => s.timer.classList.remove('run')); }

  // ------------------------------------------------------------------- effects
  /** Counts a number up/down; follows the chips. format defaults to money. */
  function tick(node, to, format) {
    if (!node) return;
    const fmt = format || money;
    const target = Number(to) || 0;
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(target);
    if (from === target || reduced()) { node.textContent = fmt(target); return; }
    const token = (node._tickToken || 0) + 1;
    node._tickToken = token;
    const start = performance.now();
    node.classList.add('ticking');
    const step = (now) => {
      if (node._tickToken !== token) return;
      const k = Math.min(1, (now - start) / TICK_MS);
      node.textContent = fmt(from + (target - from) * (1 - (1 - k) * (1 - k)));
      if (k < 1) requestAnimationFrame(step);
      else node.classList.remove('ticking');
    };
    requestAnimationFrame(step);
  }

  function fxAt(cls, text, pos) {
    const layer = byId('fx-layer');
    if (!layer) return null;
    const node = el('div', cls, text);
    place(node, pos.x, pos.y);
    layer.appendChild(node);
    return node;
  }

  function floatText(playerId, text, kind) {
    const L = T.layout.get(playerId);
    const at = L ? (L.key === 'HERO' ? { x: L.x + 76, y: L.y + 56 } : { x: L.x + 16, y: L.y + 30 }) : CENTER;
    const node = fxAt('float-text ' + (kind || ''), String(text).toLowerCase(), at);
    if (node) setTimeout(() => node.remove(), FLOAT_MS);
  }

  /** A clay lammer dropped on the table: 'all in!', 'big pot!', 'champion!'. */
  function stamp(text, kind, playerId) {
    const L = playerId && T.layout.get(playerId);
    const at = L ? (L.key === 'HERO' ? { x: L.x + 126, y: L.y - 10 } : { x: L.x + 40, y: L.y + 36 }) : { x: 168, y: 46 };
    const node = fxAt('stamp ' + (kind || '') + (L ? ' at-seat' : ''), String(text).toLowerCase(), at);
    if (!node) return;
    const ms = Math.round(STAMP_MS * speed);
    node.style.animationDuration = ms + 'ms';
    setTimeout(() => node.remove(), ms);
  }

  /** Clay chips slide across the baize (constant friction), then land. Units in, units out. */
  function slideChips(from, to, count, type) {
    if (reduced()) return;
    for (let i = 0; i < count; i++) {
      const chip = fxAt('fly-chip', null, from);
      if (!chip) return;
      chip.appendChild(Art.chipCanvas(type || ['r', 'k', 'b'][i % 3]));
      const d = unitsToPx(to.x - from.x + (i % 2), to.y - from.y - i * 3);
      chip.style.setProperty('--dx', Math.round(d.x) + 'px');
      chip.style.setProperty('--dy', Math.round(d.y) + 'px');
      chip.style.animationDelay = Math.round(i * 50 * speed) + 'ms';
      setTimeout(() => chip.remove(), (FLY_MS + i * 50) * speed + 60);
    }
  }

  /** Percentage positions from older callers are not used: from/to are seat centres in units. */
  function flyChips(from, to, count) { slideChips(from, to, count || FLY_CHIPS); }

  function shake() {
    if (reduced()) return;
    const target = byId('table-stage');
    if (!target) return;
    target.classList.remove('shake');
    void target.offsetWidth;
    target.classList.add('shake');
    setTimeout(() => target.classList.remove('shake'), SHAKE_MS);
  }

  function markCards(best) {
    const keys = new Set((best || []).map(cardKey));
    if (!keys.size) return;
    document.querySelectorAll('#felt-wrap .card.face').forEach((c) => {
      const inBest = keys.has(c.dataset.card);
      if (inBest) c.classList.add('win-card');
      else if (c.closest('#board')) c.classList.add('dim');
    });
  }

  function showdownName(hand) {
    const node = byId('showdown-name');
    if (!node || !hand) return;
    const name = String(hand.catName || '').toLowerCase();
    const desc = String(hand.desc || '').toLowerCase().replace(/^[^,]*,\s*/, '');
    clear(node);
    node.append(el('span', 'sd-big' + (name.length > 9 ? ' long' : ''), name), el('span', 'sd-sub', desc && desc !== name ? desc : ''));
    node.className = 'showdown-name show';
  }

  /** awards: [{playerId, amount, hand|null}] — the pot slides to the winner, the count follows. */
  function celebrate(awards) {
    const pot = byId('pot');
    const pile = byId('pot-pile');
    let shown = false;
    (awards || []).forEach((a) => {
      const s = T.seats.get(a.playerId);
      if (!s || !(a.amount > 0)) return;
      s.root.classList.add('winner');
      const L = T.layout.get(a.playerId);
      const to = L ? { x: L.bet.x, y: L.bet.y - 10 } : CENTER;
      if (pile && pile.firstChild && !reduced()) {
        const ghost = fxAt('award-pile', null, { x: POT_POS.x, y: POT_POS.y });
        if (ghost) {
          ghost.appendChild(Art.towersCanvas(Art.towersFor(a.amount, T.bb, 3)));
          const d = unitsToPx(to.x - POT_POS.x - 10, to.y - POT_POS.y - 10);
          ghost.style.setProperty('--dx', Math.round(d.x) + 'px');
          ghost.style.setProperty('--dy', Math.round(d.y) + 'px');
          setTimeout(() => ghost.remove(), AWARD_MS * speed + 400);
        }
      }
      floatText(a.playerId, '+' + chips(a.amount), 'win');
      if (a.hand && a.hand.best) markCards(a.hand.best);
      if (a.hand && !shown) { showdownName(a.hand); shown = true; }
      const name = a.playerId === T.heroId ? 'YOU WIN' : (seatName((T.view && (T.view.players || []).find((p) => p.id === a.playerId) || {}).name || '') + ' WINS');
      DM.flash = { l1: '+' + chips(a.amount), l2: name, until: performance.now() + DMD_FLASH_MS, start: performance.now() };
    });
    if (pile) clear(pile);
    POT.shown = 0;
    if (pot) pot.classList.remove('glow');
    updateDMD();
    animateDMD();
  }

  // ------------------------------------------------------------- dot-matrix board
  const DM = { pot: 0, toCall: null, heroTurn: false, last: '', flash: null, raf: 0 };

  function idleLine() {
    const hand = (byId('tb-hand') || {}).textContent || '';
    const blinds = (byId('tb-blinds') || {}).textContent || '';
    const n = (hand.match(/\d+/) || [''])[0];
    const b = (blinds.match(/[\d/]+/) || [''])[0];
    return n && n !== '0' ? 'HAND ' + n + (b ? ' · ' + b : '') : b ? 'BLINDS ' + b : '';
  }

  function updateDMD(now) {
    const cv = byId('dmd');
    if (!cv || !Art) return;
    const t = now || performance.now();
    let l1 = DM.pot > 0 ? 'POT ' + chips(DM.pot) : 'POT 0';
    let l2 = DM.last || idleLine();
    let inv = false;
    if (DM.heroTurn) l2 = DM.toCall > 0 ? 'TO CALL ' + chips(DM.toCall) : 'CHECK IS FREE';
    if (DM.flash && t < DM.flash.until) {
      l1 = DM.flash.l1;
      l2 = DM.flash.l2;
      const f = Math.floor((t - DM.flash.start) / FRAME_MS);
      inv = !reduced() && f < 36 && Math.floor(f / 6) % 2 === 0;
    } else if (DM.flash) DM.flash = null;
    Art.drawDMD(cv, l1, l2, inv);
    cv.setAttribute('aria-label', (l1 + ', ' + l2).toLowerCase());
  }

  function animateDMD() {
    cancelAnimationFrame(DM.raf);
    const step = (now) => {
      updateDMD(now);
      if (DM.flash && now < DM.flash.until) DM.raf = requestAnimationFrame(step);
      else updateDMD(now);
    };
    DM.raf = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- action bar
  const AB = { resolve: null, view: null, legal: null, raiseTo: 0, min: 0, max: 0 };

  function statusText(s) {
    const str = String(s || '');
    const m = str.match(/^(.*) is thinking\.\.\.$/i);
    if (m) return seatName(m[1]).toLowerCase() + ' to act';
    if (/^checking is free/i.test(str)) return 'free check · fold again to fold';
    return str.toLowerCase();
  }

  function setActionMode(mode, status) {
    const bar = byId('action-bar');
    if (!bar) return;
    bar.dataset.mode = mode;
    const st = byId('ab-status');
    if (st) setText(st, statusText(status));
    const hero = mode === 'hero';
    ['btn-fold', 'btn-call', 'btn-raise', 'raise-slider', 'raise-input'].forEach((id) => {
      const n = byId(id);
      if (n && !hero) n.disabled = true;
    });
    document.querySelectorAll('#action-bar .preset').forEach((b) => { if (!hero) { b.disabled = true; b.classList.remove('rec'); } });
    if (!hero) {
      setLabel('call-label', 'call');
      setLabel('raise-label', 'raise');
      const fold = byId('btn-fold');
      if (fold && mode !== 'hero') fold.classList.remove('armed', 'soft');
    }
    if (!hero && DM.heroTurn) { DM.heroTurn = false; updateDMD(); }
  }

  function heroOf(view) { return (view.players || []).find((p) => p.id === T.heroId) || { stack: 0, bet: 0 }; }
  function callAmountOf(legal) { return Number(legal.callAmount !== undefined ? legal.callAmount : legal.toCall) || 0; }

  /** Button labels: the verb at 2x; long labels drop to 1x. */
  function setLabel(id, text) {
    const node = byId(id);
    if (!node) return;
    const str = String(text || '').toLowerCase();
    setText(node, str);
    node.classList.toggle('long', str.length > 9);
  }

  function configureButtons(view, legal) {
    const me = heroOf(view);
    const foldBtn = byId('btn-fold');
    foldBtn.disabled = !legal.canFold;
    foldBtn.classList.remove('armed');
    foldBtn.classList.toggle('soft', !!legal.canCheck);
    foldBtn.title = legal.canCheck ? 'Checking is free - fold needs a second press' : '';
    const call = byId('btn-call');
    const toCall = callAmountOf(legal);
    if (legal.canCheck) { call.disabled = false; setLabel('call-label', 'check'); }
    else if (legal.canCall) {
      call.disabled = false;
      setLabel('call-label', (toCall >= me.stack ? 'call all in ' : 'call ') + chips(toCall));
    } else { call.disabled = true; setLabel('call-label', 'call'); }
    const canAgg = !!(legal.canBet || legal.canRaise);
    AB.max = Number(legal.maxRaiseTo) || 0;
    AB.min = Math.min(Number(legal.minRaiseTo) || 0, AB.max);
    ['btn-raise', 'raise-slider', 'raise-input'].forEach((id) => { byId(id).disabled = !canAgg; });
    document.querySelectorAll('#action-bar .preset').forEach((b) => { b.disabled = !canAgg; b.classList.remove('rec'); });
    const slider = byId('raise-slider');
    slider.min = String(AB.min);
    slider.max = String(AB.max);
    slider.step = '1';
    setRaise(canAgg ? AB.min : 0);
    DM.heroTurn = true;
    DM.toCall = legal.canCheck ? 0 : toCall;
    updateDMD();
  }

  function setRaise(amount) {
    AB.raiseTo = AB.max ? clamp(Math.round(Number(amount) || 0), AB.min, AB.max) : 0;
    const slider = byId('raise-slider');
    const input = byId('raise-input');
    if (slider) slider.value = String(AB.raiseTo);
    if (input && document.activeElement !== input) input.value = String(AB.raiseTo);
    const legal = AB.legal || {};
    const canAgg = legal.canBet || legal.canRaise;
    let label = 'raise';
    if (canAgg) label = AB.raiseTo >= AB.max ? 'all in ' + chips(AB.max) : (legal.canBet ? 'bet ' : 'raise to ') + chips(AB.raiseTo);
    setLabel('raise-label', label);
    const fill = AB.max > AB.min ? ((AB.raiseTo - AB.min) / (AB.max - AB.min)) * 100 : 100;
    if (slider) slider.style.setProperty('--fill', fill.toFixed(1) + '%');
  }

  function presetTo(frac) {
    const view = AB.view || {};
    const legal = AB.legal || {};
    const toCall = Number(legal.toCall) || 0;
    const base = legal.canBet ? 0 : Number(view.currentBet) || 0;
    return base + frac * ((Number(view.pot) || 0) + toCall);
  }

  function bindActionBar() {
    byId('btn-fold').addEventListener('click', () => triggerAction('fold'));
    byId('btn-call').addEventListener('click', () => triggerAction('call'));
    byId('btn-raise').addEventListener('click', () => triggerAction('raise'));
    byId('raise-slider').addEventListener('input', (e) => setRaise(e.target.value));
    const input = byId('raise-input');
    input.addEventListener('input', () => setRaise(input.value));
    input.addEventListener('change', () => { setRaise(input.value); input.value = String(AB.raiseTo); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerAction('raise'); } });
    document.querySelectorAll('#action-bar .preset').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.frac === 'max') setRaise(AB.max);
        else setRaise(presetTo(Number(b.dataset.frac)));
      });
    });
  }

  function requestHumanAction(view, legal) {
    if (AB.resolve) submit({ type: 'fold' });
    AB.view = view;
    AB.legal = legal || {};
    AB.foldArmedAt = 0;
    setActionMode('hero', 'YOUR MOVE');
    configureButtons(view, AB.legal);
    markRecommendedPreset();
    return new Promise((resolve) => { AB.resolve = resolve; });
  }

  function submit(action) {
    if (!AB.resolve) return false;
    const resolve = AB.resolve;
    AB.resolve = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    setActionMode('waiting', '');
    resolve(action);
    return true;
  }

  /** kind: 'fold' | 'call' | 'raise' | 'allin'. Returns true when an action was submitted. */
  function triggerAction(kind) {
    if (!AB.resolve) return false;
    const legal = AB.legal || {};
    const canAgg = legal.canBet || legal.canRaise;
    if (kind === 'fold') {
      if (!legal.canFold) return false;
      if (legal.canCheck && !(AB.foldArmedAt && performance.now() - AB.foldArmedAt < FOLD_CONFIRM_MS)) {
        AB.foldArmedAt = performance.now();
        setActionMode('hero', 'CHECKING IS FREE! PRESS FOLD AGAIN TO FOLD ANYWAY');
        byId('btn-fold').classList.add('armed');
        return false;
      }
      return submit({ type: 'fold' });
    }
    if (kind === 'call') {
      if (legal.canCheck) return submit({ type: 'check' });
      return legal.canCall ? submit({ type: 'call' }) : false;
    }
    if (kind === 'allin') {
      if (canAgg) return submit({ type: 'allin' });
      return legal.canCall ? submit({ type: 'call' }) : false;
    }
    if (kind === 'raise' && canAgg) {
      if (AB.raiseTo >= AB.max) return submit({ type: 'allin' });
      return submit({ type: legal.canBet ? 'bet' : 'raise', amount: AB.raiseTo });
    }
    return false;
  }

  function adjustRaise(direction) {
    if (!AB.resolve) return;
    const step = Math.max(1, Number((AB.view || {}).bigBlind) || 1);
    setRaise(AB.raiseTo + direction * step);
  }

  function isAwaitingHuman() { return !!AB.resolve; }
  function cancelHumanAction() { return submit({ type: 'fold' }); }

  // --------------------------------------------------------------------- coach
  const coach = { advice: null, opts: {}, guess: null, page: 0 };

  /** The equity the coach decides with: vs their likely range when they have bet/raised. */
  function shownEquity(a) {
    return a && a.adjEquity != null ? a.adjEquity : a && a.equity;
  }

  function isAggressive(t) { return t === 'call' || t === 'bet' || t === 'raise' || t === 'allin'; }

  /** True when the coach's verdict disagrees with the bare price (implied odds, semi-bluffs...). */
  function verdictDiffers(a) {
    if (!a || !(a.toCall > 0)) return false;
    const eq = shownEquity(a);
    const priceSays = eq >= a.potOdds;
    const coachSays = isAggressive((a.recommendation || {}).type);
    return priceSays !== coachSays;
  }

  function line(cls, text) { return el('div', 'c-line' + (cls ? ' ' + cls : ''), text); }

  function operands(a) {
    const pot = Number(a.pot) || 0;
    const toCall = Number(a.toCall) || 0;
    return toCall > 0 ? 'call ' + chips(toCall) + ' · pot ' + chips(pot) : 'check is free · pot ' + chips(pot);
  }

  // The coach slate fits ~19 characters a line; short seat words keep the hand line on one row.
  const SHORT_POSITION = { button: 'btn', middle: 'mid', blinds: 'blinds', late: 'late', early: 'early' };
  function shortPosition(pos) { const k = String(pos).toLowerCase(); return SHORT_POSITION[k] || k; }

  function handLine(a) {
    if (a.street === 'preflop' || !a.made) {
      return [a.holeLabel, a.preflopTier && String(a.preflopTier).toLowerCase(), a.position && shortPosition(a.position)].filter(Boolean).join(' · ');
    }
    const outs = a.outs && (typeof a.outs === 'number' ? a.outs : a.outs.count);
    return String(a.made).toLowerCase().replace(/,.*$/, '') + (outs ? ' · ' + outs + ' outs' : '');
  }

  function verdictWord(rec) {
    const t = rec.type || 'check';
    const word = t === 'allin' ? 'all in' : t;
    return word;
  }

  function readLine(a) {
    const have = Math.round(toPct(shownEquity(a)) || 0);
    if (coach.guess === null) return line('dim', handLine(a));
    const off = Math.abs(have - coach.guess);
    return line(off <= 5 ? 'dim' : '', 'you ' + coach.guess + ' · off ' + off);
  }

  function reasonsList(reasons) {
    const list = el('ul', 'coach-reasons');
    (reasons || []).forEach((r) => list.appendChild(el('li', null, r)));
    return list;
  }

  function drawCoach() {
    const root = byId('coach-body');
    if (!root) return;
    clear(root);
    const panel = root.closest('.coach-panel');
    const a = coach.advice;
    const o = coach.opts;
    const set = (state) => { if (panel) panel.dataset.state = state; };
    if (o.enabled === false) {
      set('off');
      root.append(line('dim', 'coach off'), line('dim small', 'turn it on under table ▾'));
      return;
    }
    if (!a) {
      set('idle');
      root.append(line('dim', String(o.title || 'watching').toLowerCase()));
      if (o.message) root.appendChild(el('p', 'c-note', o.message));
      return;
    }
    root.appendChild(line('', operands(a)));
    const locked = o.guessMode && coach.guess === null && SL.state === 'waiting';
    if (locked) {
      set('read');
      root.append(line('dim', 'your read?'), line('dim small', 'click the slip at your equity, or type two digits'));
      return;
    }
    set('verdict');
    root.appendChild(readLine(a));
    const rec = a.recommendation || {};
    const tag = verdictDiffers(a) ? CONCEPT_TAG[a.concept] || '' : '';
    const conf = CONF_WORD[a.confidence] || '';
    root.appendChild(line('dim', [tag, conf].filter(Boolean).join(' · ')));
    const verdict = el('div', 'c-verdict');
    verdict.appendChild(el('span', 'c-word', verdictWord(rec)));
    if (rec.amount > 0 && (rec.type === 'bet' || rec.type === 'raise')) verdict.appendChild(el('span', 'c-amt', 'to ' + chips(rec.amount)));
    root.appendChild(verdict);
    const list = reasonsList(a.reasons);
    root.appendChild(list);
    const more = el('div', 'c-more dim');
    root.appendChild(more);
    requestAnimationFrame(() => pageReasons(list, more));
  }

  /** Shows whole reasons only; the rest go to the next page (Tab). Nothing is truncated. */
  function pageReasons(list, more) {
    const items = Array.from(list.children);
    if (!items.length) return;
    items.forEach((li) => { li.hidden = false; });
    const limit = list.getBoundingClientRect().bottom;
    const pages = [[]];
    let top = null;
    items.forEach((li) => {
      const r = li.getBoundingClientRect();
      if (top === null) top = r.top;
      const page = pages[pages.length - 1];
      if (page.length && r.bottom - top > limit - list.getBoundingClientRect().top + 1) { pages.push([li]); top = r.top; }
      else page.push(li);
    });
    coach.pages = pages;
    coach.page = clamp(coach.page || 0, 0, pages.length - 1);
    pages.forEach((pg, i) => pg.forEach((li) => { li.hidden = i !== coach.page; }));
    const rest = pages.slice(coach.page + 1).reduce((n, pg) => n + pg.length, 0);
    setText(more, pages.length > 1 ? (rest ? rest + ' more · tab' : 'tab · back to start') : '');
  }

  function nextReasonPage() {
    if (!coach.pages || coach.pages.length < 2) return false;
    coach.page = (coach.page + 1) % coach.pages.length;
    coach.pages.forEach((pg, i) => pg.forEach((li) => { li.hidden = i !== coach.page; }));
    const more = document.querySelector('#coach-body .c-more');
    const rest = coach.pages.slice(coach.page + 1).reduce((n, pg) => n + pg.length, 0);
    if (more) setText(more, rest ? rest + ' more · tab' : 'tab · back to start');
    return true;
  }

  /** opts: { enabled, guessMode, onGuess(guess, actualPct), title, message } */
  function renderCoach(advice, opts) {
    coach.advice = advice || null;
    coach.opts = opts || {};
    coach.guess = null;
    coach.page = 0;
    coach.pages = null;
    if (advice && coach.opts.enabled !== false) showSlip(advice, !!coach.opts.guessMode);
    else if (SL.state === 'waiting') releaseSlip();
    drawCoach();
  }

  function markRecommendedPreset() {
    const a = coach.advice;
    const rec = a && a.recommendation;
    if (!rec || !(rec.type === 'bet' || rec.type === 'raise') || !(rec.amount > 0)) return;
    if (coach.opts.guessMode && coach.guess === null && SL.state === 'waiting') return;
    let best = null;
    let bestD = Infinity;
    document.querySelectorAll('#action-bar .preset').forEach((b) => {
      const to = b.dataset.frac === 'max' ? AB.max : presetTo(Number(b.dataset.frac));
      const d = Math.abs(to - rec.amount);
      if (d < bestD) { bestD = d; best = b; }
    });
    if (best && !best.disabled) best.classList.add('rec');
  }

  // ------------------------------------------------------------------ the slip
  // The price is printed on the back, the truth on the face. Nick your read; it flips; ink pours.
  const SL = {
    state: 'hidden', need: null, have: 0, read: null, hollow: false, pour: 0, face: false,
    scaleX: 1, showLoss: false, showHave: false, guide: null, digits: '', raf: 0, t0: 0,
  };
  const FLIPT = [1, 0.66, 0.33, 0, 0, 0.33, 0.66, 1];

  function slipNode() { return byId('slip'); }

  function renderSlip() {
    const node = slipNode();
    if (!node || !Art) return;
    const cv = node.querySelector('canvas');
    const ctx = cv && cv.getContext('2d');
    if (!ctx) return;
    Art.drawSlip(ctx, {
      need: SL.need, have: SL.have, read: SL.read, face: SL.face, pour: SL.pour,
      showLoss: SL.showLoss, showHave: SL.showHave, hollow: SL.hollow, guide: SL.state === 'waiting' ? SL.guide : null,
    });
    cv.style.transform = SL.scaleX < 1 ? 'scaleX(' + SL.scaleX + ')' : '';
    const tab = byId('price-tab');
    if (tab) {
      const showTab = SL.need !== null && SL.state !== 'hidden' && SL.state !== 'sweep' && SL.scaleX >= 1;
      tab.hidden = !showTab;
      if (showTab) {
        place(tab, SLIP_POS.x + Art.SLIP.w, SLIP_POS.y + Art.SLIP.base - SL.need - 21);
        clear(tab);
        tab.append(el('span', 'pt-num', String(SL.need)), el('span', 'pt-pct', '%'));
        const left = SL.opponents >= 3 ? el('span', 'pt-left', '· ' + SL.opponents + ' left') : null;
        if (left) tab.appendChild(left);
      }
    }
  }

  function showSlip(advice, guessMode) {
    const node = slipNode();
    if (!node) return;
    cancelAnimationFrame(SL.raf);
    SL.need = advice.toCall > 0 ? clamp(Math.round((toPct(advice.potOdds) || 0)), 0, 100) : null;
    SL.have = clamp(Math.round(toPct(shownEquity(advice)) || 0), 0, 100);
    SL.hollowWanted = verdictDiffers(advice);
    SL.opponents = advice.opponents || 0;
    SL.read = null;
    SL.digits = '';
    SL.guide = null;
    node.hidden = false;
    node.classList.remove('sweep');
    if (guessMode) {
      Object.assign(SL, { state: 'waiting', face: false, pour: 0, scaleX: 1, showLoss: false, showHave: false, hollow: false });
    } else {
      Object.assign(SL, { state: 'done', face: true, pour: SL.have, scaleX: 1, showLoss: true, showHave: true, hollow: SL.hollowWanted });
    }
    node.classList.toggle('waiting', SL.state === 'waiting');
    renderSlip();
  }

  /** Flip, then pour at a constant 2 points per frame: distance is duration. */
  function runSlip(onDone) {
    const node = slipNode();
    if (node) node.classList.remove('waiting');
    if (reduced()) {
      Object.assign(SL, { state: 'done', face: true, scaleX: 1, pour: SL.have, showLoss: true, showHave: true, hollow: SL.hollowWanted });
      renderSlip();
      if (onDone) onDone();
      return;
    }
    SL.state = 'flipping';
    SL.t0 = performance.now();
    const pourAt = 10;
    const step = (now) => {
      const f = Math.floor((now - SL.t0) / FRAME_MS);
      if (f < 8) { SL.scaleX = FLIPT[f]; SL.face = f >= 4; }
      else { SL.scaleX = 1; SL.face = true; }
      if (f >= pourAt) {
        SL.state = 'pouring';
        SL.pour = clamp((f - pourAt) * 2, 0, SL.have);
      }
      const poured = f >= pourAt && (f - pourAt) * 2 >= SL.have;
      if (poured) {
        SL.showHave = true;
        SL.showLoss = true;
        SL.hollow = SL.hollowWanted;
      }
      renderSlip();
      if (poured) { SL.state = 'done'; if (onDone) onDone(); return; }
      SL.raf = requestAnimationFrame(step);
    };
    SL.raf = requestAnimationFrame(step);
  }

  function commitRead(value) {
    if (SL.state !== 'waiting' || !coach.advice) return;
    const v = clamp(Math.round(value), 0, 100);
    SL.read = v;
    SL.guide = null;
    SL.digits = '';
    coach.guess = v;
    const actual = toPct(shownEquity(coach.advice));
    if (coach.opts.onGuess && actual !== null) coach.opts.onGuess(v, actual);
    renderSlip();
    runSlip(() => { drawCoach(); markRecommendedPreset(); });
    drawCoach();
  }

  /** The hero acted without a read: the slip still turns over and pours. No nick. */
  function releaseSlip() {
    if (SL.state !== 'waiting') return;
    runSlip(null);
  }

  function hideSlip(now) {
    const node = slipNode();
    if (!node || SL.state === 'hidden') return;
    cancelAnimationFrame(SL.raf);
    const tab = byId('price-tab');
    if (tab) tab.hidden = true;
    if (now || reduced()) { SL.state = 'hidden'; node.hidden = true; node.classList.remove('sweep', 'waiting'); return; }
    SL.state = 'sweep';
    node.classList.add('sweep');
    setTimeout(() => { if (SL.state === 'sweep') { SL.state = 'hidden'; node.hidden = true; node.classList.remove('sweep'); } }, 140);
  }

  function slipPoint(e) {
    const node = slipNode();
    const r = node.getBoundingClientRect();
    const uy = Math.floor((e.clientY - r.top) / G.u);
    return clamp(Art.SLIP.base - uy, 0, 100);
  }

  function bindSlip() {
    const node = slipNode();
    if (!node) return;
    node.addEventListener('pointermove', (e) => {
      if (SL.state !== 'waiting') return;
      SL.guide = slipPoint(e);
      renderSlip();
    });
    node.addEventListener('pointerleave', () => { if (SL.state === 'waiting') { SL.guide = null; renderSlip(); } });
    node.addEventListener('click', (e) => { if (SL.state === 'waiting') commitRead(slipPoint(e)); });
    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.screen !== 'table' || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Tab' && SL.state !== 'waiting' && coach.advice && nextReasonPage()) { e.preventDefault(); return; }
      if (SL.state !== 'waiting' || !/^[0-9]$/.test(e.key)) return;
      e.preventDefault();
      SL.digits += e.key;
      SL.guide = Number(SL.digits) * (SL.digits.length === 1 ? 10 : 1);
      renderSlip();
      if (SL.digits.length === 2) commitRead(Number(SL.digits));
    });
  }

  // ----------------------------------------------------------------------- log
  /** parts: string or [string | {t, c}] — c is a CSS class for colouring a fragment. */
  function log(parts, kind) {
    const list = byId('log');
    if (!list) return;
    const li = el('li', 'log-' + (kind || 'info'));
    (Array.isArray(parts) ? parts : [parts]).forEach((p) => {
      if (p && typeof p === 'object') li.appendChild(el('span', p.c || null, p.t));
      else li.appendChild(document.createTextNode(String(p)));
    });
    list.appendChild(li);
    while (list.children.length > LOG_LIMIT) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  function clearLog() { clear(byId('log')); }

  // -------------------------------------------------------------------- modals
  let modal = null;

  /**
   * actions: [{label, kind, value, primary, kbd}] — resolves with the clicked action's value.
   * The primary action answers SPACE/ENTER; ESC answers the primary too unless `cancelValue` is given.
   */
  function openModal(spec) {
    const s = spec || {};
    if (modal) modal.close(undefined);
    const root = byId('modal-root');
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal panel slate' + (s.wide ? ' wide' : '') + (s.className ? ' ' + s.className : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (s.title) box.appendChild(el('h2', 'modal-title', s.title));
    if (s.body) {
      const wrap = el('div', 'modal-body');
      wrap.appendChild(s.body);
      box.appendChild(wrap);
    }
    const bar = el('div', 'modal-actions');
    box.appendChild(bar);
    overlay.appendChild(box);
    root.appendChild(overlay);
    const isBust = /modal-bust/.test(s.className || '');
    if (isBust) setMood('out');
    return new Promise((resolve) => {
      const actions = s.actions && s.actions.length ? s.actions : [{ label: 'OK', kind: 'orange', value: 'ok', primary: true }];
      const close = (value) => {
        if (modal && modal.overlay === overlay) modal = null;
        overlay.classList.add('closing');
        if (isBust && ROOM.mood === 'out') setMood('calm');
        setTimeout(() => overlay.remove(), reduced() ? 0 : 120);
        resolve(value);
      };
      let primaryBtn = null;
      actions.forEach((a) => {
        const b = button(a.label, a.kind || 'grey', { kbd: a.kbd });
        b.addEventListener('click', () => close(a.value));
        bar.appendChild(b);
        if (a.primary) primaryBtn = b;
      });
      const primary = actions.find((a) => a.primary) || actions[0];
      modal = {
        overlay, close,
        primaryValue: primary.value,
        cancelValue: s.cancelValue !== undefined ? s.cancelValue : primary.value,
      };
      if (primaryBtn) setTimeout(() => primaryBtn.focus({ preventScroll: true }), 30);
    });
  }

  function isModalOpen() { return !!modal; }
  function modalPrimary() { if (modal) modal.close(modal.primaryValue); }
  function modalCancel() { if (modal) modal.close(modal.cancelValue); }
  function closeModal(value) { if (modal) modal.close(value); }

  function miniCards(cards, cls) {
    const row = el('div', 'mini-cards' + (cls ? ' ' + cls : ''));
    (cards || []).forEach((c) => row.appendChild(cardNode(c, { size: 'M' })));
    return row;
  }

  function labeledCards(label, cards) {
    const box = el('div', 'review-cards-group');
    box.append(el('span', 'coach-k', label), cards && cards.length ? miniCards(cards) : el('span', 'muted', 'none'));
    return box;
  }

  function decisionsTable(decisions) {
    if (!decisions || !decisions.length) return el('p', 'muted', 'You had no decisions this hand.');
    const list = el('div', 'decisions');
    decisions.forEach((d) => {
      const row = el('div', 'decision');
      const grade = String(d.grade || 'OK').toUpperCase();
      row.append(
        el('span', 'd-street', String(d.street || '').toUpperCase()),
        el('span', 'd-action', actionText(d.action)),
        el('span', 'grade grade-' + (GRADE_CLASS[grade] || 'ok'), grade),
        el('span', 'd-note', d.note || ''),
      );
      list.appendChild(row);
    });
    return list;
  }

  function revealHoleFor(reveal, record) {
    if (reveal.hole) return reveal.hole;
    const p = (record.players || []).find((x) => x.id === reveal.playerId || x.name === reveal.name);
    return p && p.hole;
  }

  function revealRow(r, record) {
    const row = el('div', 'reveal');
    const head = el('div', 'reveal-head');
    head.append(miniCards(revealHoleFor(r, record)), el('span', 'reveal-name', r.name || '?'),
      el('span', 'reveal-label', r.holeLabel || ''), el('span', 'reveal-desc', r.handDesc || ''));
    row.appendChild(head);
    if (r.reasoning) row.appendChild(el('p', 'reveal-why', r.reasoning));
    return row;
  }

  /** Names of players who folded before the flop (shown as one compact row). */
  function preflopFolders(record) {
    const ids = new Set((record.actions || []).filter((a) => a.type === 'fold' && a.street === 'preflop').map((a) => a.playerId));
    return new Set((record.players || []).filter((p) => ids.has(p.id)).map((p) => p.name));
  }

  function revealsList(reveals, record) {
    const list = el('div', 'reveals');
    const folders = preflopFolders(record);
    const early = reveals.filter((r) => folders.has(r.name));
    reveals.filter((r) => !folders.has(r.name)).forEach((r) => list.appendChild(revealRow(r, record)));
    if (early.length) {
      const row = el('div', 'reveal compact');
      row.appendChild(el('span', 'coach-k', 'FOLDED PREFLOP'));
      early.forEach((r) => {
        const chip = el('span', 'fold-chip');
        chip.title = r.reasoning || '';
        chip.append(el('span', 'reveal-name', r.name || '?'), el('span', 'reveal-label', r.holeLabel || ''));
        row.appendChild(chip);
      });
      list.appendChild(row);
    }
    return list;
  }

  function showReview(review, record, heroId, actions) {
    const rv = review || {};
    const rec = record || {};
    const body = el('div', 'review');
    body.appendChild(el('p', 'review-headline', rv.headline || 'Hand complete.'));
    if (rv.lesson) {
      const lesson = el('div', 'lesson paper');
      lesson.append(el('span', 'lesson-tag', 'LESSON'), el('p', null, rv.lesson));
      body.appendChild(lesson);
    }
    const hero = (rec.players || []).find((p) => p.id === heroId);
    const cards = el('div', 'review-cards');
    cards.append(labeledCards('YOUR HAND', hero && hero.hole), labeledCards('BOARD', rec.board));
    body.appendChild(cards);
    body.appendChild(el('h3', 'section-title', 'YOUR DECISIONS'));
    body.appendChild(decisionsTable(rv.heroDecisions));
    if (rv.reveals && rv.reveals.length) {
      body.appendChild(el('h3', 'section-title', 'WHAT THEY HELD'));
      body.appendChild(revealsList(rv.reveals, rec));
    }
    return openModal({
      title: 'HAND #' + (rec.handNumber || '?') + ' REVIEW',
      body, wide: true, className: 'modal-review',
      actions: actions || [{ label: 'NEXT HAND', kind: 'orange', value: 'next', primary: true, kbd: 'SPACE' }],
      cancelValue: actions && actions.some((a) => a.value === 'table') ? 'table' : undefined,
    });
  }

  // ------------------------------------------------------------------- screens
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    document.body.dataset.screen = name;
    setScene(sceneFor(name));
    closeSheet();
    if (name === 'title') selectMenu(MENU.sel, false);
  }

  function currentScreen() { return document.body.dataset.screen || ''; }

  // Title menu: up/down choose, enter picks. PLAY falls through to main.js (enter sits you down).
  const MENU = { sel: 0 };
  function menuItems() { return Array.from(document.querySelectorAll('.title-menu .menu-item')).filter((b) => !b.hidden); }
  function selectMenu(i, focus) {
    const items = menuItems();
    if (!items.length) return;
    MENU.sel = (i + items.length) % items.length;
    items.forEach((b, k) => b.classList.toggle('sel', k === MENU.sel));
    if (focus) items[MENU.sel].focus({ preventScroll: true });
  }
  function bindTitle() {
    menuItems().forEach((b, i) => {
      b.addEventListener('pointerenter', () => selectMenu(i, false));
      b.addEventListener('focus', () => selectMenu(i, false));
    });
    selectMenu(0, false);
    const wake = () => catchBulb();
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
    setTimeout(wake, TITLE_CATCH_MS);
    window.addEventListener('keydown', (e) => {
      if (currentScreen() !== 'title' || isModalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectMenu(MENU.sel + (e.key === 'ArrowDown' ? 1 : -1), true);
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && MENU.sel > 0) {
        const item = menuItems()[MENU.sel];
        if (!item) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        item.click();
      }
    }, true);
  }

  // The table sheet: coach / guess / review / auto-deal / speed live behind "table ▾".
  function closeSheet() {
    const sheet = byId('tb-sheet');
    const more = byId('tb-more');
    if (sheet) sheet.hidden = true;
    if (more) more.setAttribute('aria-expanded', 'false');
  }
  function bindSheet() {
    const sheet = byId('tb-sheet');
    const more = byId('tb-more');
    if (!sheet || !more) return;
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = sheet.hidden;
      sheet.hidden = !open;
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && e.target !== more) closeSheet();
    });
  }

  function init() {
    setSpeed(speed);
    computeScale();
    if (byId('action-bar')) bindActionBar();
    bindSlip();
    bindTitle();
    bindSheet();
    startBackground(byId('bg'));
    updateDMD();
    if (document.fonts && document.fonts.load) {
      document.fonts.load('11px "Departure Mono"').then(() => {
        updateDMD();
        renderSlip();
        ROOM.needsPaint = true;
      }, () => {});
    }
  }

  function geometry() { return { u: G.u, s: G.s, ox: G.ox * G.u, oy: G.oy * G.u, frame: FRAME }; }

  PP.UI = Object.freeze({
    // helpers
    el, setText, byId, clear, button, money, chips, wait, setSpeed, reduced, toPct, actionText, cardKey, cardText, cardsText,
    pixelIcon, stars, avatar, cardNode, miniCards,
    // background + effects
    startBackground, setMood, shake, stamp, floatText, flyChips, celebrate, tick,
    // table
    buildTable, resetHand, setSeatStatus, renderView, dealHoles, revealHole, gatherBets, showAction, showBubble,
    clearBubbles, showHandLabel, setHeroRead, startTimer, stopTimers,
    // human input
    setActionMode, requestHumanAction, triggerAction, adjustRaise, isAwaitingHuman, cancelHumanAction,
    // panels
    renderCoach, log, clearLog,
    // modals + screens
    openModal, closeModal, isModalOpen, modalPrimary, modalCancel, showReview, showScreen, currentScreen,
    init,
    // layout (frame units) for overlays such as the tutorial
    geometry, LAYOUT: Object.freeze({ FRAME, HERO_SEAT, ANCHORS, BOARD_POS, POT_POS, SLIP_POS }),
  });
})();
