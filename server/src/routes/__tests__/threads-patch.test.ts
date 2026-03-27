import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createThreadRoutes } from "../threads";
import type { SessionManager } from "../../sessions/manager";
import type { WorktreeManager } from "../../worktrees/manager";
import type { TerminalManager } from "../../terminal/manager";

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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
    seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    tool_name TEXT, tool_input TEXT, tool_output TEXT, metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

function insertThread(db: Database, overrides: Partial<Record<string, string | null>> = {}) {
  const id = overrides.id ?? "thread-1";
  const title = overrides.title ?? "Test thread";
  db.query(
    "INSERT INTO threads (id, title, agent, repo_path, status) VALUES (?, ?, 'claude', '/tmp/repo', 'running')",
  ).run(id, title);
}

describe("PATCH /threads/:id (title update)", () => {
  let db: Database;
  let app: Hono;
  let notifiedThreadIds: string[];

  beforeEach(() => {
    db = createTestDb();
    notifiedThreadIds = [];

    const mockSessionManager = {
      stopThread: () => {},
      notifyThread: (id: string) => {
        notifiedThreadIds.push(id);
      },
    } as unknown as SessionManager;

    const mockWorktreeManager = {
      cleanup: async () => {},
    } as unknown as WorktreeManager;

    const mockTerminalManager = {
      closeForThread: () => {},
    } as unknown as TerminalManager;

    app = new Hono();
    app.route(
      "/threads",
      createThreadRoutes(db, mockSessionManager, mockWorktreeManager, mockTerminalManager),
    );
  });

  test("updates title and broadcasts via notifyThread", async () => {
    insertThread(db, { id: "t-1", title: "Old title" });

    const res = await app.request("/threads/t-1", {
      method: "PATCH",
      body: JSON.stringify({ title: "New title" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("New title");

    // Verify notifyThread was called for cross-client sync
    expect(notifiedThreadIds).toContain("t-1");
  });

  test("does not broadcast when no title provided", async () => {
    insertThread(db, { id: "t-2", title: "Keep this" });

    const res = await app.request("/threads/t-2", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Keep this");

    // No title change → no broadcast
    expect(notifiedThreadIds).not.toContain("t-2");
  });

  test("returns 404 for non-existent thread", async () => {
    const res = await app.request("/threads/nonexistent", {
      method: "PATCH",
      body: JSON.stringify({ title: "New title" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(404);
  });
});
