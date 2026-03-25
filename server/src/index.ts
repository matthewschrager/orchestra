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
import { createUploadRoutes } from "./routes/uploads";
import { createSettingsRoutes, getWorktreeRoot } from "./routes/settings";
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
import { detectWorktree } from "./utils/git";
import { join } from "path";
import { homedir } from "os";

// ── Worktree isolation ──────────────────────────────────
// When running from a git worktree (e.g., dev:server in a worktree), auto-isolate
// to prevent sharing the DB/port with the main server or other worktrees.
const worktreeName = detectWorktree(process.cwd());
const DEFAULT_PORT = 3847;

let effectiveDataDir = process.env.ORCHESTRA_DATA_DIR || undefined;
let effectivePort = parseInt(process.env.ORCHESTRA_PORT || String(DEFAULT_PORT), 10);

if (worktreeName && !process.env.ORCHESTRA_DATA_DIR) {
  // Use a worktree-specific data directory
  effectiveDataDir = join(homedir(), ".orchestra", `worktree-${worktreeName}`);
  console.log(`[worktree] Detected worktree "${worktreeName}" — using isolated data dir: ${effectiveDataDir}`);
}
if (worktreeName && !process.env.ORCHESTRA_PORT) {
  // Hash the worktree name to a stable port offset (range 1-9999)
  let hash = 0;
  for (const ch of worktreeName) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const offset = (Math.abs(hash) % 9999) + 1;
  effectivePort = DEFAULT_PORT + offset;
  console.log(`[worktree] Using isolated port: ${effectivePort}`);
}

const PORT = effectivePort;
const HOST = process.env.ORCHESTRA_HOST || "127.0.0.1";
const DATA_DIR = effectiveDataDir;
const useTunnel = process.argv.includes("--tunnel");
// When tunnel is active, force auth on ALL requests — tunnel makes remote traffic appear local
const isExternal = useTunnel || HOST !== "127.0.0.1" && HOST !== "localhost";

// ── Init ────────────────────────────────────────────────

const db = createDb(DATA_DIR);
const registry = new AgentRegistry();
const worktreeManager = new WorktreeManager(db, getWorktreeRoot(db));
const uploadsDir = join(DATA_DIR || join(homedir(), ".orchestra"), "uploads");
const sessionManager = new SessionManager(db, registry, worktreeManager, uploadsDir);
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
app.route("/api/commands", createCommandRoutes(db));
app.route("/api/fs", createFilesystemRoutes());
app.route("/api/attention", createAttentionRoutes(db, sessionManager));
app.route("/api/push", createPushRoutes(pushManager));
app.route("/api/uploads", createUploadRoutes(uploadsDir));
app.route("/api/settings", createSettingsRoutes(db, worktreeManager));

// Static frontend (production)
app.use("/*", serveStatic({ root: "./static" }));
// SPA fallback
app.get("*", async (c) => {
  return c.html(await Bun.file("./static/index.html").text());
});

// ── Server ──────────────────────────────────────────────

const wsHandler = createWSHandler(sessionManager, db);

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
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
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("EADDRINUSE") || msg.includes("address already in use")) {
    console.error(`\nPort ${PORT} is already in use.`);
    if (worktreeName) {
      console.error(`This may be a port hash collision from worktree "${worktreeName}".`);
      console.error(`Fix: set ORCHESTRA_PORT=<free-port> to override.`);
    }
  }
  throw err;
}

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

// Cleanup on exit — set shuttingDown FIRST to prevent race where Claude child
// processes (in same process group) exit from the signal before stopAll() runs,
// causing handleExit to record false SIGTERM errors.
function shutdown() {
  sessionManager.shuttingDown = true;
  tunnelManager.stop();
  sessionManager.stopAll();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
