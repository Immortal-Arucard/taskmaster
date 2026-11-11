/* Taskmaster list for a master account.
   Storage is localStorage. Nothing in this file calls Supabase.

   Sync-later seam: TWGITaskmaster.sync.pull and .push.
   pull(userId) should resolve to an array of tasks, or null when the
   remote store has nothing to apply. push(userId, tasks) should resolve
   to { synced: true } after a reviewed table is applied. Until then both
   stay local-only. A future table would be owner-scoped
   (id, owner, title, done, created_at, updated_at) with row level
   security limited to auth.uid(). Do not add that call here early.

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
        return {
          id: task.id,
          title: task.title.slice(0, MAX_TITLE),
          done: !!task.done,
          createdAt: String(task.createdAt || ''),
          updatedAt: String(task.updatedAt || '')
        };
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
    write(id, device.map(function (task) {
      return {
        id: task.id,
        title: task.title,
        done: task.done,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      };
    }));
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

  function row(task) {
    var item = document.createElement('li');
    item.className = 'task-row';
    item.setAttribute('data-id', task.id);

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
      var tasks = read(activeKey());
      tasks.forEach(function (entry) {
        if (entry.id === task.id) {
          entry.done = box.checked;
          entry.updatedAt = new Date().toISOString();
        }
      });
      title.className = 'task-title' + (box.checked ? ' is-done' : '');
      persist(tasks);
    });
    remove.addEventListener('click', function () {
      var tasks = read(activeKey()).filter(function (entry) { return entry.id !== task.id; });
      persist(tasks);
      item.parentNode.removeChild(item);
      var list = root.querySelector('[data-task-list]');
      var empty = root.querySelector('[data-task-empty]');
      if (empty) empty.hidden = !!(list && list.children.length);
    });

    item.appendChild(label);
    item.appendChild(title);
    item.appendChild(remove);
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
      var task = { id: newId(), title: title, done: false, createdAt: now, updatedAt: now };
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

  global.TWGITaskmaster = {
    sync: sync,
    mount: mount,
    setUser: setUser,
    read: read
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
