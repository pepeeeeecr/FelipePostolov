self.addEventListener('push', event => {
  let data = { title: 'Foursome', body: 'You have a new update' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* fall back to default */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      badge: undefined,
      icon: undefined
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
