import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { createDb, expireAttentionItems, getSetting } from "./db";
import { createThreadRoutes } from "./routes/threads";
import { createAgentRoutes } from "./routes/agents";
import { createProjectRoutes } from "./routes/projects";
import { createCommandRoutes } from "./routes/commands";
import { createFilesystemRoutes } from "./routes/filesystem";
import { createAttentionRoutes } from "./routes/attention";
import { createPushRoutes } from "./routes/push";
import { createUploadRoutes } from "./routes/uploads";
import { createSettingsRoutes, getWorktreeRoot } from "./routes/settings";
import { createFileRoutes } from "./routes/files";
import { PushManager } from "./push/manager";
import { createWSHandler } from "./ws/handler";
import { SessionManager } from "./sessions/manager";
import { AgentRegistry } from "./agents/registry";
import { WorktreeManager } from "./worktrees/manager";
import {
  createHostValidationMiddleware,
  createApiAuthMiddleware,
  createTailscaleBootstrapMiddleware,
  getOrCreateToken,
  getOrCreateSessionSecret,
  getRequestHost,
  isLocalRequest,
  isWebSocketAuthorized,
  shouldAttemptTailscaleHostRefresh,
} from "./auth";

import { TunnelManager, generateQRCodeAscii } from "./tunnel/manager";
import { TailscaleDetector } from "./tailscale/detector";
import { createTailscaleRoutes } from "./routes/tailscale";
import { TerminalManager } from "./terminal/manager";
import { detectWorktree } from "./utils/git";
import { getAllowedOrigins, getAllowedHosts, getLocalInterfaceHosts } from "./utils/origins";
import { join } from "path";
import { homedir } from "os";

// ── Nested instance guard ─────────────────────────────────
// Block agents spawned by Orchestra from accidentally starting another instance.
// Override with --allow-nested or ORCHESTRA_ALLOW_NESTED=1 (useful when developing Orchestra itself).
if (process.env.ORCHESTRA_MANAGED === "1") {
  const allowNested =
    process.env.ORCHESTRA_ALLOW_NESTED === "1" ||
    process.argv.includes("--allow-nested");
  if (!allowNested) {
    console.error("Refusing to start: this process was spawned by Orchestra.");
    console.error("Override with --allow-nested or ORCHESTRA_ALLOW_NESTED=1");
    process.exit(1);
  }
}

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

// ── Env scrubbing for agent subprocesses ──────────────────
// Delete ORCHESTRA_* config vars so spawned agents don't inherit them
// (prevents accidental port collisions when an agent starts Orchestra elsewhere).
// Safe: server has already consumed these into PORT/HOST/DATA_DIR constants above.
for (const key of ["ORCHESTRA_PORT", "ORCHESTRA_DATA_DIR", "ORCHESTRA_HOST", "ORCHESTRA_ALLOW_NESTED"]) {
  delete process.env[key];
}
// Mark child processes as Orchestra-managed (enables startup guard above)
process.env.ORCHESTRA_MANAGED = "1";
// When tunnel is active, force auth on ALL requests — tunnel makes remote traffic appear local
const isExternal = useTunnel || HOST !== "127.0.0.1" && HOST !== "localhost";

// ── Init ────────────────────────────────────────────────

const db = createDb(DATA_DIR);
const registry = new AgentRegistry();
const worktreeManager = new WorktreeManager(db, getWorktreeRoot(db));
const uploadsDir = join(DATA_DIR || join(homedir(), ".orchestra"), "uploads");
const sessionManager = new SessionManager(db, registry, worktreeManager, uploadsDir, PORT);
const pushManager = new PushManager(db);
const terminalManager = new TerminalManager();
const tailscaleDetector = new TailscaleDetector(PORT);
const tunnelManager = new TunnelManager();
const localInterfaceHosts = getLocalInterfaceHosts();

// Wire push notifications to attention events
sessionManager.onAttention((_threadId, attention) => {
  pushManager.notify(attention).catch((err) => {
    console.error("[push] Notification dispatch failed:", err);
  });
});

let authToken: string | null = null;
authToken = getOrCreateToken(DATA_DIR);
const sessionSecret = getOrCreateSessionSecret(DATA_DIR);
if (isExternal) {
  console.log(`Auth token required for external access.`);
  console.log(`Token stored in ${DATA_DIR || "~/.orchestra"}/auth-token`);
}

// ── Tailscale hostname (cached for origin/host validation) ──
let tailscaleHostname: string | null = null;

// ── App ─────────────────────────────────────────────────

const app = new Hono();

// Fix 1: Restrict CORS to known origins (prevents cross-origin localhost attacks)
app.use("*", cors({
  origin: (origin) => {
    const allowed = getAllowedOrigins(PORT, db, tunnelManager, tailscaleHostname, [HOST, ...localInterfaceHosts]);
    return allowed.includes(origin) ? origin : null;
  },
}));

// Fix 3: Security headers (CSP, clickjacking, MIME sniffing, referrer)
app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// Fix 2B: Host header validation (DNS rebinding protection)
app.use("*", createHostValidationMiddleware({
  getAllowedHosts: () => getAllowedHosts(
    tailscaleHostname,
    getSetting(db, "remoteUrl") as string | null,
    tunnelManager.url,
    [HOST, ...localInterfaceHosts],
  ),
  getTailscaleHostname: () => tailscaleHostname,
  refreshTailscaleHostname: async () => {
    const refreshed = await tailscaleDetector.refresh().catch(() => null);
    if (refreshed?.hostname) tailscaleHostname = refreshed.hostname;
    return refreshed?.hostname ?? null;
  },
}));

// Fix 2A: Origin validation for state-changing requests (CSRF protection)
app.use("/api/*", async (c, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin) {
      const allowed = getAllowedOrigins(PORT, db, tunnelManager, tailscaleHostname, [HOST, ...localInterfaceHosts]);
      if (!allowed.includes(origin)) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }
  }
  await next();
});

app.use("*", createTailscaleBootstrapMiddleware(() => ({
  authToken: authToken!,
  sessionSecret,
  tailscaleHostname,
  remoteUrl: getSetting(db, "remoteUrl") as string | null,
})));

// Auth middleware — enforced via explicit request classification
app.use("/api/*", createApiAuthMiddleware(() => ({
  authToken: authToken!,
  sessionSecret,
  tailscaleHostname,
  remoteUrl: getSetting(db, "remoteUrl") as string | null,
})));

// API routes
app.route("/api/projects", createProjectRoutes(db, sessionManager, worktreeManager, terminalManager));
app.route("/api/threads", createThreadRoutes(db, sessionManager, worktreeManager, terminalManager));
app.route("/api/agents", createAgentRoutes(registry));
app.route("/api/commands", createCommandRoutes(db));
app.route("/api/fs", createFilesystemRoutes());
app.route("/api/attention", createAttentionRoutes(db, sessionManager));
app.route("/api/push", createPushRoutes(pushManager));
app.route("/api/uploads", createUploadRoutes(uploadsDir));
app.route("/api/settings", createSettingsRoutes(db, worktreeManager));
app.route("/api/files", createFileRoutes());
app.route("/api/tailscale", createTailscaleRoutes(tailscaleDetector, db));

// Status endpoint (must be before static/SPA fallback)
app.get("/api/status", (c) => {
  return c.json({ tunnelActive: useTunnel });
});

// Static frontend (production)
app.use("/*", serveStatic({ root: "./static" }));
// SPA fallback
app.get("*", async (c) => {
  return c.html(await Bun.file("./static/index.html").text());
});

// ── Server ──────────────────────────────────────────────

const wsHandler = createWSHandler(sessionManager, db, terminalManager);

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        // Fix 2C: WebSocket Origin check (CORS does NOT protect WebSocket connections)
        const wsOrigin = req.headers.get("origin");
        if (wsOrigin) {
          const allowed = getAllowedOrigins(PORT, db, tunnelManager, tailscaleHostname, [HOST, ...localInterfaceHosts]);
          if (!allowed.includes(wsOrigin)) {
            return new Response("Forbidden origin", { status: 403 });
          }
        }

        if (shouldAttemptTailscaleHostRefresh(getRequestHost(req), server.requestIP(req), tailscaleHostname)) {
          const refreshed = await tailscaleDetector.refresh().catch(() => null);
          if (refreshed?.hostname) tailscaleHostname = refreshed.hostname;
        }

        if (!isWebSocketAuthorized(url, req, server.requestIP(req), {
          authToken: authToken!,
          sessionSecret,
          tailscaleHostname,
          remoteUrl: getSetting(db, "remoteUrl") as string | null,
        })) {
          if (isLocalRequest(req, server.requestIP(req)) && getRequestHost(req)?.endsWith(".ts.net")) {
            return new Response("Unauthorized — tagged Tailscale access requires token", { status: 401 });
          }
          return new Response("Unauthorized", { status: 401 });
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

// ── Tailscale detection (runs regardless of isExternal) ──────
tailscaleDetector.detect().then((ts) => {
  if (!ts.installed) return;
  // Cache hostname for Origin/Host validation
  if (ts.hostname) tailscaleHostname = ts.hostname;
  if (!ts.running) {
    console.log(`\n[tailscale] Installed but not running. Start with: tailscale up`);
    return;
  }

  console.log(`\n[tailscale] Detected: ${ts.hostname || ts.ip || "unknown"}`);

  if (ts.proxyMismatch) {
    console.log(`[tailscale] ⚠ tailscale serve is proxying to HTTPS but Orchestra is HTTP — this causes 502 errors.`);
    console.log(`[tailscale] Fix: tailscale serve reset && tailscale serve --bg ${PORT}`);
  } else if (ts.httpsAvailable && ts.portMatch && ts.httpsUrl) {
    console.log(`[tailscale] HTTPS active: ${ts.httpsUrl}`);
    console.log(`[tailscale] Remote access ready — open this URL on your phone.`);
    console.log(`[tailscale] Browser sign-in uses Tailscale identity headers and a session cookie.`);
    console.log(`[tailscale] Tagged-device or fallback access can still use the bearer token in ~/.orchestra/auth-token.`);
  } else if (ts.httpsAvailable && !ts.portMatch) {
    console.log(`[tailscale] ⚠ tailscale serve is active but not mapped to port ${PORT}.`);
    console.log(`[tailscale] Fix: tailscale serve --bg ${PORT}`);
  } else {
    console.log(`[tailscale] Enable remote access with push notifications:`);
    console.log(`  tailscale serve --bg ${PORT}`);
    if (ts.hostname) {
      console.log(`  Then access via: https://${ts.hostname}/`);
    }
  }
}).catch(() => {
  // Tailscale detection is best-effort — never block startup
});

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
