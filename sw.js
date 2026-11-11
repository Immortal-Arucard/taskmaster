/* Taskmaster service worker. Bump CACHE on every release. */
const CACHE = 'taskmaster-v3';
const APP_TITLE = 'Taskmaster';
const ASSETS = [
  '/',
  '/index.html',
  '/login/',
  '/login/index.html',
  '/404.html',
  '/manifest.webmanifest',
  '/assets/app.css',
  '/assets/app.js',
  '/assets/auth.js',
  '/assets/import.js',
  '/assets/login.js',
  '/assets/taskmaster.js',
  '/assets/task-time.js',
  '/assets/push-core.js',
  '/assets/push-ui.js',
  '/assets/comments.js',
  '/vendor/supabase.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-48.png',
  '/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return response;
      }).catch(() => caches.match(url.pathname, { ignoreSearch: true })
        .then((hit) => hit || caches.match(url.pathname.replace(/\/?$/, '/'))
        .then((dir) => dir || caches.match('/'))))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      if (hit) {
        event.waitUntil(network.catch(() => {}));
        return hit;
      }
      return network;
    })
  );
});

/* Push notifications (v3). The push service sends JSON:
   { title, body, url, tag, kind }. Only same-origin paths are opened. */
function safePath(value) {
  return typeof value === 'string' && value.charAt(0) === '/' && value.charAt(1) !== '/' && value.charAt(1) !== '\\' ? value : '/';
}

self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (err) { payload = { body: event.data ? event.data.text() : '' }; }
  var title = String(payload.title || APP_TITLE).slice(0, 120);
  var options = {
    body: String(payload.body || '').slice(0, 240),
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-48.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 64) : undefined,
    renotify: !!payload.tag,
    data: { url: safePath(payload.url), kind: String(payload.kind || '') }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var path = safePath(event.notification.data && event.notification.data.url);
  var target = new URL(path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    var same = windows.filter(function (c) { return c.url && c.url.indexOf(self.location.origin) === 0; });
    var exact = same.find(function (c) { return c.url === target; });
    var client = exact || same[0];
    if (client) {
      if (!exact && client.postMessage) client.postMessage({ type: 'twgi-open', url: path });
      return client.focus ? client.focus() : client;
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : null;
  }));
});
