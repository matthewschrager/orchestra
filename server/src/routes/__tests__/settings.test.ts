import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createSettingsRoutes } from "../settings";
import { WorktreeManager } from "../../worktrees/manager";
import { join } from "path";
import { homedir } from "os";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // WorktreeManager also needs threads table for some operations
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT, agent TEXT, repo_path TEXT,
    worktree TEXT, branch TEXT, pr_url TEXT, pid INTEGER,
    status TEXT DEFAULT 'pending', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

function createApp(db: Database) {
  const wm = new WorktreeManager(db as any);
  const app = new Hono();
  app.route("/settings", createSettingsRoutes(db as any, wm));
  return { app, wm };
}

describe("GET /settings", () => {
  test("returns defaults when no settings stored", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worktreeRoot).toBe(join(homedir(), "projects", "worktrees"));
  });

  test("returns stored settings", async () => {
    const db = createTestDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "worktreeRoot",
      "/custom/path",
    );
    const { app } = createApp(db);
    const res = await app.request("/settings");
    const body = await res.json();
    expect(body.worktreeRoot).toBe("/custom/path");
  });
});

describe("PATCH /settings", () => {
  test("updates worktreeRoot", async () => {
    const db = createTestDb();
    const { app, wm } = createApp(db);
    const { mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { resolve } = await import("path");
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-settings-test-"));

    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: tmp }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worktreeRoot).toBe(tmp);
    // Also updates WorktreeManager
    expect(wm.getWorktreeRoot()).toBe(tmp);

    rmSync(tmp, { recursive: true });
  });

  test("resolves ~ in worktreeRoot", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const { mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { resolve, relative } = await import("path");
    // Create a temp dir under home so ~ expansion points to a real path
    const tmp = mkdtempSync(resolve(homedir(), ".orchestra-test-tilde-"));
    const relPath = relative(homedir(), tmp);

    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: `~/${relPath}` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worktreeRoot).toBe(tmp);

    rmSync(tmp, { recursive: true });
  });

  test("rejects empty worktreeRoot", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: "  " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot be empty");
  });

  test("rejects relative path", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: "relative/path" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("absolute path");
  });

  test("rejects non-string worktreeRoot", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be a string");
  });

  test("rejects null worktreeRoot", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: null }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be a string");
  });

  test("creates directory if it does not exist", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const { mkdtempSync, existsSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { resolve } = await import("path");
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-settings-test-"));
    const newDir = resolve(tmp, "new-worktree-root");

    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: newDir }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(newDir)).toBe(true);

    rmSync(tmp, { recursive: true });
  });

  test("updates inactivityTimeoutMinutes", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inactivityTimeoutMinutes: 60 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inactivityTimeoutMinutes).toBe(60);
  });

  test("rejects inactivityTimeoutMinutes < 1", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inactivityTimeoutMinutes: 0 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("between 1 and 1440");
  });

  test("rejects inactivityTimeoutMinutes > 1440", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inactivityTimeoutMinutes: 1441 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("between 1 and 1440");
  });

  test("rejects non-numeric inactivityTimeoutMinutes", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inactivityTimeoutMinutes: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  test("does not apply timeout when worktreeRoot validation fails", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inactivityTimeoutMinutes: 60, worktreeRoot: "relative/bad" }),
    });
    expect(res.status).toBe(400);
    // Verify timeout was NOT persisted
    const get = await app.request("/settings");
    const body = await get.json();
    expect(body.inactivityTimeoutMinutes).toBe(30); // still default
  });

  test("GET returns default inactivityTimeoutMinutes", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const res = await app.request("/settings");
    const body = await res.json();
    expect(body.inactivityTimeoutMinutes).toBe(30);
  });

  test("persists across requests", async () => {
    const db = createTestDb();
    const { app } = createApp(db);
    const { mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { resolve } = await import("path");
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-settings-test-"));

    await app.request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeRoot: tmp }),
    });

    const res = await app.request("/settings");
    const body = await res.json();
    expect(body.worktreeRoot).toBe(tmp);

    rmSync(tmp, { recursive: true });
  });
});
