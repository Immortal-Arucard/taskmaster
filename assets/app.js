/* Boots the Taskmaster app page. */
(function () {
  if ('serviceWorker' in navigator) {
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
          note.appendChild(document.createTextNode('Signed in as ' + (state.email || state.name) + '. This is your account\u2019s list on this device. '));
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
          note.appendChild(document.createTextNode(' with your TWGI master account to keep a list for your account.'));
        }
      }
      offerImport();
    });
  }
  if (window.TWGIAccount) bind();
  else document.addEventListener('twgi-account-api', bind);
})();
