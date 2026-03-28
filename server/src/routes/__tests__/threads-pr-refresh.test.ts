import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createThreadRoutes } from "../threads";
import type { SessionManager } from "../../sessions/manager";
import type { WorktreeManager } from "../../worktrees/manager";
import type { PrLookupInfo, PrLookupResult } from "../../worktrees/pr-status";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    effort_level TEXT, repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pr_status TEXT, pr_number INTEGER, pr_status_checked_at TEXT,
    pid INTEGER, status TEXT NOT NULL DEFAULT 'pending', session_id TEXT,
    archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

function insertThread(
  db: Database,
  id: string,
  overrides: Partial<Record<string, string | number | null>> = {},
) {
  db.query(
    `INSERT INTO threads (
      id, title, agent, effort_level, repo_path, project_id, worktree, branch,
      pr_url, pr_status, pr_number, pr_status_checked_at, pid, status, session_id,
      archived_at, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.title ?? "Test thread",
    overrides.agent ?? "claude",
    overrides.effort_level ?? null,
    overrides.repo_path ?? "/tmp/repo",
    overrides.project_id ?? "proj-1",
    overrides.worktree ?? null,
    overrides.branch ?? null,
    overrides.pr_url ?? null,
    overrides.pr_status ?? null,
    overrides.pr_number ?? null,
    overrides.pr_status_checked_at ?? null,
    overrides.pid ?? null,
    overrides.status ?? "done",
    overrides.session_id ?? null,
    overrides.archived_at ?? null,
    overrides.error_message ?? null,
  );
}

function createPr(branch: string, number: number, status: "draft" | "open" = "open"): PrLookupInfo {
  return {
    url: `https://github.com/acme/orchestra/pull/${number}`,
    number,
    status,
    headRefName: branch,
    headRefOid: `oid-${number}`,
  };
}

describe("thread PR discovery routes", () => {
  let db: Database;
  let notifiedThreadIds: string[];

  beforeEach(() => {
    db = createTestDb();
    notifiedThreadIds = [];
  });

  function createApp(
    deps: Parameters<typeof createThreadRoutes>[4] = {},
    worktreeOverrides: Partial<WorktreeManager> = {},
  ) {
    const app = new Hono();
    const sessionManager = {
      stopThread: () => {},
      notifyThread: (threadId: string) => {
        notifiedThreadIds.push(threadId);
      },
    } as unknown as SessionManager;
    const worktreeManager = {
      cleanup: async () => {},
      createPR: async () => {
        throw new Error("not implemented");
      },
      ...worktreeOverrides,
    } as unknown as WorktreeManager;

    app.route(
      "/threads",
      createThreadRoutes(db as any, sessionManager, worktreeManager, undefined, deps),
    );
    return app;
  }

  test("GET /threads enriches branch-backed PR metadata with one lookup per repo", async () => {
    insertThread(db, "t-1", {
      repo_path: "/tmp/repo-a",
      branch: "orchestra/feature-one",
    });
    insertThread(db, "t-2", {
      repo_path: "/tmp/repo-a",
      branch: "orchestra/no-pr",
    });
    insertThread(db, "t-3", {
      repo_path: "/tmp/repo-b",
      branch: "orchestra/feature-two",
    });

    const calls: string[] = [];
    const app = createApp({
      openPrLister: async (repoPath) => {
        calls.push(repoPath);
        if (repoPath === "/tmp/repo-a") {
          return new Map([["orchestra/feature-one", createPr("orchestra/feature-one", 41)]]);
        }
        if (repoPath === "/tmp/repo-b") {
          return new Map([["orchestra/feature-two", createPr("orchestra/feature-two", 42, "draft")]]);
        }
        return new Map();
      },
      prByUrlResolver: async (): Promise<PrLookupResult> => ({
        kind: "error",
        message: "not used",
      }),
    });

    const res = await app.request("/threads");
    expect(res.status).toBe(200);

    const body = await res.json() as Array<{
      id: string;
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    }>;
    expect(calls).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);
    expect(body.find((thread) => thread.id === "t-1")).toMatchObject({
      prUrl: "https://github.com/acme/orchestra/pull/41",
      prStatus: "open",
      prNumber: 41,
    });
    expect(body.find((thread) => thread.id === "t-2")).toMatchObject({
      prUrl: null,
      prStatus: null,
      prNumber: null,
    });
    expect(body.find((thread) => thread.id === "t-3")).toMatchObject({
      prUrl: "https://github.com/acme/orchestra/pull/42",
      prStatus: "draft",
      prNumber: 42,
    });
    expect(notifiedThreadIds.sort()).toEqual(["t-1", "t-3"]);
  });

  test("POST /threads/:id/refresh-pr resolves a branch-only PR", async () => {
    insertThread(db, "t-branch-only", {
      branch: "orchestra/feature-pr",
      pr_url: null,
      pr_status: null,
      pr_number: null,
    });

    const app = createApp({
      prByBranchResolver: async (): Promise<PrLookupResult> => ({
        kind: "found",
        pr: createPr("orchestra/feature-pr", 77),
      }),
      prByUrlResolver: async (): Promise<PrLookupResult> => ({
        kind: "error",
        message: "not used",
      }),
    });

    const res = await app.request("/threads/t-branch-only/refresh-pr", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    };
    expect(body.prUrl).toBe("https://github.com/acme/orchestra/pull/77");
    expect(body.prStatus).toBe("open");
    expect(body.prNumber).toBe(77);
    expect(notifiedThreadIds).toContain("t-branch-only");
  });

  test("POST /threads/:id/pr returns the updated thread and notifies listeners", async () => {
    insertThread(db, "t-create-pr", {
      branch: "orchestra/create-pr",
      worktree: "/tmp/wt-create-pr",
      pr_url: null,
      pr_status: null,
      pr_number: null,
    });

    const app = createApp({}, {
      createPR: async (threadId: string) => {
        db.query(
          "UPDATE threads SET pr_url = ?, pr_status = ?, pr_number = ?, pr_status_checked_at = datetime('now') WHERE id = ?",
        ).run(
          "https://github.com/acme/orchestra/pull/99",
          "open",
          99,
          threadId,
        );
        return "https://github.com/acme/orchestra/pull/99";
      },
    });

    const res = await app.request("/threads/t-create-pr/pr", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      id: string;
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    };
    expect(body).toMatchObject({
      id: "t-create-pr",
      prUrl: "https://github.com/acme/orchestra/pull/99",
      prStatus: "open",
      prNumber: 99,
    });
    expect(notifiedThreadIds).toContain("t-create-pr");
  });

  test("POST /threads/:id/refresh-pr clears stale cached PR metadata when no PR exists", async () => {
    insertThread(db, "t-stale-pr", {
      branch: "orchestra/stale-pr",
      pr_url: "https://github.com/acme/orchestra/pull/88",
      pr_status: "open",
      pr_number: 88,
    });

    const app = createApp({
      prByUrlResolver: async (): Promise<PrLookupResult> => ({
        kind: "not_found",
        message: "no pull requests found",
      }),
      prByBranchResolver: async (): Promise<PrLookupResult> => ({
        kind: "not_found",
        message: "no pull requests found",
      }),
    });

    const res = await app.request("/threads/t-stale-pr/refresh-pr", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    };
    expect(body.prUrl).toBeNull();
    expect(body.prStatus).toBeNull();
    expect(body.prNumber).toBeNull();
    expect(notifiedThreadIds).toContain("t-stale-pr");
  });

  test("POST /threads/:id/refresh-pr prefers the live branch PR over a stale cached URL", async () => {
    insertThread(db, "t-branch-truth", {
      branch: "orchestra/current-pr",
      pr_url: "https://github.com/acme/orchestra/pull/11",
      pr_status: "closed",
      pr_number: 11,
    });

    const app = createApp({
      prByBranchResolver: async (): Promise<PrLookupResult> => ({
        kind: "found",
        pr: createPr("orchestra/current-pr", 22),
      }),
      prByUrlResolver: async (): Promise<PrLookupResult> => ({
        kind: "found",
        pr: {
          url: "https://github.com/acme/orchestra/pull/11",
          number: 11,
          status: "closed",
          headRefName: "orchestra/old-pr",
          headRefOid: "old-oid",
        },
      }),
    });

    const res = await app.request("/threads/t-branch-truth/refresh-pr", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    };
    expect(body.prUrl).toBe("https://github.com/acme/orchestra/pull/22");
    expect(body.prStatus).toBe("open");
    expect(body.prNumber).toBe(22);
  });

  test("POST /threads/:id/refresh-pr keeps cached metadata when branch lookup errors", async () => {
    insertThread(db, "t-branch-error", {
      branch: "orchestra/error-pr",
      pr_url: "https://github.com/acme/orchestra/pull/33",
      pr_status: "open",
      pr_number: 33,
    });

    const app = createApp({
      prByBranchResolver: async (): Promise<PrLookupResult> => ({
        kind: "error",
        message: "gh failed",
      }),
      prByUrlResolver: async (): Promise<PrLookupResult> => ({
        kind: "not_found",
        message: "no pull requests found",
      }),
    });

    const res = await app.request("/threads/t-branch-error/refresh-pr", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      prUrl: string | null;
      prStatus: string | null;
      prNumber: number | null;
    };
    expect(body.prUrl).toBe("https://github.com/acme/orchestra/pull/33");
    expect(body.prStatus).toBe("open");
    expect(body.prNumber).toBe(33);
  });

  test("GET /threads resolves recently merged PRs immediately when they drop out of the open list", async () => {
    insertThread(db, "t-recently-merged", {
      repo_path: "/tmp/repo-merged",
      branch: "orchestra/recently-merged",
      pr_url: "https://github.com/acme/orchestra/pull/55",
      pr_status: "open",
      pr_number: 55,
      pr_status_checked_at: new Date().toISOString(),
    });

    const app = createApp({
      openPrLister: async () => new Map(),
      prByBranchResolver: async (): Promise<PrLookupResult> => ({
        kind: "found",
        pr: {
          url: "https://github.com/acme/orchestra/pull/55",
          number: 55,
          status: "merged",
          headRefName: "orchestra/recently-merged",
          headRefOid: "merged-oid",
        },
      }),
    });

    const res = await app.request("/threads");
    expect(res.status).toBe(200);

    const body = await res.json() as Array<{
      id: string;
      prStatus: string | null;
      prNumber: number | null;
    }>;
    expect(body.find((thread) => thread.id === "t-recently-merged")).toMatchObject({
      prStatus: "merged",
      prNumber: 55,
    });
    expect(notifiedThreadIds).toContain("t-recently-merged");
  });
});
