import { nanoid } from "nanoid";
import type { DB, MessageRow, ThreadRow } from "../db";
import {
  getNextSeq,
  getThread,
  insertMessage,
  updateThread,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentProcess, ParsedMessage } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";

export interface ActiveSession {
  threadId: string;
  agentProc: AgentProcess;
  lineBuffer: string;
}

type MessageListener = (threadId: string, message: MessageRow) => void;
type ThreadListener = (thread: ThreadRow) => void;

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private messageListeners: Set<MessageListener> = new Set();
  private threadListeners: Set<ThreadListener> = new Set();
  private mainWorktreeLock: string | null = null;

  constructor(
    private db: DB,
    private registry: AgentRegistry,
    private worktreeManager: WorktreeManager,
  ) {
    this.recoverOrphanedThreads();
  }

  // ── Lifecycle ─────────────────────────────────────────

  async startThread(opts: {
    agent: string;
    prompt: string;
    repoPath: string;
    title?: string;
    isolate?: boolean;
  }): Promise<ThreadRow> {
    const adapter = this.registry.get(opts.agent);
    if (!adapter) throw new Error(`Unknown agent: ${opts.agent}`);

    const threadId = nanoid(12);
    const title = opts.title || opts.prompt.slice(0, 80);
    let cwd = opts.repoPath;
    let worktree: string | null = null;
    let branch: string | null = null;

    // Main worktree concurrency check
    if (!opts.isolate) {
      if (this.mainWorktreeLock && this.sessions.has(this.mainWorktreeLock)) {
        throw new Error(
          `Main worktree is in use by thread ${this.mainWorktreeLock}. ` +
            `Isolate this thread to a worktree, or stop the other thread first.`,
        );
      }
      this.mainWorktreeLock = threadId;
    } else {
      const wt = await this.worktreeManager.create(threadId, opts.repoPath);
      cwd = wt.path;
      worktree = wt.path;
      branch = wt.branch;
    }

    // Insert thread record
    this.db
      .query(
        `INSERT INTO threads (id, title, agent, repo_path, worktree, branch, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(threadId, title, opts.agent, opts.repoPath, worktree, branch);

    // Spawn agent
    const agentProc = adapter.spawn({ cwd });
    const pid = agentProc.proc.pid;
    updateThread(this.db, threadId, { pid, status: "running" });

    const session: ActiveSession = { threadId, agentProc, lineBuffer: "" };
    this.sessions.set(threadId, session);

    // Persist user prompt as first message
    this.persistMessage(threadId, {
      role: "user",
      content: opts.prompt,
    });

    // Send prompt to agent stdin
    adapter.sendInput(agentProc, opts.prompt);

    // Start reading stdout
    this.readStream(session, adapter);

    // Watch for exit
    agentProc.proc.exited.then((exitCode) => {
      this.handleExit(threadId, exitCode);
    });

    return getThread(this.db, threadId)!;
  }

  stopThread(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.agentProc.proc.kill();
    this.sessions.delete(threadId);
    if (this.mainWorktreeLock === threadId) this.mainWorktreeLock = null;
    updateThread(this.db, threadId, { status: "done", pid: null });
    this.notifyThread(threadId);
  }

  stopAll(): void {
    for (const [id] of this.sessions) {
      this.stopThread(id);
    }
  }

  sendMessage(threadId: string, content: string): void {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No active session for thread ${threadId}`);
    const adapter = this.registry.get(
      (getThread(this.db, threadId) as ThreadRow).agent,
    )!;

    this.persistMessage(threadId, { role: "user", content });
    adapter.sendInput(session.agentProc, content);
  }

  isRunning(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  // ── Listeners ─────────────────────────────────────────

  onMessage(fn: MessageListener): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onThreadUpdate(fn: ThreadListener): () => void {
    this.threadListeners.add(fn);
    return () => this.threadListeners.delete(fn);
  }

  // ── Private ───────────────────────────────────────────

  private async readStream(session: ActiveSession, adapter: AgentAdapter) {
    const stdout = session.agentProc.proc.stdout;
    const decoder = new TextDecoder();

    try {
      for await (const chunk of stdout) {
        session.lineBuffer += decoder.decode(chunk, { stream: true });
        const lines = session.lineBuffer.split("\n");
        session.lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const messages = adapter.parseOutput(line);
          for (const msg of messages) {
            this.persistMessage(session.threadId, msg);
          }
        }
      }

      // Flush remaining buffer
      if (session.lineBuffer.trim()) {
        const messages = adapter.parseOutput(session.lineBuffer);
        for (const msg of messages) {
          this.persistMessage(session.threadId, msg);
        }
      }
    } catch (err) {
      console.error(`Stream read error for thread ${session.threadId}:`, err);
    }
  }

  private persistMessage(
    threadId: string,
    parsed: Pick<ParsedMessage, "content"> & Partial<ParsedMessage> & { role: string },
  ): void {
    const seq = getNextSeq(this.db, threadId);
    const msg: MessageRow = {
      id: nanoid(12),
      thread_id: threadId,
      seq,
      role: parsed.role,
      content: parsed.content,
      tool_name: parsed.toolName ?? null,
      tool_input: parsed.toolInput ?? null,
      tool_output: parsed.toolOutput ?? null,
      metadata: parsed.metadata ? JSON.stringify(parsed.metadata) : null,
      created_at: new Date().toISOString(),
    };

    try {
      insertMessage(this.db, msg);
    } catch (err) {
      console.error("Failed to persist message:", err);
    }

    for (const fn of this.messageListeners) {
      try {
        fn(threadId, msg);
      } catch {}
    }
  }

  private handleExit(threadId: string, exitCode: number): void {
    this.sessions.delete(threadId);
    if (this.mainWorktreeLock === threadId) this.mainWorktreeLock = null;
    const status = exitCode === 0 ? "done" : "error";
    updateThread(this.db, threadId, { status, pid: null });
    this.notifyThread(threadId);
  }

  private notifyThread(threadId: string): void {
    const thread = getThread(this.db, threadId);
    if (!thread) return;
    for (const fn of this.threadListeners) {
      try {
        fn(thread);
      } catch {}
    }
  }

  private recoverOrphanedThreads(): void {
    const running = this.db
      .query("SELECT * FROM threads WHERE status = 'running'")
      .all() as ThreadRow[];

    for (const thread of running) {
      if (thread.pid) {
        try {
          process.kill(thread.pid, 0); // Check if alive
          // Process still alive — kill it
          process.kill(thread.pid, "SIGTERM");
        } catch {
          // Already dead
        }
      }
      updateThread(this.db, thread.id, { status: "error", pid: null });
    }
  }
}
