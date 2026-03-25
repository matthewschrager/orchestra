import { Hono } from "hono";
import type { TailscaleDetector } from "../tailscale/detector";
import type { DB } from "../db";
import { getSetting } from "../db";

export function createTailscaleRoutes(detector: TailscaleDetector, db: DB) {
  const app = new Hono();

  /** GET /api/tailscale/status — Tailscale detection for Settings panel */
  app.get("/status", async (c) => {
    const forceRefresh = c.req.query("refresh") === "1";
    const status = forceRefresh ? await detector.refresh() : await detector.detect();
    status.remoteUrl = getSetting(db, "remoteUrl") || "";
    return c.json(status);
  });

  return app;
}
