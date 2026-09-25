self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title || '안심ON 새 알림', {
    body: data.body || '관제실에서 새 알림을 보냈습니다.',
    icon: '/icons/icon-192.png',
    badge: '/icons/notification-badge.png',
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
  event.waitUntil((async () => {
    try {
      const opened = await clients.openWindow(target);
      if (opened) {
        await opened.focus();
        return;
      }
    } catch (_) { /* Fall back to an existing app window. */ }

    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname === '/report.html';
    });
    if (app) {
      await app.focus();
      if (app.url !== target) await app.navigate(target);
    }
  })());
});
