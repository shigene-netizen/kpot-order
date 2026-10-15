/* KPOT To Go — service worker.
   Deliberately minimal and NETWORK-ONLY: it never caches a response, so it can
   never serve a stale menu or price. Its jobs are (1) to make the site
   installable to the Home Screen, and (2) to receive Web Push messages so an
   "order ready" alert can arrive even when the page is closed — that path is
   enabled once the site is on HTTPS and push subscriptions are wired up. */

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

/* A registered fetch handler, but a pure passthrough.
   --------------------------------------------------------------------------
   Why this exists when it does nothing: Chrome 108 (Android) / 112 (desktop)
   dropped the fetch-handler requirement for installing from the *browser menu*,
   but the heuristics behind the `beforeinstallprompt` event still check for one.
   Without it a page can pass the menu check and never receive the event, so an
   in-page "Add to Home Screen" button would silently never appear.

   Why it must stay a passthrough: a cached menu or price is a real hazard here.
   A guest scanning a QR could be shown yesterday's prices, or a total that no
   longer matches what the server recomputes at checkout. Serving stale data is
   a worse failure than a slow load, so nothing is ever written to a cache.

   Exposure is kept as small as possible: anything that is not a same-origin GET
   returns early and is handled entirely by the browser, so payment calls and
   any third-party request never pass through this worker at all. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  let sameOrigin = false;
  try { sameOrigin = new URL(e.request.url).origin === self.location.origin; } catch (err) { return; }
  if (!sameOrigin) return;
  e.respondWith(fetch(e.request));
});

/* Show the notification the server pushed (used by the future Web Push path). */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || '🛎️ Your order is ready!';
  const body = data.body || 'Come pick it up at the counter.';
  /* icon = large thumbnail (red disc on transparent, survives circle cropping).
     badge = status-bar mark; the platform masks it and keeps only the shape, so
     it must be transparent with an opaque glyph or it renders as a white blob. */
  e.waitUntil(self.registration.showNotification(title, {
    body,
    tag: data.tag || 'kpot-order',
    icon: 'assets/icon-notify-192.png',
    badge: 'assets/icon-notify-badge.png',
    requireInteraction: true,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
