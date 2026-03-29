import { describe, expect, test } from "bun:test";
import { createFilesystemRoutes, filterFiles } from "../filesystem";
import { Hono } from "hono";
import { resolve, join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";
import { Database } from "bun:sqlite";

// Minimal in-memory DB with projects table for testing
function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function createApp(db?: InstanceType<typeof Database>) {
  const testDb = db ?? createTestDb();
  const app = new Hono();
  app.route("/fs", createFilesystemRoutes(testDb as any));
  return { app, db: testDb };
}

// Tests use a temp dir under $HOME to satisfy the path boundary restriction
const HOME = homedir();

function makeTestDir(): string {
  return mkdtempSync(join(HOME, ".orchestra-test-"));
}

describe("GET /fs/browse", () => {
  test("returns home directory when no path specified", async () => {
    const { app } = createApp();
    const res = await app.request("/fs/browse");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toBeTruthy();
    expect(body.directories).toBeInstanceOf(Array);
  });

  test("returns 400 for nonexistent path", async () => {
    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(join(HOME, "nonexistent-path-that-does-not-exist-12345"))}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Path does not exist");
  });

  test("rejects paths outside home directory", async () => {
    const { app } = createApp();
    const res = await app.request("/fs/browse?path=/tmp");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Path must be under home directory");
  });

  test("rejects path prefix collision (e.g. /home/user vs /home/username)", async () => {
    // Simulate prefix collision: HOME + "extra" is a different user directory
    const { app } = createApp();
    const fakePath = HOME + "extra";
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(fakePath)}`);
    // Should either be 400 (doesn't exist) or 403 (outside boundary)
    expect([400, 403]).toContain(res.status);
  });

  test("lists subdirectories sorted alphabetically", async () => {
    const tmp = makeTestDir();
    mkdirSync(resolve(tmp, "charlie"));
    mkdirSync(resolve(tmp, "alpha"));
    mkdirSync(resolve(tmp, "bravo"));

    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();

    expect(body.current).toBe(tmp);
    expect(body.directories.map((d: { name: string }) => d.name)).toEqual(["alpha", "bravo", "charlie"]);

    rmSync(tmp, { recursive: true });
  });

  test("excludes hidden directories (dotfiles)", async () => {
    const tmp = makeTestDir();
    mkdirSync(resolve(tmp, ".hidden"));
    mkdirSync(resolve(tmp, "visible"));

    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();

    expect(body.directories).toHaveLength(1);
    expect(body.directories[0].name).toBe("visible");

    rmSync(tmp, { recursive: true });
  });

  test("detects git repos via .git directory", async () => {
    const tmp = makeTestDir();
    mkdirSync(resolve(tmp, "my-repo"));
    mkdirSync(resolve(tmp, "my-repo", ".git"));
    mkdirSync(resolve(tmp, "not-repo"));

    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();

    const repo = body.directories.find((d: { name: string }) => d.name === "my-repo");
    const notRepo = body.directories.find((d: { name: string }) => d.name === "not-repo");
    expect(repo.isGitRepo).toBe(true);
    expect(notRepo.isGitRepo).toBe(false);

    rmSync(tmp, { recursive: true });
  });

  test("returns null parent at home directory boundary", async () => {
    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(HOME)}`);
    const body = await res.json();
    // At HOME, parent should be null (can't navigate above HOME)
    expect(body.parent).toBeNull();
  });

  test("returns parent path for subdirectory of home", async () => {
    const tmp = makeTestDir();

    const { app } = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();
    expect(body.parent).toBeTruthy();

    rmSync(tmp, { recursive: true });
  });
});

// ── GET /fs/files ───────────────────────────────────

describe("GET /fs/files", () => {
  test("returns 400 when projectId is missing", async () => {
    const { app } = createApp();
    const res = await app.request("/fs/files");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("projectId is required");
  });

  test("returns 404 for unknown projectId", async () => {
    const { app } = createApp();
    const res = await app.request("/fs/files?projectId=nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Project not found");
  });

  test("returns files for a valid git project", async () => {
    const db = createTestDb();
    // Use the orchestra repo itself as the test project
    const repoPath = resolve(__dirname, "../../../..");
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["test-proj", "test", repoPath]);

    const { app } = createApp(db);
    const res = await app.request("/fs/files?projectId=test-proj");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toBeInstanceOf(Array);
    expect(body.files.length).toBeGreaterThan(0);
    expect(typeof body.truncated).toBe("boolean");
    // Should contain relative paths
    expect(body.files.some((f: string) => f.includes("package.json"))).toBe(true);
  });

  test("filters files with query parameter", async () => {
    const db = createTestDb();
    const repoPath = resolve(__dirname, "../../../..");
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["test-proj", "test", repoPath]);

    const { app } = createApp(db);
    const res = await app.request("/fs/files?projectId=test-proj&query=filesystem");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files.every((f: string) => f.toLowerCase().includes("filesystem"))).toBe(true);
    expect(body.truncated).toBe(false);
  });

  test("respects limit parameter", async () => {
    const db = createTestDb();
    const repoPath = resolve(__dirname, "../../../..");
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["test-proj", "test", repoPath]);

    const { app } = createApp(db);
    const res = await app.request("/fs/files?projectId=test-proj&query=ts&limit=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.length).toBeLessThanOrEqual(3);
  });

  test("returns empty files for non-git directory", async () => {
    const tmp = makeTestDir();
    const db = createTestDb();
    db.run("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)", ["tmp-proj", "tmp", tmp]);

    const { app } = createApp(db);
    const res = await app.request("/fs/files?projectId=tmp-proj");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
    expect(body.truncated).toBe(false);

    rmSync(tmp, { recursive: true });
  });
});

// ── filterFiles (pure function) ──────────────────────

describe("filterFiles", () => {
  const FILES = [
    "README.md",
    "src/App.tsx",
    "src/components/InputBar.tsx",
    "src/components/SlashCommandInput.tsx",
    "src/lib/fileFilter.ts",
    "server/src/index.ts",
  ];

  test("returns empty for empty query", () => {
    expect(filterFiles(FILES, "")).toEqual([]);
  });

  test("basename-start matches rank above substring", () => {
    const result = filterFiles(FILES, "Input");
    const inputBarIdx = result.indexOf("src/components/InputBar.tsx");
    const slashIdx = result.indexOf("src/components/SlashCommandInput.tsx");
    expect(inputBarIdx).toBeGreaterThanOrEqual(0);
    expect(slashIdx).toBeGreaterThanOrEqual(0);
    expect(inputBarIdx).toBeLessThan(slashIdx);
  });

  test("case-insensitive", () => {
    const result = filterFiles(FILES, "readme");
    expect(result).toContain("README.md");
  });

  test("respects limit", () => {
    const result = filterFiles(FILES, "s", 2);
    expect(result.length).toBe(2);
  });
});
