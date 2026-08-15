// ponytail: pass-through service worker — cukup untuk installability PWA.
// Cache aset ditambahkan kalau lantai produksi butuh cold-start offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
