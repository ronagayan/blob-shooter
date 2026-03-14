'use strict';

const CACHE = 'blob-shooter-v1';
const PRECACHE = ['/', '/index.html', '/style.css', '/game.js', '/draw.js', '/manifest.json', '/icon.svg', '/icon-192.png', '/icon-512.png'];

// ── Install: pre-cache all static assets ──────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE))
  );
  self.skipWaiting(); // activate immediately
});

// ── Activate: purge old caches ────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first, fall back to network ──────
self.addEventListener('fetch', e => {
  // Only handle same-origin GET requests (skip WebSocket upgrades etc.)
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Dynamically cache any new same-origin resource
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
