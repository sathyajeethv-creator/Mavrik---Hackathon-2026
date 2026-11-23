/* CareConnect service worker: shows phone notifications even when the app is closed. */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.focused)) return;   // the open app already shows it
    return self.registration.showNotification(d.title || 'CareConnect', {
      body: d.body || '', tag: 'cc-live', renotify: true, requireInteraction: !!d.urgent,
      vibrate: [200, 100, 200], data: { url: d.url || '/' }
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  }));
});
