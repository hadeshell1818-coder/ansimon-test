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
    const notify = client => {
      const url = new URL(target);
      client.postMessage?.({ type: 'safety-notification-open', alertId: url.searchParams.get('alert'), noticeId: url.searchParams.get('notice') });
    };
    try {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = windows.find(client => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname === '/report.html';
      });
      if (app) {
        const opened = app.url === target ? app : await app.navigate(target);
        await (opened || app).focus();
        notify(opened || app);
        return;
      }
    } catch (_) { /* Try opening a new app window. */ }
    const opened = await clients.openWindow(target);
    if (opened) { await opened.focus(); notify(opened); }
  })());
});
