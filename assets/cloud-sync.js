/* TWGI cloud sync engine. The same file ships in Taskmaster and the Journal.

   Works only for a signed-in master account. Signed out, nothing here runs and
   the apps keep their device-only lists exactly as before.

   Model
     records  one row per item (task or journal entry) in an owner-only table.
              Each item carries updatedAt. The newest updatedAt wins, item by
              item. A deleted item becomes a tombstone (deleted = true) so it
              can never come back from an older copy on another device.
     doc      optional single value per account (Taskmaster: the list order;
              Journal: the settings), also newest-wins.

   Local bookkeeping (localStorage, per app and account; no secrets):
     twgi-sync-v1:<app>:<user>:tombs    { id: deletedAt ms }
     twgi-sync-v1:<app>:<user>:known    { id: updatedAt ms the cloud has }
     twgi-sync-v1:<app>:<user>:cursor   last server synced_at seen
     twgi-sync-v1:<app>:<user>:doc      { value, at }  and  :docknown
   The outbox (pending changes) is every item or tombstone that is newer than
   what the cloud is known to have. It survives reloads and going offline and
   is sent on the next sync (sign-in, app open, focus, back online, realtime
   nudge, or a few hundred ms after a change).

   The server table must reject an older updated_at (trigger) and stamp
   synced_at = now() on every write; see the SQL files. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWGICloudSync = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var PREFIX = 'twgi-sync-v1:';
  var PAGE = 500;
  var BATCH = 100;
  var OVERLAP_MS = 120000;
  var MAX_TOMBS = 3000;
  var RETRY = [3000, 10000, 30000, 60000, 300000];

  function ms(value) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    var n = Date.parse(value || '');
    return isFinite(n) ? n : 0;
  }
  function iso(n) { return new Date(n).toISOString(); }

  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().filter(function (k) { return value[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // Content fingerprint of an item, ignoring the listed fields.
  function fingerprint(item, ignore) {
    var copy = {};
    Object.keys(item || {}).forEach(function (k) { if ((ignore || []).indexOf(k) === -1) copy[k] = item[k]; });
    return stable(copy);
  }

  function copyOf(item) {
    var out = {};
    Object.keys(item || {}).forEach(function (k) { out[k] = item[k]; });
    return out;
  }

  /* Pure. Gives every item whose content changed (or that is new without a
     valid time) an updatedAt later than its previous one. */
  function stamp(prev, next, now, ignore) {
    var ign = ['updatedAt'].concat(ignore || []);
    var before = {};
    (prev || []).forEach(function (p) { if (p && p.id) before[p.id] = p; });
    return (next || []).map(function (item) {
      var p = before[item.id];
      if (!p) {
        if (ms(item.updatedAt)) return item;
        var fresh = copyOf(item); fresh.updatedAt = iso(now); return fresh;
      }
      if (fingerprint(p, ign) === fingerprint(item, ign)) return item;
      if (ms(item.updatedAt) > ms(p.updatedAt)) return item;
      var out = copyOf(item);
      out.updatedAt = iso(Math.max(now, ms(p.updatedAt) + 1));
      return out;
    });
  }

  /* Pure. Merges cloud records into the device copy.
     items: device items; tombs: { id: deletedAt ms };
     remote: [{ id, updatedAt, deleted, item }].
     Newest wins. On an exact tie a deletion wins. New cloud items are added
     at the end (the app arranges them). Returns { items, tombs, changed }. */
  function merge(items, tombs, remote) {
    var list = (items || []).map(copyOf);
    var at = {};
    list.forEach(function (item, i) { at[item.id] = i; });
    var t = copyOf(tombs || {});
    var removed = {};
    var changed = [];
    (remote || []).forEach(function (r) {
      if (!r || !r.id) return;
      var rt = ms(r.updatedAt);
      var local = at[r.id] != null && !removed[r.id] ? list[at[r.id]] : null;
      var lt = local ? ms(local.updatedAt) : 0;
      var tt = t[r.id] != null ? ms(t[r.id]) : 0;
      var localTime = Math.max(lt, tt);
      var localDeleted = tt >= lt && t[r.id] != null;
      var takeRemote = rt > localTime || (rt === localTime && r.deleted && !localDeleted && (local || t[r.id] == null));
      if (!local && t[r.id] == null) takeRemote = true;
      if (!takeRemote) {
        // Exact tie between our deletion and a live cloud copy: deletion wins,
        // so nudge the tombstone forward to make sure it is sent.
        if (rt === tt && localDeleted && !r.deleted) t[r.id] = tt + 1;
        return;
      }
      if (r.deleted) {
        if (local) { removed[r.id] = true; changed.push(r.id); }
        t[r.id] = Math.max(rt, tt);
      } else {
        if (!r.item) return;
        var incoming = copyOf(r.item);
        incoming.id = r.id;
        incoming.updatedAt = iso(rt);
        if (local) {
          if (stable(local) !== stable(incoming)) { list[at[r.id]] = incoming; changed.push(r.id); }
          else list[at[r.id]] = incoming;
        } else {
          at[r.id] = list.length;
          list.push(incoming);
          delete removed[r.id];
          changed.push(r.id);
        }
        delete t[r.id];
      }
    });
    return { items: list.filter(function (item) { return !removed[item.id]; }), tombs: t, changed: changed };
  }

  /* Pure. Ids the cloud does not have yet (the outbox). */
  function dirty(items, tombs, known) {
    var out = [];
    var k = known || {};
    var seen = {};
    (items || []).forEach(function (item) {
      seen[item.id] = true;
      if (k[item.id] == null || ms(item.updatedAt) > k[item.id]) out.push(item.id);
    });
    Object.keys(tombs || {}).forEach(function (id) {
      if (seen[id]) return;
      if (k[id] == null || tombs[id] > k[id]) out.push(id);
    });
    return out;
  }

  // Missing table (SQL not applied yet) and similar "not switched on" errors.
  function classify(err, status) {
    var code = err && err.code ? String(err.code) : '';
    var text = err && err.message ? String(err.message) : '';
    if (code === 'PGRST205' || code === '42P01' || code === 'PGRST106' || status === 404 || /schema cache|does not exist/i.test(text)) return 'unavailable';
    if (code === '42501' || status === 401 || status === 403 || code === 'PGRST301' || code === 'PGRST303') return 'denied';
    return 'offline';
  }

  function SyncError(kind, err) {
    var e = new Error(kind);
    e.kind = kind;
    e.cause = err;
    return e;
  }

  async function run(query) {
    var res;
    try { res = await query; }
    catch (err) { throw SyncError(classify(err, 0), err); }
    if (res && res.error) throw SyncError(classify(res.error, res.status), res.error);
    return res || {};
  }

  function create(opts) {
    var storage = opts.storage;
    var win = opts.window || null;
    var now = opts.now || function () { return Date.now(); };
    var rec = opts.records;
    var doc = opts.doc || null;
    var ignore = opts.ignore || [];
    var user = null;
    var channel = null;
    var channelClient = null;
    var running = null;
    var again = false;
    var timer = null;
    var retryTimer = null;
    var failures = 0;
    var state = { status: 'local', pending: 0 };
    var listeners = [];
    var lastFocus = 0;
    var bound = false;
    var unavailableUntil = 0;

    function key(uid, part) { return PREFIX + opts.app + ':' + uid + ':' + part; }
    function load(uid, part, fallback) {
      try {
        var v = JSON.parse(storage.getItem(key(uid, part)) || 'null');
        return v == null ? fallback : v;
      } catch (err) { return fallback; }
    }
    function save(uid, part, value) {
      try { storage.setItem(key(uid, part), JSON.stringify(value)); } catch (err) {}
    }

    function setStatus(status, extra) {
      state = { status: status, pending: user ? pendingCount(user) : 0 };
      if (extra) Object.keys(extra).forEach(function (k) { state[k] = extra[k]; });
      listeners.forEach(function (fn) { try { fn(state); } catch (err) {} });
    }

    function tombs(uid) { return load(uid, 'tombs', {}); }
    function saveTombs(uid, t) {
      var ids = Object.keys(t);
      if (ids.length > MAX_TOMBS) {
        ids.sort(function (a, b) { return t[b] - t[a]; });
        var keep = {};
        ids.slice(0, MAX_TOMBS).forEach(function (id) { keep[id] = t[id]; });
        t = keep;
      }
      save(uid, 'tombs', t);
    }

    function pendingCount(uid) {
      var n = dirty(rec.read(uid), tombs(uid), load(uid, 'known', {})).length;
      if (doc) {
        var d = load(uid, 'doc', null);
        if (d && d.at > load(uid, 'docknown', 0)) n += 1;
      }
      return n;
    }

    function client() {
      try { return opts.getClient ? opts.getClient() : null; } catch (err) { return null; }
    }

    function isOffline() {
      var nav = win && win.navigator;
      return !!(nav && nav.onLine === false);
    }

    /* Called by the app right before it saves its list. Returns the list to
       store (changed items get a fresh updatedAt) and records deletions. */
    function recordChange(uid, prev, next, info) {
      if (!uid || uid !== user) return next;
      var stamped = stamp(prev, next, now(), ignore);
      var t = tombs(uid);
      var touched = false;
      ((info && info.deleted) || []).forEach(function (id) { t[id] = now(); touched = true; });
      stamped.forEach(function (item) {
        if (t[item.id] != null && ms(item.updatedAt) > t[item.id]) { delete t[item.id]; touched = true; }
      });
      if (touched) saveTombs(uid, t);
      soon(400);
      return stamped;
    }

    function setDoc(uid, value) {
      if (!doc || !uid || uid !== user) return;
      var current = load(uid, 'doc', null);
      if (current && stable(current.value) === stable(value)) return;
      var at = Math.max(now(), current ? current.at + 1 : 0);
      save(uid, 'doc', { value: value, at: at });
      soon(400);
    }

    function getDoc(uid) { return doc ? load(uid, 'doc', null) : null; }

    async function pullRecords(uid, c) {
      var cursor = load(uid, 'cursor', null);
      var since = cursor ? iso(Math.max(0, ms(cursor) - OVERLAP_MS)) : null;
      var rows = [];
      for (var offset = 0; ; offset += PAGE) {
        var q = c.from(rec.table).select('*').eq('user_id', uid);
        if (since) q = q.gte('synced_at', since);
        q = q.order('synced_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + PAGE - 1);
        var res = await run(q);
        var data = res.data || [];
        rows = rows.concat(data);
        if (data.length < PAGE) break;
      }
      if (!rows.length) return [];
      var known = load(uid, 'known', {});
      var maxSynced = cursor ? ms(cursor) : 0;
      var remote = rows.map(function (row) {
        var r = rec.fromRow(row);
        if (r && r.id) known[r.id] = ms(r.updatedAt);
        if (ms(row.synced_at) > maxSynced) maxSynced = ms(row.synced_at);
        return r;
      }).filter(Boolean);
      var result = merge(rec.read(uid), tombs(uid), remote);
      saveTombs(uid, result.tombs);
      save(uid, 'known', known);
      if (maxSynced) save(uid, 'cursor', iso(maxSynced));
      if (result.changed.length) rec.write(uid, result.items, { changed: result.changed });
      return result.changed;
    }

    async function pushRecords(uid, c) {
      var items = rec.read(uid);
      var t = tombs(uid);
      var known = load(uid, 'known', {});
      var ids = dirty(items, t, known);
      if (!ids.length) return 0;
      var byId = {};
      items.forEach(function (item) { byId[item.id] = item; });
      var rows = ids.map(function (id) {
        var item = byId[id];
        if (item) {
          var when = ms(item.updatedAt) || ms(item.createdAt) || now();
          return { at: when, row: rec.toRow(item, uid, iso(when)) };
        }
        return { at: t[id], row: rec.tombRow(id, uid, iso(t[id])) };
      });
      for (var i = 0; i < rows.length; i += BATCH) {
        var chunk = rows.slice(i, i + BATCH);
        await run(c.from(rec.table).upsert(chunk.map(function (x) { return x.row; }), { onConflict: 'user_id,id' }));
        known = load(uid, 'known', {});
        chunk.forEach(function (x) { known[x.row.id] = Math.max(known[x.row.id] || 0, x.at); });
        save(uid, 'known', known);
      }
      return rows.length;
    }

    async function syncDoc(uid, c) {
      if (!doc) return false;
      var res = await run(c.from(doc.table).select('*').eq('user_id', uid).maybeSingle());
      var row = res.data || null;
      var local = load(uid, 'doc', null);
      var known = load(uid, 'docknown', 0);
      if (!local && !row && doc.initial) {
        var first = doc.initial(uid);
        if (first != null) { local = { value: first, at: 1 }; save(uid, 'doc', local); }
      }
      var applied = false;
      if (row) {
        var rt = ms(row.updated_at);
        var localDirty = local && local.at > known;
        if (!local || rt > local.at || (rt === local.at && !localDirty)) {
          var value = row[doc.column];
          var differs = !local || stable(local.value) !== stable(value);
          local = { value: value, at: rt };
          save(uid, 'doc', local);
          save(uid, 'docknown', rt);
          known = rt;
          if (differs) { doc.apply(uid, value); applied = true; }
        } else if (rt > known) {
          save(uid, 'docknown', rt);
          known = rt;
        }
      }
      if (local && local.at > known) {
        var up = { user_id: uid, updated_at: iso(local.at) };
        up[doc.column] = local.value;
        await run(c.from(doc.table).upsert(up, { onConflict: 'user_id' }));
        save(uid, 'docknown', local.at);
      }
      return applied;
    }

    async function once() {
      var uid = user;
      var c = client();
      if (!uid) { setStatus('local'); return; }
      if (!c || !c.from) { setStatus('local'); return; }
      if (isOffline()) { setStatus('offline'); return; }
      if (unavailableUntil && now() < unavailableUntil) { setStatus('unavailable'); return; }
      try {
        var changed = await pullRecords(uid, c);
        if (uid !== user) return;
        var docApplied = await syncDoc(uid, c);
        if (uid !== user) return;
        var sent = await pushRecords(uid, c);
        failures = 0;
        unavailableUntil = 0;
        setStatus('synced', { changed: changed.length, sent: sent, docApplied: docApplied });
        if ((changed.length || docApplied) && opts.onApplied) opts.onApplied(uid);
      } catch (err) {
        var kind = err && err.kind ? err.kind : 'offline';
        if (kind === 'unavailable') { unavailableUntil = now() + 300000; setStatus('unavailable'); return; }
        setStatus(kind === 'denied' ? 'error' : 'offline');
        scheduleRetry();
      }
    }

    function scheduleRetry() {
      if (retryTimer || !user) return;
      var wait = RETRY[Math.min(failures, RETRY.length - 1)];
      failures += 1;
      retryTimer = setTimeout(function () { retryTimer = null; sync(); }, wait);
    }

    // Single flight: a sync asked for while one runs starts right after it.
    function sync() {
      if (running) { again = true; return running; }
      running = once().catch(function () {}).then(function () {
        running = null;
        if (again) { again = false; return sync(); }
        return state;
      });
      return running;
    }

    function soon(delay) {
      if (!user) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; sync(); }, delay == null ? 300 : delay);
    }

    function unsubscribe() {
      if (channel && channelClient && channelClient.removeChannel) {
        try { channelClient.removeChannel(channel); } catch (err) {}
      }
      channel = null;
      channelClient = null;
    }

    function subscribe(uid) {
      unsubscribe();
      var c = client();
      if (!c || !c.channel) return;
      try {
        var filter = 'user_id=eq.' + uid;
        var ch = c.channel('twgi-sync-' + opts.app + '-' + uid);
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: rec.table, filter: filter }, function () { soon(250); });
        if (doc) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: doc.table, filter: filter }, function () { soon(250); });
        ch.subscribe();
        channel = ch;
        channelClient = c;
      } catch (err) { channel = null; }
    }

    function onWake() {
      if (!user) return;
      var t = now();
      if (t - lastFocus < 2000) return;
      lastFocus = t;
      unavailableUntil = 0;
      sync();
    }

    function bind() {
      if (bound || !win || !win.addEventListener) return;
      bound = true;
      win.addEventListener('focus', onWake);
      win.addEventListener('online', function () { failures = 0; unavailableUntil = 0; if (user) sync(); });
      win.addEventListener('pageshow', onWake);
      var d = win.document;
      if (d && d.addEventListener) d.addEventListener('visibilitychange', function () { if (d.visibilityState !== 'hidden') onWake(); });
    }

    function start(uid) {
      uid = uid ? String(uid) : null;
      if (uid === user) return running || Promise.resolve(state);
      stop();
      user = uid;
      if (!uid) { setStatus('local'); return Promise.resolve(state); }
      bind();
      subscribe(uid);
      unavailableUntil = 0;
      return sync();
    }

    function stop() {
      user = null;
      unsubscribe();
      if (timer) { clearTimeout(timer); timer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      failures = 0;
      setStatus('local');
    }

    return {
      start: start,
      stop: stop,
      sync: sync,
      soon: soon,
      recordChange: recordChange,
      setDoc: setDoc,
      getDoc: getDoc,
      user: function () { return user; },
      status: function () { return state; },
      onStatus: function (fn) { listeners.push(fn); },
      pending: function () { return user ? pendingCount(user) : 0; },
      tombstones: function (uid) {
        var t = tombs(uid);
        return Object.keys(t).map(function (id) { return { id: id, deletedAt: iso(t[id]) }; })
          .sort(function (a, b) { return a.deletedAt < b.deletedAt ? 1 : -1; });
      }
    };
  }

  // Plain-language status line shared by both apps.
  function describe(state, noun) {
    var s = state || {};
    var n = s.pending || 0;
    if (s.status === 'synced') return n ? 'Syncing\u2026' : 'Synced across your devices.';
    if (s.status === 'offline') return 'Offline. ' + (n ? 'Your changes are saved here and will sync when you are back online.' : 'Saved on this device.');
    if (s.status === 'unavailable') return 'Saved on this device. Syncing between devices is not switched on yet.';
    if (s.status === 'error') return 'Saved on this device. Sign in again to sync your ' + (noun || 'changes') + '.';
    return '';
  }

  return {
    create: create, merge: merge, stamp: stamp, dirty: dirty, fingerprint: fingerprint,
    classify: classify, describe: describe, ms: ms
  };
});
