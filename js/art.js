/* PIXEL HOLD'EM — pixel art: the room, cards, clay chips, people, the slip, the dot-matrix board.
 * Direction "Smoke & Felt": one tungsten bulb, haze in its cone, olive baize, oxblood leather,
 * engraved paper cards, clay chips and a chalk slate. Everything is drawn at 1 canvas px = 1 unit (u)
 * and scaled by CSS with image-rendering: pixelated. Classic script; attaches PP.Art. Browser only. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------------ palette
  const K = {};
  function col(name) {
    if (K[name]) return K[name];
    const v = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
    if (v) K[name] = v;
    return v || '#ff00ff';
  }
  function hex(h) {
    const s = col(h).replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function hash(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s || 0) | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function canvas(w, h, cls) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    if (cls) c.className = cls;
    c.style.setProperty('--w', String(c.width));
    c.style.setProperty('--h', String(c.height));
    return c;
  }
  function pen(ctx) {
    return {
      rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); },
      px(x, y, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), 1, 1); },
    };
  }
  function bitmap(p, rows, x, y, map) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        let c = map[row[i]];
        if (typeof c === 'function') c = c(x + i, y + j);
        if (c) p.rect(x + i, y + j, 1, 1, c);
      }
    });
  }

  // ------------------------------------------------------------------ type on canvas
  // Departure Mono at 11u x k, thresholded to the unit grid (as the mockups do).
  const FONT = '"Departure Mono", ui-monospace, Menlo, monospace';
  const CELL = 7;
  const glyphCache = new Map();
  function glyphs(str, k, color) {
    const key = str + '|' + k + '|' + color;
    if (glyphCache.has(key)) return glyphCache.get(key);
    const w = Math.max(1, str.length * CELL * k);
    const h = 14 * k;
    const oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    const o = oc.getContext('2d');
    o.font = (11 * k) + 'px ' + FONT;
    o.fillStyle = color;
    o.textBaseline = 'alphabetic';
    o.fillText(str, 0, 11 * k);
    const id = o.getImageData(0, 0, w, h);
    const d = id.data;
    for (let p = 3; p < d.length; p += 4) d[p] = d[p] >= 128 ? 255 : 0;
    o.putImageData(id, 0, 0);
    if (document.fonts && document.fonts.check && document.fonts.check('11px "Departure Mono"')) glyphCache.set(key, oc);
    return oc;
  }
  function text(ctx, str, x, y, k, color, align) {
    const g = glyphs(String(str), k || 1, color);
    let dx = Math.round(x);
    if (align === 'right') dx -= g.width;
    else if (align === 'center') dx -= Math.round(g.width / 2);
    ctx.drawImage(g, dx, Math.round(y));
    return g.width;
  }

  // ------------------------------------------------------------------ cards
  // M 24x34 (board, hero), S 14x19 (bots). Real pip layouts; engraved court busts.
  const PIP7 = {
    s: ['...#...', '..###..', '.#####.', '#######', '##.#.##', '...#...', '..###..'],
    h: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
    d: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
    c: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
  };
  const PIP5 = {
    h: ['##.##', '#####', '#####', '.###.', '..#..'],
    d: ['..#..', '.###.', '#####', '.###.', '..#..'],
    s: ['..#..', '.###.', '#####', '#####', '.#.#.'],
    c: ['.###.', '.###.', '#####', '#.#.#', '..#..'],
  };
  const SUIT_INK = { s: 'ink', h: 'red-ink', d: 'blue-ink', c: 'green-ink' };
  const RANK = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const PIPS = {
    2: [[12, 11], [12, 26]], 3: [[12, 11], [12, 18], [12, 26]],
    4: [[7, 11], [17, 11], [7, 26], [17, 26]],
    5: [[7, 11], [17, 11], [12, 18], [7, 26], [17, 26]],
    6: [[7, 11], [17, 11], [7, 18], [17, 18], [7, 26], [17, 26]],
    7: [[7, 11], [17, 11], [12, 14], [7, 18], [17, 18], [7, 26], [17, 26]],
    8: [[7, 11], [17, 11], [12, 14], [7, 18], [17, 18], [12, 22], [7, 26], [17, 26]],
    9: [[7, 10], [17, 10], [7, 15], [17, 15], [12, 18], [7, 21], [17, 21], [7, 26], [17, 26]],
    10: [[7, 10], [17, 10], [12, 13], [7, 15], [17, 15], [7, 21], [17, 21], [12, 23], [7, 26], [17, 26]],
  };
  // engraved court busts 15x20. '#' suit fill, 'k' ink line, ':' ink hatch, '+' paper-shade, '=' suit hatch
  const COURT = {
    13: ['.#...#...#...#.', '.##.###.###.##.', '.#############.', '.kkkkkkkkkkkkk.', '..k:.......:k..', '..k..kk.kk..k..',
      '..k..k...k..k..', '..k.....k...k..', '..k:...kk..:k..', '..k::kkkkk::k..', '..k:::::::::k..', '...k:::k:::k...',
      '+k+.k:::::k.+k+', 'k+k+.kkkkk.+k+k', '#####+k+k+#####', '#=#=#+++++#=#=#', '##=##k+k+k##=##', '#=#=#+++++#=#=#',
      '##=##+k+k+##=##', '#=#=#+++++#=#=#'],
    11: ['..........##...', '.........##....', '...########....', '..##########...', '..kkkkkkkkkkk..', '..k:.......:k..',
      '..k:.kk.kk.:k..', '..k:.k...k.:k..', '..k:....k..:k..', '..k:...kk..:k..', '...k..kkk..k...', '....k.....k....',
      '.....kkkkk.....', '..+k+k+k+k+k+..', '.+k+k+k+k+k+k+.', '#####+++++#####', '#=#=#+k+k+#=#=#', '##=##+++++##=##',
      '#=#=#+k+k+#=#=#', '##=##+++++##=##'],
    12: ['....#.#.#.#....', '...#########...', '..k#########k..', '.k:kkkkkkkkk:k.', '.k:k.......k:k.', '.k:k.kk.kk.k:k.',
      '.k:k.k...k.k:k.', '.k:k....k..k:k.', '.k:k...kk..k:k.', '.k:.k.kkk.k.:k.', '.k:..k...k..:k.', '.k:...kkk...:k.',
      '.k+k+k+k+k+k+k.', '#####+k+k+#####', '#=#=#++#++#=#=#', '##=##+###+##=##', '#=#=#++#++#=#=#', '##=##+++++##=##',
      '#=#=#+k+k+#=#=#', '##=##+++++##=##'],
  };
  const ACE = { // a large engraved ace pip, 13x13
    s: ['......#......', '.....###.....', '....#####....', '...#######...', '..#########..', '.###########.',
      '#############', '#############', '####.###.####', '.#...###...#.', '.....###.....', '....#####....', '...#######...'],
    h: ['.###.....###.', '#####...#####', '#############', '#############', '#############', '.###########.',
      '.###########.', '..#########..', '...#######...', '....#####....', '.....###.....', '......#......', '.............'],
    d: ['......#......', '.....###.....', '....#####....', '...#######...', '..#########..', '.###########.',
      '#############', '.###########.', '..#########..', '...#######...', '....#####....', '.....###.....', '......#......'],
    c: ['....#####....', '...#######...', '...#######...', '....#####....', '.##..###..##.', '#####.#.#####',
      '#############', '#####.#.#####', '.##..###..##.', '.....###.....', '....#####....', '...#######...', '.............'],
  };
  const CARD_SIZE = { M: { w: 24, h: 34 }, S: { w: 14, h: 19 } };

  function cardShape(p, x, y, w, h, paper, drop) {
    if (drop) p.rect(x + 1, y + h, w - 1, drop, col('shade'));
    p.rect(x + 1, y, w - 2, h, paper);
    p.rect(x, y + 1, w, h - 2, paper);
    p.rect(x + w - 1, y + 1, 1, h - 2, col('paper-shade'));
    p.rect(x + 1, y + h - 1, w - 2, 1, col('paper-shade'));
  }

  /** Draws a card face into ctx at (x, y). size 'M' | 'S'. tone: paper colour (lighting). */
  function drawCard(ctx, c, size, tone, x, y) {
    const p = pen(ctx);
    const M = size === 'M';
    const { w, h } = CARD_SIZE[M ? 'M' : 'S'];
    x = x || 0; y = y || 0;
    cardShape(p, x, y, w, h, tone || col('paper'), 0);
    const ink = col(SUIT_INK[c.s] || 'ink');
    text(ctx, RANK[c.r] || '?', x + 2, y - 1, 1, ink);
    if (!M) { bitmap(p, PIP7[c.s], x + 4, y + 10, { '#': ink }); return; }
    if (COURT[c.r]) {
      bitmap(p, PIP5[c.s], x + 2, y + 12, { '#': ink });
      const black = c.s === 's' || c.s === 'c';
      const hatch = (X, Y) => ((X + Y) & 1 ? null : col('ink'));
      const fill = black ? (X, Y) => ((X & 1) && (Y & 1) ? null : ink) : ink;
      const shatch = (X, Y) => ((X + Y) & 1 ? null : ink);
      bitmap(p, COURT[c.r], x + 8, y + 12, { '#': fill, k: col('ink'), ':': hatch, '+': col('paper-shade'), '=': black ? null : shatch });
      return;
    }
    if (c.r === 14) { bitmap(p, ACE[c.s], x + 6, y + 13, { '#': ink }); return; }
    (PIPS[c.r] || []).forEach(([px5, py5]) => bitmap(p, PIP5[c.s], x + px5, y + py5, { '#': ink }));
  }

  function drawBack(ctx, size, x, y) {
    const p = pen(ctx);
    const { w, h } = CARD_SIZE[size === 'M' ? 'M' : 'S'];
    x = x || 0; y = y || 0;
    cardShape(p, x, y, w, h, col('paper'), 0);
    const back = col('back-ink');
    for (let j = 2; j < h - 2; j++) {
      for (let i = 2; i < w - 2; i++) if ((i + j) % 4 === 0 || (i - j + 400) % 4 === 0) p.px(x + i, y + j, back);
    }
    const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const d = Math.abs(i) + Math.abs(j);
        if (d <= 2) p.px(cx + i, cy + j, d === 2 ? back : col('paper'));
      }
    }
  }

  function cardCanvas(c, size, tone) {
    const s = CARD_SIZE[size === 'M' ? 'M' : 'S'];
    const cv = canvas(s.w, s.h, 'card-art');
    const ctx = cv.getContext('2d');
    if (ctx) (c ? drawCard(ctx, c, size, tone) : drawBack(ctx, size));
    return cv;
  }

  // ------------------------------------------------------------------ clay chips
  // Each chip is 14u wide with 3u of edge; the top chip shows a face.
  const CHIP = {
    r: { c: 'chip-red', lo: 'chip-red-lo', in: 'chip-bone' },
    k: { c: 'chip-black', lo: 'chip-black-lo', in: 'chip-bone' },
    b: { c: 'chip-bone', lo: 'chip-bone-lo', in: 'chip-red' },
    i: { c: 'chip-ink', lo: 'chip-ink-lo', in: 'chip-bone' },
  };
  const CHIP_W = 14;
  const CHIP_E = 3;
  const TOWER_MAX = 7;

  function drawTower(p, x, base, types) {
    const n = types.length;
    if (!n) return;
    p.rect(x, base, CHIP_W, 1, col('shade'));
    for (let i = 0; i < n; i++) {
      const t = CHIP[types[i]];
      const y = base - (i + 1) * CHIP_E;
      p.rect(x, y, CHIP_W, 2, col(t.c));
      p.rect(x, y + 2, CHIP_W, 1, col(t.lo));
      const off = (i * 2 + types[i].charCodeAt(0)) % 3;
      [0, 5, 10].forEach((sx) => p.rect(x + sx + off, y, 2, 2, col(t.in)));
    }
    const t = CHIP[types[n - 1]];
    const top = base - n * CHIP_E;
    const c = col(t.c), ins = col(t.in);
    p.rect(x + 3, top - 4, 8, 1, c); p.rect(x + 1, top - 3, 12, 2, c); p.rect(x + 2, top - 1, 10, 1, c);
    p.px(x + 3, top - 4, ins); p.px(x + 10, top - 4, ins); p.rect(x + 1, top - 3, 1, 2, ins); p.rect(x + 12, top - 3, 1, 2, ins);
    p.px(x + 3, top - 1, ins); p.px(x + 10, top - 1, ins); p.rect(x + 5, top - 3, 4, 2, col(t.lo));
  }

  /** Chips for an amount in big blinds: ink = 25bb, black = 5bb, red = 1bb, bone = change. */
  function chipsFor(amount, bb) {
    const unit = Math.max(1, Number(bb) || 1);
    let left = Math.max(0, Math.round(Number(amount) || 0));
    const out = [];
    [['i', 25 * unit], ['k', 5 * unit], ['r', unit], ['b', Math.max(1, Math.round(unit / 2))]].forEach(([t, v]) => {
      while (left >= v && out.length < 40) { out.push(t); left -= v; }
    });
    if (left > 0 || !out.length) out.push('b');
    return out;
  }

  /** Splits chips into towers of at most TOWER_MAX; biggest chips at the bottom. */
  function towersFor(amount, bb, maxTowers) {
    const chips = chipsFor(amount, bb);
    const n = Math.max(1, Math.min(maxTowers || 3, Math.ceil(chips.length / TOWER_MAX)));
    const towers = Array.from({ length: n }, () => []);
    chips.forEach((c, i) => { const t = towers[i % n]; if (t.length < TOWER_MAX) t.push(c); });
    return towers.filter((t) => t.length);
  }

  /** A canvas holding one or more towers side by side (2u apart). */
  function towersCanvas(towers) {
    const n = Math.max(1, towers.length);
    const tallest = towers.reduce((m, t) => Math.max(m, t.length), 1);
    const w = n * CHIP_W + (n - 1) * 2;
    const h = tallest * CHIP_E + 5;
    const cv = canvas(w, h, 'tower-art');
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    const p = pen(ctx);
    towers.forEach((t, i) => drawTower(p, i * (CHIP_W + 2), h - 1, t));
    return cv;
  }

  function chipCanvas(type) {
    const cv = canvas(CHIP_W, 6, 'chip-art');
    const ctx = cv.getContext('2d');
    if (ctx) drawTower(pen(ctx), 0, 5, [type || 'r']);
    return cv;
  }

  // ------------------------------------------------------------------ people (12x12)
  const AV = [
    ['...hhhhh....', '..hhhhhhh...', '..hfffffhh..', '..ffffffF...', '..fefffeF...', '..ffffffF...', '...ffffF....', '...fFFFF....', '..cccccccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
    ['............', '...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '..ffffffF...', '..fefffeF...', '..ffffffF...', '...fffFF....', '..ccFFcccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
    ['..hhhhhhh...', '.hhhhhhhhh..', '.hhfffffhhh.', '.hffffffFhh.', '.hfeffefFhh.', '.hffffffFhh.', '.hhffffFhh..', '.hh.FFF.hh..', '..cccccccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
    ['..hhhhhhhh..', '.hhhhhhhhhh.', '.hbbbbbbbbh.', '.hffffffFhh.', '.hfeffefFhh.', '.hffffffFhh.', '.hhffffFhhh.', '.hh.FFF.hhh.', '.hcccccccch.', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
    ['...hhhhhh...', '..hhhhhhhh..', '.hhffffffh..', '.hffffffFh..', '.hfeffefFh..', '.hfffffFFh..', '..hffffFh...', '..h.FFF.h...', '..cccccccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
    ['....bbbb....', '..bbbbbbbb..', '.bbbbbbbbbb.', '..ffffffF...', '..fefffeF...', '..ffffffF...', '..hhhhhhh...', '...hhhhh....', '..cccccccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'],
  ];
  const BACKFRAME = ['............', '...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '..hhhhhhhh..', '...hhhhhh...', '..cccccccc..', '.cccccccccc.', 'ccccccccccc.', 'cccccccccccc'];
  const HAIR = ['#a8642c', '#3a2f2a', '#1c1a22', '#2c2420', '#6b4a2a', '#8a8070', '#5a2a1a', '#c0a070'];
  const COLLAR = ['#5a3a2a', '#4a5a3a', '#6a2a2a', '#2f4a5a', '#3a2a4a', '#5a4a2a', '#3a3a3a', '#6a4a3a'];
  const SKIN = [['#c0855e', '#82533a'], ['#a86f4c', '#6e4430'], ['#d9a27c', '#9a6a4a'], ['#7a4a30', '#4e2e1e']];
  const HAT = ['#2f2623', '#6b2a20', '#3a4a3a', '#9a8f7b'];

  /** A 12x12 person, chosen and tinted by name. back = seen from behind (folded). */
  function personCanvas(seed, back) {
    const h = hashString(String(seed || '?'));
    const cv = canvas(12, 12, 'person-art');
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    const skin = SKIN[(h >>> 9) % SKIN.length];
    const rows = back ? BACKFRAME : AV[h % AV.length];
    const hair = HAIR[(h >>> 3) % HAIR.length];
    bitmap(pen(ctx), rows, 0, 0, {
      h: hair, f: skin[0], F: skin[1], c: COLLAR[(h >>> 6) % COLLAR.length], e: col('ink'),
      b: HAT[(h >>> 12) % HAT.length],
    });
    return cv;
  }

  // ------------------------------------------------------------------ the room
  // A scene is in frame units (480x300): table ellipse + rail, the bulb's pool, the wall spill.
  const SCENES = {
    table: {
      table: { cx: 168, cy: 128, rx: 148, ry: 88, rail: 8, wear: { x: 122, y: 108 } },
      pool: { cx: 190, cy: 140, aspect: 1.45, r1: 78, r2: 128 },
      spill: { cx: 196, cy: 150, aspect: 1.5, r1: 190, r2: 270 },
      smoke: { cx: 201, half0: 40, slope: 0.36, skip: (x, y) => (x >= 336 && y < 259) || y >= 258 },
    },
    title: {
      table: { cx: 334, cy: 238, rx: 196, ry: 100, rail: 9, wear: { x: 254, y: 168 } },
      pool: { cx: 304, cy: 206, aspect: 1.45, r1: 84, r2: 136 },
      spill: { cx: 300, cy: 190, aspect: 1.5, r1: 190, r2: 270 },
      smoke: { cx: 304, half0: 44, slope: 0.4, skip: (x, y) => x < 150 && y > 90 },
    },
    room: {
      table: null,
      pool: { cx: 240, cy: 150, aspect: 1.45, r1: 100, r2: 160 },
      spill: { cx: 240, cy: 140, aspect: 1.5, r1: 200, r2: 290 },
      smoke: { cx: 240, half0: 60, slope: 0.4, skip: null },
    },
  };

  function band(d, r1, r2, tw) {
    const step = (r) => {
      if (d < r - 3) return 0;
      if (d >= r + 3) return 1;
      return d < r ? (tw === 0 ? 1 : 0) : (tw === 0 ? 0 : 1);
    };
    return step(r1) + step(r2);
  }

  /** mood: calm | brownout | warm | out. R: {W, H, ox, oy} in units. Returns ImageData. */
  function paintRoom(ctx, R, scene, mood) {
    const S = SCENES[scene] || SCENES.table;
    const TB = S.table, P = S.pool, SP = S.spill;
    const img = ctx.createImageData(R.W, R.H);
    const d = img.data;
    const shift = mood === 'brownout' ? 1 : mood === 'out' ? 3 : 0;
    const warm = mood === 'warm';
    const r1 = P.r1 + (warm ? 8 : 0), r2 = P.r2 + (warm ? 14 : 0);
    const FELT = [warm ? 'felt-warm' : 'felt-core', 'felt', 'felt-rim', 'felt-dark'].map(hex);
    const NAP = [warm ? 'felt-core' : 'felt-core-nap', 'felt-nap', 'felt-rim-nap', 'felt-dark-nap'].map(hex);
    const RAIL = ['rail-hi', 'rail', 'rail-lo', 'rail-off'].map(hex);
    const ROOM = ['room-3', 'room-2', 'room', 'room'].map(hex);
    const SEAM = hex('room');
    for (let Y = 0; Y < R.H; Y++) {
      for (let X = 0; X < R.W; X++) {
        const x = X - R.ox, y = Y - R.oy;
        const tw = (x + y) & 3;
        const pd = Math.sqrt(((x - P.cx) / P.aspect) ** 2 + (y - P.cy) ** 2);
        const b = Math.min(3, band(pd, r1, r2, tw) + shift);
        let c;
        let e = 2, re = 2;
        if (TB) {
          const ex = (x - TB.cx) / TB.rx, ey = (y - TB.cy) / TB.ry;
          e = Math.sqrt(ex * ex + ey * ey);
          const rex = (x - TB.cx) / (TB.rx + TB.rail), rey = (y - TB.cy) / (TB.ry + TB.rail);
          re = Math.sqrt(rex * rex + rey * rey);
        }
        const h = hash(x, y, 7);
        if (e <= 1) {
          c = (h < 0.07 || (tw === 0 && h < 0.24)) ? NAP[b] : FELT[b];
        } else if (re <= 1) {
          const edge = (e - 1) * TB.rx;
          if (edge < 1.2) c = SEAM;
          else {
            let rb = Math.min(3, b);
            if (re > 0.975 && y < TB.cy && rb < 2) rb = 0; // the rail's crown catches the bulb
            c = RAIL[rb];
            if (h < 0.08) c = RAIL[Math.min(3, rb + 1)]; // leather grain
          }
        } else {
          const out = TB ? (re - 1) * (TB.rx + TB.rail) : 99;
          const sd = Math.sqrt(((x - SP.cx) / SP.aspect) ** 2 + (y - SP.cy) ** 2);
          let sb = band(sd, SP.r1, SP.r2, tw) + (mood === 'out' ? 2 : mood === 'brownout' ? 1 : 0);
          if (out < 3) sb = 2;
          else if (out < 6 && tw !== 0) sb = Math.max(sb, 2);
          c = ROOM[Math.min(3, sb)];
        }
        const i = (Y * R.W + X) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    const put = (x, y, c) => {
      const X = R.ox + x, Y = R.oy + y;
      if (X < 0 || Y < 0 || X >= R.W || Y >= R.H) return;
      const i = (Y * R.W + X) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    };
    if (TB && mood !== 'out') {
      // stitch row along the rail, visible only where the bulb reaches
      const ST = hex('stitch');
      const per = 2 * Math.PI * Math.sqrt(((TB.rx + 4) ** 2 + (TB.ry + 4) ** 2) / 2);
      const N = Math.round(per / 4);
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        const x = Math.round(TB.cx + Math.cos(a) * (TB.rx + TB.rail / 2));
        const y = Math.round(TB.cy + Math.sin(a) * (TB.ry + TB.rail / 2));
        const pd = Math.sqrt(((x - P.cx) / P.aspect) ** 2 + (y - P.cy) ** 2);
        if (pd < r2 + 30 - shift * 40) put(x, y, ST);
      }
      if (TB.wear) {
        const wc = hex('felt-wear');
        for (let j = 0; j < 8; j++) {
          for (let i = 0; i < 20; i++) {
            const ex = (i - 9.5) / 10, ey = (j - 3.5) / 4;
            const r = ex * ex + ey * ey;
            const tw = (TB.wear.x + i + TB.wear.y + j) & 3;
            if (r < 0.45 || (r < 1 && tw === 0)) put(TB.wear.x + i, TB.wear.y + j, wc);
          }
        }
      }
    }
    return img;
  }

  // ------------------------------------------------------------------ smoke
  function noiseTile(seed, cell, cellY) {
    const N = 128, g = N / cell, cy = cellY || cell, gyN = N / cy;
    const t = new Float32Array(N * N);
    const sm = (v) => v * v * (3 - 2 * v);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const gx = x / cell, gy = y / cy;
        const i0 = Math.floor(gx), j0 = Math.floor(gy);
        const fx = sm(gx - i0), fy = sm(gy - j0);
        const v = (i, j) => hash(((i % g) + g) % g, ((j % gyN) + gyN) % gyN, seed);
        const a = v(i0, j0) + (v(i0 + 1, j0) - v(i0, j0)) * fx;
        const b = v(i0, j0 + 1) + (v(i0 + 1, j0 + 1) - v(i0, j0 + 1)) * fx;
        t[y * N + x] = a + (b - a) * fy;
      }
    }
    return t;
  }
  function fbm(seed) {
    const a = noiseTile(seed, 64, 16), b = noiseTile(seed + 1, 32, 8), c = noiseTile(seed + 2, 16, 4);
    const t = new Float32Array(128 * 128);
    for (let i = 0; i < t.length; i++) t[i] = a[i] * 0.55 + b[i] * 0.3 + c[i] * 0.15;
    return t;
  }
  const SMOKE = { A: null, B: null };

  /** Paints the haze into an ImageData (unit res). t = time in frames; gain scales density. */
  function paintSmoke(img, R, scene, t, gain) {
    if (!SMOKE.A) { SMOKE.A = fbm(11); SMOKE.B = fbm(23); }
    const S = (SCENES[scene] || SCENES.table).smoke;
    const d = img.data, A = SMOKE.A, B = SMOKE.B;
    const ax = Math.floor(t * 0.07), ay = Math.floor(t * 0.025), bx = Math.floor(t * 0.045), by = Math.floor(t * 0.04);
    const C1 = hex('smoke'), C2 = hex('smoke-hi');
    for (let Y = 0; Y < R.H; Y++) {
      const y = Y - R.oy;
      const half = S.half0 + (y + 40) * S.slope;
      const layer = 0.62 + 0.38 * Math.sin(y * 0.09 + t * 0.004);
      for (let X = 0; X < R.W; X++) {
        const x = X - R.ox;
        const i = (Y * R.W + X) * 4;
        if (S.skip && S.skip(x, y)) { d[i + 3] = 0; continue; }
        const m = clamp((half - Math.abs(x - S.cx)) / 22, 0, 1);
        const dens = A[((y + ay) & 127) * 128 + ((x - ax) & 127)] * 0.62 + B[((y + by) & 127) * 128 + ((x + bx) & 127)] * 0.38;
        const v = (dens - 0.16) * (0.3 + 0.7 * m) * layer * gain;
        const th = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        if (v > 0.3 + th * 0.14) { d[i] = C2[0]; d[i + 1] = C2[1]; d[i + 2] = C2[2]; d[i + 3] = 40; }
        else if (v > 0.18 + th * 0.14) { d[i] = C1[0]; d[i + 1] = C1[1]; d[i + 2] = C1[2]; d[i + 3] = 22; }
        else d[i + 3] = 0;
      }
    }
  }

  // ------------------------------------------------------------------ title props
  const TITLE_SLIP = { x: 288, y: 150, w: 36, h: 108, base: 104 };
  function drawTitleProps(ctx, R, mood, ticks) {
    const p = pen(ctx);
    const on = mood !== 'out';
    const ox = R.ox, oy = R.oy;
    ctx.save();
    ctx.translate(ox, oy);
    if (on) {
      drawBack(ctx, 'M', 222, 184);
      p.rect(245, 178 + 34, 23, 2, col('shade'));
      drawCard(ctx, { r: 13, s: 'h' }, 'M', mood === 'calm' ? col('paper') : col('paper-2'), 244, 178);
      drawTower(p, 404, 240, ['k', 'r', 'r', 'b', 'r', 'k', 'r']);
      drawTower(p, 420, 246, ['b', 'b', 'r', 'i']);
      drawTower(p, 436, 236, ['r', 'r', 'k']);
    }
    // a slip, face down, with its price lit
    const { x, y, w, h } = TITLE_SLIP;
    const paper = mood === 'calm' ? col('paper') : mood === 'out' ? '#3a3127' : col('paper-2');
    const shade = mood === 'out' ? '#2a231c' : col('paper-shade');
    p.rect(x + 1, y + h, w - 1, 2, col('shade'));
    p.rect(x + 1, y, w - 2, h, paper); p.rect(x, y + 1, w, h - 2, paper);
    p.rect(x + w - 1, y + 1, 1, h - 2, shade); p.rect(x + 1, y + h - 1, w - 2, 1, shade);
    for (let i = 1; i < w - 1; i += 3) p.rect(x + i, y + 2, 1, 1, shade);
    for (let pt = 0; pt <= 100; pt += 5) p.rect(x + 1, y + 104 - pt, pt % 10 === 0 ? 5 : 3, 1, on ? col('ink') : shade);
    const ry = y + 104 - 25;
    p.rect(x + 6, ry - 1, w - 6, 2, on ? col('price-ink') : shade);
    if (on) {
      p.rect(x + w, ry - 1, 3, 2, col('price')); p.rect(x + w, ry + 1, 3, 1, col('shade'));
      text(ctx, '25', x + w + 5, ry - 21, 2, col('price'));
      text(ctx, '%', x + w + 33, ry - 9, 1, col('price'));
    }
    ashtray(p, 170, 246, mood, ticks);
    ctx.restore();
  }
  function ashtray(p, x, y, mood, tk) {
    const dark = mood === 'out';
    const rim = dark ? '#2a221c' : col('chip-bone-lo'), well = dark ? '#16110d' : '#3a302a', ash = dark ? '#221c17' : '#6e655c';
    p.rect(x + 3, y - 2, 16, 1, rim); p.rect(x + 1, y - 1, 20, 1, rim); p.rect(x, y, 22, 4, rim);
    p.rect(x + 1, y + 4, 20, 1, dark ? '#1a1410' : col('chip-red-lo')); p.rect(x + 2, y + 5, 18, 1, col('shade'));
    p.rect(x + 3, y - 1, 16, 1, well); p.rect(x + 2, y, 18, 2, well);
    p.px(x + 7, y + 1, ash); p.px(x + 8, y, ash); p.px(x + 11, y + 1, ash); p.px(x + 6, y, ash);
    p.rect(x + 14, y - 2, 7, 1, dark ? '#4a4034' : col('paper')); p.rect(x + 14, y - 2, 2, 1, dark ? '#3a2a1a' : col('chip-bone'));
    const drag = (tk % 200) < 14;
    p.px(x + 21, y - 2, drag ? col('chip-bone') : col('ember'));
    for (let j = 0; j < 44; j++) {
      const wx = x + 21 + Math.round(Math.sin((j + tk * 0.05) * 0.3) * (1 + j * 0.08) + j * 0.35);
      if (hash(j, Math.floor(tk / 7), 9) < j / 52) continue;
      p.px(wx, y - 4 - j, j < 10 ? col('smoke-hi') : col('smoke'));
    }
  }

  // ------------------------------------------------------------------ the slip
  // 36x108 paper strip: scale on the left edge, price rule, nick, ink pour, loss hatch.
  const SLIP = { w: 36, h: 108, base: 104 };
  const slipY = (pt) => SLIP.base - pt;

  /**
   * o: { need: 0..100 | null, have: 0..100, read: 0..100 | null, face: bool, pour: 0..100,
   *      showLoss, showHave, hollow, guide: 0..100 | null }
   */
  function drawSlip(ctx, o) {
    const p = pen(ctx);
    const { w, h } = SLIP;
    ctx.clearRect(0, 0, w, h + 2);
    p.rect(1, h, w - 1, 2, col('shade'));
    p.rect(1, 0, w - 2, h, col('paper')); p.rect(0, 1, w, h - 2, col('paper'));
    p.rect(w - 1, 1, 1, h - 2, col('paper-shade')); p.rect(1, h - 1, w - 2, 1, col('paper-shade'));
    for (let i = 1; i < w - 1; i += 3) p.rect(i, 2, 1, 1, col('paper-shade'));
    const face = !!o.face, pour = o.pour || 0, NEED = o.need, HAVE = o.have;
    if (face && pour > 0) p.rect(1, slipY(pour), w - 2, pour, col('ink'));
    if (face && o.showLoss && NEED !== null && HAVE < NEED) {
      for (let pt = HAVE + 1; pt < NEED - 1; pt++) {
        for (let i = 1; i < w - 1; i++) if ((i + pt) % 3 === 0) p.rect(i, slipY(pt), 1, 1, col('loss'));
      }
    }
    for (let pt = 0; pt <= 100; pt += 5) {
      const inInk = face && pt <= pour;
      p.rect(1, slipY(pt), pt % 10 === 0 ? 5 : 3, 1, inInk ? col('paper-shade') : col('ink'));
    }
    if (NEED !== null && NEED !== undefined) {
      const ry = slipY(NEED);
      const c = face && NEED <= pour ? col('paper-shade') : col('price-ink');
      if (o.hollow) { p.rect(6, ry - 1, w - 6, 1, c); p.rect(6, ry + 1, w - 6, 1, c); }
      else p.rect(6, ry - 1, w - 6, 2, c);
    }
    if (face && o.showHave) {
      const inside = pour >= 24;
      const ty = inside ? slipY(pour) + 2 : slipY(pour) - 24;
      if (!inside) p.rect(6, ty + 2, 28, 20, col('paper'));
      text(ctx, String(HAVE), 6, ty - 3, 2, inside ? col('paper') : col('ink'));
    }
    if (o.read !== null && o.read !== undefined) {
      const ny = slipY(o.read);
      [[-3, 1], [-2, 3], [-1, 5], [0, 6], [1, 5], [2, 3], [3, 1]].forEach(([dy, len]) => {
        ctx.clearRect(0, ny + dy, len, 1);
        p.rect(len, ny + dy, 1, 1, col('paper-shade'));
      });
    }
    if (o.guide !== null && o.guide !== undefined && !face) p.rect(6, slipY(o.guide), w - 8, 1, col('text-dim'));
  }

  // ------------------------------------------------------------------ dot-matrix board
  const F57 = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], 3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], 9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'], ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'], '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
    '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'], '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
    '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'], '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
    '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'], '·': ['.....', '.....', '.....', '..#..', '.....', '.....', '.....'],
  };
  const F35 = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'], G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
    I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'], K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['.#.', '#.#', '#.#', '#.#', '.#.'], P: ['##.', '#.#', '##.', '#..', '#..'],
    Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'], S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
    0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'],
    4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'], 6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '##.'],
    ' ': ['...', '...', '...', '...', '...'], ',': ['...', '...', '...', '.#.', '#..'], '.': ['...', '...', '...', '...', '.#.'], '%': ['#.#', '..#', '.#.', '#..', '#.#'],
    '·': ['...', '...', '.#.', '...', '...'], '-': ['...', '...', '###', '...', '...'], ':': ['...', '.#.', '...', '.#.', '...'], '/': ['..#', '..#', '.#.', '#..', '#..'],
    '+': ['...', '.#.', '###', '.#.', '...'], '#': ['#.#', '###', '#.#', '###', '#.#'], '!': ['.#.', '.#.', '.#.', '...', '.#.'], '$': ['.##', '##.', '.#.', '.##', '##.'],
  };
  function dotWidth(str, face, pitch) {
    const gw = face === 57 ? 5 : 3;
    return String(str).length * (gw + 1) * pitch - pitch;
  }
  function dotText(p, str, x, y, face, pitch, color) {
    const F = face === 57 ? F57 : F35;
    const gw = face === 57 ? 5 : 3;
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const g = F[ch] || F[' '];
      g.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === '#') p.rect(cx + i * pitch, y + j * pitch, 1, 1, color); });
      cx += (gw + 1) * pitch;
    }
  }

  /** The orange scoreboard. lines: [big line (5x7), small line (3x5)]. invert flashes line 1. */
  function drawDMD(cv, line1, line2, invert) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const p = pen(ctx);
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    // iron bezel with four screws
    p.rect(1, 0, w - 2, h, col('iron')); p.rect(0, 1, w, h - 2, col('iron'));
    p.rect(1, 1, w - 2, 1, col('wood-hi'));
    [[2, 2], [w - 4, 2], [2, h - 4], [w - 4, h - 4]].forEach(([sx, sy]) => { p.rect(sx, sy, 2, 2, col('wood')); p.px(sx, sy, col('wood-hi')); });
    const ix = 5, iy = 4, iw = w - 10, ih = h - 8;
    p.rect(ix, iy, iw, ih, col('dmd-bg'));
    for (let j = 1; j < ih - 1; j += 2) for (let i = 1; i < iw - 1; i += 2) p.px(ix + i, iy + j, col('dmd-off'));
    const on = col('dmd-on');
    const l1 = String(line1 || ''), l2 = String(line2 || '');
    if (invert) for (let j = 1; j < 18; j += 2) for (let i = 1; i < iw - 1; i += 2) p.px(ix + i, iy + j, on);
    const fit57 = dotWidth(l1, 57, 2) <= iw - 4;
    const w1 = fit57 ? dotWidth(l1, 57, 2) : dotWidth(l1, 35, 2);
    const w2 = dotWidth(l2, 35, 2) <= iw - 4 ? dotWidth(l2, 35, 2) : dotWidth(l2, 35, 1);
    const cxp = (s) => ix + 1 + 2 * Math.max(0, Math.floor((iw - 2 - s) / 4));
    if (fit57) dotText(p, l1, cxp(w1), iy + 3, 57, 2, invert ? col('dmd-bg') : on);
    else dotText(p, l1, cxp(w1), iy + 5, 35, 2, invert ? col('dmd-bg') : on);
    if (dotWidth(l2, 35, 2) <= iw - 4) dotText(p, l2, cxp(w2), iy + 21, 35, 2, on);
    else dotText(p, l2, cxp(w2), iy + 23, 35, 1, on);
  }

  // ------------------------------------------------------------------ CSS textures
  // Tiles generated once, scaled to device pixels so CSS draws them crisp. Returns data URLs.
  function tile(w, h, paint) {
    const cv = canvas(w, h);
    const ctx = cv.getContext('2d');
    if (!ctx) return '';
    paint(pen(ctx), ctx);
    try { return cv.toDataURL('image/png'); } catch (err) { return ''; }
  }
  function textures() {
    const slate = tile(128, 128, (p) => {
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const v = Math.sin(x * 0.098 + Math.sin(y * 0.0982 * 0.7) * 2.5) + Math.sin(y * 0.0982 * 1.3 - x * 0.049);
          const h = hash(x, y, 41);
          let c = (v > 1.25 && h < 0.5) || h < 0.035 ? col('slate-2') : col('slate');
          const sm = Math.abs(y - (96 + Math.sin(x * 0.049 * 2) * 10));
          if (sm < 12 && BAYER[(y & 3) * 4 + (x & 3)] < 3 && h > 0.3) c = col('slate-ghost');
          p.px(x, y, c);
        }
      }
    });
    const wood = tile(64, 8, (p) => {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 64; x++) {
          const g = hash(Math.floor(x / 7), y, 5);
          p.px(x, y, g < 0.3 ? col('wood-lo') : col('wood'));
        }
      }
    });
    const woodV = tile(8, 64, (p) => {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 8; x++) {
          const g = hash(x, Math.floor(y / 7), 6);
          p.px(x, y, g < 0.3 ? col('wood-lo') : col('wood'));
        }
      }
    });
    const chalk = tile(64, 64, (p) => {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) if (hash(x, y, 77) > 0.06) p.px(x, y, '#000');
      }
    });
    const paper = tile(64, 64, (p) => {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const h = hash(x, y, 13);
          p.px(x, y, h < 0.04 ? col('paper-2') : col('paper'));
        }
      }
    });
    const dots = tile(2, 2, (p) => { p.rect(0, 0, 2, 2, col('dmd-bg')); p.px(1, 1, col('dmd-off')); });
    const dotMask = tile(2, 2, (p) => { p.px(0, 0, '#000'); });
    const stitch = tile(3, 1, (p) => { p.px(0, 0, col('stitch')); });
    const felt = tile(64, 64, (p) => {
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const tw = (x + y) & 3;
          const h = hash(x, y, 7);
          p.px(x, y, (h < 0.07 || (tw === 0 && h < 0.24)) ? col('felt-nap') : col('felt'));
        }
      }
    });
    const chalkDash = tile(4, 1, (p) => { p.px(0, 0, col('chalk-dim')); p.px(1, 0, col('chalk-dim')); });
    const hatch = tile(3, 3, (p) => { for (let i = 0; i < 3; i++) p.px(i, (3 - i) % 3, col('loss')); });
    return { slate, wood, woodV, chalk, paper, dots, dotMask, stitch, felt, hatch, chalkDash };
  }

  PP.Art = Object.freeze({
    col, hash, hashString, canvas, pen, text, glyphs,
    CARD_SIZE, drawCard, drawBack, cardCanvas,
    CHIP_W, CHIP_E, TOWER_MAX, chipsFor, towersFor, towersCanvas, chipCanvas,
    personCanvas,
    SCENES, paintRoom, paintSmoke, drawTitleProps,
    SLIP, drawSlip,
    drawDMD, dotWidth,
    textures,
  });
})();
