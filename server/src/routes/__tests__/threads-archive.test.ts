import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createThreadRoutes } from "../threads";
import type { SessionManager } from "../../sessions/manager";
import type { WorktreeManager } from "../../worktrees/manager";

// In-memory DB with threads table
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pid INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT, archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
    seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    tool_name TEXT, tool_input TEXT, tool_output TEXT, metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

function createMockSessionManager(): SessionManager {
  return {
    stopThread: () => {},
    notifyThread: () => {},
  } as unknown as SessionManager;
}

function createMockWorktreeManager(opts?: { shouldFail?: boolean }): WorktreeManager {
  return {
    cleanup: async () => {
      if (opts?.shouldFail) throw new Error("git worktree remove failed");
    },
  } as unknown as WorktreeManager;
}

function insertThread(db: Database, overrides: Partial<Record<string, string | null>> = {}) {
  const id = overrides.id ?? "thread-1";
  const title = overrides.title ?? "Test thread";
  const agent = overrides.agent ?? "claude";
  const repo_path = overrides.repo_path ?? "/tmp/repo";
  const status = overrides.status ?? "done";
  const worktree = overrides.worktree ?? null;
  const branch = overrides.branch ?? null;

  db.query(
    "INSERT INTO threads (id, title, agent, repo_path, status, worktree, branch) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, title, agent, repo_path, status, worktree, branch);
}

describe("DELETE /threads/:id (archive)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("archives a thread without worktree", async () => {
    insertThread(db);
    const app = new Hono();
    app.route("/threads", createThreadRoutes(db as any, createMockSessionManager(), createMockWorktreeManager()));

    const res = await app.request("/threads/thread-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleanupFailed: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleanupFailed).toBe(false);

    // Thread should be archived
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("thread-1") as { archived_at: string | null };
    expect(row.archived_at).toBeTruthy();
  });

  test("archives thread with worktree cleanup when cleanup_worktree=true", async () => {
    insertThread(db, { worktree: "/tmp/wt", branch: "orchestra/wt" });
    let cleanupCalled = false;
    const wtManager = {
      cleanup: async () => { cleanupCalled = true; },
    } as unknown as WorktreeManager;

    const app = new Hono();
    app.route("/threads", createThreadRoutes(db as any, createMockSessionManager(), wtManager));

    const res = await app.request("/threads/thread-1?cleanup_worktree=true", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleanupFailed: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleanupFailed).toBe(false);
    expect(cleanupCalled).toBe(true);
  });

  test("archives thread without cleanup when cleanup_worktree is not set", async () => {
    insertThread(db, { worktree: "/tmp/wt", branch: "orchestra/wt" });
    let cleanupCalled = false;
    const wtManager = {
      cleanup: async () => { cleanupCalled = true; },
    } as unknown as WorktreeManager;

    const app = new Hono();
    app.route("/threads", createThreadRoutes(db as any, createMockSessionManager(), wtManager));

    const res = await app.request("/threads/thread-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleanupFailed: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleanupFailed).toBe(false);
    expect(cleanupCalled).toBe(false);
  });

  test("returns cleanupFailed=true when worktree cleanup throws", async () => {
    insertThread(db, { worktree: "/tmp/wt", branch: "orchestra/wt" });
    const app = new Hono();
    app.route("/threads", createThreadRoutes(db as any, createMockSessionManager(), createMockWorktreeManager({ shouldFail: true })));

    const res = await app.request("/threads/thread-1?cleanup_worktree=true", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cleanupFailed: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleanupFailed).toBe(true);

    // Thread should still be archived despite cleanup failure
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("thread-1") as { archived_at: string | null };
    expect(row.archived_at).toBeTruthy();
  });

  test("returns 404 for nonexistent thread", async () => {
    const app = new Hono();
    app.route("/threads", createThreadRoutes(db as any, createMockSessionManager(), createMockWorktreeManager()));

    const res = await app.request("/threads/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
