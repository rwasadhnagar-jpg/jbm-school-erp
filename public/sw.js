self.addEventListener('push', event => {
  let data = { title: 'JBM ERP', body: '' };
  try { data = event.data.json(); } catch (e) { if (event.data) data.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(data.title || 'JBM ERP', {
    body: data.body || '',
    icon: '/img/logo.png',
    badge: '/img/logo.png'
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('/dashboard');
    })
  );
});
