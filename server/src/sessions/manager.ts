import { nanoid } from "nanoid";
import type { DB, MessageRow, ThreadRow } from "../db";
import {
  getThread,
  insertMessage,
  updateThread,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentProcess, ParsedMessage } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";
import type { StreamDelta } from "shared";

export interface ActiveSession {
  threadId: string;
  agentProc: AgentProcess;
  lineBuffer: string;
  sessionId: string | null;
  cwd: string;
}

type MessageListener = (threadId: string, message: MessageRow) => void;
type ThreadListener = (thread: ThreadRow) => void;
type StreamDeltaListener = (threadId: string, delta: StreamDelta) => void;

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private messageListeners: Set<MessageListener> = new Set();
  private threadListeners: Set<ThreadListener> = new Set();
  private streamDeltaListeners: Set<StreamDeltaListener> = new Set();
  private mainWorktreeLocks: Map<string, string> = new Map();

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
    projectId: string;
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

    // Per-project main worktree concurrency check
    if (!opts.isolate) {
      const existingLock = this.mainWorktreeLocks.get(opts.projectId);
      if (existingLock && this.sessions.has(existingLock)) {
        throw new Error(
          `Main worktree for this project is in use by thread ${existingLock}. ` +
            `Isolate this thread to a worktree, or stop the other thread first.`,
        );
      }
      this.mainWorktreeLocks.set(opts.projectId, threadId);
    } else {
      const wt = await this.worktreeManager.create(threadId, opts.repoPath);
      cwd = wt.path;
      worktree = wt.path;
      branch = wt.branch;
    }

    // Insert thread record
    this.db
      .query(
        `INSERT INTO threads (id, title, agent, repo_path, project_id, worktree, branch, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(threadId, title, opts.agent, opts.repoPath, opts.projectId, worktree, branch);

    // Persist user prompt as first message
    this.persistMessage(threadId, {
      role: "user",
      content: opts.prompt,
    });

    // Spawn agent with -p (prompt mode)
    this.spawnTurn(threadId, adapter, cwd, opts.prompt, null);

    return getThread(this.db, threadId)!;
  }

  stopThread(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.agentProc.proc.kill();
    this.sessions.delete(threadId);
    this.clearMainWorktreeLock(threadId);
    updateThread(this.db, threadId, { status: "done", pid: null });
    this.notifyThread(threadId);
  }

  stopAll(): void {
    for (const [id] of this.sessions) {
      this.stopThread(id);
    }
  }

  sendMessage(threadId: string, content: string): void {
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const adapter = this.registry.get(thread.agent);
    if (!adapter) throw new Error(`Unknown agent: ${thread.agent}`);

    // If there's already a running process for this thread, kill it first
    const existingSession = this.sessions.get(threadId);
    if (existingSession) {
      existingSession.agentProc.proc.kill();
      this.sessions.delete(threadId);
    }

    // Persist user message
    this.persistMessage(threadId, { role: "user", content });

    // Get the cwd — use worktree if isolated, otherwise repo_path
    const cwd = thread.worktree || thread.repo_path;

    // Get session_id: prefer in-memory (still running), fall back to DB
    const sessionId = existingSession?.sessionId
      ?? this.getPersistedSessionId(threadId)
      ?? null;

    // Spawn a new process with --resume + -p
    updateThread(this.db, threadId, { status: "running" });
    this.notifyThread(threadId);
    this.spawnTurn(threadId, adapter, cwd, content, sessionId);
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

  onStreamDelta(fn: StreamDeltaListener): () => void {
    this.streamDeltaListeners.add(fn);
    return () => this.streamDeltaListeners.delete(fn);
  }

  // ── Private ───────────────────────────────────────────

  private spawnTurn(
    threadId: string,
    adapter: AgentAdapter,
    cwd: string,
    prompt: string,
    resumeSessionId: string | null,
  ): void {
    const agentProc = adapter.spawn({
      cwd,
      prompt,
      resumeSessionId: resumeSessionId ?? undefined,
    });

    const pid = agentProc.proc.pid;
    updateThread(this.db, threadId, { pid, status: "running" });

    const session: ActiveSession = {
      threadId,
      agentProc,
      lineBuffer: "",
      sessionId: resumeSessionId,
      cwd,
    };
    this.sessions.set(threadId, session);

    // Start reading stdout
    this.readStream(session, adapter);

    // Watch for exit — pass PID to distinguish from superseded processes
    agentProc.proc.exited.then((exitCode) => {
      this.handleExit(threadId, exitCode, pid);
    });
  }

  private async readStream(session: ActiveSession, adapter: AgentAdapter) {
    const stdout = session.agentProc.proc.stdout;
    const decoder = new TextDecoder();
    const pid = session.agentProc.proc.pid;

    try {
      for await (const chunk of stdout) {
        // Check if this session was superseded by a new spawn
        const current = this.sessions.get(session.threadId);
        if (!current || current.agentProc.proc.pid !== pid) return;

        session.lineBuffer += decoder.decode(chunk, { stream: true });
        const lines = session.lineBuffer.split("\n");
        session.lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const { messages, deltas } = adapter.parseOutput(line);
          for (const msg of messages) {
            this.persistMessage(session.threadId, msg);
          }
          for (const delta of deltas) {
            if (delta.deltaType === "turn_end" && delta.text) {
              session.sessionId = delta.text;
              this.persistSessionId(session.threadId, delta.text);
            }
            this.notifyStreamDelta(session.threadId, {
              ...delta,
              threadId: session.threadId,
            });
          }
        }
      }

      // Flush remaining buffer
      const current = this.sessions.get(session.threadId);
      if (!current || current.agentProc.proc.pid !== pid) return;

      if (session.lineBuffer.trim()) {
        const { messages, deltas } = adapter.parseOutput(session.lineBuffer);
        for (const msg of messages) {
          this.persistMessage(session.threadId, msg);
        }
        for (const delta of deltas) {
          if (delta.deltaType === "turn_end" && delta.text) {
            session.sessionId = delta.text;
            this.persistSessionId(session.threadId, delta.text);
          }
          this.notifyStreamDelta(session.threadId, {
            ...delta,
            threadId: session.threadId,
          });
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
    const msgData = {
      id: nanoid(12),
      thread_id: threadId,
      role: parsed.role,
      content: parsed.content,
      tool_name: parsed.toolName ?? null,
      tool_input: parsed.toolInput ?? null,
      tool_output: parsed.toolOutput ?? null,
      metadata: parsed.metadata ? JSON.stringify(parsed.metadata) : null,
      created_at: new Date().toISOString(),
    };

    let seq: number;
    try {
      seq = insertMessage(this.db, msgData);
    } catch (err) {
      console.error("Failed to persist message:", err);
      return;
    }

    const msg: MessageRow = { ...msgData, seq };

    for (const fn of this.messageListeners) {
      try {
        fn(threadId, msg);
      } catch {}
    }
  }

  private handleExit(threadId: string, exitCode: number, pid: number): void {
    // Only act if this is still the current session (not superseded by sendMessage)
    const current = this.sessions.get(threadId);
    if (current && current.agentProc.proc.pid !== pid) return;

    this.sessions.delete(threadId);
    this.clearMainWorktreeLock(threadId);
    const status = exitCode === 0 ? "done" : "error";
    updateThread(this.db, threadId, { status, pid: null });
    this.notifyThread(threadId);
  }

  private clearMainWorktreeLock(threadId: string): void {
    for (const [projectId, lockedThread] of this.mainWorktreeLocks) {
      if (lockedThread === threadId) {
        this.mainWorktreeLocks.delete(projectId);
        break;
      }
    }
  }

  private persistSessionId(threadId: string, sessionId: string): void {
    // Store in a simple key-value on the thread row's branch field as a fallback
    // (or use a dedicated column — for now, store in the DB via a simple query)
    this.db.query(
      "UPDATE threads SET updated_at = datetime('now') WHERE id = ?",
    ).run(threadId);
    // Store session_id in a way that survives process exit
    // Use a simple in-memory map that persists across spawns
    if (!this._sessionIds) this._sessionIds = new Map();
    this._sessionIds.set(threadId, sessionId);
  }

  private _sessionIds?: Map<string, string>;

  private getPersistedSessionId(threadId: string): string | null {
    return this._sessionIds?.get(threadId) ?? null;
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

  private notifyStreamDelta(threadId: string, delta: StreamDelta): void {
    for (const fn of this.streamDeltaListeners) {
      try {
        fn(threadId, delta);
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
          if (this.isAgentProcess(thread.pid, thread.agent)) {
            process.kill(thread.pid, "SIGTERM");
          }
        } catch {
          // Already dead
        }
      }
      updateThread(this.db, thread.id, { status: "error", pid: null });
    }
  }

  private isAgentProcess(pid: number, agentName: string): boolean {
    try {
      const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const args = new TextDecoder().decode(proc.stdout).trim();
      return args.includes(agentName);
    } catch {
      return false;
    }
  }
}
