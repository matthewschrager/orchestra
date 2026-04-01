import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

  test("creates worktree branching from the checked-out branch", () => {
    // Put the main repo on a feature branch
    Bun.spawnSync(["git", "checkout", "-b", "feature/dirty"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "feature commit"], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    // The worktree should branch from feature/dirty (the checked-out branch)
    const result = mgr.create("test-thread", repoDir);

    return result.then((wt) => {
      // Verify the worktree was created
      expect(wt.path).toContain("test-thread");
      expect(wt.branch).toStartWith("orchestra/");
      expect(wt.baseBranch).toBe("feature/dirty");

      // Verify the worktree branch points to feature/dirty's commit
      const featureCommit = Bun.spawnSync(["git", "rev-parse", "feature/dirty"], { cwd: repoDir });
      const featureSha = new TextDecoder().decode(featureCommit.stdout).trim();

      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();

      expect(wtSha).toBe(featureSha);
    });
  });

  test("falls back to main/master when HEAD is detached", () => {
    // Detach HEAD
    const initCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoDir });
    const sha = new TextDecoder().decode(initCommit.stdout).trim();
    Bun.spawnSync(["git", "checkout", "--detach", sha], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    const result = mgr.create("detach-test", repoDir);

    return result.then((wt) => {
      // With detached HEAD, getCurrentBranch returns "" → falls back to main
      expect(wt.baseBranch).toBe("main");

      const mainCommit = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repoDir });
      const mainSha = new TextDecoder().decode(mainCommit.stdout).trim();

      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();

      expect(wtSha).toBe(mainSha);
    });
  });

  test("branches from checked-out branch even on master-based repos", () => {
    // Create a repo with "master" as the default branch (no "main")
    const masterRepo = mkdtempSync(join(tmpdir(), "wt-master-"));
    Bun.spawnSync(["git", "init", "-b", "master"], { cwd: masterRepo });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: masterRepo });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: masterRepo });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: masterRepo });
    // Put on a feature branch — worktree should branch from feature/x
    Bun.spawnSync(["git", "checkout", "-b", "feature/x"], { cwd: masterRepo });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "feature"], { cwd: masterRepo });

    const mgr = new WorktreeManager(db, wtRoot);
    const result = mgr.create("master-test", masterRepo);

    return result.then((wt) => {
      expect(wt.baseBranch).toBe("feature/x");

      const featureCommit = Bun.spawnSync(["git", "rev-parse", "feature/x"], { cwd: masterRepo });
      const featureSha = new TextDecoder().decode(featureCommit.stdout).trim();
      const wtCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt.path });
      const wtSha = new TextDecoder().decode(wtCommit.stdout).trim();
      expect(wtSha).toBe(featureSha);

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

describe("WorktreeManager.getFileDiff", () => {
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

  function insertThread(id: string, wt: { path: string; branch: string }) {
    db.run(
      "INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, "test", "claude", repoDir, wt.path, wt.branch, "idle"],
    );
  }

  test("returns old and new content for a modified file", async () => {
    // Create a file on main
    writeFileSync(join(repoDir, "app.ts"), "const x = 1;\n");
    Bun.spawnSync(["git", "add", "app.ts"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "add app"], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-mod", repoDir);
    insertThread("diff-mod", wt);

    // Modify in worktree
    writeFileSync(join(wt.path, "app.ts"), "const x = 2;\nconst y = 3;\n");

    const diff = await mgr.getFileDiff("diff-mod", "app.ts");
    expect(diff).not.toBeNull();
    expect(diff!.filePath).toBe("app.ts");
    expect(diff!.oldContent).toBe("const x = 1;\n");
    expect(diff!.newContent).toBe("const x = 2;\nconst y = 3;\n");
    expect(diff!.binary).toBeUndefined();
  });

  test("returns empty oldContent for a new file", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-new", repoDir);
    insertThread("diff-new", wt);

    // Create a new file in the worktree (not in main)
    writeFileSync(join(wt.path, "brand-new.ts"), "hello\n");

    const diff = await mgr.getFileDiff("diff-new", "brand-new.ts");
    expect(diff).not.toBeNull();
    expect(diff!.oldContent).toBe("");
    expect(diff!.newContent).toBe("hello\n");
  });

  test("returns empty newContent for a deleted file", async () => {
    // Create a file on main
    writeFileSync(join(repoDir, "doomed.ts"), "goodbye\n");
    Bun.spawnSync(["git", "add", "doomed.ts"], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "add doomed"], { cwd: repoDir });

    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-del", repoDir);
    insertThread("diff-del", wt);

    // Delete the file in the worktree
    rmSync(join(wt.path, "doomed.ts"));

    const diff = await mgr.getFileDiff("diff-del", "doomed.ts");
    expect(diff).not.toBeNull();
    expect(diff!.oldContent).toBe("goodbye\n");
    expect(diff!.newContent).toBe("");
  });

  test("rejects path traversal attempts", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-sec", repoDir);
    insertThread("diff-sec", wt);

    const diff = await mgr.getFileDiff("diff-sec", "../../../etc/passwd");
    expect(diff).toBeNull();
  });

  test("rejects null bytes in file path", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-null", repoDir);
    insertThread("diff-null", wt);

    const diff = await mgr.getFileDiff("diff-null", "file\0.ts");
    expect(diff).toBeNull();
  });

  test("returns null for non-existent thread", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const diff = await mgr.getFileDiff("no-such-thread", "file.ts");
    expect(diff).toBeNull();
  });

  test("detects binary files", async () => {
    const mgr = new WorktreeManager(db, wtRoot);
    const wt = await mgr.create("diff-bin", repoDir);
    insertThread("diff-bin", wt);

    // Write a file with null bytes (binary)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
    const { writeFileSync: wfs } = await import("fs");
    wfs(join(wt.path, "image.png"), buf);

    const diff = await mgr.getFileDiff("diff-bin", "image.png");
    expect(diff).not.toBeNull();
    expect(diff!.binary).toBe(true);
    expect(diff!.oldContent).toBe("");
    expect(diff!.newContent).toBe("");
  });
});
