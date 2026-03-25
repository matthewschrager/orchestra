import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { DB } from "../db";
import { getAllSettings, getSetting, setSetting } from "../db";
import { DEFAULT_WORKTREE_ROOT, type WorktreeManager } from "../worktrees/manager";
import type { Settings } from "shared";

const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

/** Resolve settings from DB with fallback defaults */
function resolveSettings(db: DB): Settings {
  const raw = getAllSettings(db);
  const timeoutRaw = raw.inactivityTimeoutMinutes;
  const timeoutParsed = timeoutRaw ? Number(timeoutRaw) : NaN;
  return {
    worktreeRoot: raw.worktreeRoot || DEFAULT_WORKTREE_ROOT,
    inactivityTimeoutMinutes: Number.isFinite(timeoutParsed) && timeoutParsed > 0
      ? timeoutParsed
      : DEFAULT_INACTIVITY_TIMEOUT_MINUTES,
  };
}

export function createSettingsRoutes(db: DB, worktreeManager: WorktreeManager) {
  const app = new Hono();

  // Get all settings
  app.get("/", (c) => {
    return c.json(resolveSettings(db));
  });

  // Update settings (partial patch)
  // Validate ALL inputs before writing ANY to avoid partial-apply on error.
  app.patch("/", async (c) => {
    const body = await c.req.json<Partial<Settings>>();

    // ── Phase 1: Validate (no writes) ─────────────────────
    let validatedTimeout: number | undefined;
    if (body.inactivityTimeoutMinutes !== undefined) {
      const val = Number(body.inactivityTimeoutMinutes);
      if (!Number.isFinite(val) || val < 1 || val > 1440) {
        return c.json({ error: "inactivityTimeoutMinutes must be a number between 1 and 1440" }, 400);
      }
      validatedTimeout = val;
    }

    let resolvedWorktreeRoot: string | undefined;
    if (body.worktreeRoot !== undefined) {
      if (typeof body.worktreeRoot !== "string") {
        return c.json({ error: "worktreeRoot must be a string" }, 400);
      }
      const trimmed = body.worktreeRoot.trim();
      if (!trimmed) {
        return c.json({ error: "worktreeRoot cannot be empty" }, 400);
      }
      // Resolve ~ to home directory
      const resolved = trimmed.startsWith("~")
        ? join(process.env.HOME || "~", trimmed.slice(1))
        : trimmed;

      if (!resolved.startsWith("/")) {
        return c.json({ error: "worktreeRoot must be an absolute path" }, 400);
      }

      // Ensure the directory exists or can be created
      try {
        if (!existsSync(resolved)) {
          mkdirSync(resolved, { recursive: true });
        }
      } catch {
        return c.json({ error: `Cannot create directory: ${resolved}` }, 400);
      }

      resolvedWorktreeRoot = resolved;
    }

    // ── Phase 2: Apply (all validated) ────────────────────
    if (validatedTimeout !== undefined) {
      setSetting(db, "inactivityTimeoutMinutes", String(validatedTimeout));
    }
    if (resolvedWorktreeRoot !== undefined) {
      setSetting(db, "worktreeRoot", resolvedWorktreeRoot);
      worktreeManager.setWorktreeRoot(resolvedWorktreeRoot);
    }

    return c.json(resolveSettings(db));
  });

  return app;
}

/** Read the worktree root from settings DB (for use by WorktreeManager) */
export function getWorktreeRoot(db: DB): string {
  return getSetting(db, "worktreeRoot") || DEFAULT_WORKTREE_ROOT;
}
