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
      return parsed.filter(function (task) {
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
          completedAt: task.completedAt
        };
        return T ? T.clean(base) : base;
      });
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
  }

  function persist(tasks) {
    var id = activeKey();
    if (requireUser && !id) return Promise.resolve();
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
    }
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

    var title = document.createElement('span');
    title.className = 'task-title' + (task.done ? ' is-done' : '');
    title.textContent = task.title;

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-delete';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete ' + task.title);

    box.addEventListener('change', function () {
      update(task.id, function (entry, now) { return box.checked ? T.complete(entry, now) : T.reopen(entry, now); });
    });
    remove.addEventListener('click', function () {
      var tasks = read(activeKey()).filter(function (entry) { return entry.id !== task.id; });
      persist(tasks);
      item.parentNode.removeChild(item);
      var list = root.querySelector('[data-task-list]');
      var empty = root.querySelector('[data-task-empty]');
      if (empty) empty.hidden = !!(list && list.children.length);
    });

    top.appendChild(label);
    top.appendChild(title);
    top.appendChild(remove);
    item.appendChild(top);
    item.appendChild(metaTags(task));

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
    item.appendChild(actions);
    item.appendChild(detailsPanel(task, options.open));
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
      tasks.unshift(task);
      input.value = '';
      list.insertBefore(row(task), list.firstChild);
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
