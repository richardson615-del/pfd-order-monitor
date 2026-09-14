// Minimal service worker: enables PWA installability + web push notifications.
// No offline caching in the MVP - orders always need to be fresh from the server.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Keep the subscription alive without anybody touching the tablet.
 *
 * The browser can retire a push endpoint on its own - after a long silence, a
 * storage clear, or a Chrome update. When it does it fires this event, and if
 * nothing handles it the tablet simply stops ringing. Nothing on screen
 * changes. That is the failure this whole workstream exists to remove, and it
 * was unhandled.
 *
 * Two halves, deliberately:
 *
 *   1. Re-subscribe here, so the browser holds a valid endpoint again
 *      immediately, whether or not anybody is looking at the tablet.
 *   2. Try to record it. This runs same-origin with credentials, so the
 *      session cookie /api/push/subscribe actually reads goes with it. It can
 *      still fail - a service worker cannot refresh an expired Supabase
 *      session the way the page can - and that is survivable rather than
 *      fatal: AlertGate re-records the current subscription on every mount and
 *      every return to the foreground, so the page repairs what this could
 *      not. Giving the worker its own signed token would be a second
 *      credential path to keep honest, for a case the page already covers.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const existing = await self.registration.pushManager.getSubscription();
        const applicationServerKey =
          (event.oldSubscription && event.oldSubscription.options &&
            event.oldSubscription.options.applicationServerKey) ||
          (existing && existing.options && existing.options.applicationServerKey);

        // Without the key there is nothing to subscribe WITH. Bail rather than
        // throw: the page subscribes from scratch when it next runs.
        if (!applicationServerKey) return;

        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });

        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(sub),
        });
      } catch (err) {
        // Logged, never rethrown. A failure here must not stop the worker
        // handling the next push it does receive.
        console.error("pushsubscriptionchange: could not re-subscribe", err);
      }
    })()
  );
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
