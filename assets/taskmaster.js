/* Taskmaster list for a master account.
   Storage is localStorage. Nothing in this file calls Supabase.

   Sync-later seam: TWGITaskmaster.sync.pull and .push.
   pull(userId) should resolve to an array of tasks, or null when the
   remote store has nothing to apply. push(userId, tasks) should resolve
   to { synced: true } after a reviewed table is applied. Until then both
   stay local-only. A future table would be owner-scoped
   (id, owner, title, done, created_at, updated_at) with row level
   security limited to auth.uid(). Do not add that call here early.

   Schedule and timing fields (assets/task-time.js): startAt, dueAt,
   durationMin, segments [{s, e}], completedAt. Start / Stop (not finished) /
   Resume / Done record worked segments; a stopped, unfinished task shows a
   red Incomplete tag until it is resumed or completed.

   Manual order (v4, assets/task-order.js): each task has `order` (0 = top)
   and the stored array is kept in that order. Drag the handle (touch, pen or
   mouse), use the arrow keys on it, or tap Up / Down.

   Rename (v5): Edit name turns the title into a text field with Save and
   Cancel. Enter saves, Escape cancels. An empty name is rejected and the
   old name is kept. The new title is stored with the task (same localStorage
   key, sync.push and onChange), so reminder text and comment threads pick
   it up. The task's id, order, times, tags and comments stay the same.

   Full-page task (v5): tapping a non-control part of a card opens #/task/<id>
   (phone Back returns to the list at the same scroll). The page shows only
   that task: no app header, list or other chrome. A small Back control sits
   at the top. The first screen is a read-only stats display (name, status,
   scheduled and actual times, duration, comment count; dashes for anything
   not set; local times). Swipe, scroll or tap "Swipe for settings" to reach
   the tools below (rename, start/stop/complete, plan, actual times, comments).
   Taps on buttons, inputs, the drag handle, links or comments, and a drag to
   reorder, do not open the page.

   Change listeners: TWGITaskmaster.onChange(fn) gets (userId, tasks) after
   every save. assets/push-ui.js uses it to send the schedule fields to the
   push service, and assets/comments.js to keep comment threads titled.

   Keys:
     twgi-taskmaster-v1:<user id>   signed-in list
     twgi-taskmaster-v1:device      this browser, signed out
   The first time a signed-in list is empty and the device list is not,
   the device list is copied onto the account key. The device copy stays.
*/
(function (global) {
  var PREFIX = 'twgi-taskmaster-v1:';
  var DEVICE = 'device';
  var MAX_TITLE = 140;
  var MAX_TASKS = 200;
  var root = null;
  var userId = null;
  var requireUser = false;
  var changeListeners = [];
  var T = global.TWGITaskTime;
  var O = global.TWGITaskOrder;
  var listScroll = 0;
  var pushedPage = false;
  var closingPage = false;
  var ignoreOpenClick = false;
  var hashBound = false;

  var sync = {
    mode: 'local',
    pull: function () { return Promise.resolve(null); },
    push: function () { return Promise.resolve({ synced: false, reason: 'local-only' }); }
  };

  function storageKey(id) {
    return PREFIX + (id || DEVICE);
  }

  function read(id) {
    try {
      var parsed = JSON.parse(global.localStorage.getItem(storageKey(id)) || '[]');
      if (!Array.isArray(parsed)) return [];
      var list = parsed.filter(function (task) {
        return task && typeof task.id === 'string' && typeof task.title === 'string';
      }).map(function (task) {
        var base = {
          id: task.id,
          title: task.title.slice(0, MAX_TITLE),
          done: !!task.done,
          createdAt: String(task.createdAt || ''),
          updatedAt: String(task.updatedAt || ''),
          startAt: task.startAt,
          dueAt: task.dueAt,
          durationMin: task.durationMin,
          segments: task.segments,
          completedAt: task.completedAt,
          order: task.order
        };
        return T ? T.clean(base) : base;
      });
      return O ? O.normalize(list) : list;
    } catch (err) {
      return [];
    }
  }

  function write(id, tasks) {
    global.localStorage.setItem(storageKey(id), JSON.stringify(tasks));
  }

  function cleanTitle(value) {
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_TITLE);
  }

  function newId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function adoptDeviceList(id) {
    if (!id) return;
    var marker = PREFIX + 'adopted:' + id;
    if (global.localStorage.getItem(marker)) return;
    var mine = read(id);
    if (mine.length) {
      global.localStorage.setItem(marker, 'kept-account');
      return;
    }
    var device = read(null);
    if (!device.length) return;
    write(id, device);
    global.localStorage.setItem(marker, 'copied-device');
  }

  function activeKey() {
    return requireUser && !userId ? null : userId;
  }

  function say(text) {
    var status = root && root.querySelector('[data-task-status]');
    if (status) status.textContent = text || '';
    var pageStatus = document.querySelector('[data-task-page-status]');
    if (pageStatus) pageStatus.textContent = text || '';
  }

  function persist(tasks) {
    var id = activeKey();
    if (requireUser && !id) return Promise.resolve();
    if (O) tasks = O.normalize(tasks);
    try {
      write(id, tasks);
    } catch (err) {
      say('This device could not store the list.');
      return Promise.resolve();
    }
    changeListeners.forEach(function (fn) { try { fn(id, tasks); } catch (err) {} });
    return sync.push(id, tasks).then(function (result) {
      if (result && result.synced) say('Synced.');
      else say('Saved on this device. Sync later: this list is not sent to the account store.');
    }).catch(function () {
      say('Saved on this device. Sync later: this list is not sent to the account store.');
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function when(value) {
    var n = Date.parse(value || '');
    if (!isFinite(n)) return '';
    var d = new Date(n);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    var opts = sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return (sameDay ? 'today ' : '') + d.toLocaleString(undefined, opts);
  }

  function tag(text, kind) {
    var span = document.createElement('span');
    span.className = 'task-tag' + (kind ? ' tag-' + kind : '');
    span.textContent = text;
    return span;
  }

  function el(name, cls, text) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function field(labelText, input) {
    var wrap = el('label', 'task-field');
    wrap.appendChild(el('span', '', labelText));
    wrap.appendChild(input);
    return wrap;
  }

  function dateInput(value) {
    var input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = T.toLocalInput(value);
    return input;
  }

  function durationInputs(minutes) {
    var hours = document.createElement('input');
    hours.type = 'number'; hours.min = '0'; hours.max = '168'; hours.inputMode = 'numeric';
    hours.className = 'task-num'; hours.setAttribute('aria-label', 'Projected hours');
    var mins = document.createElement('input');
    mins.type = 'number'; mins.min = '0'; mins.max = '59'; mins.step = '5'; mins.inputMode = 'numeric';
    mins.className = 'task-num'; mins.setAttribute('aria-label', 'Projected minutes');
    if (minutes) { hours.value = String(Math.floor(minutes / 60)); mins.value = String(minutes % 60); }
    var box = el('span', 'task-duration');
    box.appendChild(hours); box.appendChild(el('span', '', 'h'));
    box.appendChild(mins); box.appendChild(el('span', '', 'm'));
    return { node: box, value: function () {
      var total = (Number(hours.value) || 0) * 60 + (Number(mins.value) || 0);
      return total > 0 ? total : null;
    } };
  }

  // Applies fn to one stored task, saves, and repaints its row.
  function update(id, fn) {
    var tasks = read(activeKey());
    var now = Date.now();
    var changed = null;
    tasks = tasks.map(function (entry) {
      if (entry.id !== id) return entry;
      changed = fn(entry, now) || entry;
      return changed;
    });
    if (!changed) return null;
    persist(tasks);
    var list = root.querySelector('[data-task-list]');
    var old = list && list.querySelector('[data-id="' + cssId(id) + '"]');
    if (old) {
      var open = old.querySelector('details.task-details');
      var next = row(changed, { open: open && open.open });
      list.replaceChild(next, old);
      refreshMoveButtons();
    }
    refreshOpenPage(id);
    return changed;
  }

  function cssId(id) { return String(id).replace(/["\\]/g, '\\$&'); }

  function metaTags(task) {
    var now = Date.now();
    var box = el('div', 'task-meta');
    var st = T.status(task);
    if (task.startAt) box.appendChild(tag('Starts ' + when(task.startAt), 'plan'));
    if (task.dueAt) box.appendChild(tag('Due ' + when(task.dueAt), T.overdue(task, now) ? 'late' : 'plan'));
    if (task.durationMin) box.appendChild(tag('Planned ' + T.formatDuration(task.durationMin), 'plan'));
    if (task.segments && task.segments.length) {
      var worked = T.actualMinutes(task, now);
      if (st !== 'running' || worked > 0) box.appendChild(tag('Actual ' + T.formatDuration(worked), 'actual'));
    }
    if (st === 'running') box.appendChild(tag('Running', 'running'));
    if (st === 'stopped') {
      var alert = tag('Incomplete', 'incomplete');
      alert.setAttribute('role', 'status');
      box.appendChild(alert);
    }
    return box;
  }

  function planVsActual(task) {
    var now = Date.now();
    var lines = el('div', 'task-compare');
    var plannedEnd = T.plannedEnd(task);
    lines.appendChild(el('p', 'note', 'Planned: ' + (task.startAt ? when(task.startAt) : 'no start set')
      + (plannedEnd ? ' to ' + when(plannedEnd) : '')
      + (task.durationMin ? ' (' + T.formatDuration(task.durationMin) + ')' : '')
      + (task.dueAt ? '. Due ' + when(task.dueAt) + '.' : '.')));
    var segs = task.segments || [];
    if (!segs.length) {
      lines.appendChild(el('p', 'note', 'Actual: not started.'));
    } else {
      var parts = segs.map(function (seg) { return when(seg.s) + ' to ' + (seg.e ? when(seg.e) : 'now'); });
      lines.appendChild(el('p', 'note', 'Actual: ' + T.formatDuration(T.actualMinutes(task, now)) + ' worked'
        + (segs.length > 1 ? ' in ' + segs.length + ' sessions' : '') + ': ' + parts.join('; ') + '.'));
      if (task.durationMin) {
        var diff = T.actualMinutes(task, now) - task.durationMin;
        lines.appendChild(el('p', 'note', diff === 0 ? 'Right on the plan.' : T.formatDuration(Math.abs(diff)) + (diff > 0 ? ' over plan.' : ' under plan.')));
      }
    }
    return lines;
  }

  function detailsPanel(task, open) {
    var details = el('details', 'task-details');
    details.open = !!open;
    details.appendChild(el('summary', '', 'Times and comments'));
    details.appendChild(planVsActual(task));

    var plan = el('fieldset', 'task-fieldset');
    plan.appendChild(el('legend', '', 'Plan'));
    var startIn = dateInput(task.startAt);
    var dueIn = dateInput(task.dueAt);
    var dur = durationInputs(task.durationMin);
    plan.appendChild(field('Scheduled start', startIn));
    plan.appendChild(field('Due', dueIn));
    var durWrap = el('div', 'task-field');
    durWrap.appendChild(el('span', '', 'Projected duration'));
    durWrap.appendChild(dur.node);
    plan.appendChild(durWrap);
    var savePlan = el('button', 'mini', 'Save plan');
    savePlan.type = 'button';
    savePlan.setAttribute('data-save-plan', 'true');
    savePlan.addEventListener('click', function () {
      update(task.id, function (entry, now) {
        return T.setPlan(entry, { startAt: T.fromLocalInput(startIn.value), dueAt: T.fromLocalInput(dueIn.value), durationMin: dur.value() }, now);
      });
      say('Plan saved.');
    });
    plan.appendChild(savePlan);
    details.appendChild(plan);

    var actual = el('fieldset', 'task-fieldset');
    actual.appendChild(el('legend', '', 'Actual'));
    var aStart = dateInput(T.actualStart(task));
    var aEnd = dateInput(T.actualEnd(task));
    actual.appendChild(field('Actual start', aStart));
    actual.appendChild(field('Actual end', aEnd));
    if ((task.segments || []).length > 1) {
      actual.appendChild(el('p', 'note', 'Changing these moves the first start and the last end. Sessions in between are kept.'));
    }
    var saveActual = el('button', 'mini', 'Save actual times');
    saveActual.type = 'button';
    saveActual.setAttribute('data-save-actual', 'true');
    saveActual.addEventListener('click', function () {
      try {
        update(task.id, function (entry, now) {
          return T.setActual(entry, T.fromLocalInput(aStart.value), T.fromLocalInput(aEnd.value), now);
        });
        say('Actual times saved.');
      } catch (err) { say(err.message); }
    });
    actual.appendChild(saveActual);
    details.appendChild(actual);

    var comments = el('details', 'task-comments');
    comments.setAttribute('data-comments-for', task.id);
    comments.appendChild(el('summary', '', 'Comments'));
    var slot = el('div', 'comments-slot');
    comments.appendChild(slot);
    comments.addEventListener('toggle', function () {
      if (comments.open && global.TWGITaskComments && !slot.getAttribute('data-mounted')) {
        slot.setAttribute('data-mounted', 'true');
        global.TWGITaskComments.mountTask(slot, { taskId: task.id, title: task.title, ownerId: activeKey() });
      }
    });
    details.appendChild(comments);
    return details;
  }

  // ---- Manual order (v4) ----
  function listNode() { return root && root.querySelector('[data-task-list]'); }

  function refreshMoveButtons() {
    var list = listNode();
    if (!list) return;
    var rows = Array.prototype.filter.call(list.children, function (n) { return n.classList && n.classList.contains('task-row'); });
    rows.forEach(function (item, i) {
      var up = item.querySelector('[data-move=up]');
      var down = item.querySelector('[data-move=down]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
      var handle = item.querySelector('[data-drag-handle]');
      if (handle) handle.setAttribute('aria-description', 'Position ' + (i + 1) + ' of ' + rows.length);
    });
  }

  // Saves a new order and moves the existing rows to match (open panels stay open).
  function applyOrder(tasks, movedId, focusSel) {
    if (!O) return;
    var ordered = O.normalize(tasks);
    var at0 = O.indexOf(ordered, movedId);
    var note = ordered[at0] ? 'Moved \u201c' + ordered[at0].title + '\u201d to position ' + (at0 + 1) + ' of ' + ordered.length + '.' : '';
    // The save message arrives later; keep the move announcement visible.
    persist(ordered).then(function () { if (note) say(note); });
    var list = listNode();
    if (list) {
      ordered.forEach(function (task) {
        var node = list.querySelector('[data-id="' + cssId(task.id) + '"]');
        if (node) list.appendChild(node);
      });
    }
    refreshMoveButtons();
    if (note) say(note);
    if (focusSel && list) {
      var again = list.querySelector('[data-id="' + cssId(movedId) + '"] ' + focusSel);
      if (again && !again.disabled && again.focus) again.focus();
      else {
        var handle = list.querySelector('[data-id="' + cssId(movedId) + '"] [data-drag-handle]');
        if (handle && handle.focus) handle.focus();
      }
    }
  }

  function moveBy(id, delta, focusSel) {
    if (!O) return;
    applyOrder(O.moveBy(read(activeKey()), id, delta), id, focusSel);
  }

  // Touch, pen and mouse drag on the handle (Pointer Events).
  function startDrag(item, handle, event) {
    var list = listNode();
    if (!list || !O) return;
    var others = Array.prototype.filter.call(list.children, function (n) { return n !== item && n.classList && n.classList.contains('task-row'); });
    var mids = others.map(function (n) { var r = n.getBoundingClientRect(); return r.top + r.height / 2; });
    var startY = event.clientY;
    var startScroll = global.scrollY || 0;
    var slot = O.indexOf(read(activeKey()), item.getAttribute('data-id'));
    var pointerId = event.pointerId;
    item.classList.add('is-dragging');
    list.classList.add('is-sorting');
    if (handle.setPointerCapture && pointerId != null) { try { handle.setPointerCapture(pointerId); } catch (err) {} }

    function mark() {
      others.forEach(function (n, i) {
        n.classList.toggle('drop-before', i === slot);
        n.classList.toggle('drop-after', i === others.length - 1 && slot === others.length);
      });
    }
    function onMove(e) {
      if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
      if (e.cancelable) e.preventDefault();
      var scrolled = (global.scrollY || 0) - startScroll;
      item.style.transform = 'translateY(' + (e.clientY - startY + scrolled) + 'px)';
      slot = O.slotFor(mids.map(function (m) { return m - scrolled; }), e.clientY);
      mark();
      // Edge scrolling on small screens.
      var h = global.innerHeight || 0;
      if (h && global.scrollBy) {
        if (e.clientY < 70) global.scrollBy(0, -12);
        else if (e.clientY > h - 70) global.scrollBy(0, 12);
      }
    }
    function finish(commit) {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      item.classList.remove('is-dragging');
      list.classList.remove('is-sorting');
      item.style.transform = '';
      others.forEach(function (n) { n.classList.remove('drop-before'); n.classList.remove('drop-after'); });
      suppressOpen();
      if (commit) {
        var id = item.getAttribute('data-id');
        applyOrder(O.moveTo(read(activeKey()), id, slot), id, null);
      }
    }
    function onUp() { finish(true); }
    function onCancel() { finish(false); }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    mark();
  }

  function dragHandle(item, task) {
    var handle = el('button', 'task-handle');
    handle.type = 'button';
    handle.setAttribute('data-drag-handle', 'true');
    handle.setAttribute('aria-label', 'Reorder ' + task.title + '. Drag, or use the arrow keys.');
    handle.title = 'Drag to reorder';
    handle.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="7" cy="5" r="1.6"/><circle cx="13" cy="5" r="1.6"/><circle cx="7" cy="10" r="1.6"/><circle cx="13" cy="10" r="1.6"/><circle cx="7" cy="15" r="1.6"/><circle cx="13" cy="15" r="1.6"/></svg>';
    handle.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (e.cancelable) e.preventDefault();
      startDrag(item, handle, e);
    });
    handle.addEventListener('keydown', function (e) {
      if (!O) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(task.id, -1, '[data-drag-handle]'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(task.id, 1, '[data-drag-handle]'); }
      else if (e.key === 'Home') { e.preventDefault(); applyOrder(O.moveTo(read(activeKey()), task.id, 0), task.id, '[data-drag-handle]'); }
      else if (e.key === 'End') { e.preventDefault(); applyOrder(O.moveTo(read(activeKey()), task.id, 1e9), task.id, '[data-drag-handle]'); }
    });
    return handle;
  }

  function moveButtons(task) {
    var box = el('span', 'task-move');
    var up = el('button', 'mini task-move-btn', '\u2191 Up');
    up.type = 'button';
    up.setAttribute('data-move', 'up');
    up.setAttribute('aria-label', 'Move ' + task.title + ' up');
    up.addEventListener('click', function () { moveBy(task.id, -1, '[data-move=up]'); });
    var down = el('button', 'mini task-move-btn', '\u2193 Down');
    down.type = 'button';
    down.setAttribute('data-move', 'down');
    down.setAttribute('aria-label', 'Move ' + task.title + ' down');
    down.addEventListener('click', function () { moveBy(task.id, 1, '[data-move=down]'); });
    box.appendChild(up);
    box.appendChild(down);
    return box;
  }


  function suppressOpen() {
    ignoreOpenClick = true;
    setTimeout(function () { ignoreOpenClick = false; }, 500);
  }

  function isInteractive(node, rootEl) {
    while (node && node !== rootEl) {
      if (node.nodeType === 1) {
        var tag = node.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'LABEL' || tag === 'SUMMARY') return true;
        if (node.getAttribute && (node.getAttribute('data-drag-handle') || node.getAttribute('data-rename-input') || node.getAttribute('contenteditable') === 'true')) return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  function currentScroll() { return global.pageYOffset || global.scrollY || 0; }

  function restoreScroll() {
    if (global.scrollTo) global.scrollTo(0, listScroll);
    else global.scrollY = listScroll;
  }

  function idFromHash(hash) {
    var m = String(hash || '').match(/^#\/task\/(.+)$/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (err) { return m[1]; }
  }

  function hashFor(id) { return '#/task/' + encodeURIComponent(id); }

  function pageNode() { return document.querySelector('[data-task-page]'); }

  function bindHash() {
    if (hashBound) return;
    hashBound = true;
    global.addEventListener('hashchange', onHashChange);
  }

  function onHashChange() {
    var id = idFromHash(global.location.hash);
    if (id) {
      if (closingPage) return;
      showTaskPage(id);
    } else {
      closingPage = false;
      pushedPage = false;
      hideTaskPage();
    }
  }

  function goToTask(id) {
    listScroll = currentScroll();
    closingPage = false;
    if (idFromHash(global.location.hash) !== id) {
      pushedPage = true;
      global.location.hash = hashFor(id);
    }
    showTaskPage(id);
  }

  function goBackToList() {
    closingPage = true;
    hideTaskPage();
    if (idFromHash(global.location.hash)) {
      if (pushedPage && global.history && global.history.length > 1) {
        pushedPage = false;
        global.history.back();
        return;
      }
      pushedPage = false;
      if (global.history && global.history.replaceState) {
        global.history.replaceState(null, '', (global.location.pathname || '/') + (global.location.search || ''));
      } else global.location.hash = '';
    }
    closingPage = false;
  }

  function ensurePage() {
    var page = pageNode();
    if (page) return page;
    page = el('div', 'task-page');
    page.setAttribute('data-task-page', 'true');
    page.setAttribute('role', 'dialog');
    page.setAttribute('aria-modal', 'true');
    page.setAttribute('aria-label', 'Task');
    page.hidden = true;
    document.body.appendChild(page);
    return page;
  }

  function showTaskPage(id) {
    var task = null;
    read(activeKey()).forEach(function (t) { if (t.id === id) task = t; });
    var page = ensurePage();
    var y = page.hidden ? 0 : page.scrollTop;
    var keepScroll = !page.hidden && page.getAttribute('data-open-id') === id;
    clear(page);
    page.hidden = false;
    page.setAttribute('data-open-id', id);
    document.documentElement.classList.add('is-task-page');
    document.body.classList.add('is-task-page');
    if (task) page.appendChild(buildTaskPage(task));
    else {
      page.appendChild(backButton());
      page.appendChild(el('p', 'note', 'That task is not on this list.'));
    }
    page.scrollTop = keepScroll ? y : 0;
    page.setAttribute('aria-label', task ? task.title : 'Task');
  }

  function hideTaskPage() {
    var page = pageNode();
    if (page) {
      clear(page);
      page.hidden = true;
      page.removeAttribute('data-open-id');
    }
    document.documentElement.classList.remove('is-task-page');
    document.body.classList.remove('is-task-page');
    restoreScroll();
  }

  function refreshOpenPage(id) {
    var page = pageNode();
    if (!page || page.hidden) return;
    var openId = page.getAttribute('data-open-id') || idFromHash(global.location.hash);
    if (id && openId !== id) return;
    if (openId) showTaskPage(openId);
  }

  function removeTask(id) {
    var tasks = read(activeKey()).filter(function (entry) { return entry.id !== id; });
    persist(tasks);
    var list = root && root.querySelector('[data-task-list]');
    var item = list && list.querySelector('[data-id="' + cssId(id) + '"]');
    if (item && item.parentNode) item.parentNode.removeChild(item);
    var empty = root && root.querySelector('[data-task-empty]');
    if (empty && list) empty.hidden = !!list.children.length;
    refreshMoveButtons();
    if (idFromHash(global.location.hash) === id) goBackToList();
  }

  function backButton() {
    var back = el('button', 'task-back', '\u2190 Back');
    back.type = 'button';
    back.setAttribute('data-task-back', 'true');
    back.addEventListener('click', function () { goBackToList(); });
    return back;
  }

  function statusLabel(task) {
    var st = T.status(task);
    if (st === 'running') return 'In progress';
    if (st === 'done') return 'Completed';
    if (st === 'stopped') return 'Incomplete';
    return 'Not started';
  }

  // Local date and time for the stats display. A dash means the value is not set.
  function localWhen(value) {
    var n = Date.parse(value || '');
    if (!isFinite(n)) return '\u2014';
    return new Date(n).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function statRow(label, value, key) {
    var row = el('div', 'task-stat-row');
    row.appendChild(el('span', 'task-stat-label', label));
    var v = el('span', 'task-stat-value', value);
    v.setAttribute('data-stat', key);
    row.appendChild(v);
    return row;
  }

  function fillCommentCount(node, task) {
    node.textContent = '\u2014';
    if (!global.TWGITaskComments || !global.TWGITaskComments.countFor) return;
    global.TWGITaskComments.countFor(activeKey(), task.id).then(function (n) {
      if (!node.isConnected) return;
      node.textContent = n == null ? '\u2014' : String(n);
    }).catch(function () { if (node.isConnected) node.textContent = '\u2014'; });
  }

  function nameEditor(task) {
    var title = document.createElement('span');
    title.className = 'task-title' + (task.done ? ' is-done' : '');
    title.textContent = task.title;
    title.setAttribute('data-task-title', 'true');

    var nameBox = el('div', 'task-name');
    var editName = el('button', 'mini task-rename-btn', 'Edit name');
    editName.type = 'button';
    editName.setAttribute('data-rename', 'true');
    editName.setAttribute('aria-label', 'Edit name of ' + task.title);
    editName.addEventListener('click', function () {
      if (nameBox.querySelector('[data-rename-input]')) return;
      title.hidden = true;
      editName.hidden = true;
      var input = document.createElement('input');
      input.className = 'task-input task-rename-input';
      input.type = 'text';
      input.maxLength = MAX_TITLE;
      input.autocomplete = 'off';
      input.value = task.title;
      input.setAttribute('data-rename-input', 'true');
      input.setAttribute('aria-label', 'Task name');
      var actions = el('div', 'task-rename-actions');
      var save = el('button', 'mini', 'Save');
      save.type = 'button';
      save.setAttribute('data-rename-save', 'true');
      var cancel = el('button', 'mini', 'Cancel');
      cancel.type = 'button';
      cancel.setAttribute('data-rename-cancel', 'true');
      function closeEditor() {
        if (input.parentNode) input.parentNode.removeChild(input);
        if (actions.parentNode) actions.parentNode.removeChild(actions);
        title.hidden = false;
        editName.hidden = false;
      }
      function saveName() {
        var next = cleanTitle(input.value);
        if (!next) {
          say('A task needs a name. The old name was kept.');
          input.value = task.title;
          if (input.focus) input.focus();
          return;
        }
        if (next === task.title) {
          closeEditor();
          if (editName.focus) editName.focus();
          return;
        }
        update(task.id, function (entry, now) {
          var out = {};
          Object.keys(entry).forEach(function (k) { out[k] = entry[k]; });
          out.title = next;
          out.updatedAt = new Date(now).toISOString();
          return out;
        });
        say('Name saved.');
        var scope = document.querySelector('[data-task-page]:not([hidden])') || root;
        var again = scope && scope.querySelector('[data-rename]');
        if (again && again.focus) again.focus();
      }
      function cancelName() {
        closeEditor();
        if (editName.focus) editName.focus();
      }
      save.addEventListener('click', saveName);
      cancel.addEventListener('click', cancelName);
      input.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); saveName(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelName(); }
      });
      actions.appendChild(save);
      actions.appendChild(cancel);
      nameBox.appendChild(input);
      nameBox.appendChild(actions);
      if (input.focus) input.focus();
      if (input.select) input.select();
    });
    nameBox.appendChild(title);
    nameBox.appendChild(editName);
    return nameBox;
  }

  function actionButtons(task, withMove) {
    var st = T.status(task);
    var actions = el('div', 'task-actions');
    if (!task.done) {
      if (st === 'running') {
        var stopBtn = el('button', 'mini', 'Stop (not finished)');
        stopBtn.type = 'button';
        stopBtn.setAttribute('data-action', 'stop');
        stopBtn.addEventListener('click', function () { update(task.id, function (e, now) { return T.stop(e, now); }); say('Stopped. Marked Incomplete until you resume or finish it.'); });
        actions.appendChild(stopBtn);
      } else {
        var startBtn = el('button', 'mini', st === 'stopped' ? 'Resume' : 'Start now');
        startBtn.type = 'button';
        startBtn.setAttribute('data-action', st === 'stopped' ? 'resume' : 'start');
        startBtn.addEventListener('click', function () { update(task.id, function (e, now) { return T.start(e, now); }); });
        actions.appendChild(startBtn);
      }
      var doneBtn = el('button', 'mini', 'Finish');
      doneBtn.type = 'button';
      doneBtn.setAttribute('data-action', 'finish');
      doneBtn.addEventListener('click', function () { update(task.id, function (e, now) { return T.complete(e, now); }); });
      actions.appendChild(doneBtn);
    }
    if (withMove) actions.appendChild(moveButtons(task));
    return actions;
  }

  function planFields(task) {
    var plan = el('fieldset', 'task-fieldset');
    plan.appendChild(el('legend', '', 'Plan'));
    var startIn = dateInput(task.startAt);
    var dueIn = dateInput(task.dueAt);
    var dur = durationInputs(task.durationMin);
    plan.appendChild(field('Scheduled start', startIn));
    plan.appendChild(field('Due', dueIn));
    var durWrap = el('div', 'task-field');
    durWrap.appendChild(el('span', '', 'Projected duration'));
    durWrap.appendChild(dur.node);
    plan.appendChild(durWrap);
    var savePlan = el('button', 'mini', 'Save plan');
    savePlan.type = 'button';
    savePlan.setAttribute('data-save-plan', 'true');
    savePlan.addEventListener('click', function () {
      update(task.id, function (entry, now) {
        return T.setPlan(entry, { startAt: T.fromLocalInput(startIn.value), dueAt: T.fromLocalInput(dueIn.value), durationMin: dur.value() }, now);
      });
      say('Plan saved.');
    });
    plan.appendChild(savePlan);
    return plan;
  }

  function actualFields(task) {
    var actual = el('fieldset', 'task-fieldset');
    actual.appendChild(el('legend', '', 'Actual'));
    var aStart = dateInput(T.actualStart(task));
    var aEnd = dateInput(T.actualEnd(task));
    actual.appendChild(field('Actual start', aStart));
    actual.appendChild(field('Actual end', aEnd));
    if ((task.segments || []).length > 1) {
      actual.appendChild(el('p', 'note', 'Changing these moves the first start and the last end. Sessions in between are kept.'));
    }
    var saveActual = el('button', 'mini', 'Save actual times');
    saveActual.type = 'button';
    saveActual.setAttribute('data-save-actual', 'true');
    saveActual.addEventListener('click', function () {
      try {
        update(task.id, function (entry, now) {
          return T.setActual(entry, T.fromLocalInput(aStart.value), T.fromLocalInput(aEnd.value), now);
        });
        say('Actual times saved.');
      } catch (err) { say(err.message); }
    });
    actual.appendChild(saveActual);
    return actual;
  }

  function statsPanel(task) {
    var stats = el('section', 'task-stats');
    stats.setAttribute('data-task-stats', 'true');
    stats.appendChild(backButton());
    var body = el('div', 'task-stats-body');
    var name = el('h1', 'task-stats-name', task.title);
    name.setAttribute('data-stat', 'name');
    body.appendChild(name);

    var statusRow = el('div', 'task-stat-row');
    statusRow.appendChild(el('span', 'task-stat-label', 'Status'));
    var statusVal = el('span', 'task-stat-value task-stat-status');
    statusVal.setAttribute('data-stat', 'status');
    statusVal.appendChild(document.createTextNode(statusLabel(task)));
    if (T.incomplete(task)) statusVal.appendChild(tag('Incomplete', 'incomplete'));
    if (T.status(task) === 'running') statusVal.appendChild(tag('Running', 'running'));
    if (T.status(task) === 'done') statusVal.appendChild(tag('Completed', 'actual'));
    if (T.overdue(task, Date.now())) statusVal.appendChild(tag('Overdue', 'late'));
    statusRow.appendChild(statusVal);
    body.appendChild(statusRow);

    body.appendChild(statRow('Scheduled start', localWhen(task.startAt), 'start'));
    body.appendChild(statRow('Due', localWhen(task.dueAt), 'due'));
    body.appendChild(statRow('Projected duration', task.durationMin ? T.formatDuration(task.durationMin) : '\u2014', 'planned'));
    body.appendChild(statRow('Actual start', localWhen(T.actualStart(task)), 'actual-start'));
    body.appendChild(statRow('Actual end', localWhen(T.actualEnd(task)), 'actual-end'));
    var running = T.status(task) === 'running';
    var hasWork = task.segments && task.segments.length;
    var durLabel = running ? 'Elapsed duration' : 'Actual duration';
    var durValue = hasWork ? T.formatDuration(T.actualMinutes(task, Date.now())) : '\u2014';
    body.appendChild(statRow(durLabel, durValue, 'actual-duration'));
    var commentsRow = statRow('Comments', '\u2014', 'comments');
    fillCommentCount(commentsRow.querySelector('[data-stat=comments]'), task);
    body.appendChild(commentsRow);
    stats.appendChild(body);

    var hint = el('button', 'task-stats-hint');
    hint.type = 'button';
    hint.setAttribute('data-settings-hint', 'true');
    hint.appendChild(el('span', '', 'Swipe for settings'));
    hint.appendChild(el('span', 'task-stats-chevron', '\u2304'));
    hint.setAttribute('aria-label', 'Swipe for settings');
    hint.addEventListener('click', function () {
      var settings = stats.parentNode && stats.parentNode.querySelector('[data-task-settings]');
      if (settings && settings.scrollIntoView) settings.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    stats.appendChild(hint);
    return stats;
  }

  function settingsPanel(task) {
    var settings = el('section', 'task-settings');
    settings.setAttribute('data-task-settings', 'true');
    settings.appendChild(el('h2', '', 'Settings'));
    var nameBox = el('fieldset', 'task-fieldset');
    nameBox.appendChild(el('legend', '', 'Name'));
    nameBox.appendChild(nameEditor(task));
    settings.appendChild(nameBox);
    settings.appendChild(actionButtons(task, false));
    settings.appendChild(planFields(task));
    settings.appendChild(actualFields(task));
    var comments = el('section', 'task-page-comments');
    comments.appendChild(el('h3', '', 'Comments'));
    var slot = el('div', 'comments-slot');
    slot.setAttribute('data-comments-for', task.id);
    comments.appendChild(slot);
    if (global.TWGITaskComments) {
      global.TWGITaskComments.mountTask(slot, { taskId: task.id, title: task.title, ownerId: activeKey() });
    } else {
      slot.appendChild(el('p', 'note', 'Sign in to see and write comments.'));
    }
    settings.appendChild(comments);
    var status = el('p', 'note');
    status.setAttribute('data-task-page-status', 'true');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    settings.appendChild(status);
    return settings;
  }

  function buildTaskPage(task) {
    var wrap = el('div', 'task-page-inner');
    wrap.setAttribute('data-id', task.id);
    wrap.appendChild(statsPanel(task));
    wrap.appendChild(settingsPanel(task));
    return wrap;
  }

  function row(task, options) {
    options = options || {};
    var st = T.status(task);
    var item = document.createElement('li');
    item.className = 'task-row' + (st === 'stopped' ? ' is-incomplete' : '');
    item.setAttribute('data-id', task.id);

    var top = el('div', 'task-top');
    var label = document.createElement('label');
    label.className = 'task-check';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = task.done;
    var caption = document.createElement('span');
    caption.className = 'visually-hidden';
    caption.textContent = 'Done: ' + task.title;
    label.appendChild(box);
    label.appendChild(caption);

    var nameBox = nameEditor(task);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-delete';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete ' + task.title);

    box.addEventListener('change', function () {
      update(task.id, function (entry, now) { return box.checked ? T.complete(entry, now) : T.reopen(entry, now); });
    });
    remove.addEventListener('click', function () { removeTask(task.id); });

    top.appendChild(dragHandle(item, task));
    top.appendChild(label);
    top.appendChild(nameBox);
    top.appendChild(remove);
    item.appendChild(top);
    item.appendChild(metaTags(task));

    item.appendChild(actionButtons(task, true));
    item.appendChild(detailsPanel(task, options.open));
    item.addEventListener('click', function (e) {
      if (ignoreOpenClick) return;
      if (isInteractive(e.target, item)) return;
      goToTask(task.id);
    });
    return item;
  }

  function renderList() {
    var list = root.querySelector('[data-task-list]');
    var empty = root.querySelector('[data-task-empty]');
    if (!list) return;
    clear(list);
    if (requireUser && !userId) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Log in on the master account to use this list.';
      }
      return;
    }
    var tasks = read(activeKey());
    tasks.forEach(function (task) { list.appendChild(row(task)); });
    refreshMoveButtons();
    if (empty) {
      empty.hidden = tasks.length > 0;
      empty.textContent = 'No tasks yet.';
    }
  }

  function ensure() {
    if (root.querySelector('[data-task-form]')) return;
    var form = document.createElement('form');
    form.className = 'task-form';
    form.setAttribute('data-task-form', 'true');
    form.method = 'post';
    form.action = '#';
    form.noValidate = true;

    var label = document.createElement('label');
    label.className = 'visually-hidden';
    label.setAttribute('for', root.id ? root.id + '-input' : 'taskmaster-input');
    label.textContent = 'New task';

    var input = document.createElement('input');
    input.className = 'task-input';
    input.id = label.getAttribute('for');
    input.type = 'text';
    input.maxLength = MAX_TITLE;
    input.autocomplete = 'off';
    input.placeholder = 'Add a task';
    input.setAttribute('aria-label', 'New task');

    var add = document.createElement('button');
    add.className = 'take task-add';
    add.type = 'submit';
    add.textContent = 'Add';

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(add);

    var whenBox = document.createElement('details');
    whenBox.className = 'task-new-times';
    var whenSummary = document.createElement('summary');
    whenSummary.textContent = 'Add a start time, due time, or duration';
    whenBox.appendChild(whenSummary);
    var newStart = dateInput(null);
    newStart.setAttribute('data-new-start', 'true');
    var newDue = dateInput(null);
    newDue.setAttribute('data-new-due', 'true');
    var newDur = durationInputs(null);
    whenBox.appendChild(field('Scheduled start', newStart));
    whenBox.appendChild(field('Due', newDue));
    var newDurWrap = el('div', 'task-field');
    newDurWrap.appendChild(el('span', '', 'Projected duration'));
    newDurWrap.appendChild(newDur.node);
    whenBox.appendChild(newDurWrap);
    form.appendChild(whenBox);

    var empty = document.createElement('p');
    empty.className = 'note';
    empty.setAttribute('data-task-empty', 'true');
    empty.textContent = 'No tasks yet.';

    var list = document.createElement('ul');
    list.className = 'task-list';
    list.setAttribute('data-task-list', 'true');

    var status = document.createElement('p');
    status.className = 'note';
    status.setAttribute('data-task-status', 'true');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (requireUser && !userId) {
        say('Log in on the master account to add a task.');
        return;
      }
      var title = cleanTitle(input.value);
      if (!title) {
        say('Write a task first.');
        input.focus();
        return;
      }
      var tasks = read(activeKey());
      if (tasks.length >= MAX_TASKS) {
        say('The list holds ' + MAX_TASKS + ' tasks.');
        return;
      }
      var now = new Date().toISOString();
      var task = T.setPlan({ id: newId(), title: title, done: false, createdAt: now, updatedAt: now, segments: [] }, {
        startAt: T.fromLocalInput(newStart.value), dueAt: T.fromLocalInput(newDue.value), durationMin: newDur.value()
      }, Date.parse(now));
      newStart.value = '';
      newDue.value = '';
      Array.prototype.forEach.call(whenBox.querySelectorAll('input[type=number]'), function (n) { n.value = ''; });
      whenBox.open = false;
      if (O) tasks = O.addTop(tasks, task);
      else tasks.unshift(task);
      input.value = '';
      list.insertBefore(row(task), list.firstChild);
      refreshMoveButtons();
      empty.hidden = true;
      persist(tasks);
      input.focus();
    });

    root.appendChild(form);
    root.appendChild(empty);
    root.appendChild(list);
    root.appendChild(status);
  }

  function mount(node, options) {
    if (!node) return;
    root = node;
    options = options || {};
    requireUser = !!options.requireUser;
    if (options.userId) userId = String(options.userId);
    ensure();
    if (userId) adoptDeviceList(userId);
    renderList();
    bindHash();
    if (idFromHash(global.location.hash)) onHashChange();
    sync.pull(userId).then(function (remote) {
      if (!Array.isArray(remote) || !root) return;
      write(activeKey(), remote);
      renderList();
      say('Loaded the synced list.');
    }).catch(function () {});
  }

  function setUser(id) {
    var next = id ? String(id) : null;
    if (next === userId && root && root.querySelector('[data-task-list]')) {
      if (next) adoptDeviceList(next);
      return;
    }
    userId = next;
    if (!root) return;
    if (userId) adoptDeviceList(userId);
    renderList();
    if (idFromHash(global.location.hash)) onHashChange();
    say(userId
      ? 'Showing the list for this account on this device.'
      : 'Showing the list kept on this device.');
  }

  // Opens one task's details (used by notification links: /?task=<id>).
  function openTask(id, withComments) {
    if (!root) return false;
    var item = root.querySelector('[data-id="' + cssId(id) + '"]');
    if (!item) return false;
    var details = item.querySelector('details.task-details');
    if (details) details.open = true;
    if (withComments) {
      var c = item.querySelector('details.task-comments');
      if (c && !c.open) { c.open = true; c.dispatchEvent(new Event('toggle')); }
    }
    item.classList.add('is-focus');
    if (item.scrollIntoView) item.scrollIntoView({ block: 'center' });
    return true;
  }

  global.TWGITaskmaster = {
    sync: sync,
    mount: mount,
    setUser: setUser,
    read: read,
    activeKey: function () { return activeKey(); },
    onChange: function (fn) { changeListeners.push(fn); },
    openTask: openTask,
    moveBy: function (id, delta) { moveBy(id, delta, null); },
    update: function (id, fn) { return update(id, fn); }
  };

  function bootEmbedded() {
    var embedded = document.getElementById('taskmaster-root');
    if (!embedded) return;
    mount(embedded, { requireUser: true });
    function bind(state) {
      setUser(state && state.user ? state.user.id : null);
    }
    if (global.TWGIAccount) global.TWGIAccount.subscribe(bind);
    else document.addEventListener('twgi-account-api', function () {
      global.TWGIAccount.subscribe(bind);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootEmbedded);
  else bootEmbedded();
})(window);
