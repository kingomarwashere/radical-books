// Radical Books service worker. CRITICAL: never intercept page navigations — doing
// so silently breaks /upgrade, /reader etc. in installed PWAs (see the Sound + Radical
// Movies SW-navigation bug). We only cache the static shell + fonts/covers.
const SHELL = 'rb-shell-v1';
const ASSETS = ['/', '/app.js?v=1', '/style.css', '/favicon.svg', '/manifest.json'];

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k); await self.clients.claim(); })()); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Never touch navigations — let the browser load pages directly.
  if (req.mode === 'navigate') return;
  const url = new URL(req.url);
  // Never cache API or media; always go to network.
  if (url.pathname.startsWith('/api/')) return;
  // Cache-first for our static shell + same-origin assets; network fallback.
  if (url.origin === location.origin && /\.(js|css|svg|png|json|woff2?)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(c => c || fetch(req).then(r => { const cp = r.clone(); caches.open(SHELL).then(cc => cc.put(req, cp)); return r; }).catch(() => c)));
  }
});
