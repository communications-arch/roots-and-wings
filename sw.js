// Service Worker for Roots & Wings push notifications + PWA installability

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
  event.waitUntil(self.registration.showNotification(title, options));
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
      // If the app is already open, focus it
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf('/members.html') !== -1) {
          clientList[i].focus();
          clientList[i].navigate(url);
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
