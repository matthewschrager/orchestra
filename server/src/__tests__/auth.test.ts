import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createApiAuthMiddleware,
  createHostValidationMiddleware,
  createTailscaleBootstrapMiddleware,
  getOrCreateSessionSecret,
  getOrCreateToken,
  getRequestHost,
  isWebSocketAuthorized,
} from "../auth";
import { getAllowedHosts } from "../utils/origins";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface TestHarness {
  app: Hono;
  dataDir: string;
  authToken: string;
  sessionSecret: string;
  state: { tailscaleHostname: string | null; remoteUrl: string | null };
}

function createHarness(opts?: { tailscaleHostname?: string | null; remoteUrl?: string | null; refreshTo?: string | null }) {
  const dataDir = mkdtempSync(join(tmpdir(), "orchestra-auth-test-"));
  const authToken = getOrCreateToken(dataDir);
  const sessionSecret = getOrCreateSessionSecret(dataDir);
  const state = {
    tailscaleHostname: opts?.tailscaleHostname ?? null,
    remoteUrl: opts?.remoteUrl ?? null,
  };

  const app = new Hono();
  app.use("*", createHostValidationMiddleware({
    getAllowedHosts: () => getAllowedHosts(state.tailscaleHostname, state.remoteUrl, null),
    getTailscaleHostname: () => state.tailscaleHostname,
    refreshTailscaleHostname: async () => {
      state.tailscaleHostname = opts?.refreshTo ?? null;
      return state.tailscaleHostname;
    },
  }));
  app.use("*", createTailscaleBootstrapMiddleware(() => ({
    authToken,
    sessionSecret,
    tailscaleHostname: state.tailscaleHostname,
    remoteUrl: state.remoteUrl,
  })));
  app.use("/api/*", async (c, next) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const host = getRequestHost(c.req.raw);
      const allowed = new Set<string>();
      if (host === "localhost" || host === "127.0.0.1") {
        allowed.add(`http://${host}`);
      }
      if (state.tailscaleHostname) {
        allowed.add(`https://${state.tailscaleHostname}`);
      }
      if (state.remoteUrl) {
        allowed.add(state.remoteUrl.replace(/\/$/, ""));
      }
      if (origin && !allowed.has(origin)) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }
    await next();
  });
  app.use("/api/*", createApiAuthMiddleware(() => ({
    authToken,
    sessionSecret,
    tailscaleHostname: state.tailscaleHostname,
    remoteUrl: state.remoteUrl,
  })));
  app.get("/", (c) => c.html("<html><body>ok</body></html>"));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.post("/api/mutate", (c) => c.json({ ok: true }));

  return { app, dataDir, authToken, sessionSecret, state } satisfies TestHarness;
}

function loopbackEnv() {
  return { ip: { address: "127.0.0.1" } } as any;
}

describe("auth hardening", () => {
  test("parses bracketed IPv6 host headers", () => {
    const req = new Request("http://[::1]/api/ping", {
      headers: { host: "[::1]:4850" },
    });
    expect(getRequestHost(req)).toBe("::1");
  });

  test("rejects invalid host even when a valid bearer token is present", async () => {
    const h = createHarness({ tailscaleHostname: "macbook.tail.ts.net" });
    try {
      const res = await h.app.fetch(new Request("http://evil.example/api/ping", {
        headers: {
          host: "evil.example",
          authorization: `Bearer ${h.authToken}`,
        },
      }), loopbackEnv());
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Invalid Host");
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  test("first Tailscale HTML request refreshes hostname and mints a session cookie", async () => {
    const h = createHarness({ refreshTo: "macbook.tail.ts.net" });
    try {
      const res = await h.app.fetch(new Request("http://macbook.tail.ts.net/", {
        headers: {
          host: "macbook.tail.ts.net",
          accept: "text/html",
          "Tailscale-User-Login": "matt@example.com",
          "Tailscale-User-Name": "Matt",
        },
      }), loopbackEnv());

      expect(res.status).toBe(200);
      expect(h.state.tailscaleHostname).toBe("macbook.tail.ts.net");
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("orchestra_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  test("tagged-device fallback requires bearer auth", async () => {
    const h = createHarness({ tailscaleHostname: "macbook.tail.ts.net" });
    try {
      const res = await h.app.fetch(new Request("http://macbook.tail.ts.net/api/ping", {
        headers: { host: "macbook.tail.ts.net" },
      }), loopbackEnv());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized — tagged Tailscale access requires Bearer token",
      });
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  test("cookie-authenticated mutation still rejects bad origin", async () => {
    const h = createHarness({ tailscaleHostname: "macbook.tail.ts.net" });
    try {
      const bootstrap = await h.app.fetch(new Request("http://macbook.tail.ts.net/", {
        headers: {
          host: "macbook.tail.ts.net",
          accept: "text/html",
          "Tailscale-User-Login": "matt@example.com",
          "Tailscale-User-Name": "Matt",
        },
      }), loopbackEnv());
      const cookie = bootstrap.headers.get("set-cookie");
      expect(cookie).toBeTruthy();

      const res = await h.app.fetch(new Request("http://macbook.tail.ts.net/api/mutate", {
        method: "POST",
        headers: {
          host: "macbook.tail.ts.net",
          cookie: cookie!,
          origin: "https://evil.example",
        },
      }), loopbackEnv());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });

  test("websocket auth accepts a valid session cookie", async () => {
    const h = createHarness({ tailscaleHostname: "macbook.tail.ts.net" });
    try {
      const bootstrap = await h.app.fetch(new Request("http://macbook.tail.ts.net/", {
        headers: {
          host: "macbook.tail.ts.net",
          accept: "text/html",
          "Tailscale-User-Login": "matt@example.com",
          "Tailscale-User-Name": "Matt",
        },
      }), loopbackEnv());
      const cookie = bootstrap.headers.get("set-cookie");
      expect(cookie).toBeTruthy();

      const wsReq = new Request("http://macbook.tail.ts.net/ws", {
        headers: {
          host: "macbook.tail.ts.net",
          cookie: cookie!,
          origin: "https://macbook.tail.ts.net",
        },
      });
      const wsUrl = new URL("ws://macbook.tail.ts.net/ws");

      expect(isWebSocketAuthorized(wsUrl, wsReq, { address: "127.0.0.1" }, {
        authToken: h.authToken,
        sessionSecret: h.sessionSecret,
        tailscaleHostname: h.state.tailscaleHostname,
        remoteUrl: h.state.remoteUrl,
      })).toBe(true);
    } finally {
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });
});
