import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createProjectRoutes } from "../projects";
import type { SessionManager } from "../../sessions/manager";
import type { WorktreeManager } from "../../worktrees/manager";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT REFERENCES projects(id),
    worktree TEXT, branch TEXT, pr_url TEXT, pid INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', session_id TEXT,
    archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

function insertProject(db: Database, id: string, path = "/tmp/repo") {
  db.query("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(
    id,
    "Test Project",
    path,
  );
}

function insertThread(
  db: Database,
  id: string,
  projectId: string,
  overrides: Partial<Record<string, string | null>> = {},
) {
  db.query(
    `INSERT INTO threads (id, title, agent, repo_path, project_id, status, worktree, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.title ?? "Test thread",
    overrides.agent ?? "claude",
    overrides.repo_path ?? "/tmp/repo",
    projectId,
    overrides.status ?? "done",
    overrides.worktree ?? null,
    overrides.branch ?? null,
  );
}

interface CleanupResult {
  cleaned: Array<{ id: string; title: string }>;
  skipped: Array<{ id: string; title: string; reason: string }>;
}

function createMockSessionManager(): SessionManager {
  return {
    stopThread: () => {},
    notifyThread: () => {},
  } as unknown as SessionManager;
}

function createMockWorktreeManager(opts?: {
  isPushed?: Record<string, boolean>;
  shouldFailCleanup?: boolean;
}): WorktreeManager {
  return {
    isPushedToRemote: async (threadId: string) => {
      const pushed = opts?.isPushed?.[threadId] ?? false;
      return pushed
        ? { pushed: true }
        : { pushed: false, reason: "not_on_remote" };
    },
    cleanup: async () => {
      if (opts?.shouldFailCleanup) throw new Error("cleanup failed");
    },
  } as unknown as WorktreeManager;
}

function createApp(
  db: Database,
  sessionManager?: SessionManager,
  worktreeManager?: WorktreeManager,
) {
  const app = new Hono();
  app.route(
    "/projects",
    createProjectRoutes(
      db as any,
      sessionManager,
      worktreeManager,
    ),
  );
  return app;
}

describe("POST /projects/:id/cleanup-pushed", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("returns 404 for nonexistent project", async () => {
    const app = createApp(db, createMockSessionManager(), createMockWorktreeManager());
    const res = await app.request("/projects/nonexistent/cleanup-pushed", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("returns 500 when managers not provided", async () => {
    insertProject(db, "proj-1");
    const app = createApp(db);
    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    expect(res.status).toBe(500);
  });

  test("cleans up pushed worktree threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-pushed", "proj-1", {
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({ isPushed: { "t-pushed": true } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CleanupResult;
    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-pushed");

    // Thread should be archived
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-pushed") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeTruthy();
  });

  test("skips active (running) threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-running", "proj-1", {
      status: "running",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({ isPushed: { "t-running": true } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toBe("still_active");

    // Thread should NOT be archived
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-running") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  test("skips threads without worktrees (not included in results)", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-no-wt", "proj-1", { status: "done" });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager(),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    // Non-worktree threads are silently skipped (not in cleaned OR skipped)
    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(0);
  });

  test("skips unpushed worktree threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-unpushed", "proj-1", {
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({ isPushed: { "t-unpushed": false } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].id).toBe("t-unpushed");
    expect(body.skipped[0].reason).toBe("not_on_remote");
  });

  test("handles mixed pushed/unpushed/active threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-pushed", "proj-1", {
      title: "Pushed",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/pushed",
    });
    insertThread(db, "t-unpushed", "proj-1", {
      title: "Unpushed",
      status: "done",
      worktree: "/tmp/wt-2",
      branch: "orchestra/unpushed",
    });
    insertThread(db, "t-running", "proj-1", {
      title: "Running",
      status: "running",
      worktree: "/tmp/wt-3",
      branch: "orchestra/running",
    });
    insertThread(db, "t-no-wt", "proj-1", {
      title: "No worktree",
      status: "done",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({ isPushed: { "t-pushed": true } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-pushed");

    // Skipped: t-running (active) + t-unpushed (not pushed)
    // t-no-wt is silently ignored (no worktree)
    expect(body.skipped).toHaveLength(2);
    const reasons = body.skipped.map((s) => s.reason);
    expect(reasons).toContain("still_active");
    expect(reasons).toContain("not_on_remote");
  });

  test("skips thread when cleanup throws but continues processing", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-fail", "proj-1", {
      title: "Cleanup fail",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/fail",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        isPushed: { "t-fail": true },
        shouldFailCleanup: true,
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toBe("cleanup_failed");

    // Thread should NOT be archived when cleanup fails
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-fail") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  test("calls stopThread and notifyThread for cleaned threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-1", "proj-1", {
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });

    const stopped: string[] = [];
    const notified: string[] = [];
    const sessionManager = {
      stopThread: (id: string) => stopped.push(id),
      notifyThread: (id: string) => notified.push(id),
    } as unknown as SessionManager;

    const app = createApp(
      db,
      sessionManager,
      createMockWorktreeManager({ isPushed: { "t-1": true } }),
    );

    await app.request("/projects/proj-1/cleanup-pushed", { method: "POST" });

    expect(stopped).toContain("t-1");
    expect(notified).toContain("t-1");
  });

  test("ignores threads from other projects", async () => {
    insertProject(db, "proj-1");
    insertProject(db, "proj-2", "/tmp/repo2");
    insertThread(db, "t-proj1", "proj-1", {
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/1",
    });
    insertThread(db, "t-proj2", "proj-2", {
      status: "done",
      worktree: "/tmp/wt-2",
      branch: "orchestra/2",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        isPushed: { "t-proj1": true, "t-proj2": true },
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-proj1");

    // proj-2's thread should be untouched
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-proj2") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  test("does not archive already-archived threads", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-archived", "proj-1", {
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });
    // Manually archive it
    db.query("UPDATE threads SET archived_at = datetime('now') WHERE id = ?").run("t-archived");

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({ isPushed: { "t-archived": true } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;
    // Already-archived threads are excluded by the WHERE clause
    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(0);
  });
});
