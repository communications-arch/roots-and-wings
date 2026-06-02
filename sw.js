// Service Worker for Roots & Wings push notifications + PWA installability

// Empty fetch listener is required for Chrome on Android to qualify the site
// as an installable PWA (real WebAPK in the app drawer). Without it, "Install"
// silently downgrades to a launcher shortcut that gets cleaned up after a few
// days. We do not intercept or cache anything — purely pass-through.
self.addEventListener('fetch', function () {});

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
