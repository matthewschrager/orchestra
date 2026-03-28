import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { TerminalManager } from "../manager";
import { mkdtempSync, rmdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let manager: TerminalManager;
let testDir: string;

async function waitForOutput(
  predicate: () => boolean,
  timeoutMs = 2_500,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

beforeEach(() => {
  manager = new TerminalManager();
  testDir = mkdtempSync(join(tmpdir(), "terminal-test-"));
});

afterEach(() => {
  manager.closeAll();
  try {
    rmdirSync(testDir);
  } catch {
    /* may already be cleaned */
  }
});

describe("TerminalManager", () => {
  // ── create ───────────────────────────────────────────

  test("create() returns { created: true, reconnect: false }", () => {
    const result = manager.create("t1", testDir);
    expect(result.created).toBe(true);
    expect(result.reconnect).toBe(false);
    expect(manager.has("t1")).toBe(true);
  });

  test("create() same id returns { created: false, reconnect: true } (idempotent)", () => {
    manager.create("t1", testDir);
    const result = manager.create("t1", testDir);
    expect(result.created).toBe(false);
    expect(result.reconnect).toBe(true);
  });

  test("create() with invalid cwd throws", () => {
    expect(() => manager.create("t1", "/nonexistent/path/xyz")).toThrow(
      "Working directory not found",
    );
    expect(manager.has("t1")).toBe(false);
  });

  test("create() beyond MAX_PTYS throws", () => {
    // Create 20 terminals (the max)
    for (let i = 0; i < 20; i++) {
      manager.create(`t${i}`, testDir);
    }
    expect(() => manager.create("t-over-limit", testDir)).toThrow(
      "Max terminal limit",
    );
  });

  // ── write ────────────────────────────────────────────

  test("write() with oversized data is silently rejected", () => {
    manager.create("t1", testDir);
    // Should not throw — silently rejected
    const bigData = "x".repeat(70_000); // > 64KB
    expect(() => manager.write("t1", bigData)).not.toThrow();
  });

  test("write() to nonexistent terminal is no-op", () => {
    expect(() => manager.write("nonexistent", "hello")).not.toThrow();
  });

  // ── resize ───────────────────────────────────────────

  test("resize() clamps out-of-range values", () => {
    manager.create("t1", testDir);
    // Should not throw with extreme values
    expect(() => manager.resize("t1", -10, 0)).not.toThrow();
    expect(() => manager.resize("t1", 9999, 9999)).not.toThrow();
    expect(() => manager.resize("t1", 80, 24)).not.toThrow();
  });

  // ── close ────────────────────────────────────────────

  test("close() cleans up and removes from map", () => {
    manager.create("t1", testDir);
    expect(manager.has("t1")).toBe(true);
    manager.close("t1");
    expect(manager.has("t1")).toBe(false);
  });

  test("close() on nonexistent id is no-op", () => {
    expect(() => manager.close("nonexistent")).not.toThrow();
  });

  test("closeAll() closes all sessions", () => {
    manager.create("t1", testDir);
    manager.create("t2", testDir);
    manager.create("t3", testDir);
    expect(manager.has("t1")).toBe(true);
    expect(manager.has("t2")).toBe(true);
    expect(manager.has("t3")).toBe(true);
    manager.closeAll();
    expect(manager.has("t1")).toBe(false);
    expect(manager.has("t2")).toBe(false);
    expect(manager.has("t3")).toBe(false);
  });

  test("closeForThread() closes terminal for a specific thread", () => {
    manager.create("t1", testDir);
    manager.create("t2", testDir);
    manager.closeForThread("t1");
    expect(manager.has("t1")).toBe(false);
    expect(manager.has("t2")).toBe(true);
  });

  // ── replay buffer ────────────────────────────────────

  test("getReplayBuffer() returns null for nonexistent terminal", () => {
    expect(manager.getReplayBuffer("nonexistent")).toBeNull();
  });

  test("getReplayBuffer() returns empty string initially", () => {
    manager.create("t1", testDir);
    expect(manager.getReplayBuffer("t1")).toBe("");
  });

  // ── event listeners ──────────────────────────────────

  test("onData listener can be registered", () => {
    let called = false;
    manager.onData(() => {
      called = true;
    });
    // Listener is registered but not yet fired (needs PTY output)
    expect(called).toBe(false);
  });

  test("onExit listener can be registered", () => {
    let called = false;
    manager.onExit(() => {
      called = true;
    });
    expect(called).toBe(false);
  });

  // ── isExited ─────────────────────────────────────────

  test("isExited() returns false for running terminal", () => {
    manager.create("t1", testDir);
    expect(manager.isExited("t1")).toBe(false);
  });

  test("isExited() returns false for nonexistent terminal", () => {
    expect(manager.isExited("nonexistent")).toBe(false);
  });

  // ── integration: PTY I/O ─────────────────────────────

  test("write() delivers data and onData fires with output", async () => {
    const outputs: string[] = [];
    manager.onData((_id, data) => {
      outputs.push(data);
    });

    manager.create("t1", testDir);
    // Write a command that produces output
    manager.write("t1", "echo hello_terminal_test\n");

    await waitForOutput(() => outputs.join("").includes("hello_terminal_test"));

    const combined = outputs.join("");
    expect(combined).toContain("hello_terminal_test");
  });

  test("create() starts PTY in the specified cwd", async () => {
    const outputs: string[] = [];
    manager.onData((_id, data) => {
      outputs.push(data);
    });

    manager.create("t-cwd", testDir);
    // Wait for shell initialization before sending pwd
    await new Promise((resolve) => setTimeout(resolve, 500));
    outputs.length = 0; // Clear init output
    manager.write("t-cwd", "pwd\n");

    await waitForOutput(() => outputs.join("").includes(testDir));

    const combined = outputs.join("");
    // The PTY should report the testDir as cwd, not $HOME or elsewhere
    expect(combined).toContain(testDir);
  });

  test("replay buffer accumulates output", async () => {
    manager.create("t1", testDir);
    manager.write("t1", "echo replay_test_marker\n");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const replay = manager.getReplayBuffer("t1");
    expect(replay).not.toBeNull();
    expect(replay!.length).toBeGreaterThan(0);
    expect(replay).toContain("replay_test_marker");
  });
});
