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
    remoteUrl: raw.remoteUrl || "",
    defaultModelClaude: raw.defaultModelClaude || "",
    defaultModelCodex: raw.defaultModelCodex || "",
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

    let validatedRemoteUrl: string | undefined;
    if (body.remoteUrl !== undefined) {
      if (typeof body.remoteUrl !== "string") {
        return c.json({ error: "remoteUrl must be a string" }, 400);
      }
      const trimmed = body.remoteUrl.trim();
      // Allow empty string (to clear the URL)
      if (trimmed && !trimmed.startsWith("https://")) {
        return c.json({ error: "remoteUrl must be an HTTPS URL" }, 400);
      }
      validatedRemoteUrl = trimmed;
    }

    // Validate default model settings (format only — model list is dynamic)
    const MODEL_RE = /^[a-zA-Z0-9.\-]*$/;
    let validatedDefaultModelClaude: string | undefined;
    if (body.defaultModelClaude !== undefined) {
      const val = String(body.defaultModelClaude).trim();
      if (val.length > 100 || !MODEL_RE.test(val)) {
        return c.json({ error: "defaultModelClaude must be a valid model ID (alphanumeric, dots, hyphens, max 100 chars)" }, 400);
      }
      validatedDefaultModelClaude = val;
    }

    let validatedDefaultModelCodex: string | undefined;
    if (body.defaultModelCodex !== undefined) {
      const val = String(body.defaultModelCodex).trim();
      if (val.length > 100 || !MODEL_RE.test(val)) {
        return c.json({ error: "defaultModelCodex must be a valid model ID (alphanumeric, dots, hyphens, max 100 chars)" }, 400);
      }
      validatedDefaultModelCodex = val;
    }

    // ── Phase 2: Apply (all validated) ────────────────────
    if (validatedTimeout !== undefined) {
      setSetting(db, "inactivityTimeoutMinutes", String(validatedTimeout));
    }
    if (resolvedWorktreeRoot !== undefined) {
      setSetting(db, "worktreeRoot", resolvedWorktreeRoot);
      worktreeManager.setWorktreeRoot(resolvedWorktreeRoot);
    }
    if (validatedRemoteUrl !== undefined) {
      setSetting(db, "remoteUrl", validatedRemoteUrl);
    }
    if (validatedDefaultModelClaude !== undefined) {
      setSetting(db, "defaultModelClaude", validatedDefaultModelClaude);
    }
    if (validatedDefaultModelCodex !== undefined) {
      setSetting(db, "defaultModelCodex", validatedDefaultModelCodex);
    }

    return c.json(resolveSettings(db));
  });

  return app;
}

/** Read the worktree root from settings DB (for use by WorktreeManager) */
export function getWorktreeRoot(db: DB): string {
  return getSetting(db, "worktreeRoot") || DEFAULT_WORKTREE_ROOT;
}
