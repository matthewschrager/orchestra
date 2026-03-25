import { Hono } from "hono";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { DB } from "../db";
import { getAllSettings, getSetting, setSetting } from "../db";
import { DEFAULT_WORKTREE_ROOT, type WorktreeManager } from "../worktrees/manager";
import type { Settings } from "shared";

/** Resolve settings from DB with fallback defaults */
function resolveSettings(db: DB): Settings {
  const raw = getAllSettings(db);
  return {
    worktreeRoot: raw.worktreeRoot || DEFAULT_WORKTREE_ROOT,
  };
}

export function createSettingsRoutes(db: DB, worktreeManager: WorktreeManager) {
  const app = new Hono();

  // Get all settings
  app.get("/", (c) => {
    return c.json(resolveSettings(db));
  });

  // Update settings (partial patch)
  app.patch("/", async (c) => {
    const body = await c.req.json<Partial<Settings>>();

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

      setSetting(db, "worktreeRoot", resolved);
      worktreeManager.setWorktreeRoot(resolved);
    }

    return c.json(resolveSettings(db));
  });

  return app;
}

/** Read the worktree root from settings DB (for use by WorktreeManager) */
export function getWorktreeRoot(db: DB): string {
  return getSetting(db, "worktreeRoot") || DEFAULT_WORKTREE_ROOT;
}
