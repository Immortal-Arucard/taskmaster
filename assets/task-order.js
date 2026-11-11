/* Taskmaster manual order. Pure functions, no DOM; used by taskmaster.js and
   the Node tests.

   Each stored task carries `order` (0 = top). The stored array is also kept
   in that order, so older code that reads the array sees the same sequence.
   Tasks saved before v4 have no `order`: they keep the position they already
   had in the stored array (new tasks were added at the top), so nothing jumps
   around on the first load. Tasks that arrive later without an order (for
   example from the one-time import) go after the ordered ones, in the order
   they came. Duplicate or junk order values are resolved the same stable way. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWGITaskOrder = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function valid(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0;
  }

  // Sorted copy with order renumbered 0..n-1. Input is not changed.
  function normalize(tasks) {
    var list = (tasks || []).map(function (task, index) { return { task: task, index: index }; });
    list.sort(function (a, b) {
      var ao = valid(a.task.order);
      var bo = valid(b.task.order);
      if (ao && bo && a.task.order !== b.task.order) return a.task.order - b.task.order;
      if (ao !== bo) return ao ? -1 : 1;
      return a.index - b.index;
    });
    return list.map(function (entry, i) {
      var copy = {};
      Object.keys(entry.task).forEach(function (k) { copy[k] = entry.task[k]; });
      copy.order = i;
      return copy;
    });
  }

  function indexOf(tasks, id) {
    for (var i = 0; i < tasks.length; i += 1) if (tasks[i].id === id) return i;
    return -1;
  }

  // Moves one task to position `to` (clamped). Returns a normalized copy.
  function moveTo(tasks, id, to) {
    var list = normalize(tasks);
    var from = indexOf(list, id);
    if (from < 0) return list;
    var target = Math.max(0, Math.min(list.length - 1, Math.round(Number(to) || 0)));
    if (target === from) return list;
    var moved = list.splice(from, 1)[0];
    list.splice(target, 0, moved);
    return list.map(function (task, i) { task.order = i; return task; });
  }

  function moveBy(tasks, id, delta) {
    var list = normalize(tasks);
    var from = indexOf(list, id);
    if (from < 0) return list;
    return moveTo(list, id, from + delta);
  }

  // A new task goes on top.
  function addTop(tasks, task) {
    var copy = {};
    Object.keys(task).forEach(function (k) { copy[k] = task[k]; });
    return [copy].concat(normalize(tasks)).map(function (t, i) { t.order = i; return t; });
  }

  // While dragging: which slot a pointer at clientY belongs to, given each
  // row's vertical midpoint (rows other than the one being dragged).
  function slotFor(midpoints, clientY) {
    var slot = 0;
    for (var i = 0; i < midpoints.length; i += 1) if (clientY > midpoints[i]) slot = i + 1;
    return slot;
  }

  return { normalize: normalize, moveTo: moveTo, moveBy: moveBy, addTop: addTop, slotFor: slotFor, indexOf: indexOf };
});
