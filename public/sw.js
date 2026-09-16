// Minimal service worker: PWA installability, web push, and ONE offline page.
//
// It caches nothing of the app itself - orders always come fresh from the
// server, and a stale cached dashboard is a screen that lies about what is
// waiting. The one thing it holds is /offline.html, and it serves that only
// when a navigation cannot reach the network at all.
//
// Why: the restaurant's only setup step is Wi-Fi (Nick, 2026-09-16). A
// tablet bound at the office and powered on at a store with no known
// network opens the app and, without this, gets Chrome's dinosaur - a page
// with no brand, no restaurant name and no button that opens the Wi-Fi
// picker. With this it gets the Wi-Fi screen. The worker was installed at
// the office, when the tablet was signed in, so it is always there by the
// time the tablet is somewhere with no network.

const OFFLINE_CACHE = "premium-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(OFFLINE_CACHE);
        // cache: "reload" bypasses the HTTP cache so a new deploy's page is
        // the one stored, not whatever Chrome had from last month.
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch (err) {
        // Installing while offline, most likely. The worker still installs -
        // push and everything else must not depend on this page - and the
        // next activation tries again.
        console.error("offline page not cached", err);
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== OFFLINE_CACHE).map((n) => caches.delete(n)));
      // Refresh the page on every activation too, so a worker that installed
      // offline (see above) eventually holds it.
      try {
        const cache = await caches.open(OFFLINE_CACHE);
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch {}
    })()
  );
});

/**
 * Navigations only, and only on failure. Everything else - API calls,
 * scripts, the realtime socket - goes straight to the network exactly as
 * it did before this handler existed. The fetch is the browser's own,
 * untouched; the cache is consulted only after it throws, which it does
 * solely when there is no network. A 500 from the server is not "offline"
 * and is shown as the 500 it is.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return cached || Response.error();
    })
  );
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

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      // Tell every open page, so the list updates now rather than at the
      // next poll. Realtime is opt-in since 2026-09-16 (lib/order-sync.ts);
      // this is what keeps a new order's latency at the push's, not the
      // poll's. Best-effort: a page that is not open hears nothing, and
      // the poll still covers it.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((pages) => pages.forEach((p) => p.postMessage({ type: "premium:order", orderId: data.orderId })))
        .catch(() => {}),
    ])
  );
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
