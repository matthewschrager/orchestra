import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDiagnosticsRoutes } from "../diagnostics";
import type { LspDiagnosticsResponse } from "shared";

function createApp() {
  const app = new Hono();
  app.route("/diagnostics", createDiagnosticsRoutes());
  return app;
}

/**
 * The diagnostics route is a thin pass-through to `runAndCacheLspDoctor` /
 * `getCachedLspDiagnostics`, which read from `~/.claude`. The doctor's pure
 * logic is covered by `server/src/lsp/__tests__/doctor.test.ts`. These tests
 * verify the route's shape and content-type contract — not the doctor's
 * behavior.
 */
describe("GET /diagnostics/lsp", () => {
  test("returns JSON with diagnostics array and ISO checkedAt", async () => {
    const app = createApp();
    const res = await app.request("/diagnostics/lsp");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as LspDiagnosticsResponse;
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect(typeof body.checkedAt).toBe("string");
    // ISO-8601 timestamp
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("each diagnostic entry has required fields with correct types", async () => {
    const app = createApp();
    const res = await app.request("/diagnostics/lsp");
    const body = (await res.json()) as LspDiagnosticsResponse;

    for (const d of body.diagnostics) {
      expect(typeof d.pluginId).toBe("string");
      expect(typeof d.pluginName).toBe("string");
      expect(typeof d.marketplace).toBe("string");
      expect(typeof d.serverName).toBe("string");
      expect(typeof d.command).toBe("string");
      expect(["ok", "missing", "manifest-missing"]).toContain(d.status);
      expect(typeof d.resolved).toBe("boolean");
      expect(d.installHint === null || typeof d.installHint === "string").toBe(true);
      expect(d.reason === null || typeof d.reason === "string").toBe(true);
      // Defense against adversarial review #19: the absolute path must never
      // appear in the API response.
      expect(d).not.toHaveProperty("resolvedPath");
    }
  });

  test("?refresh=1 triggers a re-run and bumps checkedAt", async () => {
    const app = createApp();
    const first = (await (await app.request("/diagnostics/lsp")).json()) as LspDiagnosticsResponse;
    // Yield so Date.now() can advance at least 1ms.
    await new Promise((r) => setTimeout(r, 2));
    const second = (await (await app.request("/diagnostics/lsp?refresh=1")).json()) as LspDiagnosticsResponse;

    expect(new Date(second.checkedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.checkedAt).getTime(),
    );
    // Same set of plugin IDs either way — doctor is deterministic against the
    // same disk state within a single test run.
    const firstIds = first.diagnostics.map((d) => d.pluginId).sort();
    const secondIds = second.diagnostics.map((d) => d.pluginId).sort();
    expect(secondIds).toEqual(firstIds);
  });
});
