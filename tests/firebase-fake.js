/*
 * PIXEL HOLD'EM — in-memory fake of the Firebase JS SDK surface js/net-firebase.js uses
 * (initializeApp, initializeAuth/getAuth, signInAnonymously, getDatabase, ref, child, push, set,
 * remove, get, onValue, onChildAdded, onDisconnect). NOT shipped to players: node tests preload it
 * (tests/run.js), and on localhost only `?fakeFirebase=1` loads it into the page (two tabs share it
 * through localStorage + `storage` events) so the full UI can run without a Firebase project.
 *
 * It also enforces a JS mirror of database.rules.json (read/write/validate), so tests can prove a
 * client cannot read another client's frames, and that a second host cannot take a live room.
 *
 *   const fb = PPFakeFirebase.create();         // one fake "server"
 *   const sdkA = fb.client();                   // one fake "tab" (its own anonymous uid)
 *   fb.read('rooms/K7QXM/host'), fb.kill(sdkA), fb.writes, fb.failAuth = true
 */
(function () {
  'use strict';
  const MAX_D = 65536;
  const CODE_RE = /^[A-HJKMNP-Z2-9]{5}$/;
  const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const LS_PREFIX = 'ppfakedb:';
  const defer = typeof setImmediate === 'function' ? (fn) => setImmediate(fn) : (fn) => setTimeout(fn, 0);

  function randomId(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    return s;
  }

  /* ---------------------------------------------------------------- stores (flat leaf maps) */

  function memoryStore() {
    const m = new Map();
    return {
      get: (k) => m.get(k),
      set: (k, v) => { m.set(k, v); },
      del: (k) => { m.delete(k); },
      keys: () => Array.from(m.keys()),
      subscribe: () => {},
    };
  }

  function localStore(ls, win) {
    return {
      get: (k) => {
        const raw = ls.getItem(LS_PREFIX + k);
        return raw == null ? undefined : JSON.parse(raw);
      },
      set: (k, v) => ls.setItem(LS_PREFIX + k, JSON.stringify(v)),
      del: (k) => ls.removeItem(LS_PREFIX + k),
      keys: () => {
        const out = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k && k.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
        }
        return out;
      },
      subscribe: (fn) => win.addEventListener('storage', (e) => {
        if (!e.key || e.key.startsWith(LS_PREFIX)) fn();
      }),
    };
  }

  /* ---------------------------------------------------------------- tree over a leaf store */

  const norm = (p) => String(p || '').split('/').filter(Boolean).join('/');

  function readTree(store, path) {
    const p = norm(path);
    const direct = p ? store.get(p) : undefined;
    if (direct !== undefined) return direct;
    const pre = p ? p + '/' : '';
    let out = null;
    store.keys().forEach((k) => {
      if (!k.startsWith(pre)) return;
      const segs = k.slice(pre.length).split('/');
      out = out || {};
      let node = out;
      segs.forEach((s, i) => {
        if (i === segs.length - 1) node[s] = store.get(k);
        else node = node[s] = node[s] && typeof node[s] === 'object' ? node[s] : {};
      });
    });
    return out;
  }

  function writeTree(store, path, value) {
    const p = norm(path);
    const pre = p + '/';
    store.keys().forEach((k) => {
      if (k === p || k.startsWith(pre) || p.startsWith(k + '/')) store.del(k);
    });
    const put = (base, v) => {
      if (v === null || v === undefined) return;
      if (typeof v === 'object') Object.keys(v).forEach((k) => put(base + '/' + k, v[k]));
      else store.set(base, v);
    };
    put(p, value);
  }

  /* ---------------------------------------------------------------- rules (mirror of database.rules.json) */

  function validFrame(v) {
    if (!v || typeof v !== 'object') return false;
    if (Object.keys(v).some((k) => k !== 'd' && k !== 'ts' && k !== 'c')) return false;
    return typeof v.d === 'string' && v.d.length <= MAX_D && typeof v.ts === 'number' &&
      (v.c === undefined || v.c === true);
  }

  function validPeer(v) {
    return !!v && typeof v === 'object' && Object.keys(v).every((k) => k === 'joinedAt' || k === 's') &&
      typeof v.joinedAt === 'number' && typeof v.s === 'string' && v.s.length <= 40;
  }

  function validHost(v, uid) {
    return !!v && typeof v === 'object' && Object.keys(v).every((k) => k === 'uid' || k === 'createdAt') &&
      v.uid === uid && typeof v.createdAt === 'number';
  }

  function makeRules(store) {
    const hostUid = (code) => {
      const v = readTree(store, 'rooms/' + code + '/host/uid');
      return typeof v === 'string' ? v : null;
    };
    function canRead(uid, path) {
      const s = norm(path).split('/');
      if (!uid || s[0] !== 'rooms' || s.length < 3) return false;
      const [, code, sub, cid] = s;
      if (sub === 'host') return true;
      if (sub === 'down') return s.length >= 4 && uid === cid;
      if (sub === 'up') return s.length >= 4 && uid === hostUid(code);
      if (sub === 'peers') return uid === hostUid(code) || (s.length >= 4 && uid === cid);
      return false;
    }
    function canWrite(uid, path, nv) {
      const s = norm(path).split('/');
      if (!uid || s[0] !== 'rooms' || s.length < 2 || !CODE_RE.test(s[1])) return false;
      const [, code, sub, cid] = s;
      const h = hostUid(code);
      const del = nv === null || nv === undefined;
      if (s.length === 2) return del && h === uid;
      if (sub === 'host' && s.length === 3) return del ? h === uid : validHost(nv, uid) && (h === null || h === uid);
      if (sub === 'peers' && s.length === 4) return uid === cid && (del || (h !== null && validPeer(nv)));
      if ((sub === 'down' || sub === 'up') && s.length === 4) return del && (uid === cid || uid === h);
      if (sub === 'down' && s.length === 5) return uid === h ? del || validFrame(nv) : uid === cid && del;
      if (sub === 'up' && s.length === 5) {
        if (del) return uid === h || uid === cid;
        return uid === cid && h !== null && validFrame(nv) && readTree(store, path) === null;
      }
      return false;
    }
    return { canRead, canWrite };
  }

  /* ---------------------------------------------------------------- server + clients */

  function permissionDenied() {
    const err = new Error('PERMISSION_DENIED: Permission denied');
    err.code = 'PERMISSION_DENIED';
    return err;
  }

  function create(opts) {
    const o = opts || {};
    const store = o.store || memoryStore();
    const rules = makeRules(store);
    const clients = new Set();
    const fb = { failAuth: false, failLoad: false, writes: [], denied: [], clients };
    let pushSeq = 0;

    const notifyAll = () => clients.forEach((c) => c.notify());
    store.subscribe(notifyAll);

    function snapshot(db, path, value) {
      const r = { db, path: norm(path), key: norm(path).split('/').pop() || null };
      const v = value === undefined ? null : value;
      return { key: r.key, ref: r, val: () => (v === null ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null };
    }

    function client(clientOpts) {
      const co = clientOpts || {};
      const c = { uid: co.uid || randomId(28), signedIn: false, dead: false, listeners: new Set(), onDisc: [] };
      clients.add(c);
      const uidOf = () => (c.signedIn && !c.dead ? c.uid : null);

      c.notify = () => {
        if (c.dead) return;
        Array.from(c.listeners).forEach((l) => {
          if (!c.listeners.has(l)) return;
          const v = readTree(store, l.path);
          if (l.type === 'value') {
            const json = JSON.stringify(v);
            if (json === l.last) return;
            l.last = json;
            l.cb(snapshot(l.db, l.path, v));
            return;
          }
          const keys = v && typeof v === 'object' ? Object.keys(v).sort() : [];
          Array.from(l.seen).forEach((k) => { if (!keys.includes(k)) l.seen.delete(k); });
          keys.forEach((k) => {
            if (l.seen.has(k) || !c.listeners.has(l)) return;
            l.seen.add(k);
            l.cb(snapshot(l.db, l.path + '/' + k, v[k]));
          });
        });
      };

      function doWrite(path, value) {
        const uid = uidOf();
        if (!rules.canWrite(uid, path, value)) {
          fb.denied.push({ uid, path: norm(path), value });
          throw permissionDenied();
        }
        fb.writes.push({ uid, path: norm(path), value });
        writeTree(store, path, value);
        notifyAll();
      }

      const later = (fn) => new Promise((resolve, reject) => defer(() => {
        if (c.dead) return; // a dead tab never hears back
        try { resolve(fn()); } catch (err) { reject(err); }
      }));

      function listen(type, r, cb, cancel) {
        const l = { type, db: r.db, path: r.path, cb, last: undefined, seen: new Set() };
        defer(() => {
          if (c.dead) return;
          if (!rules.canRead(uidOf(), r.path)) {
            if (typeof cancel === 'function') cancel(permissionDenied());
            return;
          }
          c.listeners.add(l);
          c.notify();
        });
        return () => { c.listeners.delete(l); l.cb = () => {}; };
      }

      const sdk = {
        __fake: true,
        __client: c,
        initializeApp: (cfg, name) => ({ name: name || '[DEFAULT]', options: cfg }),
        browserSessionPersistence: { type: 'SESSION' },
        initializeAuth: (app) => ({ app, currentUser: null }),
        getAuth: (app) => ({ app, currentUser: null }),
        signInAnonymously: (auth) => later(() => {
          if (fb.failAuth) throw Object.assign(new Error('auth/network-request-failed'), { code: 'auth/network-request-failed' });
          c.signedIn = true;
          auth.currentUser = { uid: c.uid };
          return { user: { uid: c.uid } };
        }),
        getDatabase: (app) => ({ app }),
        ref: (db, path) => ({ db, path: norm(path), key: norm(path).split('/').pop() || null }),
        child: (r, p) => sdk.ref(r.db, r.path + '/' + p),
        push: (r) => {
          pushSeq += 1;
          const id = Date.now().toString(36).padStart(9, '0') + pushSeq.toString(36).padStart(5, '0') + randomId(6);
          return sdk.child(r, id);
        },
        set: (r, v) => later(() => doWrite(r.path, v)),
        remove: (r) => later(() => doWrite(r.path, null)),
        get: (r) => later(() => {
          if (!rules.canRead(uidOf(), r.path)) throw permissionDenied();
          return snapshot(r.db, r.path, readTree(store, r.path));
        }),
        onValue: (r, cb, cancel) => listen('value', r, cb, cancel),
        onChildAdded: (r, cb, cancel) => listen('child', r, cb, cancel),
        onDisconnect: (r) => ({
          remove: () => later(() => {
            if (!rules.canWrite(uidOf(), r.path, null)) throw permissionDenied();
            c.onDisc.push({ path: r.path, value: null });
          }),
          cancel: () => later(() => { c.onDisc = c.onDisc.filter((d) => d.path !== r.path); }),
        }),
      };
      return sdk;
    }

    /** The tab vanished: run its onDisconnect ops (server side), silence it forever. */
    fb.kill = (sdk) => {
      const c = sdk.__client;
      if (c.dead) return;
      const uid = c.signedIn ? c.uid : null;
      c.dead = true;
      c.listeners.clear();
      c.onDisc.splice(0).forEach((d) => {
        if (rules.canWrite(uid, d.path, d.value)) writeTree(store, d.path, d.value);
      });
      clients.delete(c);
      notifyAll();
    };
    fb.client = client;
    fb.read = (path) => readTree(store, path);
    fb.write = (path, v) => { writeTree(store, path, v); notifyAll(); }; // admin (no rules)
    fb.rules = rules;
    return fb;
  }

  globalThis.PPFakeFirebase = Object.freeze({ create, memoryStore, localStore });
})();
