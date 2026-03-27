import { describe, expect, test } from "bun:test";
import { createFilesystemRoutes } from "../filesystem";
import { Hono } from "hono";
import { resolve, join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";

function createApp() {
  const app = new Hono();
  app.route("/fs", createFilesystemRoutes());
  return app;
}

// Tests use a temp dir under $HOME to satisfy the path boundary restriction
const HOME = homedir();

function makeTestDir(): string {
  return mkdtempSync(join(HOME, ".orchestra-test-"));
}

describe("GET /fs/browse", () => {
  test("returns home directory when no path specified", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toBeTruthy();
    expect(body.directories).toBeInstanceOf(Array);
  });

  test("returns 400 for nonexistent path", async () => {
    const app = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(join(HOME, "nonexistent-path-that-does-not-exist-12345"))}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Path does not exist");
  });

  test("rejects paths outside home directory", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/tmp");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Path must be under home directory");
  });

  test("rejects path prefix collision (e.g. /home/user vs /home/username)", async () => {
    // Simulate prefix collision: HOME + "extra" is a different user directory
    const app = createApp();
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

    const app = createApp();
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

    const app = createApp();
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

    const app = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();

    const repo = body.directories.find((d: { name: string }) => d.name === "my-repo");
    const notRepo = body.directories.find((d: { name: string }) => d.name === "not-repo");
    expect(repo.isGitRepo).toBe(true);
    expect(notRepo.isGitRepo).toBe(false);

    rmSync(tmp, { recursive: true });
  });

  test("returns null parent at home directory boundary", async () => {
    const app = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(HOME)}`);
    const body = await res.json();
    // At HOME, parent should be null (can't navigate above HOME)
    expect(body.parent).toBeNull();
  });

  test("returns parent path for subdirectory of home", async () => {
    const tmp = makeTestDir();

    const app = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();
    expect(body.parent).toBeTruthy();

    rmSync(tmp, { recursive: true });
  });
});
