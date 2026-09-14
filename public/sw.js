// Minimal service worker: enables PWA installability + web push notifications.
// No offline caching in the MVP - orders always need to be fresh from the server.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "New order", body: "Tap to view", orderId: null };
  try {
    data = event.data.json();
  } catch (e) {
    // fall back to defaults above
  }

  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    // A badge is drawn as a silhouette in the status bar - Android keeps the
    // alpha and discards the colour. The 192 icon used here before came out
    // as a solid blob; badge-96 is white on transparent for that reason.
    badge: "/icons/badge-96.png",
    vibrate: [200, 100, 200, 100, 200],
    tag: data.orderId ? `order-${data.orderId}` : undefined,
    data: { orderId: data.orderId },
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const orderId = event.notification.data?.orderId;
  const url = orderId ? `/order/${orderId}` : "/dashboard";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(url) && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
  );
});
