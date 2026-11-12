/* Boots the Taskmaster app page. */
(function () {
  // v6: registers the service worker and reloads once when a new version
  // takes over (assets/auto-update.js), so the Home Screen app updates itself.
  if (window.TWGIAutoUpdate) {
    window.TWGIAutoUpdate.start({ window: window, storage: window.sessionStorage, busySelector: '[data-rename-input], .task-mic[aria-pressed="true"]' });
  } else if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
  var pill = document.getElementById('offline-pill');
  function online() { if (pill) pill.hidden = navigator.onLine !== false; }
  window.addEventListener('online', online);
  window.addEventListener('offline', online);
  online();

  var app = document.getElementById('taskmaster-app');
  if (!app || !window.TWGITaskmaster) return;
  window.TWGITaskmaster.mount(app, { requireUser: false });

  var note = document.getElementById('who-note');
  var importSlot = document.getElementById('import-slot');
  var offered = false;

  function offerImport() {
    if (offered || !window.TWGITaskmasterImport || !window.TWGITaskmasterImport.pending()) return;
    offered = true;
    window.TWGITaskmasterImport.offer(importSlot, function () {
      window.TWGITaskmaster.mount(app, { requireUser: false });
    });
  }

  function bind() {
    window.TWGIAccount.subscribe(function (state) {
      var user = state && state.user;
      window.TWGITaskmaster.setUser(user ? user.id : null);
      if (note) {
        note.textContent = '';
        if (user) {
          note.appendChild(document.createTextNode('Signed in as ' + (state.email || state.name) + '. Your list syncs across every device where you sign in. '));
          var out = document.createElement('a');
          out.href = '#';
          out.textContent = 'Sign out';
          out.addEventListener('click', function (event) {
            event.preventDefault();
            window.TWGIAccount.signOut();
          });
          note.appendChild(out);
        } else {
          note.appendChild(document.createTextNode('Not signed in: this list is kept on this device. '));
          var link = document.createElement('a');
          link.href = '/login/';
          link.textContent = 'Sign in';
          note.appendChild(link);
          note.appendChild(document.createTextNode(' with your TWGI master account to sync your list across your devices.'));
        }
      }
      offerImport();
      openFromLink();
    });
  }

  // Notification links: /?task=<id>[&comments=1] opens that task,
  // /?plan=1 puts the cursor in "Add a task".
  var linkHandled = false;
  function openFromLink(href) {
    var url;
    try { url = new URL(href || window.location.href); } catch (err) { return; }
    if (!href && linkHandled) return;
    var taskId = url.searchParams.get('task');
    if (taskId && window.TWGITaskmaster.openTask(taskId, url.searchParams.get('comments') === '1')) linkHandled = true;
    if (url.searchParams.get('plan') === '1') {
      var input = app.querySelector('.task-input');
      if (input) input.focus();
      linkHandled = true;
    }
  }
  if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'twgi-open' && typeof data.url === 'string') openFromLink(new URL(data.url, window.location.origin).href);
    });
  }
  openFromLink();
  if (window.TWGIAccount) bind();
  else document.addEventListener('twgi-account-api', bind);
})();
