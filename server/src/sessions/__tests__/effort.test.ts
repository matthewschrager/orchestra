import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDb } from "../../db";
import { AgentRegistry } from "../../agents/registry";
import type { AgentAdapter, AgentSession, ParseResult, StartOpts } from "../../agents/types";
import { SessionManager } from "../manager";
import { WorktreeManager } from "../../worktrees/manager";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orch-effort-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createCapturingAdapter(name: "codex" | "claude", seenOpts: StartOpts[]): AgentAdapter {
  return {
    name,
    detect: async () => true,
    getVersion: async () => "test",
    supportsResume: () => true,
    start(opts: StartOpts): AgentSession {
      seenOpts.push(opts);

      async function* generate() {
        yield { type: "system", session_id: "sess-effort" };
        yield { type: "result", session_id: "sess-effort" };
      }

      return {
        messages: generate(),
        abort: () => {},
        parseMessage(msg: unknown): ParseResult {
          const event = msg as Record<string, unknown>;
          if (event.type === "system") {
            return { messages: [], deltas: [], sessionId: event.session_id as string };
          }
          if (event.type === "result") {
            return {
              messages: [],
              deltas: [{ deltaType: "turn_end", text: event.session_id as string }],
              sessionId: event.session_id as string,
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

  db.query(
    "INSERT INTO projects (id, name, path) VALUES ('proj1', 'Test Project', ?)",
  ).run(repoDir);

  const registry = new AgentRegistry();
  (registry as any).adapters = new Map();
  registry.register(adapter);

  const sessionManager = new SessionManager(
    db,
    registry,
    new WorktreeManager(db),
    join(dbDir, "uploads"),
  );

  return { db, repoDir, sessionManager };
}

describe("effort level session plumbing", () => {
  test("persists and reuses codex effort level across resumed turns", async () => {
    const seenOpts: StartOpts[] = [];
    const adapter = createCapturingAdapter("codex", seenOpts);
    const { db, repoDir, sessionManager } = setupSessionManager(adapter);

    const thread = await sessionManager.startThread({
      agent: "codex",
      effortLevel: "xhigh",
      prompt: "first turn",
      repoPath: repoDir,
      projectId: "proj1",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    sessionManager.sendMessage(thread.id, "follow-up");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const row = db.query("SELECT effort_level FROM threads WHERE id = ?").get(thread.id) as { effort_level: string | null };
    expect(row.effort_level).toBe("xhigh");
    expect(seenOpts.map((opts) => opts.effortLevel)).toEqual(["xhigh", "xhigh"]);

    sessionManager.stopAll();
  });

  test("rejects unsupported effort for claude", async () => {
    const adapter = createCapturingAdapter("claude", []);
    const { repoDir, sessionManager } = setupSessionManager(adapter);

    await expect(sessionManager.startThread({
      agent: "claude",
      effortLevel: "xhigh",
      prompt: "unsupported",
      repoPath: repoDir,
      projectId: "proj1",
    })).rejects.toThrow('Effort level "xhigh" is not supported for claude');

    sessionManager.stopAll();
  });
});
