const CACHE_NAME = 'codedb-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './codedb.ico',
  './codedb.png',
  './css/style.css',
  './js/utils.js',
  './js/tabs.js',
  './js/live.js',
  './js/grid.js',
  './js/uml.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Alcuni asset statici non sono stati memorizzati nella cache SW:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Richieste socket.io o mcp vanno sempre in rete (network-only)
  if (event.request.url.includes('/socket.io/') || event.request.url.includes('/mcp')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
