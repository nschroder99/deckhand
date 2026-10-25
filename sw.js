// Offline: precache the app shell. Card media lives in IndexedDB, not here.
const PRECACHE = 'precache.json';
const VERSION = '2026-10-25T19:33:12.488Z'; // rewritten by scripts/check.js so browsers pick up new code
const CACHE = 'deckhand-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const { files } = await fetch(PRECACHE, { cache: 'no-store' }).then(r => r.json());
    const cache = await caches.open(CACHE);
    await cache.addAll(files.map(f => new Request(f, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Remove this app's old versions only; github.io is shared with the user's other sites.
    await Promise.all(keys.filter(k => k.startsWith('deckhand-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Answer only from this app's own versioned cache (never caches.match across the shared origin).
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isFont = FONT_HOSTS.includes(url.hostname);
  if (!isFont && url.origin !== location.origin) return;
  if (!isFont && !url.pathname.startsWith(new URL('./', location).pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: !isFont });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (isFont && (res.ok || res.type === 'opaque')) cache.put(e.request, res.clone());
    return res;
  })());
});
