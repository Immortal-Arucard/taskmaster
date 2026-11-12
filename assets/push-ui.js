/* Taskmaster notification settings panel and schedule sync.
   Mounts into #notify-panel. Needs push-core.js (TWGIPush), auth.js
   (TWGIAccount) and taskmaster.js (TWGITaskmaster).

   Schedule sync: when this device has notifications on and someone is
   signed in, every list save sends ONLY the schedule fields of each task
   (id, title unless hidden, done, start, due, projected duration, actual
   start/end) to the push service, debounced, and again when the device
   comes back online. Nothing else from the list leaves the device. */
(function (global) {
  var APP = 'taskmaster';
  var KINDS = [
    ['start', 'When a task\u2019s scheduled start time arrives'],
    ['due', 'Due soon and due now'],
    ['overdue', 'Overdue reminders'],
    ['hourly', 'Every hour while fewer than 2 tasks are scheduled in the next 12 hours'],
    ['wake', 'Wake-up'],
    ['bedtime', 'Bedtime'],
    ['dawn', 'Dawn'],
    ['dusk', 'Dusk'],
    ['comment', 'New comments on my tasks']
  ];
  var Push = global.TWGIPush;
  var T = global.TWGITaskTime;
  var panel = document.getElementById('notify-panel');
  if (!panel || !Push) return;

  var userId = '';
  var settings = null;
  var timer = null;
  var pendingSync = false;

  function el(name, cls, text) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function q(sel) { return panel.querySelector(sel); }
  function status(text) { var s = q('[data-push-status]'); if (s) s.textContent = text || ''; }

  function scheduleNow() {
    if (!userId || !Push.isOn(APP, userId) || !global.TWGITaskmaster) return Promise.resolve(false);
    var showTitles = !settings || !settings.prefs || settings.prefs.showTitles !== false;
    var tasks = global.TWGITaskmaster.read(userId).map(function (t) { return T.scheduleOf(t, showTitles); });
    // v6: tasks deleted on any device are sent as finished, so an older copy
    // saved by another device cannot keep reminding. The service takes 200.
    var have = {};
    tasks.forEach(function (t) { have[t.id] = true; });
    var gone = global.TWGITaskmaster.tombstones ? global.TWGITaskmaster.tombstones(userId) : [];
    gone.forEach(function (g) {
      if (tasks.length >= 200 || have[g.id]) return;
      tasks.push({ id: g.id, title: '', done: true, startAt: null, dueAt: null, durationMin: null, actualStartAt: null, actualEndAt: null, updatedAt: g.deletedAt });
    });
    if (tasks.length > 200) tasks = tasks.slice(0, 200);
    return Push.sendTasks(tasks).then(function () { pendingSync = false; return true; })
      .catch(function () { pendingSync = true; return false; });
  }
  function queueSync() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; scheduleNow(); }, 1500);
  }

  function build() {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.appendChild(el('h2', '', 'Notifications'));
    var support = Push.currentSupport();
    if (support.reason === 'ios-install') {
      var hint = el('p', 'flag push-ios-hint', support.note);
      hint.setAttribute('data-ios-hint', 'true');
      panel.appendChild(hint);
    }
    if (!userId) {
      var p = el('p', 'note', '');
      p.appendChild(document.createTextNode('Sign in to get reminders on this device. '));
      var a = el('a', '', 'Sign in'); a.href = '/login/';
      p.appendChild(a);
      panel.appendChild(p);
      return;
    }
    var on = Push.isOn(APP, userId);
    var master = el('button', 'take', on ? 'Turn off notifications on this device' : 'Enable notifications');
    master.type = 'button';
    master.setAttribute('data-push-master', on ? 'off' : 'on');
    master.disabled = !support.ok && support.reason !== 'denied' ? true : false;
    master.addEventListener('click', function () {
      if (Push.isOn(APP, userId)) {
        Push.disable(APP, userId).then(function (r) { status(r.note); build(); });
        return;
      }
      // enable() asks permission first, inside this tap.
      Push.enable(APP, userId).then(function (r) {
        status(r.note);
        if (r.ok) { scheduleNow(); loadSettings(); }
        build();
        status(r.note);
      }).catch(function (err) { status(err && err.message ? err.message : 'Notifications were not turned on.'); });
    });
    panel.appendChild(master);
    if (!support.ok && support.reason !== 'ios-install') panel.appendChild(el('p', 'note', support.note));
    var st = el('p', 'note'); st.setAttribute('data-push-status', 'true'); st.setAttribute('role', 'status'); st.setAttribute('aria-live', 'polite');
    panel.appendChild(st);
    if (!on) {
      panel.appendChild(el('p', 'note', 'Nothing is asked or sent until you tap Enable notifications.'));
      return;
    }

    var form = el('form', 'push-form');
    form.setAttribute('data-push-form', 'true');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    var kinds = el('fieldset', 'task-fieldset');
    kinds.appendChild(el('legend', '', 'Send me'));
    var prefs = (settings && settings.prefs) || {};
    var k = prefs.kinds || {};
    KINDS.forEach(function (pair) {
      var lab = el('label', 'opt');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'kind-' + pair[0];
      box.checked = k[pair[0]] !== false;
      lab.appendChild(box);
      lab.appendChild(document.createTextNode(' ' + pair[1]));
      kinds.appendChild(lab);
    });
    form.appendChild(kinds);

    var times = el('fieldset', 'task-fieldset');
    times.appendChild(el('legend', '', 'Times'));
    function timeField(name, label, value) {
      var input = document.createElement('input');
      input.type = 'time'; input.name = name; input.value = value;
      var w = el('label', 'task-field'); w.appendChild(el('span', '', label)); w.appendChild(input);
      return w;
    }
    times.appendChild(timeField('wake', 'Wake-up time', prefs.wake || '06:30'));
    times.appendChild(timeField('bedtime', 'Bedtime', prefs.bedtime || '22:00'));
    var quiet = el('label', 'opt');
    var quietBox = document.createElement('input'); quietBox.type = 'checkbox'; quietBox.name = 'quietOvernight';
    quietBox.checked = prefs.quietOvernight !== false;
    quiet.appendChild(quietBox); quiet.appendChild(document.createTextNode(' Pause the hourly nudge between bedtime and wake-up'));
    times.appendChild(quiet);
    var soon = document.createElement('select'); soon.name = 'dueSoonMinutes';
    [[0, 'No early warning'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before']].forEach(function (o) {
      var opt = el('option', '', o[1]); opt.value = String(o[0]); if (Number(prefs.dueSoonMinutes == null ? 60 : prefs.dueSoonMinutes) === o[0]) opt.selected = true; soon.appendChild(opt);
    });
    var soonWrap = el('label', 'task-field'); soonWrap.appendChild(el('span', '', 'Due-soon warning')); soonWrap.appendChild(soon);
    times.appendChild(soonWrap);
    var tz = document.createElement('input'); tz.type = 'text'; tz.name = 'tz'; tz.autocomplete = 'off';
    tz.value = (settings && settings.tz) || Push.timeZone();
    var tzWrap = el('label', 'task-field'); tzWrap.appendChild(el('span', '', 'Time zone')); tzWrap.appendChild(tz);
    times.appendChild(tzWrap);
    form.appendChild(times);

    var sun = el('fieldset', 'task-fieldset');
    sun.appendChild(el('legend', '', 'Dawn and dusk'));
    var mode = document.createElement('select'); mode.name = 'dawnMode';
    [['sunrise', 'Sunrise and sunset'], ['civil', 'First light and last light (civil twilight)']].forEach(function (o) {
      var opt = el('option', '', o[1]); opt.value = o[0]; if ((prefs.dawnMode || 'sunrise') === o[0]) opt.selected = true; mode.appendChild(opt);
    });
    var modeWrap = el('label', 'task-field'); modeWrap.appendChild(el('span', '', 'Dawn and dusk mean')); modeWrap.appendChild(mode);
    sun.appendChild(modeWrap);
    var loc = document.createElement('input'); loc.type = 'text'; loc.name = 'location'; loc.inputMode = 'decimal';
    loc.placeholder = '39.08, -84.51';
    if (settings && settings.lat != null && settings.lon != null) loc.value = settings.lat + ', ' + settings.lon;
    var locWrap = el('label', 'task-field'); locWrap.appendChild(el('span', '', 'Location (latitude, longitude)')); locWrap.appendChild(loc);
    sun.appendChild(locWrap);
    var geo = el('button', 'mini', 'Use my location'); geo.type = 'button'; geo.setAttribute('data-geo', 'true');
    geo.addEventListener('click', function () {
      if (!global.navigator.geolocation) { status('This device cannot share its location. Type it in instead.'); return; }
      global.navigator.geolocation.getCurrentPosition(function (pos) {
        loc.value = pos.coords.latitude.toFixed(2) + ', ' + pos.coords.longitude.toFixed(2);
        save();
      }, function () { status('Location was not shared. You can type it in instead.'); }, { maximumAge: 86400000, timeout: 15000 });
    });
    sun.appendChild(geo);
    sun.appendChild(el('p', 'note', 'Rounded to about 1 km and used only to work out sunrise and sunset.'));
    form.appendChild(sun);

    var privacy = el('label', 'opt');
    var titles = document.createElement('input'); titles.type = 'checkbox'; titles.name = 'showTitles';
    titles.checked = prefs.showTitles !== false;
    privacy.appendChild(titles); privacy.appendChild(document.createTextNode(' Show task names in notifications (off sends only times, and says \u201cA task\u201d)'));
    form.appendChild(privacy);

    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'showTitles') { save().then(scheduleNow); return; }
      save();
    });
    panel.appendChild(form);

    var test = el('button', 'mini', 'Send a test notification'); test.type = 'button'; test.setAttribute('data-push-test', 'true');
    test.addEventListener('click', function () {
      Push.test(APP).then(function () { status('Test sent. It should arrive in a few seconds.'); })
        .catch(function (err) { status(err.message); });
    });
    panel.appendChild(test);
  }

  function readForm() {
    var form = q('[data-push-form]');
    var kinds = {};
    KINDS.forEach(function (pair) { var b = form.querySelector('[name="kind-' + pair[0] + '"]'); kinds[pair[0]] = !!(b && b.checked); });
    var loc = String(form.querySelector('[name=location]').value || '').trim();
    var lat = null; var lon = null;
    if (loc) {
      var m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(loc);
      if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) throw new Error('Type the location as latitude, longitude, for example 39.08, -84.51.');
      lat = Math.round(Number(m[1]) * 100) / 100; lon = Math.round(Number(m[2]) * 100) / 100;
    }
    return {
      tz: String(form.querySelector('[name=tz]').value || '').trim() || Push.timeZone(),
      lat: lat, lon: lon,
      prefs: {
        kinds: kinds,
        wake: form.querySelector('[name=wake]').value,
        bedtime: form.querySelector('[name=bedtime]').value,
        quietOvernight: form.querySelector('[name=quietOvernight]').checked,
        dueSoonMinutes: Number(form.querySelector('[name=dueSoonMinutes]').value),
        dawnMode: form.querySelector('[name=dawnMode]').value,
        showTitles: form.querySelector('[name=showTitles]').checked
      }
    };
  }

  function save() {
    var body;
    try { body = readForm(); } catch (err) { status(err.message); return Promise.resolve(); }
    return Push.saveSettings(APP, body).then(function (r) {
      settings = r && r.settings ? r.settings : settings;
      status('Notification settings saved.');
    }).catch(function (err) { status(err.message); });
  }

  function loadSettings() {
    if (!userId || !Push.isOn(APP, userId)) return Promise.resolve();
    return Push.settings(APP).then(function (r) { settings = r && r.settings ? r.settings : null; build(); })
      .catch(function () {});
  }

  if (global.TWGITaskmaster) global.TWGITaskmaster.onChange(function (id) { if (id && id === userId) queueSync(); });
  global.addEventListener('online', function () { if (pendingSync) scheduleNow(); });

  function bind(state) {
    var next = state && state.user ? state.user.id : '';
    if (next === userId && panel.firstChild) return;
    userId = next; settings = null;
    build();
    loadSettings().then(function () { if (userId && Push.isOn(APP, userId)) scheduleNow(); });
  }
  build();
  if (global.TWGIAccount) global.TWGIAccount.subscribe(bind);
  else document.addEventListener('twgi-account-api', function () { global.TWGIAccount.subscribe(bind); });

  global.TWGITaskmasterPush = { scheduleNow: scheduleNow, readForm: readForm, KINDS: KINDS };
})(window);
