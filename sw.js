const CACHE_NAME = 'reisekosten-tracker-v3.0.0';
const APP_SHELL = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(APP_SHELL.map((url) =>
        fetch(url, { cache: 'reload' }).then((response) => cache.put(url, response))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return; // e.g. OpenRouteService calls: always go to the network untouched
  }
  // Page navigations always resolve to the cached app shell, regardless of
  // which exact URL variant ("/" vs "/index.html") the browser requested.
  const cacheKey = event.request.mode === 'navigate' ? './index.html' : event.request;

  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const network = fetch(event.request, { cache: 'no-store' }).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
