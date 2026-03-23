// Orchestra Service Worker
// Handles push notifications and offline caching

// ── Push Notification Handler ────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Orchestra", body: event.data.text() };
  }

  const options = {
    body: payload.body || "Agent needs your attention",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.data?.attentionId || "orchestra-notification",
    renotify: true,
    data: payload.data || {},
    actions: [],
  };

  // Add action buttons based on attention kind
  if (payload.data?.kind === "permission") {
    options.actions = [
      { action: "allow", title: "Allow" },
      { action: "deny", title: "Deny" },
    ];
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Orchestra", options));
});

// ── Notification Click Handler ───────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  // Build the URL to navigate to
  let targetUrl = "/";
  if (data.threadId) {
    targetUrl = `/?thread=${data.threadId}`;
    if (data.attentionId) {
      targetUrl += `&attention=${data.attentionId}`;
    }
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If there's already an open window, focus it and navigate
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope)) {
          client.focus();
          client.postMessage({
            type: "notification-click",
            threadId: data.threadId,
            attentionId: data.attentionId,
            action: event.action || null,
          });
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    }),
  );
});

// ── Offline Cache (app shell) ────────────────────────────

const CACHE_NAME = "orchestra-v1";
const APP_SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Network-first strategy for API, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Don't cache API requests or WebSocket
  if (url.pathname.startsWith("/api") || url.pathname === "/ws") {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)),
  );
});
