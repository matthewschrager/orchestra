import { describe, expect, test } from "bun:test";
import { createFilesystemRoutes } from "../filesystem";
import { Hono } from "hono";
import { resolve } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmdirSync, rmSync } from "fs";
import { tmpdir } from "os";

function createApp() {
  const app = new Hono();
  app.route("/fs", createFilesystemRoutes());
  return app;
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
    const res = await app.request("/fs/browse?path=/nonexistent/path/that/does/not/exist");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Path does not exist");
  });

  test("lists subdirectories sorted alphabetically", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-test-"));
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
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-test-"));
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
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-test-"));
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

  test("returns parent path (null at root)", async () => {
    const app = createApp();
    const res = await app.request("/fs/browse?path=/");
    const body = await res.json();
    expect(body.parent).toBeNull();
  });

  test("returns parent path for non-root directory", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "orchestra-test-"));

    const app = createApp();
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(tmp)}`);
    const body = await res.json();
    expect(body.parent).toBeTruthy();
    expect(body.parent).toBe(resolve(tmp, ".."));

    rmSync(tmp, { recursive: true });
  });
});
