import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WorktreeManager } from "../manager";

/** Create a bare remote + cloned working repo for push-status tests */
function createRepoWithRemote(): { remote: string; local: string } {
  const remote = mkdtempSync(join(tmpdir(), "wt-remote-"));
  Bun.spawnSync(["git", "init", "--bare", "-b", "main"], { cwd: remote });

  const local = mkdtempSync(join(tmpdir(), "wt-local-"));
  Bun.spawnSync(["git", "clone", remote, "."], { cwd: local });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: local });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: local });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: local });
  Bun.spawnSync(["git", "push", "origin", "main"], { cwd: local });
  return { remote, local };
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pr_status TEXT, pr_number INTEGER, pr_status_checked_at TEXT,
    pid INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT, archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
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
}

function insertThread(
  db: Database,
  id: string,
  overrides: ThreadOverrides = {},
) {
  db.query(
    `INSERT INTO threads (
      id, title, agent, repo_path, status, worktree, branch, pr_url, pr_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.title ?? "Test",
    overrides.agent ?? "claude",
    overrides.repo_path ?? "/tmp",
    overrides.status ?? "done",
    overrides.worktree ?? null,
    overrides.branch ?? null,
    overrides.pr_url ?? null,
    overrides.pr_status ?? null,
  );
}

describe("WorktreeManager.isPushedToRemote", () => {
  let repos: { remote: string; local: string };
  let wtRoot: string;
  let db: Database;
  let mgr: WorktreeManager;

  beforeEach(() => {
    repos = createRepoWithRemote();
    wtRoot = mkdtempSync(join(tmpdir(), "wt-root-"));
    db = createTestDb();
    mgr = new WorktreeManager(db, wtRoot);
  });

  afterEach(() => {
    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  });

  test("returns pushed=false for thread without worktree", async () => {
    insertThread(db, "no-wt");
    const result = await mgr.isPushedToRemote("no-wt");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("no_worktree");
  });

  test("returns pushed=false when worktree path does not exist", async () => {
    insertThread(db, "missing-wt", {
      worktree: "/tmp/nonexistent-wt-path",
      branch: "orchestra/test",
    });
    const result = await mgr.isPushedToRemote("missing-wt");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("worktree_missing");
  });

  test("returns pushed=false for nonexistent thread", async () => {
    const result = await mgr.isPushedToRemote("does-not-exist");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("no_worktree");
  });

  test("returns pushed=true when branch is fully pushed with no local changes", async () => {
    // Create worktree + push the branch
    const wt = await mgr.create("pushed-clean", repos.local);
    insertThread(db, "pushed-clean", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Make a commit and push
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "work"], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("pushed-clean");
    expect(result.pushed).toBe(true);
  });

  test("returns pushed=false when branch has uncommitted changes to tracked files", async () => {
    const wt = await mgr.create("uncommitted", repos.local);
    insertThread(db, "uncommitted", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Push the branch, then modify a tracked file without committing
    writeFileSync(join(wt.path, "file.txt"), "initial");
    Bun.spawnSync(["git", "add", "file.txt"], { cwd: wt.path });
    Bun.spawnSync(["git", "commit", "-m", "add file"], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });
    writeFileSync(join(wt.path, "file.txt"), "modified");

    const result = await mgr.isPushedToRemote("uncommitted");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("uncommitted_changes");
  });

  test("returns pushed=true when only untracked files exist (regression)", async () => {
    const wt = await mgr.create("untracked-only", repos.local);
    insertThread(db, "untracked-only", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Push the branch, then add untracked files (e.g. PLAN.md, temp files from other agents)
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "work"], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });
    writeFileSync(join(wt.path, "PLAN.md"), "untracked plan file");
    writeFileSync(join(wt.path, "temp-test.ts"), "untracked test file");

    const result = await mgr.isPushedToRemote("untracked-only");
    expect(result.pushed).toBe(true);
  });

  test("returns pushed=false when branch has not been pushed at all", async () => {
    const wt = await mgr.create("not-pushed", repos.local);
    insertThread(db, "not-pushed", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Commit but do NOT push
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "local only"], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("not-pushed");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("not_on_remote");
  });

  test("returns pushed=false when branch has unpushed commits", async () => {
    const wt = await mgr.create("unpushed", repos.local);
    insertThread(db, "unpushed", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Push once, then make another commit without pushing
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "first"], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "unpushed"], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("unpushed");
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("unpushed_commits");
  });

  test("returns pushed=true for worktree with no new commits (clean branch)", async () => {
    // Worktree just created, no extra commits, branch pushed as-is
    const wt = await mgr.create("empty-branch", repos.local);
    insertThread(db, "empty-branch", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
    });

    // Push the branch (even though it has no commits beyond main)
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("empty-branch");
    expect(result.pushed).toBe(true);
  });

  test("returns pushed=true for merged PR after remote branch is deleted", async () => {
    const wt = await mgr.create("merged-pr", repos.local);
    insertThread(db, "merged-pr", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
      pr_url: "https://github.com/octo/repo/pull/1",
      pr_status: "merged",
    });

    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "work"], { cwd: wt.path });
    const headOid = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: wt.path,
      stdout: "pipe",
    }).stdout.toString().trim();
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "origin", "--delete", wt.branch], { cwd: wt.path });
    Bun.spawnSync(["git", "fetch", "origin", "--prune"], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("merged-pr", {
      mergedPrHeadOid: headOid,
    });
    expect(result.pushed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toBe("remote_branch_deleted");
  });

  test("returns pushed=false when merged PR branch has local commits after merge", async () => {
    const wt = await mgr.create("merged-pr-dirty", repos.local);
    insertThread(db, "merged-pr-dirty", {
      worktree: wt.path,
      branch: wt.branch,
      repo_path: repos.local,
      pr_url: "https://github.com/octo/repo/pull/2",
      pr_status: "merged",
    });

    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "merged head"], { cwd: wt.path });
    const mergedHeadOid = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: wt.path,
      stdout: "pipe",
    }).stdout.toString().trim();
    Bun.spawnSync(["git", "push", "-u", "origin", wt.branch], { cwd: wt.path });
    Bun.spawnSync(["git", "push", "origin", "--delete", wt.branch], { cwd: wt.path });
    Bun.spawnSync(["git", "fetch", "origin", "--prune"], { cwd: wt.path });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "post merge"], { cwd: wt.path });

    const result = await mgr.isPushedToRemote("merged-pr-dirty", {
      mergedPrHeadOid: mergedHeadOid,
    });
    expect(result.pushed).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.reason).toBe("post_merge_commits");
  });
});
