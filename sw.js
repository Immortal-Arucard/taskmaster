/* Taskmaster service worker. Bump CACHE on every release. */
const CACHE = 'taskmaster-v1';
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
