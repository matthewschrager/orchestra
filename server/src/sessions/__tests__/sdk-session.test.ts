import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDb, getThread } from "../../db";
import { SessionManager } from "../manager";
import { AgentRegistry } from "../../agents/registry";
import { WorktreeManager } from "../../worktrees/manager";
import type { AgentAdapter, AgentSession, ParseResult, StartOpts } from "../../agents/types";

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

/** Creates a mock adapter that yields SDK-style messages from an async generator */
function createMockAdapter(
  messages: Array<Record<string, unknown>>,
  opts?: { delayMs?: number },
): AgentAdapter {
  return {
    name: "mock",
    detect: async () => true,
    getVersion: async () => "1.0.0-mock",
    supportsResume: () => true,
    start(_opts: StartOpts): AgentSession {
      const abortController = new AbortController();

      async function* generate() {
        for (const msg of messages) {
          if (abortController.signal.aborted) return;
          if (opts?.delayMs) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          yield msg;
        }
      }

      return {
        messages: generate(),
        abort: () => abortController.abort(),
        parseMessage(msg: unknown): ParseResult {
          const m = msg as Record<string, unknown>;
          const type = m.type as string;

          if (type === "system") {
            return {
              messages: [],
              deltas: [],
              sessionId: m.session_id as string | undefined,
            };
          }

          if (type === "assistant") {
            const message = m.message as { content?: Array<{ type: string; text?: string }> };
            const textBlocks = message?.content?.filter(b => b.type === "text") ?? [];
            const text = textBlocks.map(b => b.text ?? "").join("");
            return {
              messages: text ? [{ role: "assistant", content: text }] : [],
              deltas: [],
            };
          }

          if (type === "result") {
            return {
              messages: [],
              deltas: [
                {
                  deltaType: "metrics",
                  costUsd: m.total_cost_usd as number | undefined,
                  durationMs: m.duration_ms as number | undefined,
                },
                {
                  deltaType: "turn_end",
                  text: m.session_id as string | undefined,
                },
              ],
              sessionId: m.session_id as string | undefined,
            };
          }

          return { messages: [], deltas: [] };
        },
      };
    },
  };
}

function setupSessionManager(adapter: AgentAdapter) {
  const dbDir = makeTmpDir("db");
  const repoDir = makeTmpDir("repo");
  const db = createDb(dbDir);

  // Create a project
  db.query(
    "INSERT INTO projects (id, name, path) VALUES ('proj1', 'Test Project', ?)",
  ).run(repoDir);

  const registry = new AgentRegistry();
  // Replace the default claude adapter with our mock
  (registry as any).adapters = new Map();
  registry.register(adapter);

  const wtManager = new WorktreeManager(db);
  const sessionManager = new SessionManager(db, registry, wtManager);

  return { db, repoDir, sessionManager };
}

describe("SDK Session lifecycle", () => {
  test("persists messages and session_id from SDK stream", async () => {
    const adapter = createMockAdapter([
      { type: "system", subtype: "init", session_id: "sess-test-1", tools: [], cwd: "/tmp" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from SDK!" }] },
        session_id: "sess-test-1",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 500,
        session_id: "sess-test-1",
        permission_denials: [],
      },
    ]);

    const { db, repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "test prompt",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200));

    // Check thread status
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");

    // Check session_id was persisted
    const row = db.query("SELECT session_id FROM threads WHERE id = ?").get(thread.id) as any;
    expect(row.session_id).toBe("sess-test-1");

    // Check messages were persisted (user prompt + assistant response)
    const msgs = db.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(thread.id) as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("test prompt");
    // At least one assistant message
    const assistantMsg = msgs.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Hello from SDK!");

    sessionManager.stopAll();
  });

  test("abort stops session cleanly with status done", async () => {
    // Slow messages so we can abort mid-stream
    const adapter = createMockAdapter(
      [
        { type: "system", subtype: "init", session_id: "sess-abort", tools: [], cwd: "/tmp" },
        { type: "assistant", message: { content: [{ type: "text", text: "msg 1" }] }, session_id: "sess-abort" },
        { type: "assistant", message: { content: [{ type: "text", text: "msg 2" }] }, session_id: "sess-abort" },
        { type: "assistant", message: { content: [{ type: "text", text: "msg 3" }] }, session_id: "sess-abort" },
        { type: "result", subtype: "success", session_id: "sess-abort", permission_denials: [] },
      ],
      { delayMs: 100 },
    );

    const { db, repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "slow test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Wait briefly then stop
    await new Promise((r) => setTimeout(r, 150));
    sessionManager.stopThread(thread.id);

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 100));

    const updated = getThread(db, thread.id);
    // Should be "done" not "error" since user initiated the stop
    expect(updated?.status).toBe("done");

    sessionManager.stopAll();
  });

  test("SDK error mid-stream sets status to error with message", async () => {
    // Create an adapter where the generator throws
    const errorAdapter: AgentAdapter = {
      name: "mock",
      detect: async () => true,
      getVersion: async () => "1.0.0-mock",
      supportsResume: () => true,
      start(_opts: StartOpts): AgentSession {
        async function* generate() {
          yield { type: "system", subtype: "init", session_id: "sess-err", tools: [], cwd: "/tmp" };
          yield { type: "assistant", message: { content: [{ type: "text", text: "before error" }] }, session_id: "sess-err" };
          throw new Error("SDK connection lost");
        }

        return {
          messages: generate(),
          abort: () => {},
          parseMessage(msg: unknown): ParseResult {
            const m = msg as Record<string, unknown>;
            if (m.type === "system") return { messages: [], deltas: [], sessionId: m.session_id as string };
            if (m.type === "assistant") {
              const message = m.message as any;
              const text = message?.content?.[0]?.text ?? "";
              return { messages: text ? [{ role: "assistant", content: text }] : [], deltas: [] };
            }
            return { messages: [], deltas: [] };
          },
        };
      },
    };

    const { db, repoDir, sessionManager } = setupSessionManager(errorAdapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "error test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Wait for the error to propagate
    await new Promise((r) => setTimeout(r, 200));

    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("error");
    expect(updated?.error_message).toContain("SDK connection lost");

    sessionManager.stopAll();
  });
});
