/* Notepad Online — offline support.
   The app's own files are fetched fresh whenever there is a connection (so an
   update shows up on the next load, not some loads later) and served from the
   cache only when offline. The large libraries under vendor/ never change for
   a given version, so they are served from the cache first. */
const CACHE = 'notepad-online-v18';
const ASSETS = [
  './', './index.html', './styles.css', './icon.svg', './manifest.webmanifest',
  './js/icons.js', './js/sanitize.js', './js/markdown.js', './js/zip.js', './js/docx.js', './js/store.js', './js/fonts.js', './js/pdf.js', './js/app.js'
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
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached && url.pathname.includes('/vendor/')) return cached;
    try {
      // no-cache: ask the server even if the browser's own HTTP cache thinks its copy is recent
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  }));
});
