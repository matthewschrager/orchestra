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
    effort_level TEXT, permission_mode TEXT, model TEXT,
    repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pr_status TEXT, pr_number INTEGER,
    pid INTEGER, status TEXT NOT NULL DEFAULT 'pending',
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
  const agent = overrides.agent ?? "claude";
  const status = overrides.status ?? "running";
  db.query(
    "INSERT INTO threads (id, title, agent, repo_path, status) VALUES (?, ?, ?, '/tmp/repo', ?)",
  ).run(id, title, agent, status);
}

function createMockSessionManager(testDb?: Database, opts?: {
  changeModelError?: string;
  changePermissionModeError?: string;
  changeEffortLevelError?: string;
}): SessionManager & { notifiedThreadIds: string[] } {
  const notifiedThreadIds: string[] = [];
  return {
    notifiedThreadIds,
    stopThread: () => {},
    notifyThread: (id: string) => { notifiedThreadIds.push(id); },
    changeModel: async (threadId: string, model: string | null) => {
      if (opts?.changeModelError) throw new Error(opts.changeModelError);
      if (testDb) testDb.query("UPDATE threads SET model = ?, updated_at = datetime('now') WHERE id = ?").run(model, threadId);
    },
    changePermissionMode: async (threadId: string, mode: string | null) => {
      if (opts?.changePermissionModeError) throw new Error(opts.changePermissionModeError);
      if (testDb) testDb.query("UPDATE threads SET permission_mode = ?, updated_at = datetime('now') WHERE id = ?").run(mode, threadId);
      notifiedThreadIds.push(threadId);
    },
    changeEffortLevel: async (threadId: string, effort: string | null) => {
      if (opts?.changeEffortLevelError) throw new Error(opts.changeEffortLevelError);
      if (testDb) testDb.query("UPDATE threads SET effort_level = ?, updated_at = datetime('now') WHERE id = ?").run(effort, threadId);
      notifiedThreadIds.push(threadId);
    },
  } as unknown as SessionManager & { notifiedThreadIds: string[] };
}

describe("PATCH /threads/:id (title update)", () => {
  let db: Database;
  let app: Hono;
  let mockSessionManager: SessionManager & { notifiedThreadIds: string[] };

  beforeEach(() => {
    db = createTestDb();
    mockSessionManager = createMockSessionManager(db);

    const mockWorktreeManager = {
      cleanup: async () => {},
    } as unknown as WorktreeManager;

    const mockTerminalManager = {
      closeForThread: () => {},
    } as unknown as TerminalManager;

    app = new Hono();
    app.route(
      "/threads",
      createThreadRoutes(db, mockSessionManager as unknown as SessionManager, mockWorktreeManager, mockTerminalManager),
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
    expect(mockSessionManager.notifiedThreadIds).toContain("t-1");
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
    expect(mockSessionManager.notifiedThreadIds).not.toContain("t-2");
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

describe("PATCH /threads/:id (permissionMode)", () => {
  let db: Database;

  function makeApp(sessionManager?: SessionManager) {
    const sm = sessionManager ?? createMockSessionManager(db) as unknown as SessionManager;
    const app = new Hono();
    app.route("/threads", createThreadRoutes(
      db,
      sm,
      { cleanup: async () => {} } as unknown as WorktreeManager,
      { closeForThread: () => {} } as unknown as TerminalManager,
    ));
    return app;
  }

  beforeEach(() => {
    db = createTestDb();
  });

  test("updates permission mode for Claude thread", async () => {
    insertThread(db, { id: "t-1", agent: "claude" });
    const app = makeApp();

    const res = await app.request("/threads/t-1", {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: "plan" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionMode).toBe("plan");
  });

  test("rejects unsupported permission mode for Codex", async () => {
    insertThread(db, { id: "t-2", agent: "codex" });
    const app = makeApp();

    const res = await app.request("/threads/t-2", {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: "plan" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });

  test("clears permission mode with null", async () => {
    insertThread(db, { id: "t-3", agent: "claude" });
    // Set permission mode first
    db.query("UPDATE threads SET permission_mode = 'plan' WHERE id = 't-3'").run();

    const app = makeApp();

    const res = await app.request("/threads/t-3", {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: null }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionMode).toBeNull();
  });
});

describe("PATCH /threads/:id (effortLevel)", () => {
  let db: Database;

  function makeApp(sessionManager?: SessionManager) {
    const sm = sessionManager ?? createMockSessionManager(db) as unknown as SessionManager;
    const app = new Hono();
    app.route("/threads", createThreadRoutes(
      db,
      sm,
      { cleanup: async () => {} } as unknown as WorktreeManager,
      { closeForThread: () => {} } as unknown as TerminalManager,
    ));
    return app;
  }

  beforeEach(() => {
    db = createTestDb();
  });

  test("updates effort level for Claude thread", async () => {
    insertThread(db, { id: "t-1", agent: "claude" });
    const app = makeApp();

    const res = await app.request("/threads/t-1", {
      method: "PATCH",
      body: JSON.stringify({ effortLevel: "high" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effortLevel).toBe("high");
  });

  test("rejects unsupported effort level for Claude", async () => {
    insertThread(db, { id: "t-2", agent: "claude" });
    const app = makeApp();

    const res = await app.request("/threads/t-2", {
      method: "PATCH",
      body: JSON.stringify({ effortLevel: "xhigh" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not supported");
  });

  test("allows Codex-specific effort levels", async () => {
    insertThread(db, { id: "t-3", agent: "codex" });
    const app = makeApp();

    const res = await app.request("/threads/t-3", {
      method: "PATCH",
      body: JSON.stringify({ effortLevel: "xhigh" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effortLevel).toBe("xhigh");
  });

  test("clears effort level with null", async () => {
    insertThread(db, { id: "t-4", agent: "claude" });
    db.query("UPDATE threads SET effort_level = 'high' WHERE id = 't-4'").run();

    const app = makeApp();

    const res = await app.request("/threads/t-4", {
      method: "PATCH",
      body: JSON.stringify({ effortLevel: null }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effortLevel).toBeNull();
  });
});

describe("PATCH /threads/:id (validation-first)", () => {
  let db: Database;

  function makeApp() {
    const sm = createMockSessionManager() as unknown as SessionManager;
    const app = new Hono();
    app.route("/threads", createThreadRoutes(
      db,
      sm,
      { cleanup: async () => {} } as unknown as WorktreeManager,
      { closeForThread: () => {} } as unknown as TerminalManager,
    ));
    return app;
  }

  beforeEach(() => {
    db = createTestDb();
  });

  test("rejects bad model format before applying other changes", async () => {
    insertThread(db, { id: "t-1", agent: "claude" });
    const app = makeApp();

    const res = await app.request("/threads/t-1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Should not apply", model: "invalid model with spaces!!" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);

    // Title should NOT have been updated (validation-first)
    const row = db.query("SELECT title FROM threads WHERE id = 't-1'").get() as { title: string };
    expect(row.title).toBe("Test thread");
  });

  test("rejects invalid permission mode before applying effort change", async () => {
    insertThread(db, { id: "t-2", agent: "codex" });
    const app = makeApp();

    const res = await app.request("/threads/t-2", {
      method: "PATCH",
      body: JSON.stringify({ effortLevel: "low", permissionMode: "plan" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);

    // Effort should NOT have been updated (validation-first)
    const row = db.query("SELECT effort_level FROM threads WHERE id = 't-2'").get() as { effort_level: string | null };
    expect(row.effort_level).toBeNull();
  });
});
