// Al Hikmah Live - minimal service worker (ES5, for old Android browsers).
// Its only job is to let the browser treat the site as an installable app.
// It does NOT cache or intercept any request, so the live stream, the live
// status, the recordings and the page itself always come straight from the network.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* pass-through: no respondWith() */ });
