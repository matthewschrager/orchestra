import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDb, getThread } from "../../db";
import { SessionManager } from "../manager";
import { AgentRegistry } from "../../agents/registry";
import { WorktreeManager } from "../../worktrees/manager";
import type { AgentAdapter, AgentOutputParser, AgentProcess, ParseResult, SpawnOpts } from "../../agents/types";

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

/**
 * Creates a mock adapter that spawns a real process which outputs the given
 * lines to stdout (as JSON events), then exits. This lets us test the real
 * readStream → handleExit flow without needing Claude installed.
 */
function createMockAdapter(lines: string[]): AgentAdapter {
  return {
    name: "mock",
    detect: async () => true,
    getVersion: async () => "mock-1.0",
    supportsResume: () => false,
    getBypassFlags: () => [],
    spawn(opts: SpawnOpts): AgentProcess {
      // Use a shell script that echoes lines and exits
      const script = lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join("; ");
      const proc = Bun.spawn(["sh", "-c", script], {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return { proc };
    },
    createParser(): AgentOutputParser {
      return {
        parseOutput(line: string): ParseResult {
          const trimmed = line.trim();
          if (!trimmed) return { messages: [], deltas: [] };
          try {
            const data = JSON.parse(trimmed);
            if (data.type === "result") {
              const deltas: Array<{ deltaType: string; text?: string }> = [];
              deltas.push({ deltaType: "turn_end", text: data.session_id });
              return { messages: [], deltas };
            }
            if (data.type === "assistant") {
              return {
                messages: [{ role: "assistant", content: data.text ?? "" }],
                deltas: [],
              };
            }
            return { messages: [], deltas: [] };
          } catch {
            return { messages: [{ role: "assistant", content: trimmed }], deltas: [] };
          }
        },
      };
    },
  };
}

describe("stream-exit race condition", () => {
  test("result event (with session_id) is processed before handleExit", async () => {
    const dataDir = makeTmpDir("race");
    const db = createDb(dataDir);

    // Insert a project for the thread
    db.query("INSERT INTO projects (id, name, path) VALUES ('p1', 'TestProject', '/tmp')").run();

    const sessionId = "test-session-abc123";
    const adapter = createMockAdapter([
      JSON.stringify({ type: "assistant", text: "Hello from mock agent" }),
      JSON.stringify({ type: "result", session_id: sessionId, cost_usd: 0.05 }),
    ]);

    const registry = new AgentRegistry();
    registry.register(adapter);
    const worktreeManager = new WorktreeManager(db);
    const mgr = new SessionManager(db, registry, worktreeManager);

    const thread = await mgr.startThread({
      agent: "mock",
      prompt: "test prompt",
      repoPath: "/tmp",
      projectId: "p1",
    });

    // Wait for the process to exit and handleExit to complete
    // The mock process outputs two lines and exits immediately, so this
    // exercises the race between readStream and handleExit.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const finalThread = getThread(db, thread.id);
    expect(finalThread).toBeDefined();
    expect(finalThread!.session_id).toBe(sessionId);
    expect(finalThread!.status).toBe("done");

    // Verify the assistant message was persisted
    const messages = db
      .query("SELECT * FROM messages WHERE thread_id = ? AND role = 'assistant'")
      .all(thread.id) as Array<{ content: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.content.includes("Hello from mock agent"))).toBe(true);

    mgr.stopAll();
    db.close();
  });
});
