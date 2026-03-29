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

  // Use server-provided targetUrl (per-subscription origin), fallback to relative path
  // Fix 8: Validate targetUrl is same-origin to prevent open redirect via push notifications
  let targetUrl = data.targetUrl || "/";
  if (targetUrl && !targetUrl.startsWith("/")) {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.origin !== self.location.origin) {
        targetUrl = "/"; // Reject cross-origin, javascript:, data:, blob:
      }
    } catch {
      targetUrl = "/"; // Invalid URL
    }
  }
  if (!data.targetUrl && data.threadId) {
    targetUrl = `/?thread=${data.threadId}`;
    if (data.attentionId) {
      targetUrl += `&attention=${data.attentionId}`;
    }
  }

  // Check if targetUrl is same-origin (can focus existing window)
  const isSameOrigin = targetUrl.startsWith("/") || targetUrl.startsWith(self.location.origin);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      if (isSameOrigin) {
        // Same-origin: try to focus existing window and navigate via postMessage
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
      }
      // Cross-origin or no existing window: open new window
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
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  // Let the browser handle cross-origin requests directly. Intercepting them
  // routes the request through service-worker fetch(), which is governed by
  // connect-src and breaks Google Fonts under the current CSP.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Don't cache API requests or WebSocket
  if (url.pathname.startsWith("/api") || url.pathname === "/ws") {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || Response.error();
    }),
  );
});
