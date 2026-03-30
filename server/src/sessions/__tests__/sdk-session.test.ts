import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDb, getThread, getPendingAttention } from "../../db";
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

  test("non-persistent session: AskUser attention can be resolved and resumed with stored session_id", async () => {
    const seenStarts: Array<{ prompt: string; resumeSessionId?: string }> = [];
    let turn = 0;

    const adapter: AgentAdapter = {
      name: "mock",
      detect: async () => true,
      getVersion: async () => "1.0.0-mock",
      supportsResume: () => true,
      start(opts: StartOpts): AgentSession {
        seenStarts.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId });
        turn += 1;

        async function* generate() {
          yield { type: "system", subtype: "init", session_id: "sess-legacy-attn", tools: [], cwd: "/tmp" };

          if (turn === 1) {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "I need your input." }] },
              session_id: "sess-legacy-attn",
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sess-legacy-attn",
              permission_denials: [],
              _hasAttention: true,
            };
            return;
          }

          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Thanks, I'll continue with main." }] },
            session_id: "sess-legacy-attn",
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-legacy-attn",
            permission_denials: [],
          };
        }

        return {
          messages: generate(),
          abort: () => {},
          parseMessage(msg: unknown): ParseResult {
            const m = msg as Record<string, unknown>;

            if (m.type === "system") {
              return { messages: [], deltas: [], sessionId: m.session_id as string | undefined };
            }

            if (m.type === "assistant") {
              const message = m.message as { content?: Array<{ type: string; text?: string }> };
              const text = message?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "";
              return { messages: text ? [{ role: "assistant", content: text }] : [], deltas: [] };
            }

            if (m.type === "result") {
              const result: ParseResult = {
                messages: [],
                deltas: [{ deltaType: "turn_end" }],
                sessionId: m.session_id as string | undefined,
              };
              if (m._hasAttention) {
                result.attention = {
                  kind: "ask_user",
                  prompt: "Which branch should I use?",
                  options: ["main", "release"],
                };
              }
              return result;
            }

            return { messages: [], deltas: [] };
          },
        };
      },
    };

    const { db, repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "legacy attention test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    await new Promise((r) => setTimeout(r, 100));

    let updated = getThread(db, thread.id);
    expect(updated?.status).toBe("waiting");
    expect(seenStarts).toEqual([{ prompt: "legacy attention test", resumeSessionId: undefined }]);

    const pending = getPendingAttention(db, thread.id);
    expect(pending).toHaveLength(1);

    await sessionManager.resolveAttention(pending[0].id, { type: "user", optionIndex: 0 });
    await new Promise((r) => setTimeout(r, 100));

    updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");
    expect(seenStarts).toEqual([
      { prompt: "legacy attention test", resumeSessionId: undefined },
      { prompt: 'User selected: "main"', resumeSessionId: "sess-legacy-attn" },
    ]);

    const messages = db.query("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY seq").all(thread.id) as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.role === "assistant" && message.content.includes("continue with main"))).toBe(true);

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
  let startCalls: Array<{ prompt: string; resumeSessionId?: string }> = [];
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
      startCalls.push({ prompt: _opts.prompt, resumeSessionId: _opts.resumeSessionId });
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
    getStartCalls: () => startCalls,
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

  test("persistent session: stopThread can continue with the next queued message", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "stop and continue",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-stop-next", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    sessionManager.sendMessage(thread.id, "continue with this instead");
    sessionManager.stopThread(thread.id, { drainQueued: true });
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.isClosed()).toBe(true);

    const startCalls = mock.getStartCalls();
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1]).toMatchObject({
      prompt: "continue with this instead",
      resumeSessionId: "sess-stop-next",
    });

    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("running");
    expect(sessionManager.isRunning(thread.id)).toBe(true);

    const queueRows = db.query(
      "SELECT delivered_at FROM message_queue WHERE thread_id = ? ORDER BY created_at ASC",
    ).all(thread.id) as Array<{ delivered_at: string | null }>;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]!.delivered_at).not.toBeNull();

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

    // Regular steering should stay queued until the current turn finishes
    expect(mock.getInjectCalls()).toHaveLength(0);

    const pendingQueue = db.query(
      "SELECT content, delivered_at FROM message_queue WHERE thread_id = ? ORDER BY created_at ASC",
    ).all(thread.id) as Array<{ content: string; delivered_at: string | null }>;
    expect(pendingQueue).toHaveLength(1);
    expect(pendingQueue[0]!.content).toBe("queued message 1");
    expect(pendingQueue[0]!.delivered_at).toBeNull();

    // Verify queued_message delta was emitted
    const queuedDeltas = deltas.filter((d) => d.deltaType === "queued_message");
    expect(queuedDeltas.length).toBe(1);
    expect(queuedDeltas[0].queuedCount).toBe(1);

    sessionManager.stopAll();
  });

  test("persistent session: queued steering auto-starts on the next turn", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const deltas: Array<{ deltaType: string; queuedCount?: number }> = [];
    sessionManager.onStreamDelta((_threadId, delta) => {
      deltas.push({ deltaType: delta.deltaType, queuedCount: delta.queuedCount });
    });

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "next-turn test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-next", tools: [], cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));

    sessionManager.sendMessage(thread.id, "pick this up next turn");
    expect(mock.getInjectCalls()).toHaveLength(0);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-next",
      permission_denials: [],
    });
    await new Promise((r) => setTimeout(r, 100));

    const injects = mock.getInjectCalls();
    expect(injects).toHaveLength(1);
    expect(injects[0]).toMatchObject({
      text: "pick this up next turn",
      sessionId: "sess-next",
    });

    const queueRows = db.query(
      "SELECT delivered_at FROM message_queue WHERE thread_id = ? ORDER BY created_at ASC",
    ).all(thread.id) as Array<{ delivered_at: string | null }>;
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]!.delivered_at).not.toBeNull();

    const queuedCounts = deltas
      .filter((d) => d.deltaType === "queued_message")
      .map((d) => d.queuedCount);
    expect(queuedCounts).toEqual([1, 0]);

    sessionManager.stopAll();
  });

  test("persistent session: queue depth limit (max 5)", async () => {
    const mock = createPersistentMockAdapter();
    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

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
    expect(mock.getInjectCalls()).toHaveLength(0);
    const pendingCount = db.query(
      "SELECT COUNT(*) as count FROM message_queue WHERE thread_id = ? AND delivered_at IS NULL",
    ).get(thread.id) as { count: number };
    expect(pendingCount.count).toBe(5);

    // 6th should throw "Queue full"
    expect(() => {
      sessionManager.sendMessage(thread.id, "one too many");
    }).toThrow("Queue full");

    sessionManager.stopAll();
  });

  test("persistent session: queuedCount reflects remaining backlog after turn_end", async () => {
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
    expect(mock.getInjectCalls()).toHaveLength(0);

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
    await new Promise((r) => setTimeout(r, 100));

    expect(mock.getInjectCalls()).toHaveLength(1);

    const queuedCounts = deltas
      .filter((d) => d.deltaType === "queued_message")
      .map((d) => d.queuedCount);
    expect(queuedCounts).toEqual([1, 2, 1]);

    // One queued follow-up is now in flight, so four more queued messages fit.
    for (let i = 1; i <= 4; i++) {
      sessionManager.sendMessage(thread.id, `after-reset ${i}`);
    }
    expect(() => {
      sessionManager.sendMessage(thread.id, "after-reset 5");
    }).toThrow("Queue full");

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

    // Sending while thinking on a non-persistent adapter should queue (not throw)
    expect(() => {
      sessionManager.sendMessage(thread.id, "impatient message");
    }).not.toThrow();

    sessionManager.stopAll();
  });

  test("non-persistent session: queued messages are persisted to SQLite", async () => {
    const adapter = createMockAdapter([
      { type: "system", subtype: "init", session_id: "sess-npq", tools: [], cwd: "/tmp" },
      { type: "assistant", message: { content: [{ type: "text", text: "Working..." }] }, session_id: "sess-npq" },
      { type: "result", subtype: "success", session_id: "sess-npq", total_cost_usd: 0.01, duration_ms: 100 },
    ], { delayMs: 200 });
    const { db, repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "queue persist test",
      repoPath: repoDir,
      projectId: "proj1",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Queue a message while thinking
    sessionManager.sendMessage(thread.id, "queued follow-up");

    // Check it's in the message_queue table
    const { countPendingQueue } = await import("../../db");
    const pendingCount = countPendingQueue(db, thread.id);
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    sessionManager.stopAll();
  });

  test("persistent session: interrupt sends with priority 'now'", async () => {
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

    // Send with interrupt flag
    sessionManager.sendMessage(thread.id, "interrupt now!", undefined, { interrupt: true });

    // Verify injectMessage was called with priority "now"
    const calls = mock.getInjectCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.priority).toBe("now");

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

  test("persistent session: stale attention items don't prevent done transition", async () => {
    // Regression test: when a user sends a follow-up message without resolving
    // an AskUserQuestion attention item, the thread gets stuck in "running" forever
    // because the turn_end handler sees hasPendingAttention=true and skips the
    // status→"done" transition.
    const mock = createPersistentMockAdapter();

    // Override parseMessage to emit an attention event on "ask_user" type messages
    const origStartPersistent = mock.adapter.startPersistent!.bind(mock.adapter);
    mock.adapter.startPersistent = (opts: StartOpts) => {
      const session = origStartPersistent(opts);
      const origParse = session.parseMessage;
      session.parseMessage = (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        // When we get a special "ask_user" message, emit attention
        if (m.type === "result" && m._hasAttention) {
          const base = origParse(msg);
          base.attention = {
            kind: "ask_user",
            prompt: "What do you prefer?",
            options: ["A", "B"],
          };
          return base;
        }
        return origParse(msg);
      };
      return session;
    };

    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);
    const resolvedEvents: Array<{ attentionId: string; threadId: string }> = [];
    sessionManager.onAttentionResolved((attentionId, threadId) => {
      resolvedEvents.push({ attentionId, threadId });
    });

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "attention test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Turn 1: agent asks a question via AskUserQuestion → result with attention
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-attn", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Let me ask you something" }] },
      session_id: "sess-attn",
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-attn",
      permission_denials: [],
      _hasAttention: true, // triggers attention in our mock parser
    });

    await new Promise((r) => setTimeout(r, 100));

    // Thread should be "waiting" (attention item created)
    let updated = getThread(db, thread.id);
    expect(updated?.status).toBe("waiting");

    // Verify attention item exists
    const pendingBefore = getPendingAttention(db, thread.id);
    expect(pendingBefore.length).toBe(1);
    const attentionId = pendingBefore[0].id;

    // User sends a follow-up WITHOUT resolving the attention item (bypasses UI)
    sessionManager.sendMessage(thread.id, "I prefer option A");

    await new Promise((r) => setTimeout(r, 50));

    // After sendMessage, stale attention items should be orphaned
    const pendingAfterSend = getPendingAttention(db, thread.id);
    expect(pendingAfterSend.length).toBe(0);
    expect(resolvedEvents).toEqual([{ attentionId, threadId: thread.id }]);

    // Thread should now be "running" (new turn started)
    updated = getThread(db, thread.id);
    expect(updated?.status).toBe("running");

    // Turn 2: agent processes the response and completes normally
    mock.pushMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Got it, option A!" }] },
      session_id: "sess-attn",
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-attn",
      permission_denials: [],
    });

    await new Promise((r) => setTimeout(r, 100));

    // Thread should be "done" — NOT stuck at "running"
    updated = getThread(db, thread.id);
    expect(updated?.status).toBe("done");

    sessionManager.stopAll();
  });

  test("ExitPlanMode creates attention item immediately (same flow as AskUserQuestion)", async () => {
    const mock = createPersistentMockAdapter();

    // Override parseMessage to emit an attention event for ExitPlanMode tool_use
    // (mirrors how the real ClaudeParser creates attention for ExitPlanMode)
    const origStartPersistent = mock.adapter.startPersistent!.bind(mock.adapter);
    mock.adapter.startPersistent = (opts: StartOpts) => {
      const session = origStartPersistent(opts);
      const origParse = session.parseMessage.bind(session);
      session.parseMessage = (msg: unknown) => {
        const result = origParse(msg);
        const m = msg as Record<string, unknown>;
        if (m.type === "assistant") {
          const message = m.message as { content?: Array<{ type: string; name?: string }> };
          if (message?.content?.some(b => b.type === "tool_use" && b.name === "ExitPlanMode")) {
            result.attention = {
              kind: "confirmation",
              prompt: "Agent has a plan ready and wants to proceed with implementation.",
              options: ["Approve plan", "Reject plan"],
              metadata: { source: "exit_plan_mode" },
            };
          }
        }
        return result;
      };
      return session;
    };

    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "plan mode test",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit init
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-plan", tools: [], cwd: "/tmp" });
    // Emit assistant message with ExitPlanMode tool_use — attention created immediately
    mock.pushMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: {} },
        ],
      },
      session_id: "sess-plan",
    });
    // Emit turn end
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-plan",
      permission_denials: [],
    });

    await new Promise((r) => setTimeout(r, 150));

    // Thread should be "waiting" (attention item created from parser attention event)
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("waiting");

    // Attention item should exist in DB
    const attention = db.query(
      "SELECT * FROM attention_required WHERE thread_id = ? AND resolved_at IS NULL",
    ).all(thread.id) as any[];
    expect(attention.length).toBe(1);
    expect(attention[0].kind).toBe("confirmation");
    expect(attention[0].prompt).toContain("plan");

    const options = JSON.parse(attention[0].options);
    expect(options).toContain("Approve plan");
    expect(options).toContain("Reject plan");

    // No injectMessage calls — no auto-approval happened
    expect(mock.getInjectCalls().length).toBe(0);

    sessionManager.stopAll();
  });

  test("ExitPlanMode: stream death after attention created keeps waiting status", async () => {
    const mock = createPersistentMockAdapter();

    // Override parseMessage to emit attention for ExitPlanMode
    const origStartPersistent = mock.adapter.startPersistent!.bind(mock.adapter);
    mock.adapter.startPersistent = (opts: StartOpts) => {
      const session = origStartPersistent(opts);
      const origParse = session.parseMessage.bind(session);
      session.parseMessage = (msg: unknown) => {
        const result = origParse(msg);
        const m = msg as Record<string, unknown>;
        if (m.type === "assistant") {
          const message = m.message as { content?: Array<{ type: string; name?: string }> };
          if (message?.content?.some(b => b.type === "tool_use" && b.name === "ExitPlanMode")) {
            result.attention = {
              kind: "confirmation",
              prompt: "Agent has a plan ready and wants to proceed with implementation.",
              options: ["Approve plan", "Reject plan"],
              metadata: { source: "exit_plan_mode" },
            };
          }
        }
        return result;
      };
      return session;
    };

    const { db, repoDir, sessionManager } = setupSessionManager(mock.adapter);

    const thread = await sessionManager.startThread({
      agent: "mock",
      prompt: "stream death plan mode",
      repoPath: repoDir,
      projectId: "proj1",
    });

    // Emit init + ExitPlanMode (attention created immediately) but NO turn_end
    mock.pushMessage({ type: "system", subtype: "init", session_id: "sess-plan2", tools: [], cwd: "/tmp" });
    mock.pushMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_exit2", name: "ExitPlanMode", input: {} },
        ],
      },
      session_id: "sess-plan2",
    });
    await new Promise((r) => setTimeout(r, 50));

    // Attention should already be created (before stream death)
    const pendingBefore = getPendingAttention(db, thread.id);
    expect(pendingBefore.length).toBe(1);

    // Kill stream without turn_end
    mock.finish();
    await new Promise((r) => setTimeout(r, 150));

    // Thread should be "waiting" — attention was created before stream died
    const updated = getThread(db, thread.id);
    expect(updated?.status).toBe("waiting");

    // Attention item should still exist
    const attention = db.query(
      "SELECT * FROM attention_required WHERE thread_id = ? AND resolved_at IS NULL",
    ).all(thread.id) as any[];
    expect(attention.length).toBe(1);
    expect(attention[0].kind).toBe("confirmation");
    expect(JSON.parse(attention[0].metadata)).toEqual({ source: "exit_plan_mode" });

    sessionManager.stopAll();
  });
});
