self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title || '안심ON 새 알림', {
    body: data.body || '관제실에서 새 알림을 보냈습니다.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.alertId || data.noticeId || 'ansimon-message',
    renotify: true,
    requireInteraction: data.type === 'urgent',
    silent: false,
    vibrate: data.type === 'urgent' ? [1000, 250, 1000, 250, 1000, 250, 1500] : [250, 120, 250],
    data: { url: data.url || '/report.html' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/report.html', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const app = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (app) {
      await app.navigate(target);
      return app.focus();
    }
    return clients.openWindow(target);
  }));
});
