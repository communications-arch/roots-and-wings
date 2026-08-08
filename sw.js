// Service Worker for Roots & Wings push notifications + PWA installability

// Updates take over immediately. Without this, a new SW waits until every
// portal window closes — PWAs people keep open ran week-old push handlers
// (Erin, 2026-08-05: badge-refresh fix "didn't work" because the old
// worker was still active). No caches here, so instant takeover is safe.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(clients.claim()); });

// Chrome on Android requires a non-trivial fetch handler to qualify the site
// as an installable PWA (real WebAPK in the app drawer). An empty handler
// gets detected as no-op by Chrome's "skippable fetch handler" optimization
// and the install silently downgrades to a launcher shortcut that gets
// cleaned up after a few days. Calling event.respondWith() on navigations
// makes the handler look real to Chrome without intercepting static assets.
self.addEventListener('fetch', function (event) {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignore */ }
  var title = data.title || 'Roots & Wings';
  var options = {
    body: data.body || '',
    icon: '/logo-combined-mark.png',
    badge: '/logo-combined-mark.png',
    tag: data.tag || 'rw-notification',
    data: { url: data.url || '/members.html#coverage' },
    requireInteraction: true
  };
  // Also nudge any open portal windows so the in-app bell updates live.
  // With the app foregrounded, Android tends to drop the notification
  // straight into the tray (no heads-up over the focused app — Erin,
  // 2026-08-05), so the bell badge is what the user actually sees.
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      list.forEach(function (c) { c.postMessage({ type: 'rw-push-received' }); });
    })
  ]));
});

// Browsers occasionally rotate/expire a push subscription on their own.
// Without this handler the device silently stops receiving forever.
// Re-subscribe with the same key here; the page's daily re-sync uploads
// the fresh endpoint on the next portal visit (the SW itself has no auth
// token, so it can't POST to /api/push-subscribe directly).
self.addEventListener('pushsubscriptionchange', function (event) {
  var oldKey = event.oldSubscription && event.oldSubscription.options
    ? event.oldSubscription.options.applicationServerKey : null;
  if (!oldKey) return;
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: oldKey })
      .catch(function () { /* page-side heal will retry */ })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/members.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // If the app is already open, focus it. Codebase review 2026-08-08:
      // Vercel cleanUrls serves the page at /members (no .html), so
      // matching only '/members.html' never found the open portal and a
      // duplicate window opened every time. Match either form.
      for (var i = 0; i < clientList.length; i++) {
        var u = clientList[i].url || '';
        if (u.indexOf('/members.html') !== -1 || /\/members(\b|[/?#])/.test(u)) {
          clientList[i].focus();
          clientList[i].navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
