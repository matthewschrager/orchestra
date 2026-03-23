import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { createDb } from "./db";
import { createThreadRoutes } from "./routes/threads";
import { createAgentRoutes } from "./routes/agents";
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

const PORT = parseInt(process.env.ORCHESTRA_PORT || "3000", 10);
const HOST = process.env.ORCHESTRA_HOST || "127.0.0.1";
const isExternal = HOST !== "127.0.0.1" && HOST !== "localhost";

// ── Init ────────────────────────────────────────────────

const db = createDb();
const registry = new AgentRegistry();
const worktreeManager = new WorktreeManager(db);
const sessionManager = new SessionManager(db, registry, worktreeManager);

let authToken: string | null = null;
if (isExternal) {
  authToken = getOrCreateToken();
  console.log(`Auth token required for external access.`);
  console.log(`Token stored in ~/.orchestra/auth-token`);
}

// ── App ─────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors());

// Auth middleware — only enforced for non-local requests when binding externally
app.use("/api/*", async (c, next) => {
  if (authToken && !isLocalRequest(c.req.raw, (c as any).env?.ip)) {
    if (!validateToken(c.req.raw, authToken)) {
      return c.json({ error: "Unauthorized — provide Bearer token" }, 401);
    }
  }
  await next();
});

// API routes
app.route("/api/threads", createThreadRoutes(db, sessionManager, worktreeManager));
app.route("/api/agents", createAgentRoutes(registry));

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
      // Auth check for external WS connections
      if (authToken) {
        const ip = server.requestIP(req);
        const isLocal =
          !ip ||
          ip.address === "127.0.0.1" ||
          ip.address === "::1" ||
          ip.address === "::ffff:127.0.0.1";

        if (!isLocal && !validateWSToken(url, authToken)) {
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
if (isExternal) {
  console.log(
    `\nRemote access setup:\n` +
      `  LAN:       http://<your-ip>:${PORT}\n` +
      `  Tailscale: http://<tailscale-ip>:${PORT} (recommended)\n` +
      `  Tunnel:    cloudflared tunnel --url http://localhost:${PORT}\n` +
      `  SSH:       ssh -L ${PORT}:localhost:${PORT} <host>\n`,
  );
}

// Cleanup on exit
function shutdown() {
  sessionManager.stopAll();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
