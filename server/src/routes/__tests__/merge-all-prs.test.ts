import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { createProjectRoutes } from "../projects";
import type { SessionManager } from "../../sessions/manager";

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
    worktree TEXT, branch TEXT, pr_url TEXT, pr_status TEXT, pr_number INTEGER,
    pid INTEGER, status TEXT NOT NULL DEFAULT 'pending', session_id TEXT,
    archived_at TEXT, error_message TEXT, pr_status_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

function insertProject(db: Database, id: string, path: string, name = "Test Project") {
  db.query("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(id, name, path);
}

function insertThread(
  db: Database,
  id: string,
  projectId: string,
  repoPath: string,
  overrides: Partial<Record<string, string | number | null>> = {},
) {
  db.query(
    `INSERT INTO threads (
      id, title, agent, repo_path, project_id, worktree, branch,
      pr_url, pr_status, pr_number, status, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.title ?? "Test thread",
    overrides.agent ?? "claude",
    repoPath,
    projectId,
    overrides.worktree ?? null,
    overrides.branch ?? null,
    overrides.pr_url ?? null,
    overrides.pr_status ?? null,
    overrides.pr_number ?? null,
    overrides.status ?? "done",
    overrides.archived_at ?? null,
  );
}

function createApp(db: Database, sessionManager?: SessionManager) {
  const app = new Hono();
  app.route("/projects", createProjectRoutes(db as any, sessionManager));
  return app;
}

let tempDir: string;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("project PR metadata and merge-all route", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    tempDir = mkdtempSync(join(tmpdir(), "orchestra-merge-all-"));
    mkdirSync(tempDir, { recursive: true });
  });

  test("lists outstanding PR counts per project", async () => {
    insertProject(db, "proj-1", tempDir);
    insertThread(db, "open-pr", "proj-1", tempDir, {
      title: "Open PR",
      pr_url: "https://github.com/acme/repo/pull/41",
      pr_status: "open",
      pr_number: 41,
    });
    insertThread(db, "merged-pr", "proj-1", tempDir, {
      title: "Merged PR",
      pr_url: "https://github.com/acme/repo/pull/42",
      pr_status: "merged",
      pr_number: 42,
    });
    insertThread(db, "plain-thread", "proj-1", tempDir, {
      title: "No PR",
      pr_url: null,
    });

    const app = createApp(db);
    const res = await app.request("/projects");
    expect(res.status).toBe(200);

    const body = await res.json() as Array<{ outstandingPrCount: number }>;
    expect(body).toHaveLength(1);
    expect(body[0].outstandingPrCount).toBe(1);
  });

  test("creates a merge-all session with only outstanding PRs in the prompt", async () => {
    insertProject(db, "proj-1", tempDir, "Orchestra");
    insertThread(db, "pr-open", "proj-1", tempDir, {
      title: "Fix auth edge case",
      pr_url: "https://github.com/acme/orchestra/pull/17",
      pr_status: "open",
      pr_number: 17,
      branch: "orchestra/auth-fix",
      worktree: "/tmp/wt-auth",
    });
    insertThread(db, "pr-draft", "proj-1", tempDir, {
      title: "Polish mobile sidebar",
      pr_url: "https://github.com/acme/orchestra/pull/19",
      pr_status: "draft",
      pr_number: 19,
      branch: "orchestra/mobile-polish",
    });
    insertThread(db, "pr-merged", "proj-1", tempDir, {
      title: "Already merged",
      pr_url: "https://github.com/acme/orchestra/pull/20",
      pr_status: "merged",
      pr_number: 20,
    });

    let capturedOpts: Record<string, unknown> | null = null;
    const sessionManager = {
      startThread: async (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return {
          id: "merge-thread",
          title: String(opts.title),
          agent: String(opts.agent),
          project_id: String(opts.projectId),
          repo_path: String(opts.repoPath),
          worktree: null,
          branch: null,
          pr_url: null,
          pr_status: null,
          pr_number: null,
          pr_status_checked_at: null,
          pid: null,
          status: "running",
          error_message: null,
          session_id: null,
          archived_at: null,
          created_at: "2026-03-27T00:00:00.000Z",
          updated_at: "2026-03-27T00:00:00.000Z",
          last_interacted_at: "2026-03-27T00:00:00.000Z",
        };
      },
    } as unknown as SessionManager;

    const app = createApp(db, sessionManager);
    const res = await app.request("/projects/proj-1/merge-all-prs", {
      method: "POST",
      body: JSON.stringify({ agent: "codex" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts?.title).toBe("Merge all PRs (2)");
    expect(capturedOpts?.agent).toBe("codex");
    expect(capturedOpts?.repoPath).toBe(tempDir);

    const prompt = String(capturedOpts?.prompt);
    expect(prompt).toContain("Project: Orchestra");
    expect(prompt).toContain("This project has 2 outstanding pull requests");
    expect(prompt).toContain("Fix auth edge case");
    expect(prompt).toContain("Polish mobile sidebar");
    expect(prompt).toContain("https://github.com/acme/orchestra/pull/17");
    expect(prompt).toContain("https://github.com/acme/orchestra/pull/19");
    expect(prompt).not.toContain("Already merged");
    expect(prompt).toContain("Do not simply merge locally and then manually close the PRs.");

    const body = await res.json() as { title: string; agent: string; projectId: string };
    expect(body.title).toBe("Merge all PRs (2)");
    expect(body.agent).toBe("codex");
    expect(body.projectId).toBe("proj-1");
  });

  test("rejects merge-all when there are no outstanding PRs", async () => {
    insertProject(db, "proj-1", tempDir);
    insertThread(db, "done-pr", "proj-1", tempDir, {
      title: "Already merged",
      pr_url: "https://github.com/acme/repo/pull/50",
      pr_status: "merged",
      pr_number: 50,
    });

    const sessionManager = {
      startThread: async () => {
        throw new Error("should not be called");
      },
    } as unknown as SessionManager;

    const app = createApp(db, sessionManager);
    const res = await app.request("/projects/proj-1/merge-all-prs", {
      method: "POST",
      body: JSON.stringify({ agent: "codex" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("no outstanding PRs");
  });
});
