/* Stale-tab guard. tools/stamp.py writes the same build id into <meta name="pp-build">
 * and version.json on every commit; if the server's id differs, this tab is running an
 * old build (a tab left open, or a cached page) and multiplayer would not match friends.
 * On load, and before multiplayer, a stale tab reloads itself with a cache-busting ?_v=. */
(function () {
  'use strict';
  const PP = (globalThis.PP = globalThis.PP || {});
  const FETCH_TIMEOUT_MS = 4000;
  const RELOAD_KEY = 'pp-reloaded-for';

  function currentBuild() {
    const meta = globalThis.document && document.querySelector('meta[name="pp-build"]');
    return meta ? meta.getAttribute('content') : null;
  }

  async function latestBuild() {
    if (typeof fetch !== 'function' || !globalThis.location || !/^https?:$/.test(location.protocol)) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store', signal: ctrl && ctrl.signal });
      if (!res.ok) return null;
      const body = await res.json();
      return body && typeof body.build === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(body.build) ? body.build : null;
    } catch (err) {
      return null; // offline or blocked: keep playing on what we have
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function alreadyTried(target) {
    try { return sessionStorage.getItem(RELOAD_KEY) === target; } catch (err) { return false; }
  }

  function reloadInto(target) {
    try { sessionStorage.setItem(RELOAD_KEY, target); } catch (err) { /* private mode: reload anyway */ }
    const url = new URL(location.href);
    url.searchParams.set('_v', target); // a new URL, so a cached index.html can't be reused
    location.replace(url.toString());
  }

  /** Resolves true if this tab is stale; reloads it (once per build) when `reload` is set. */
  async function ensureFresh(reload) {
    const mine = currentBuild();
    const latest = await latestBuild();
    if (!mine || !latest || mine === latest) return false;
    if (reload && !alreadyTried(latest)) reloadInto(latest);
    return true;
  }

  PP.Update = Object.freeze({ currentBuild, ensureFresh });
  if (globalThis.document) ensureFresh(true);
})();
