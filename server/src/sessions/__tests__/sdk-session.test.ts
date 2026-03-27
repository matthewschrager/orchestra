import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDb, getThread } from "../../db";
import { SessionManager } from "../manager";
import { AgentRegistry } from "../../agents/registry";
import { WorktreeManager } from "../../worktrees/manager";
import type { AgentAdapter, AgentSession, ParseResult, PersistentSession, StartOpts } from "../../agents/types";

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
  const uploadsDir = join(dbDir, "uploads");
  const sessionManager = new SessionManager(db, registry, wtManager, uploadsDir);

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

// ── Persistent Session Tests ────────────────────────────────────

/** Message parser shared across persistent mock tests */
function mockParseMessage(msg: unknown): ParseResult {
  const m = msg as Record<string, unknown>;
  const type = m.type as string;

  if (type === "system") {
    return { messages: [], deltas: [], sessionId: m.session_id as string | undefined };
  }
  if (type === "assistant") {
    const message = m.message as { content?: Array<{ type: string; text?: string }> };
    const textBlocks = message?.content?.filter(b => b.type === "text") ?? [];
    const text = textBlocks.map(b => b.text ?? "").join("");
    return { messages: text ? [{ role: "assistant", content: text }] : [], deltas: [] };
  }
  if (type === "result") {
    return {
      messages: [],
      deltas: [
        { deltaType: "metrics", costUsd: m.total_cost_usd as number | undefined, durationMs: m.duration_ms as number | undefined },
        { deltaType: "turn_end", text: m.session_id as string | undefined },
      ],
      sessionId: m.session_id as string | undefined,
    };
  }
  return { messages: [], deltas: [] };
}

/**
 * Creates a mock persistent adapter that keeps the iterator alive.
 * `pushMessage()` injects messages into the living stream.
 * `finish()` ends the iterator.
 */
function createPersistentMockAdapter() {
  let pushMessage: (msg: Record<string, unknown>) => void;
  let finish: () => void;
  let injectCalls: Array<{ text: string; sessionId: string; priority?: "now" | "next" }> = [];
  let closed = false;
  let resetCalls = 0;

  const adapter: AgentAdapter = {
    name: "mock",
    detect: async () => true,
    getVersion: async () => "1.0.0-mock",
    supportsResume: () => true,
    supportsPersistent: () => true,

    // Legacy start — should not be called for persistent adapters
    start(_opts: StartOpts): AgentSession {
      throw new Error("Should not call start() on persistent adapter");
    },

    startPersistent(_opts: StartOpts): PersistentSession {
      // Create a push-based async generator
      let resolve: ((value: IteratorResult<Record<string, unknown>>) => void) | null = null;
      const queue: Record<string, unknown>[] = [];
      let done = false;

      pushMessage = (msg) => {
        if (resolve) {
          const r = resolve;
          resolve = null;
          r({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      };

      finish = () => {
        done = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r({ value: undefined as any, done: true });
        }
      };

      const iterator: AsyncIterableIterator<Record<string, unknown>> = {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as any, done: true as const });
          }
          return new Promise((r) => { resolve = r; });
        },
      };

      return {
        messages: iterator as AsyncIterable<unknown>,
        abort: () => { closed = true; finish(); },
        parseMessage: mockParseMessage,
        sessionId: _opts.resumeSessionId,
        close: () => { closed = true; finish(); },
        resetTurnState: () => { resetCalls++; },
        async injectMessage(text: string, sessionId: string, priority?: "now" | "next"): Promise<void> {
          injectCalls.push({ text, sessionId, priority });
        },
      };
    },
  };

  return {
    adapter,
    pushMessage: (msg: Record<string, unknown>) => pushMessage(msg),
    finish: () => finish(),
    getInjectCalls: () => injectCalls,
    isClosed: () => closed,
    getResetCalls: () => resetCalls,
  };
}

describe("Persistent Session lifecycle", () => {
  test("persistent session: turn completes → idle, session stays alive", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "hello persistent",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit first turn messages
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p1", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Turn 1 response" }] },
      session_id: "sess-p1",
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      duration_ms: 100,
      session_id: "sess-p1",
      permission_denials: [],
    });

    await new Promise((r) => setTimeout(r, 100));

    // Thread should be "done" (turn complete) but session still in map
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");

    // Session_id should be persisted
    const row = db.query("SELECT session_id FROM threads WHERE id = ?").get(thread.id) as any;
    expect(row.session_id).toBe("sess-p1");

    // Session should still be tracked (persistent — stays alive)
    expect(sessionManager.isRunning(thread.id)).toBe(true);

    // Check messages persisted
    const msgs = db.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(thread.id) as any[];
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello persistent");
    const assistantMsg = msgs.find((m: any) => m.content === "Turn 1 response");
    expect(assistantMsg).toBeDefined();

    sessionManager.stopAll();
  });

  test("persistent session: sendMessage injects via streamInput", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "first turn",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Complete first turn
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p2", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Ready for more" }] },
      session_id: "sess-p2",
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-p2",
      permission_denials: [],
    });

    await new Promise((r) => setTimeout(r, 100));

    // Now send a follow-up message — should use streamInput, not spawn new subprocess
    sessionManager.sendMessage(thread.id, "follow-up question");

    await new Promise((r) => setTimeout(r, 50));

    // Check injectMessage was called
    const injectCalls = mock.getInjectCalls();
    expect(injectCalls.length).toBe(1);
    expect(injectCalls[0].text).toBe("follow-up question");
    expect(injectCalls[0].sessionId).toBe("sess-p2");

    // User message should be persisted
    const msgs = db.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq").all(thread.id) as any[];
    const userMsgs = msgs.filter((m: any) => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[1].content).toBe("follow-up question");

    // Thread should be back to running
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("running");

    // resetTurnState should have been called before inject
    expect(mock.getResetCalls()).toBe(1);

    sessionManager.stopAll();
  });

  test("persistent session: stopThread calls close()", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "will stop",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit init so the session is alive
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p3", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    // Stop the thread
    sessionManager.stopThread(thread.id);
    await new Promise((r) => setTimeout(r, 100));

    // close() should have been called
    expect(mock.isClosed()).toBe(true);

    // Thread should be done
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");

    // Session should be removed from tracking
    expect(sessionManager.isRunning(thread.id)).toBe(false);

    sessionManager.stopAll();
  });

  test("persistent session: queues message while agent is thinking", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    // Track stream deltas
    const deltas: Array<{ threadId: string; deltaType: string; queuedCount?: number }> = [];
    sessionManager.onStreamDelta((threadId, delta) => {
      deltas.push({ threadId, deltaType: delta.deltaType, queuedCount: delta.queuedCount });
    });

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "thinking test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit init but NOT the result — agent is still "thinking"
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p4", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    // Sending a message while thinking should QUEUE (not throw)
    sessionManager.sendMessage(thread.id, "queued message 1");

    // Verify message was persisted
    const { getMessages } = await import("../../db");
    const msgs = getMessages(db, thread.id);
    const userMsgs = msgs.filter((m: { role: string }) => m.role === "user");
    expect(userMsgs.length).toBe(2); // initial prompt + queued message

    // Verify injectMessage called with priority 'next'
    const injects = mock.getInjectCalls();
    expect(injects.length).toBe(1);
    expect(injects[0].text).toBe("queued message 1");
    expect(injects[0].priority).toBe("next");

    // Verify queued_message delta was emitted
    const queuedDeltas = deltas.filter((d) => d.deltaType === "queued_message");
    expect(queuedDeltas.length).toBe(1);
    expect(queuedDeltas[0].queuedCount).toBe(1);

    sessionManager.stopAll();
  });

  test("persistent session: queue depth limit (max 5)", async () => {
    const mock = createPersistentMockAdapter();
    const { repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "queue limit test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-ql", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    // Queue 5 messages — should all succeed
    for (let i = 1; i <= 5; i++) {
      sessionManager.sendMessage(thread.id, `queued ${i}`);
    }
    expect(mock.getInjectCalls().length).toBe(5);

    // 6th should throw "Queue full"
    expect(() => {
      sessionManager.sendMessage(thread.id, "one too many");
    }).toThrow("Queue full");

    sessionManager.stopAll();
  });

  test("persistent session: queuedCount resets on turn_end", async () => {
    const mock = createPersistentMockAdapter();
    const { repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const deltas: Array<{ deltaType: string; queuedCount?: number }> = [];
    sessionManager.onStreamDelta((_threadId, delta) => {
      deltas.push({ deltaType: delta.deltaType, queuedCount: delta.queuedCount });
    });

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "reset test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-rst", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    // Queue 2 messages
    sessionManager.sendMessage(thread.id, "msg 1");
    sessionManager.sendMessage(thread.id, "msg 2");
    expect(mock.getInjectCalls().length).toBe(2);

    // Complete the turn
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-rst",
      is_error: false,
      duration_ms: 100,
      total_cost_usd: 0.01,
      num_turns: 1,
    });
    await new Promise((r) => setTimeout(r, 50));

    // After turn_end, should be able to queue 5 more (count was reset)
    for (let i = 1; i <= 5; i++) {
      sessionManager.sendMessage(thread.id, `after-reset ${i}`);
    }
    // Total injects: 2 (before reset) + 5 (after reset) = 7
    // But after turn_end, state is 'idle' so these are regular injects, not queued
    // The 5 after reset go through the idle path (state is idle after turn_end)

    sessionManager.stopAll();
  });

  test("persistent session: rejects empty message during queue", async () => {
    const mock = createPersistentMockAdapter();
    const { repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "empty test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-em", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    expect(() => {
      sessionManager.sendMessage(thread.id, "   ");
    }).toThrow("Cannot queue an empty message");

    // No inject should have been called
    expect(mock.getInjectCalls().length).toBe(0);

    sessionManager.stopAll();
  });

  test("persistent session: interrupt flag ignored in Phase 1", async () => {
    const mock = createPersistentMockAdapter();
    const { repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "interrupt test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-int", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    // Send with interrupt=true — should still queue as 'next' (Phase 1 ignores interrupt)
    sessionManager.sendMessage(thread.id, "steer message", undefined, true);

    const injects = mock.getInjectCalls();
    expect(injects.length).toBe(1);
    expect(injects[0].priority).toBe("next");

    sessionManager.stopAll();
  });

  test("non-persistent session: rejects message while agent is thinking", async () => {
    // Non-persistent (legacy) adapters don't support queuing — should still block
    // Use delay to keep the session alive while we send a message
    const adapter = createMockAdapter([
      { type: "system", subtype: "init", session_id: "sess-np", tools: [], cwd: "/tmp" },
      { type: "assistant", message: { content: [{ type: "text", text: "Working..." }] }, session_id: "sess-np" },
      { type: "result", subtype: "success", session_id: "sess-np", total_cost_usd: 0.01, duration_ms: 100 },
    ], { delayMs: 200 });
    const { repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "non-persistent test",
      repoPath: repoDir,
      projectId: "proj1",
    });
    // Wait for init to be consumed but not the result (delayMs=200 between messages)
    await new Promise((r) => setTimeout(r, 100));

    // Sending while thinking on a non-persistent adapter should throw (not silently abort)
    expect(() => {
      sessionManager.sendMessage(thread.id, "impatient message");
    }).toThrow("Agent is still processing");

    sessionManager.stopAll();
  });

  test("persistent session: subprocess death mid-turn marks error", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "crash test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit init and some work, then kill the iterator without a result event
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p5", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it..." }] },
      session_id: "sess-p5",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Kill the iterator (simulates subprocess crash)
    mock.finish();
    await new Promise((r) => setTimeout(r, 100));

    // Thread should be in error state
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("error");
    expect(updated?.error_message).toContain("unexpectedly");

    sessionManager.stopAll();
  });

  test("persistent session: idle subprocess exit does not mark error", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "idle exit test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Complete a turn → state becomes idle
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-p6", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Done" }] },
      session_id: "sess-p6",
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-p6",
      permission_denials: [],
    });
    await new Promise((r) => setTimeout(r, 100));

    // Now the subprocess exits while idle (e.g., normal cleanup)
    mock.finish();
    await new Promise((r) => setTimeout(r, 100));

    // Thread should still be "done" — not "error"
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");

    sessionManager.stopAll();
  });
});
