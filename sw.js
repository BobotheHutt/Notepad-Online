/* Notepad Online — offline support.
   Serves the app from cache and refreshes the cache in the background, so it
   opens with no connection and picks up updates on the next visit. */
const CACHE = 'notepad-online-v5';
const ASSETS = [
  './', './index.html', './styles.css', './icon.svg', './manifest.webmanifest',
  './js/icons.js', './js/sanitize.js', './js/markdown.js', './js/zip.js', './js/docx.js', './js/store.js', './js/pdf.js', './js/app.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh;
  }));
});
