/* TWGI app auto-update. Same file in Taskmaster and the Journal.

   Registers /sw.js and asks the browser to look for a new version when the
   app opens, comes back to the screen, regains focus or comes back online
   (at most once every 30 seconds). The service worker installs the new
   version, takes over (skipWaiting + clients.claim), and this page reloads
   ONCE so the new files are used. No more closing the Home Screen app twice.

   Guards
     - no reload on the very first install (there was no old version)
     - at most one automatic reload per 30 seconds (sessionStorage), so a
       broken release can never loop
     - never while you are typing, editing, or recording: it waits, shows
       "Update ready", and reloads when the page is idle or you tap Reload */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWGIAutoUpdate = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var RELOAD_KEY = 'twgi-sw-reloaded-at';
  var MIN_GAP = 30000;
  var CHECK_GAP = 30000;

  // Pure decision used by start() and the tests.
  function decide(o) {
    if (!o.hadController) return 'skip-first-install';
    if (o.lastReloadAt && o.now - o.lastReloadAt >= 0 && o.now - o.lastReloadAt < (o.minGap || MIN_GAP)) return 'skip-loop';
    if (o.busy) return 'defer';
    return 'reload';
  }

  // True while the person is typing, editing or recording.
  function isBusy(doc, extraSelector) {
    if (!doc) return false;
    var a = doc.activeElement;
    if (a && a !== doc.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || ''))) return true;
    var fields = doc.querySelectorAll('textarea, input[type=text], input:not([type])');
    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i];
      if (f.type === 'hidden') continue;
      if (String(f.value || '').trim() && f.value !== f.defaultValue) return true;
    }
    if (extraSelector && doc.querySelector(extraSelector)) return true;
    return false;
  }

  function start(o) {
    o = o || {};
    var win = o.window;
    var nav = o.navigator || (win && win.navigator);
    var doc = o.document || (win && win.document);
    var store = o.storage || null;
    var now = o.now || function () { return Date.now(); };
    if (!nav || !nav.serviceWorker || !nav.serviceWorker.register) return null;
    var sw = nav.serviceWorker;
    var hadController = !!sw.controller;
    var reg = null;
    var lastCheck = 0;
    var deferred = false;
    var banner = null;
    var api = { reloads: 0, checks: 0, decisions: [] };

    function lastReloadAt() {
      try { return Number(store && store.getItem(RELOAD_KEY)) || 0; } catch (err) { return 0; }
    }
    function busy() { return o.busy ? !!o.busy() : isBusy(doc, o.busySelector); }

    function reloadNow() {
      try { if (store) store.setItem(RELOAD_KEY, String(now())); } catch (err) {}
      api.reloads += 1;
      if (o.reload) o.reload(); else win.location.reload();
    }

    function showBanner() {
      if (banner || !doc || !doc.body) return;
      banner = doc.createElement('div');
      banner.className = 'update-ready';
      banner.setAttribute('role', 'status');
      banner.setAttribute('data-update-ready', 'true');
      banner.appendChild(doc.createTextNode('Update ready. '));
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'mini';
      btn.textContent = 'Reload';
      btn.addEventListener('click', function () { deferred = false; reloadNow(); });
      banner.appendChild(btn);
      doc.body.appendChild(banner);
    }

    function attempt() {
      var d = decide({ hadController: hadController, lastReloadAt: lastReloadAt(), now: now(), busy: busy() });
      api.decisions.push(d);
      if (d === 'reload') { deferred = false; reloadNow(); }
      else if (d === 'defer') { deferred = true; showBanner(); }
      return d;
    }

    function check(force) {
      if (!reg || !reg.update) return;
      var t = now();
      if (!force && t - lastCheck < CHECK_GAP) return;
      lastCheck = t;
      api.checks += 1;
      try { var p = reg.update(); if (p && p.catch) p.catch(function () {}); } catch (err) {}
    }

    function wake() {
      if (deferred) attempt();
      check(false);
    }

    sw.addEventListener('controllerchange', function () {
      var before = hadController;
      hadController = true;
      if (!before) { api.decisions.push('skip-first-install'); return; }
      attempt();
    });

    function register() {
      return sw.register(o.url || '/sw.js', { updateViaCache: 'none' }).then(function (r) {
        reg = r;
        check(true);
        return r;
      }).catch(function () { return null; });
    }

    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () { if (doc.visibilityState !== 'hidden') wake(); });
      doc.addEventListener('focusout', function () { if (deferred) setTimeout(function () { if (deferred) attempt(); }, 300); });
    }
    if (win && win.addEventListener) {
      win.addEventListener('focus', wake);
      win.addEventListener('online', wake);
      win.addEventListener('pageshow', wake);
    }
    if (o.interval !== 0 && typeof setInterval === 'function' && win) {
      api.interval = setInterval(function () { check(false); }, o.interval || 3600000);
    }

    api.ready = (!doc || doc.readyState === 'complete' || !win || o.immediate) ? register()
      : new Promise(function (resolve) { win.addEventListener('load', function () { resolve(register()); }); });
    api.check = check;
    api.attempt = attempt;
    api.isDeferred = function () { return deferred; };
    return api;
  }

  return { start: start, decide: decide, isBusy: isBusy, RELOAD_KEY: RELOAD_KEY };
});
