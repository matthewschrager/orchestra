import { Hono } from "hono";
import type { PushManager } from "../push/manager";

export function createPushRoutes(pushManager: PushManager) {
  const app = new Hono();

  // Get VAPID public key (client needs this to subscribe)
  app.get("/vapid-key", (c) => {
    return c.json({ publicKey: pushManager.publicKey });
  });

  // Register a push subscription
  app.post("/subscribe", async (c) => {
    const body = await c.req.json();
    const { endpoint, keys, userAgent } = body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return c.json({ error: "Invalid subscription: endpoint and keys required" }, 400);
    }

    pushManager.addSubscription({ endpoint, keys, userAgent });
    return c.json({ ok: true });
  });

  // Unregister a push subscription
  app.delete("/subscribe", async (c) => {
    const body = await c.req.json();
    const { endpoint } = body;

    if (!endpoint) {
      return c.json({ error: "endpoint required" }, 400);
    }

    pushManager.removeSubscription(endpoint);
    return c.json({ ok: true });
  });

  return app;
}
