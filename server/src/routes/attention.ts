import { Hono } from "hono";
import type { DB } from "../db";
import { getPendingAttention, attentionRowToApi } from "../db";
import type { SessionManager } from "../sessions/manager";

export function createAttentionRoutes(db: DB, sessionManager: SessionManager) {
  const app = new Hono();

  // List pending attention items (optionally filtered by threadId)
  app.get("/", (c) => {
    const threadId = c.req.query("threadId");
    const rows = getPendingAttention(db, threadId || undefined);
    return c.json(rows.map(attentionRowToApi));
  });

  // Resolve an attention item
  app.post("/:id/resolve", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { resolution } = body;

    if (!resolution || !resolution.type) {
      return c.json({ error: "resolution with type field required" }, 400);
    }

    const resolved = sessionManager.resolveAttention(id, resolution);
    if (!resolved) {
      return c.json({ error: "Attention item not found" }, 404);
    }

    return c.json(attentionRowToApi(resolved));
  });

  return app;
}
