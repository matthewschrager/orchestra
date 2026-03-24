import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ServerWebSocket } from "bun";
import { createDb, insertMessage } from "../../db";
import { createWSHandler } from "../handler";
import type { SessionManager } from "../../sessions/manager";
import type { WSServerMessage } from "shared";

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

function createSessionManagerStub(): SessionManager {
  const noop = () => () => {};
  return {
    onMessage: noop,
    onStreamDelta: noop,
    onThreadUpdate: noop,
    onAttention: noop,
    onAttentionResolved: noop,
    sendMessage() {},
    stopThread() {},
    resolveAttention() { return null; },
  } as unknown as SessionManager;
}

describe("WS subscribe replay", () => {
  test("sends the current thread snapshot before replaying persisted messages", () => {
    const dataDir = makeTmpDir("ws");
    const db = createDb(dataDir);
    db.query("INSERT INTO projects (id, name, path) VALUES ('p1', 'Project', '/tmp')").run();
    db.query(
      `INSERT INTO threads (id, title, agent, repo_path, project_id, status)
       VALUES ('t1', 'Thread title', 'claude', '/tmp', 'p1', 'done')`,
    ).run();
    insertMessage(db, {
      id: "m1",
      thread_id: "t1",
      role: "assistant",
      content: "Persisted reply",
      tool_name: null,
      tool_input: null,
      tool_output: null,
      metadata: null,
      created_at: new Date().toISOString(),
    });

    const wsHandler = createWSHandler(createSessionManagerStub(), db);
    const sent: WSServerMessage[] = [];
    const ws = {
      data: { subscriptions: new Set<string>() },
      send(payload: string) {
        sent.push(JSON.parse(payload) as WSServerMessage);
      },
    } as unknown as ServerWebSocket<{ subscriptions: Set<string> }>;

    wsHandler.open(ws);
    wsHandler.message(ws, JSON.stringify({ type: "subscribe", threadId: "t1", lastSeq: 0 }));

    expect(sent[0]).toMatchObject({
      type: "thread_updated",
      thread: { id: "t1", status: "done" },
    });
    expect(sent[1]).toMatchObject({
      type: "message",
      message: { threadId: "t1", content: "Persisted reply" },
    });
    expect(sent.at(-1)).toMatchObject({ type: "replay_done", threadId: "t1" });

    db.close();
  });
});
