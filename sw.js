/* Minimal service worker for Al Hikmah Live.
   - Makes the site installable as an app (Chrome requires a fetch handler).
   - Touches ONLY page navigations: network first, and falls back to the last
     saved copy of the page if the phone is offline.
   - Never handles the live stream, /api/live-status, recordings or any other
     request, so live audio and live status are never cached or delayed. */
const CACHE = 'alhikmah-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return; // everything else: normal network
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
        return res;
      })
      .catch(() => caches.match('/').then((hit) => hit || new Response(
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px"><h3>ইন্টারনেট সংযোগ নেই</h3><p>সংযোগ ফিরলে পাতাটি আবার খুলুন।</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )))
  );
});
