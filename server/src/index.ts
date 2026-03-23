import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { createDb, expireAttentionItems } from "./db";
import { createThreadRoutes } from "./routes/threads";
import { createAgentRoutes } from "./routes/agents";
import { createProjectRoutes } from "./routes/projects";
import { createCommandRoutes } from "./routes/commands";
import { createFilesystemRoutes } from "./routes/filesystem";
import { createAttentionRoutes } from "./routes/attention";
import { createPushRoutes } from "./routes/push";
import { PushManager } from "./push/manager";
import { createWSHandler } from "./ws/handler";
import { SessionManager } from "./sessions/manager";
import { AgentRegistry } from "./agents/registry";
import { WorktreeManager } from "./worktrees/manager";
import {
  getOrCreateToken,
  isLocalRequest,
  validateToken,
  validateWSToken,
} from "./auth";

import { TunnelManager, generateQRCodeAscii } from "./tunnel/manager";

const PORT = parseInt(process.env.ORCHESTRA_PORT || "3847", 10);
const HOST = process.env.ORCHESTRA_HOST || "127.0.0.1";
const DATA_DIR = process.env.ORCHESTRA_DATA_DIR || undefined;
const useTunnel = process.argv.includes("--tunnel");
// When tunnel is active, force auth on ALL requests — tunnel makes remote traffic appear local
const isExternal = useTunnel || HOST !== "127.0.0.1" && HOST !== "localhost";

// ── Init ────────────────────────────────────────────────

const db = createDb(DATA_DIR);
const registry = new AgentRegistry();
const worktreeManager = new WorktreeManager(db);
const sessionManager = new SessionManager(db, registry, worktreeManager);
const pushManager = new PushManager(db);

// Wire push notifications to attention events
sessionManager.onAttention((_threadId, attention) => {
  pushManager.notify(attention).catch((err) => {
    console.error("[push] Notification dispatch failed:", err);
  });
});

let authToken: string | null = null;
if (isExternal) {
  authToken = getOrCreateToken(DATA_DIR);
  console.log(`Auth token required for external access.`);
  console.log(`Token stored in ${DATA_DIR || "~/.orchestra"}/auth-token`);
}

// ── App ─────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors());

// Auth middleware — enforced for non-local requests (tunnel traffic has CF-Connecting-IP)
app.use("/api/*", async (c, next) => {
  if (authToken) {
    const isTunneled = !!c.req.raw.headers.get("cf-connecting-ip");
    const isLocal = isLocalRequest(c.req.raw, (c as any).env?.ip);
    if (isTunneled || !isLocal) {
      if (!validateToken(c.req.raw, authToken)) {
        return c.json({ error: "Unauthorized — provide Bearer token" }, 401);
      }
    }
  }
  await next();
});

// API routes
app.route("/api/projects", createProjectRoutes(db));
app.route("/api/threads", createThreadRoutes(db, sessionManager, worktreeManager));
app.route("/api/agents", createAgentRoutes(registry));
app.route("/api/commands", createCommandRoutes());
app.route("/api/fs", createFilesystemRoutes());
app.route("/api/attention", createAttentionRoutes(db, sessionManager));
app.route("/api/push", createPushRoutes(pushManager));

// Static frontend (production)
app.use("/*", serveStatic({ root: "./static" }));
// SPA fallback
app.get("*", async (c) => {
  return c.html(await Bun.file("./static/index.html").text());
});

// ── Server ──────────────────────────────────────────────

const wsHandler = createWSHandler(sessionManager, db);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      // Auth check for external WS connections (tunnel traffic has CF-Connecting-IP)
      if (authToken) {
        const isTunneled = !!req.headers.get("cf-connecting-ip");
        const ip = server.requestIP(req);
        const isLocal =
          !ip ||
          ip.address === "127.0.0.1" ||
          ip.address === "::1" ||
          ip.address === "::ffff:127.0.0.1";

        if ((isTunneled || !isLocal) && !validateWSToken(url, authToken)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      if (server.upgrade(req, { data: { subscriptions: new Set() } }))
        return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: wsHandler,
});

console.log(`Orchestra server running at http://${HOST}:${PORT}`);
if (DATA_DIR) console.log(`Data directory: ${DATA_DIR}`);

// ── Tunnel ───────────────────────────────────────────────
const tunnelManager = new TunnelManager();

// Expose tunnel URL via API (for PWA reconnection)
app.get("/api/tunnel", (c) => {
  return c.json({ url: tunnelManager.url, active: tunnelManager.isRunning });
});

if (useTunnel) {
  console.log("\nStarting Cloudflare Tunnel...");
  tunnelManager.start(PORT).then(async (url) => {
    const authUrl = authToken ? `${url}?token=${authToken}` : url;
    const qr = await generateQRCodeAscii(authUrl);
    console.log(`\n${qr}`);
    console.log(`\nTunnel active: ${url}`);
    if (authToken) {
      console.log(`Scan the QR code — token is embedded in the URL.`);
    }
  }).catch((err) => {
    console.error(`\nTunnel failed: ${(err as Error).message}`);
    console.log("Server is still running — connect via LAN/VPN instead.");
  });
} else if (isExternal) {
  console.log(
    `\nRemote access setup:\n` +
      `  LAN:       http://<your-ip>:${PORT}\n` +
      `  Tailscale: http://<tailscale-ip>:${PORT} (recommended)\n` +
      `  Tunnel:    orchestra serve --tunnel (auto-setup)\n` +
      `  SSH:       ssh -L ${PORT}:localhost:${PORT} <host>\n`,
  );
}

// ── Periodic attention expiry ─────────────────────────────
const EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // every hour
setInterval(() => {
  const expired = expireAttentionItems(db);
  if (expired > 0) console.log(`[attention] Expired ${expired} stale items`);
}, EXPIRY_INTERVAL_MS);
// Run once on startup
expireAttentionItems(db);

// Cleanup on exit
function shutdown() {
  tunnelManager.stop();
  sessionManager.stopAll();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
