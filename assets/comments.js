/* Taskmaster task comments (Supabase tables from supabase/taskmaster_comments.sql).
   Uses the signed-in Supabase client from auth.js; row level security decides
   who can read, write, edit and delete. This file never sets author name,
   avatar or times: database triggers do.

   - Owner: comment, edit own, delete any, grant/revoke comment access per task
     or for the whole list, by TWGI account email.
   - Granted person: sees the task in "Shared with me", comments, edits and
     deletes only their own comments.
   Until the SQL is applied every call fails and the panel says comments are
   not switched on yet. */
(function (global) {
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var me = { id: '', email: '' };

  function client() { return global.TWGIAccount && global.TWGIAccount.client && global.TWGIAccount.client(); }
  function el(name, cls, text) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, attr) {
    var b = el('button', 'mini', text); b.type = 'button';
    if (attr) b.setAttribute(attr, 'true');
    return b;
  }
  function stamp(value) {
    var d = new Date(value);
    return isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }
  function offline(err) {
    return 'Comments are not switched on yet' + (err && err.message ? ' (' + err.message + ')' : '') + '.';
  }
  function must(result) {
    if (result && result.error) throw result.error;
    return result ? result.data : null;
  }
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : (parts[0].charAt(1) || ''))).toUpperCase();
  }
  function avatar(url, name) {
    var span = el('span', 'account-avatar', initials(name));
    span.setAttribute('aria-hidden', 'true');
    if (!/^https:\/\//.test(String(url || ''))) return span;
    var img = el('img', 'account-avatar');
    img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = url; img.width = 28; img.height = 28;
    img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(span, img); });
    return img;
  }

  async function ensureThread(ownerId, taskId, title) {
    return must(await client().from('taskmaster_threads').upsert({ owner_id: ownerId, task_id: taskId, title: String(title || '').slice(0, 140) }, { onConflict: 'owner_id,task_id' }));
  }

  function commentNode(c, ownerId, refresh, status) {
    var li = el('li', 'comment');
    li.setAttribute('data-comment-id', c.id);
    var head = el('div', 'comment-head');
    head.appendChild(avatar(c.author_avatar, c.author_name));
    head.appendChild(el('strong', 'comment-author', c.author_name || 'TWGI member'));
    var time = el('time', 'comment-time', stamp(c.created_at) + (c.edited_at ? ' (edited)' : ''));
    time.dateTime = c.created_at;
    head.appendChild(time);
    li.appendChild(head);
    var body = el('p', 'comment-body', c.body);
    li.appendChild(body);
    var mine = c.author_id === me.id;
    var canDelete = mine || ownerId === me.id;
    if (mine || canDelete) {
      var actions = el('div', 'comment-actions');
      if (mine) {
        var edit = button('Edit', 'data-comment-edit');
        edit.addEventListener('click', function () {
          var area = el('textarea', 'comment-input'); area.value = c.body; area.maxLength = 2000;
          var save = button('Save', 'data-comment-save');
          li.replaceChild(area, body);
          edit.replaceWith(save);
          save.addEventListener('click', async function () {
            var text = area.value.trim();
            if (!text) { status('Write something first.'); return; }
            try { must(await client().from('taskmaster_comments').update({ body: text }).eq('id', c.id)); refresh(); }
            catch (err) { status(err.message); }
          });
        });
        actions.appendChild(edit);
      }
      if (canDelete) {
        var del = button('Delete', 'data-comment-delete');
        del.addEventListener('click', async function () {
          if (global.confirm && !global.confirm('Delete this comment?')) return;
          try { must(await client().from('taskmaster_comments').delete().eq('id', c.id)); refresh(); }
          catch (err) { status(err.message); }
        });
        actions.appendChild(del);
      }
      li.appendChild(actions);
    }
    return li;
  }

  // Comment thread for one task. options: { ownerId, taskId, title }
  function mountTask(slot, options) {
    var ownerId = options.ownerId || me.id;
    var isOwner = ownerId === me.id;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    var statusNode = el('p', 'note'); statusNode.setAttribute('role', 'status');
    function status(text) { statusNode.textContent = text || ''; }
    if (!client() || !me.id) {
      slot.appendChild(el('p', 'note', 'Sign in to see and write comments.'));
      return Promise.resolve();
    }
    var list = el('ul', 'comment-list');
    var area = el('textarea', 'comment-input'); area.maxLength = 2000; area.placeholder = 'Write a comment';
    area.setAttribute('aria-label', 'Write a comment');
    var post = el('button', 'take', 'Post comment'); post.type = 'button'; post.setAttribute('data-comment-post', 'true');
    slot.appendChild(list); slot.appendChild(area); slot.appendChild(post); slot.appendChild(statusNode);

    async function refresh() {
      try {
        var rows = must(await client().from('taskmaster_comments')
          .select('id, owner_id, task_id, author_id, author_name, author_avatar, body, created_at, edited_at')
          .eq('owner_id', ownerId).eq('task_id', options.taskId).order('created_at', { ascending: true }));
        while (list.firstChild) list.removeChild(list.firstChild);
        (rows || []).forEach(function (c) { list.appendChild(commentNode(c, ownerId, refresh, status)); });
        if (!rows || !rows.length) list.appendChild(el('li', 'note', 'No comments yet.'));
      } catch (err) { status(offline(err)); }
    }
    post.addEventListener('click', async function () {
      var text = area.value.trim();
      if (!text) { status('Write a comment first.'); return; }
      post.disabled = true;
      try {
        if (isOwner) await ensureThread(ownerId, options.taskId, options.title);
        must(await client().from('taskmaster_comments').insert({ owner_id: ownerId, task_id: options.taskId, body: text.slice(0, 2000) }));
        area.value = '';
        status('Comment posted.');
        await refresh();
      } catch (err) { status(err.message || offline()); }
      post.disabled = false;
    });
    if (isOwner) slot.appendChild(grantsPanel(ownerId, options.taskId, options.title));
    return refresh();
  }

  // Who may comment: per task (taskId) or the whole list (taskId null).
  function grantsPanel(ownerId, taskId, title) {
    var box = el('div', 'comment-grants');
    box.setAttribute('data-grants-for', taskId || 'list');
    box.appendChild(el('h3', 'grants-h', taskId ? 'Who can comment on this task' : 'People who can comment on every task'));
    var list = el('ul', 'grant-list');
    var input = el('input', 'comment-email'); input.type = 'email'; input.placeholder = 'their TWGI account email'; input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Email of the TWGI account to invite');
    var add = button(taskId ? 'Allow comments' : 'Allow on all tasks', 'data-grant-add');
    var note = el('p', 'note'); note.setAttribute('role', 'status');
    box.appendChild(list); box.appendChild(input); box.appendChild(add); box.appendChild(note);
    async function refresh() {
      try {
        var query = client().from('taskmaster_comment_grants').select('id, task_id, grantee_email, created_at').eq('owner_id', ownerId);
        query = taskId ? query.eq('task_id', taskId) : query.is('task_id', null);
        var rows = must(await query.order('created_at', { ascending: true }));
        while (list.firstChild) list.removeChild(list.firstChild);
        (rows || []).forEach(function (g) {
          var li = el('li', 'grant');
          li.appendChild(el('span', '', g.grantee_email));
          var revoke = button('Remove', 'data-grant-revoke');
          revoke.addEventListener('click', async function () {
            try { must(await client().from('taskmaster_comment_grants').delete().eq('id', g.id)); note.textContent = g.grantee_email + ' can no longer comment.'; refresh(); }
            catch (err) { note.textContent = err.message; }
          });
          li.appendChild(revoke);
          list.appendChild(li);
        });
        if (!rows || !rows.length) list.appendChild(el('li', 'note', 'Only you so far.'));
      } catch (err) { note.textContent = offline(err); }
    }
    add.addEventListener('click', async function () {
      var email = String(input.value || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { note.textContent = 'Type a full email address.'; return; }
      try {
        if (taskId) await ensureThread(ownerId, taskId, title);
        must(await client().from('taskmaster_comment_grants').insert({ owner_id: ownerId, task_id: taskId || null, grantee_email: email }));
        if (!taskId) await syncThreads(ownerId, global.TWGITaskmaster ? global.TWGITaskmaster.read(ownerId) : [], { all: true });
        input.value = '';
        note.textContent = email + ' can now comment once they sign in with that email. They will see it under Shared with me.';
        refresh();
      } catch (err) { note.textContent = err.message || offline(); }
    });
    refresh();
    return box;
  }

  // Keeps thread titles current, and opens a thread for every task while
  // the owner shares the whole list.
  async function syncThreads(ownerId, tasks, options) {
    if (!client() || !ownerId || ownerId !== me.id) return false;
    var listGrants = options && options.all ? [1] : must(await client().from('taskmaster_comment_grants').select('id').eq('owner_id', ownerId).is('task_id', null).limit(1));
    var rows;
    if (listGrants && listGrants.length) rows = tasks;
    else {
      var existing = must(await client().from('taskmaster_threads').select('task_id').eq('owner_id', ownerId));
      var ids = {}; (existing || []).forEach(function (r) { ids[r.task_id] = true; });
      rows = tasks.filter(function (t) { return ids[t.id]; });
    }
    if (!rows.length) return true;
    must(await client().from('taskmaster_threads').upsert(rows.slice(0, 200).map(function (t) {
      return { owner_id: ownerId, task_id: t.id, title: String(t.title || '').slice(0, 140) };
    }), { onConflict: 'owner_id,task_id' }));
    return true;
  }

  // "Shared with me": tasks other people opened to me.
  function mountShared(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    if (!client() || !me.id) { node.hidden = true; return Promise.resolve(); }
    return (async function () {
      try {
        var rows = must(await client().from('taskmaster_threads').select('owner_id, task_id, title, owner_name, archived, updated_at')
          .neq('owner_id', me.id).order('updated_at', { ascending: false }).limit(100));
        if (!rows || !rows.length) { node.hidden = true; return; }
        node.hidden = false;
        node.appendChild(el('h2', '', 'Shared with me'));
        rows.forEach(function (t) {
          var d = el('details', 'task-comments shared-thread');
          d.appendChild(el('summary', '', (t.title || 'Task') + ' \u00b7 ' + (t.owner_name || 'TWGI member')));
          var slot = el('div', 'comments-slot');
          d.appendChild(slot);
          d.addEventListener('toggle', function () {
            if (d.open && !slot.getAttribute('data-mounted')) { slot.setAttribute('data-mounted', 'true'); mountTask(slot, { ownerId: t.owner_id, taskId: t.task_id, title: t.title }); }
          });
          node.appendChild(d);
        });
      } catch (err) { node.hidden = true; }
    })();
  }

  function mountListSharing(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    if (!client() || !me.id) { node.hidden = true; return; }
    node.hidden = false;
    node.appendChild(grantsPanel(me.id, null, ''));
  }

  function setMe(state) {
    me = { id: state && state.user ? state.user.id : '', email: state && state.email ? String(state.email).toLowerCase() : '' };
  }

  // Comment count for the task stats display. Resolves to a number, or
  // null when comments are not switched on or cannot be read.
  function countFor(ownerId, taskId) {
    if (!client() || !ownerId || !taskId) return Promise.resolve(null);
    return (async function () {
      try {
        var rows = must(await client().from('taskmaster_comments').select('id').eq('owner_id', ownerId).eq('task_id', taskId));
        return rows ? rows.length : 0;
      } catch (err) { return null; }
    })();
  }

  global.TWGITaskComments = {
    mountTask: mountTask, mountShared: mountShared, mountListSharing: mountListSharing,
    syncThreads: syncThreads, setMe: setMe, me: function () { return me; },
    countFor: countFor
  };

  function boot() {
    global.TWGIAccount.subscribe(function (state) {
      setMe(state);
      var shared = document.getElementById('shared-with-me');
      if (shared) mountShared(shared);
      var sharing = document.getElementById('list-sharing');
      if (sharing) mountListSharing(sharing);
    });
    if (global.TWGITaskmaster) {
      var t = null;
      global.TWGITaskmaster.onChange(function (id, tasks) {
        if (!id || id !== me.id) return;
        clearTimeout(t);
        t = setTimeout(function () { syncThreads(id, tasks).catch(function () {}); }, 2000);
      });
    }
  }
  if (global.TWGIAccount) boot();
  else document.addEventListener('twgi-account-api', boot);
})(window);
