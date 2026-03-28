import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WorktreeManager } from "../manager";

/** Create a real git repo in a temp dir for integration tests */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  // Need at least one commit for worktree add to work
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL,
    repo_path TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
    pr_url TEXT, pid INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT, archived_at TEXT, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_interacted_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe("WorktreeManager.create", () => {
  let repoDir: string;
  let wtRoot: string;
  let db: Database;

  beforeEach(() => {
    repoDir = createTempRepo();
    wtRoot = mkdtempSync(join(tmpdir(), "wt-root-"));
    db = createTestDb();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  });

  test("creates worktree branching from main, not HEAD", () => {
    // Put the main repo on a feature branch to simulate a polluted checkout
    Bun.spawnSync(["git", "checkout", "-b", "feature/dirty"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "feature commit"], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    // The worktree should branch from main, not from feature/dirty
    const result = mgr.create("test-thread", repoDir);

    return result.then((wt) => {
      // Verify the worktree was created
      expect(wt.path).toContain("test-thread");
      expect(wt.branch).toStartWith("orchestra/");

      // Verify the worktree branch points to main's commit, NOT feature/dirty's commit
      const mainCommit = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repoDir });
      const mainSha = new TextDecoder().decode(mainCommit.stdout).trim();

      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();

      const featureCommit = Bun.spawnSync(["git", "rev-parse", "feature/dirty"], { cwd: repoDir });
      const featureSha = new TextDecoder().decode(featureCommit.stdout).trim();

      expect(wtSha).toBe(mainSha);
      expect(wtSha).not.toBe(featureSha);
    });
  });

  test("creates worktree from main even when HEAD is detached", () => {
    // Detach HEAD
    const initCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoDir });
    const sha = new TextDecoder().decode(initCommit.stdout).trim();
    Bun.spawnSync(["git", "checkout", "--detach", sha], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    const result = mgr.create("detach-test", repoDir);

    return result.then((wt) => {
      const mainCommit = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repoDir });
      const mainSha = new TextDecoder().decode(mainCommit.stdout).trim();

      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();

      expect(wtSha).toBe(mainSha);
    });
  });

  test("falls back to master when main branch does not exist", () => {
    // Create a repo with "master" as the default branch (no "main")
    const masterRepo = mkdtempSync(join(tmpdir(), "wt-master-"));
    Bun.spawnSync(["git", "init", "-b", "master"], { cwd: masterRepo });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: masterRepo });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: masterRepo });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: masterRepo });
    // Put on a feature branch so we can verify it branches from master, not HEAD
    Bun.spawnSync(["git", "checkout", "-b", "feature/x"], { cwd: masterRepo });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "feature"], { cwd: masterRepo });

    const mgr = new WorktreeManager(db, wtRoot);
    const result = mgr.create("master-test", masterRepo);

    return result.then((wt) => {
      const masterCommit = Bun.spawnSync(["git", "rev-parse", "master"], { cwd: masterRepo });
      const masterSha = new TextDecoder().decode(masterCommit.stdout).trim();
      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();
      expect(wtSha).toBe(masterSha);

      rmSync(masterRepo, { recursive: true, force: true });
    });
  });

  test("uses custom worktree root directory", () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const result = mgr.create("custom-root", repoDir);

    return result.then((wt) => {
      expect(wt.path).toStartWith(wtRoot);
    });
  });
});

describe("WorktreeManager.getStatus", () => {
  let repoDir: string;
  let wtRoot: string;
  let db: Database;

  beforeEach(() => {
    repoDir = createTempRepo();
    wtRoot = mkdtempSync(join(tmpdir(), "wt-root-"));
    db = createTestDb();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  });

  test("returns diffStats with insertions and deletions", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("status-test", repoDir);

    // Insert thread row so getStatus can find it
    db.run(
      "INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["status-test", "test", "claude", repoDir, wt.path, wt.branch, "idle"],
    );

    // Add a file with some content in the worktree
    const { writeFileSync } = await import("fs");
    writeFileSync(join(wt.path, "new-file.ts"), "line1\nline2\nline3\n");
    Bun.spawnSync(["git", "add", "new-file.ts"], { cwd: wt.path });
    Bun.spawnSync(["git", "commit", "-m", "add file"], { cwd: wt.path });

    const status = await mgr.getStatus("status-test");
    expect(status).not.toBeNull();
    expect(status!.diffStats).toBeDefined();
    expect(status!.diffStats!.insertions).toBe(3);
    expect(status!.diffStats!.deletions).toBe(0);
    expect(status!.aheadBehind.ahead).toBe(1);
  });

  test("returns undefined diffStats when no changes vs main", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("no-diff-test", repoDir);

    db.run(
      "INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["no-diff-test", "test", "claude", repoDir, wt.path, wt.branch, "idle"],
    );

    const status = await mgr.getStatus("no-diff-test");
    expect(status).not.toBeNull();
    expect(status!.diffStats).toBeUndefined();
  });

  test("returns null diffStats when thread has no branch", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("no-branch-test", repoDir);

    // Insert thread WITHOUT branch
    db.run(
      "INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["no-branch-test", "test", "claude", repoDir, wt.path, null, "idle"],
    );

    const status = await mgr.getStatus("no-branch-test");
    expect(status).not.toBeNull();
    expect(status!.diffStats).toBeUndefined();
    expect(status!.aheadBehind.ahead).toBe(0);
    expect(status!.aheadBehind.behind).toBe(0);
  });

  test("counts both insertions and deletions correctly", async () => {
    const mgr = new WorktreeManager(db, wtRoot);

    // Create a file on main first
    const { writeFileSync } = await import("fs");
    writeFileSync(join(repoDir, "existing.ts"), "old1\nold2\nold3\n");
    Bun.spawnSync(["git", "add", "existing.ts"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "add existing"], { cwd: repoDir });

    const wt = await mgr.create("both-test", repoDir);

    db.run(
      "INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["both-test", "test", "claude", repoDir, wt.path, wt.branch, "idle"],
    );

    // Modify the file: replace content (deletions + insertions)
    writeFileSync(join(wt.path, "existing.ts"), "new1\nnew2\nnew3\nnew4\n");
    Bun.spawnSync(["git", "add", "existing.ts"], { cwd: wt.path });
    Bun.spawnSync(["git", "commit", "-m", "modify file"], { cwd: wt.path });

    const status = await mgr.getStatus("both-test");
    expect(status).not.toBeNull();
    expect(status!.diffStats).toBeDefined();
    expect(status!.diffStats!.insertions).toBe(4);
    expect(status!.diffStats!.deletions).toBe(3);
  });
});
