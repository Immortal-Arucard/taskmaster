/* Taskmaster task timing: planned schedule, worked segments, stop/resume.
   Pure functions, no DOM. Used by taskmaster.js and by the Node tests.

   A task may carry:
     startAt      planned (scheduled) start, ISO string or null
     dueAt        due time, ISO or null
     durationMin  projected duration in minutes, or null
     segments     worked time: [{ s: ISO, e: ISO|null }], oldest first.
                  An open segment (e null) means the task is running.
     completedAt  ISO when it was checked off, or null

   Status:
     'todo'     nothing recorded
     'running'  last segment is open
     'stopped'  work recorded, not running, not done  -> shows "Incomplete"
     'done'     checked off
   Actual duration = sum of closed segments (+ the open one up to now). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWGITaskTime = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var MAX_SEGMENTS = 50;

  function iso(value) {
    if (value == null || value === '') return null;
    var ms = typeof value === 'number' ? value : Date.parse(value);
    return isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function ms(value) {
    var n = value == null || value === '' ? NaN : Date.parse(value);
    return isFinite(n) ? n : null;
  }

  function cleanSegments(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (seg) {
      if (!seg) return;
      var s = iso(seg.s);
      var e = iso(seg.e);
      if (!s) return;
      if (e && Date.parse(e) < Date.parse(s)) e = s;
      out.push({ s: s, e: e });
    });
    out.sort(function (a, b) { return Date.parse(a.s) - Date.parse(b.s); });
    // Only the newest segment may stay open.
    for (var i = 0; i < out.length - 1; i += 1) if (!out[i].e) out[i].e = out[i + 1].s;
    return out.slice(-MAX_SEGMENTS);
  }

  function cleanDuration(value) {
    var n = Math.round(Number(value));
    return isFinite(n) && n > 0 && n <= 10080 ? n : null;
  }

  // Normalises the timing fields of a stored task (keeps other fields).
  function clean(task) {
    var out = {};
    Object.keys(task || {}).forEach(function (k) { out[k] = task[k]; });
    out.startAt = iso(task && task.startAt);
    out.dueAt = iso(task && task.dueAt);
    out.durationMin = cleanDuration(task && task.durationMin);
    out.segments = cleanSegments(task && task.segments);
    out.completedAt = task && task.done ? iso(task.completedAt) : null;
    return out;
  }

  function last(task) {
    return task.segments && task.segments.length ? task.segments[task.segments.length - 1] : null;
  }

  function status(task) {
    if (task.done) return 'done';
    var seg = last(task);
    if (seg && !seg.e) return 'running';
    if (seg) return 'stopped';
    return 'todo';
  }

  function incomplete(task) {
    return status(task) === 'stopped';
  }

  function touch(task, now) {
    task.updatedAt = new Date(now).toISOString();
    return task;
  }

  // Start the first time, or resume after a stop. Resuming clears Incomplete
  // because the task is running again.
  function start(task, now) {
    var t = clean(task);
    if (t.done) { t.done = false; t.completedAt = null; }
    if (status(t) === 'running') return t;
    t.segments.push({ s: new Date(now).toISOString(), e: null });
    t.segments = t.segments.slice(-MAX_SEGMENTS);
    return touch(t, now);
  }

  // Stop (not finished): closes the running segment, the task stays open.
  function stop(task, now) {
    var t = clean(task);
    var seg = last(t);
    if (!seg || seg.e) return t;
    seg.e = new Date(Math.max(now, Date.parse(seg.s))).toISOString();
    return touch(t, now);
  }

  // Complete: closes a running segment and checks the task off.
  function complete(task, now) {
    var t = stop(task, now);
    t.done = true;
    t.completedAt = new Date(now).toISOString();
    return touch(t, now);
  }

  function reopen(task, now) {
    var t = clean(task);
    t.done = false;
    t.completedAt = null;
    return touch(t, now);
  }

  // Manually typed actual start / end. The first segment's start and the
  // last segment's end move; segments in between stay as recorded.
  function setActual(task, startValue, endValue, now) {
    var t = clean(task);
    var s = iso(startValue);
    var e = iso(endValue);
    if (!s && !e) { t.segments = []; return touch(t, now); }
    if (!s) throw new Error('Enter the actual start time first.');
    if (e && Date.parse(e) < Date.parse(s)) throw new Error('The actual end is before the actual start.');
    if (!t.segments.length) t.segments = [{ s: s, e: e }];
    else {
      t.segments[0].s = s;
      var tail = t.segments[t.segments.length - 1];
      tail.e = e;
      if (Date.parse(tail.s) < Date.parse(s)) tail.s = s;
      if (e && Date.parse(tail.s) > Date.parse(e)) {
        // The new end is before later segments: collapse to one segment.
        t.segments = [{ s: s, e: e }];
      }
      t.segments = cleanSegments(t.segments);
    }
    return touch(t, now);
  }

  function setPlan(task, plan, now) {
    var t = clean(task);
    t.startAt = iso(plan.startAt);
    t.dueAt = iso(plan.dueAt);
    t.durationMin = cleanDuration(plan.durationMin);
    return touch(t, now);
  }

  function actualMinutes(task, now) {
    var total = 0;
    (task.segments || []).forEach(function (seg) {
      var s = ms(seg.s);
      var e = seg.e ? ms(seg.e) : now;
      if (s != null && e != null && e > s) total += e - s;
    });
    return Math.round(total / 60000);
  }

  function actualStart(task) {
    var seg = task.segments && task.segments[0];
    return seg ? seg.s : null;
  }

  function actualEnd(task) {
    var seg = last(task);
    return seg && seg.e ? seg.e : null;
  }

  function plannedEnd(task) {
    var s = ms(task.startAt);
    return s != null && task.durationMin ? new Date(s + task.durationMin * 60000).toISOString() : null;
  }

  function formatDuration(minutes) {
    if (minutes == null) return '';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (!h) return m + 'm';
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function overdue(task, now) {
    var due = ms(task.dueAt);
    return !task.done && due != null && due < now;
  }

  // Minimal schedule data sent to the push service (no notes, no segments).
  function scheduleOf(task, showTitle) {
    var st = status(task);
    return {
      id: task.id,
      title: showTitle === false ? '' : task.title,
      done: !!task.done,
      startAt: task.startAt || null,
      dueAt: task.dueAt || null,
      durationMin: task.durationMin || null,
      actualStartAt: actualStart(task),
      actualEndAt: st === 'done' ? actualEnd(task) || task.completedAt || null : null,
      updatedAt: task.updatedAt || null
    };
  }

  // datetime-local <-> ISO in the device's own time zone.
  function toLocalInput(value) {
    var n = ms(value);
    if (n == null) return '';
    var d = new Date(n);
    function p(x) { return String(x).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fromLocalInput(value) {
    if (!value) return null;
    var n = new Date(value).getTime();
    return isFinite(n) ? new Date(n).toISOString() : null;
  }

  return {
    clean: clean, status: status, incomplete: incomplete, start: start, stop: stop,
    complete: complete, reopen: reopen, setActual: setActual, setPlan: setPlan,
    actualMinutes: actualMinutes, actualStart: actualStart, actualEnd: actualEnd,
    plannedEnd: plannedEnd, formatDuration: formatDuration, overdue: overdue,
    scheduleOf: scheduleOf, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput
  };
});
