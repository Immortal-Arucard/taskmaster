/* Taskmaster cloud sync (v6). Needs assets/cloud-sync.js, assets/taskmaster.js,
   assets/task-order.js and assets/auth.js (TWGIAccount).

   Signed in: every task syncs to public.taskmaster_tasks (one owner-only row
   per task: name, done, times, worked sessions; deleted tasks stay as
   tombstones) and the list order to public.taskmaster_lists. Newest change
   wins per task; the newest reorder wins for the order. Tasks that are not in
   the synced order yet (just added on another device) appear at the top.
   Signed out: nothing is sent; the device list works as before.
   Uses only the public publishable key session from auth.js. */
(function (global) {
  var TM = global.TWGITaskmaster;
  var Sync = global.TWGICloudSync;
  var O = global.TWGITaskOrder;
  if (!TM || !Sync) return;

  var FIELDS = ['title', 'done', 'createdAt', 'startAt', 'dueAt', 'durationMin', 'segments', 'completedAt'];

  function ids(list) { return (list || []).map(function (t) { return t.id; }); }
  function normalize(list) { return O ? O.normalize(list) : list.slice(); }

  function payload(task) {
    var out = {};
    FIELDS.forEach(function (k) { if (task[k] !== undefined) out[k] = task[k]; });
    return out;
  }

  // Order: tasks in the synced order follow it; tasks not in it go on top
  // (brand new ones first, newest first; then the rest in their old order).
  function arrange(items, prevIds, docIds) {
    var prevPos = {};
    (prevIds || []).forEach(function (id, i) { prevPos[id] = i; });
    var docPos = null;
    if (Array.isArray(docIds)) { docPos = {}; docIds.forEach(function (id, i) { if (docPos[id] == null) docPos[id] = i; }); }
    var unlisted = [];
    var listed = [];
    items.forEach(function (t) { if (docPos && docPos[t.id] != null) listed.push(t); else unlisted.push(t); });
    unlisted.sort(function (a, b) {
      var an = prevPos[a.id] == null;
      var bn = prevPos[b.id] == null;
      if (an !== bn) return an ? -1 : 1;
      if (an) return String(b.createdAt || '') < String(a.createdAt || '') ? -1 : (String(b.createdAt || '') > String(a.createdAt || '') ? 1 : 0);
      return prevPos[a.id] - prevPos[b.id];
    });
    listed.sort(function (a, b) { return docPos[a.id] - docPos[b.id]; });
    return unlisted.concat(listed).map(function (t, i) {
      var c = {};
      Object.keys(t).forEach(function (k) { c[k] = t[k]; });
      c.order = i;
      return c;
    });
  }

  function cleanDocIds(value) {
    if (!Array.isArray(value)) return null;
    return value.filter(function (id) { return typeof id === 'string' && id.length <= 80; }).slice(0, 1000);
  }

  var engine = Sync.create({
    app: 'taskmaster',
    storage: global.localStorage,
    window: global,
    ignore: ['order'],
    getClient: function () { return global.TWGIAccount && global.TWGIAccount.client ? global.TWGIAccount.client() : null; },
    records: {
      table: 'taskmaster_tasks',
      read: function (uid) { return TM.read(uid); },
      write: function (uid, items) {
        var doc = engine.getDoc(uid);
        TM.applyRemote(uid, arrange(items, ids(TM.read(uid)), doc ? cleanDocIds(doc.value) : null));
      },
      toRow: function (task, uid, updatedAt) {
        return { user_id: uid, id: task.id, data: payload(task), deleted: false, updated_at: updatedAt };
      },
      tombRow: function (id, uid, updatedAt) {
        return { user_id: uid, id: id, data: {}, deleted: true, updated_at: updatedAt };
      },
      fromRow: function (row) {
        if (!row || typeof row.id !== 'string') return null;
        if (row.deleted) return { id: row.id, updatedAt: row.updated_at, deleted: true };
        var data = row.data && typeof row.data === 'object' ? row.data : {};
        if (typeof data.title !== 'string') return null;
        var item = payload(data);
        item.id = row.id;
        return { id: row.id, updatedAt: row.updated_at, deleted: false, item: item };
      }
    },
    doc: {
      table: 'taskmaster_lists',
      column: 'task_order',
      initial: function (uid) { var list = ids(TM.read(uid)); return list.length ? list : null; },
      apply: function (uid, value) {
        var order = cleanDocIds(value);
        if (!order) return;
        var current = TM.read(uid);
        TM.applyRemote(uid, arrange(current, ids(current), order));
      }
    }
  });

  var waiters = [];
  function result(state) {
    if (state.status === 'synced' && !state.pending) return { synced: true, status: state.status };
    return { synced: false, pending: state.pending, status: state.status, message: Sync.describe(state, 'tasks') || 'Saved on this device.' };
  }
  var syncNote = document.getElementById('sync-note');
  engine.onStatus(function (state) {
    var list = waiters; waiters = [];
    list.forEach(function (w) { clearTimeout(w.t); w.resolve(result(state)); });
    if (syncNote) {
      var text = engine.user() ? Sync.describe(state, 'tasks') : '';
      syncNote.textContent = text;
      syncNote.hidden = !text;
    }
  });

  TM.sync.mode = 'cloud';
  TM.sync.stamp = function (uid, prev, next, info) {
    if (!uid || engine.user() !== uid) return next;
    var out = engine.recordChange(uid, prev, normalize(next), info);
    if (ids(prev).join('\n') !== ids(out).join('\n')) engine.setDoc(uid, ids(out));
    return out;
  };
  TM.sync.tombstones = function (uid) { return engine.tombstones(uid); };
  TM.sync.push = function (uid) {
    if (!uid || engine.user() !== uid) return Promise.resolve({ synced: false, reason: 'local-only' });
    return new Promise(function (resolve) {
      var w = { resolve: resolve };
      w.t = setTimeout(function () {
        waiters = waiters.filter(function (x) { return x !== w; });
        resolve(result(engine.status()));
      }, 15000);
      waiters.push(w);
      engine.soon(300);
    });
  };

  global.TWGITaskSync = { engine: engine, arrange: arrange };

  function bind(state) { engine.start(state && state.user ? state.user.id : null); }
  if (global.TWGIAccount) global.TWGIAccount.subscribe(bind);
  else document.addEventListener('twgi-account-api', function () { global.TWGIAccount.subscribe(bind); }, { once: true });
})(window);
