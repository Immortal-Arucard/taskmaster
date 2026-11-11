/* One-time import of tasks handed over from the main site's old
   /taskmaster/ page. The main site redirect puts the lists in the URL
   fragment as tm-import=<json>. Fragments are not sent to any server.
   This file removes the fragment right away, asks before importing, and
   merges by task id into the same twgi-taskmaster-v1:<key> entries.
   Nothing already on this device is removed. */
(function (global) {
  var PREFIX = 'twgi-taskmaster-v1:';
  var MAX_TITLE = 140;
  var MAX_TASKS = 200;
  var KEY_RE = /^(device|[A-Za-z0-9-]{1,64})$/;

  function readPayload() {
    var raw = location.hash.charAt(0) === '#' ? location.hash.slice(1) : '';
    if (!raw || raw.indexOf('tm-import=') === -1) return null;
    var params = new URLSearchParams(raw);
    var value = params.get('tm-import');
    params.delete('tm-import');
    var rest = params.toString();
    history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    try {
      var data = JSON.parse(value || '');
      if (!data || data.v !== 1 || typeof data.lists !== 'object' || !data.lists) return null;
      return data.lists;
    } catch (err) { return null; }
  }

  function clean(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (t) {
      return t && typeof t.id === 'string' && t.id.length <= 80 && typeof t.title === 'string' && t.title.trim();
    }).slice(0, MAX_TASKS).map(function (t) {
      return {
        id: t.id,
        title: t.title.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_TITLE),
        done: !!t.done,
        createdAt: String(t.createdAt || '').slice(0, 40),
        updatedAt: String(t.updatedAt || '').slice(0, 40)
      };
    });
  }

  function readLocal(key) {
    try {
      var v = JSON.parse(global.localStorage.getItem(PREFIX + key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (err) { return []; }
  }

  function merge(lists) {
    var added = 0;
    Object.keys(lists).forEach(function (key) {
      if (!KEY_RE.test(key) || key === 'adopted') return;
      var incoming = clean(lists[key]);
      if (!incoming.length) return;
      var mine = readLocal(key);
      var seen = {};
      mine.forEach(function (t) { if (t && t.id) seen[t.id] = true; });
      incoming.forEach(function (t) {
        if (seen[t.id] || mine.length >= MAX_TASKS) return;
        mine.push(t);
        seen[t.id] = true;
        added += 1;
      });
      global.localStorage.setItem(PREFIX + key, JSON.stringify(mine));
    });
    return added;
  }

  function count(lists) {
    var n = 0;
    Object.keys(lists).forEach(function (key) {
      if (KEY_RE.test(key)) n += clean(lists[key]).length;
    });
    return n;
  }

  var lists = readPayload();
  global.TWGITaskmasterImport = {
    pending: function () { return !!lists && count(lists) > 0; },
    offer: function (slot, done) {
      if (!slot || !lists) return;
      var total = count(lists);
      if (!total) { lists = null; return; }
      slot.hidden = false;
      slot.textContent = '';
      var p = document.createElement('p');
      p.style.margin = '0';
      p.textContent = 'You have ' + total + (total === 1 ? ' task' : ' tasks') + ' from Taskmaster on the main site. Bring them into this app? Tasks already here stay.';
      var actions = document.createElement('div');
      actions.className = 'actions';
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'take';
      yes.textContent = 'Import tasks';
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'take ghost';
      no.textContent = 'Not now';
      actions.appendChild(yes);
      actions.appendChild(no);
      slot.appendChild(p);
      slot.appendChild(actions);
      yes.addEventListener('click', function () {
        var added = 0;
        try { added = merge(lists); } catch (err) {}
        lists = null;
        slot.textContent = added ? 'Imported ' + added + (added === 1 ? ' task.' : ' tasks.') : 'Those tasks were already here.';
        if (done) done(added);
      });
      no.addEventListener('click', function () {
        lists = null;
        slot.hidden = true;
      });
    }
  };
})(window);
