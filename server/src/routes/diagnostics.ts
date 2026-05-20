import { Hono } from "hono";
import type { LspDiagnosticsResponse } from "shared";
import { getCachedLspDiagnostics, runAndCacheLspDoctor } from "../lsp/doctor";

/**
 * Diagnostics endpoints for server-level health signals that aren't tied to a
 * specific thread. Currently just LSP-plugin PATH checks; more probes (missing
 * CLI binaries, cache integrity, etc.) can be added here.
 */
export function createDiagnosticsRoutes() {
  const app = new Hono();

  app.get("/lsp", (c) => {
    const refresh = c.req.query("refresh") === "1";
    const { diagnostics, checkedAt } = refresh
      ? runAndCacheLspDoctor()
      : getCachedLspDiagnostics();

    // If the cache is empty (e.g. server just started and async boot hasn't
    // completed), compute on demand so the client always sees fresh data.
    if (!checkedAt) {
      const fresh = runAndCacheLspDoctor();
      const body: LspDiagnosticsResponse = {
        diagnostics: fresh.diagnostics,
        checkedAt: fresh.checkedAt,
      };
      return c.json(body);
    }

    const body: LspDiagnosticsResponse = { diagnostics, checkedAt };
    return c.json(body);
  });

  return app;
}
