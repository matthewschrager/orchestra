import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createProjectRoutes } from "../projects";
import type { SessionManager } from "../../sessions/manager";
import type { WorktreeManager } from "../../worktrees/manager";
import type { PrLookupResult } from "../../worktrees/pr-status";

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
    worktree TEXT, branch TEXT, pr_url TEXT, pr_status TEXT,
    pr_number INTEGER, pr_status_checked_at TEXT, pid INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', session_id TEXT,
    archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
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

interface ThreadOverrides {
  title?: string;
  agent?: string;
  repo_path?: string;
  status?: string;
  worktree?: string | null;
  branch?: string | null;
  pr_url?: string | null;
  pr_status?: string | null;
  pr_number?: number | null;
  pr_status_checked_at?: string | null;
}

function insertThread(
  db: Database,
  id: string,
  projectId: string,
  overrides: ThreadOverrides = {},
) {
  db.query(
    `INSERT INTO threads (
      id, title, agent, repo_path, project_id, status, worktree, branch,
      pr_url, pr_status, pr_number, pr_status_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.title ?? "Test thread",
    overrides.agent ?? "claude",
    overrides.repo_path ?? "/tmp/repo",
    projectId,
    overrides.status ?? "done",
    overrides.worktree ?? null,
    overrides.branch ?? null,
    overrides.pr_url ?? null,
    overrides.pr_status ?? null,
    overrides.pr_number ?? null,
    overrides.pr_status_checked_at ?? null,
  );
}

interface CleanupResult {
  cleaned: Array<{ id: string; title: string }>;
  skipped: Array<{ id: string; title: string; reason: string }>;
  needsConfirmation: Array<{
    id: string;
    title: string;
    reason: string;
    defaultSelected: boolean;
  }>;
}

interface MockCleanupStatus {
  pushed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

function createMockSessionManager(): SessionManager {
  return {
    stopThread: () => {},
    notifyThread: () => {},
  } as unknown as SessionManager;
}

function createMockWorktreeManager(opts?: {
  isPushed?: Record<string, boolean>;
  statuses?: Record<string, MockCleanupStatus>;
  shouldFailCleanup?: boolean;
}): WorktreeManager {
  return {
    isPushedToRemote: async (threadId: string) => {
      if (opts?.statuses?.[threadId]) {
        return opts.statuses[threadId];
      }
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
  deps: Parameters<typeof createProjectRoutes>[4] = {},
) {
  const app = new Hono();
  app.route(
    "/projects",
    createProjectRoutes(
      db as any,
      sessionManager,
      worktreeManager,
      undefined,
      deps,
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
    expect(body.needsConfirmation).toHaveLength(0);

    // Thread should be archived
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-pushed") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeTruthy();
  });

  test("dryRun returns what would be cleaned without side effects", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-pushed", "proj-1", {
      title: "Will be cleaned",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/test",
    });
    insertThread(db, "t-unpushed", "proj-1", {
      title: "Not pushed",
      status: "done",
      worktree: "/tmp/wt-2",
      branch: "orchestra/unpushed",
    });

    const stopped: string[] = [];
    const sessionManager = {
      stopThread: (id: string) => stopped.push(id),
      notifyThread: () => {},
    } as unknown as SessionManager;

    const app = createApp(
      db,
      sessionManager,
      createMockWorktreeManager({ isPushed: { "t-pushed": true } }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CleanupResult;

    // Should report what would be cleaned
    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-pushed");
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].id).toBe("t-unpushed");

    // But NOT actually archive or stop anything
    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-pushed") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
    expect(stopped).toHaveLength(0);
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
    expect(body.needsConfirmation).toHaveLength(0);

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
    expect(body.needsConfirmation).toHaveLength(0);
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
    expect(body.needsConfirmation).toHaveLength(0);
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
    expect(body.needsConfirmation).toHaveLength(0);
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
    expect(body.needsConfirmation).toHaveLength(0);

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
    expect(body.needsConfirmation).toHaveLength(0);
  });

  test("returns merged-but-unclean threads for confirmation without archiving them", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-merged", "proj-1", {
      title: "Merged, deleted branch",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/merged",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-merged": {
            pushed: true,
            reason: "remote_branch_deleted",
            requiresConfirmation: true,
          },
        },
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(0);
    expect(body.needsConfirmation).toHaveLength(1);
    expect(body.needsConfirmation[0]).toEqual({
      id: "t-merged",
      title: "Merged, deleted branch",
      reason: "remote_branch_deleted",
      defaultSelected: true,
    });

    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-merged") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
  });

  test("confirmed merged-but-unclean threads are cleaned up on a second request", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-confirm", "proj-1", {
      title: "Needs confirm",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/confirm",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-confirm": {
            pushed: true,
            reason: "remote_branch_deleted",
            requiresConfirmation: true,
          },
        },
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
      body: JSON.stringify({ confirmedThreadIds: ["t-confirm"] }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-confirm");
    expect(body.skipped).toHaveLength(0);
    expect(body.needsConfirmation).toHaveLength(0);

    const row = db.query("SELECT archived_at FROM threads WHERE id = ?").get("t-confirm") as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeTruthy();
  });

  test("post-merge commits require confirmation and default to unchecked", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-post-merge", "proj-1", {
      title: "Post merge commits",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/post-merge",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-post-merge": {
            pushed: false,
            reason: "post_merge_commits",
            requiresConfirmation: true,
          },
        },
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(0);
    expect(body.skipped).toHaveLength(0);
    expect(body.needsConfirmation).toEqual([{
      id: "t-post-merge",
      title: "Post merge commits",
      reason: "post_merge_commits",
      defaultSelected: false,
    }]);
  });

  test("confirmed post-merge commits are cleaned only after explicit confirmation", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-post-merge-confirm", "proj-1", {
      title: "Force delete post merge",
      status: "done",
      worktree: "/tmp/wt-1",
      branch: "orchestra/post-merge-confirm",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-post-merge-confirm": {
            pushed: false,
            reason: "post_merge_commits",
            requiresConfirmation: true,
          },
        },
      }),
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
      body: JSON.stringify({ confirmedThreadIds: ["t-post-merge-confirm"] }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(1);
    expect(body.cleaned[0].id).toBe("t-post-merge-confirm");
    expect(body.skipped).toHaveLength(0);
    expect(body.needsConfirmation).toHaveLength(0);
  });

  test("refreshes recent open PR status during cleanup so newly merged threads are eligible", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-refresh-merged", "proj-1", {
      title: "Freshly merged",
      status: "done",
      repo_path: "/tmp/repo",
      worktree: "/tmp/wt-1",
      branch: "orchestra/freshly-merged",
      pr_url: "https://github.com/octo/repo/pull/123",
      pr_status: "open",
      pr_status_checked_at: new Date().toISOString(),
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-refresh-merged": {
            pushed: true,
            reason: "remote_branch_deleted",
            requiresConfirmation: true,
          },
        },
      }),
      {
        prByUrlResolver: async (): Promise<PrLookupResult> => ({
          kind: "found",
          pr: {
            url: "https://github.com/octo/repo/pull/123",
            number: 123,
            status: "merged",
            headRefName: "orchestra/freshly-merged",
            headRefOid: "abc123",
          },
        }),
      },
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(0);
    expect(body.needsConfirmation).toEqual([{
      id: "t-refresh-merged",
      title: "Freshly merged",
      reason: "remote_branch_deleted",
      defaultSelected: true,
    }]);

    const row = db.query(
      "SELECT pr_status, pr_number, pr_status_checked_at FROM threads WHERE id = ?",
    ).get("t-refresh-merged") as {
      pr_status: string | null;
      pr_number: number | null;
      pr_status_checked_at: string | null;
    };
    expect(row.pr_status).toBe("merged");
    expect(row.pr_number).toBe(123);
    expect(row.pr_status_checked_at).toBeTruthy();
  });

  test("does not preselect remote-branch-deleted cleanup when merged head verification fails", async () => {
    insertProject(db, "proj-1");
    insertThread(db, "t-unverified-merged", "proj-1", {
      title: "Unverified merged head",
      status: "done",
      repo_path: "/tmp/repo",
      worktree: "/tmp/wt-1",
      branch: "orchestra/unverified-merged",
      pr_url: "https://github.com/octo/repo/pull/456",
      pr_status: "merged",
    });

    const app = createApp(
      db,
      createMockSessionManager(),
      createMockWorktreeManager({
        statuses: {
          "t-unverified-merged": {
            pushed: true,
            reason: "remote_branch_deleted",
            requiresConfirmation: true,
          },
        },
      }),
      {
        prByUrlResolver: async (): Promise<PrLookupResult> => ({
          kind: "not_found",
          message: "no pull requests found",
        }),
        prByBranchResolver: async (): Promise<PrLookupResult> => ({
          kind: "not_found",
          message: "no pull requests found",
        }),
      },
    );

    const res = await app.request("/projects/proj-1/cleanup-pushed", {
      method: "POST",
    });
    const body = (await res.json()) as CleanupResult;

    expect(body.cleaned).toHaveLength(0);
    expect(body.needsConfirmation).toEqual([{
      id: "t-unverified-merged",
      title: "Unverified merged head",
      reason: "remote_branch_deleted",
      defaultSelected: false,
    }]);
  });
});
