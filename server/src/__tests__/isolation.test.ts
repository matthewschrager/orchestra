import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDb } from "../db";
import { getOrCreateToken, regenerateToken, readToken } from "../auth";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orch-test-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("multi-instance isolation", () => {
  describe("database isolation", () => {
    test("separate data dirs produce separate databases", () => {
      const dirA = makeTmpDir("db-a");
      const dirB = makeTmpDir("db-b");

      const dbA = createDb(dirA);
      const dbB = createDb(dirB);

      expect(existsSync(join(dirA, "orchestra.db"))).toBe(true);
      expect(existsSync(join(dirB, "orchestra.db"))).toBe(true);

      // Insert into A, verify not visible in B
      dbA.query("INSERT INTO projects (id, name, path) VALUES ('test-a', 'ProjectA', '/tmp/a')").run();
      const rowsA = dbA.query("SELECT * FROM projects WHERE id = 'test-a'").all();
      const rowsB = dbB.query("SELECT * FROM projects WHERE id = 'test-a'").all();

      expect(rowsA.length).toBe(1);
      expect(rowsB.length).toBe(0);

      dbA.close();
      dbB.close();
    });
  });

  describe("auth token isolation", () => {
    test("separate data dirs produce separate tokens", () => {
      const dirA = makeTmpDir("auth-a");
      const dirB = makeTmpDir("auth-b");

      const tokenA = getOrCreateToken(dirA);
      const tokenB = getOrCreateToken(dirB);

      expect(tokenA).toBeTruthy();
      expect(tokenB).toBeTruthy();
      expect(tokenA).not.toBe(tokenB);

      expect(existsSync(join(dirA, "auth-token"))).toBe(true);
      expect(existsSync(join(dirB, "auth-token"))).toBe(true);
    });

    test("readToken reads from the correct data dir", () => {
      const dir = makeTmpDir("auth-read");
      const created = getOrCreateToken(dir);
      const read = readToken(dir);
      expect(read).toBe(created);
    });

    test("regenerateToken writes to the correct data dir", () => {
      const dir = makeTmpDir("auth-regen");
      const original = getOrCreateToken(dir);
      const regenerated = regenerateToken(dir);
      expect(regenerated).not.toBe(original);
      expect(readToken(dir)).toBe(regenerated);
    });
  });
});
