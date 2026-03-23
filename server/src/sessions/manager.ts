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
  stderrBuffer: string;
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
  private shuttingDown = false;

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
    worktreeName?: string;
  }): Promise<ThreadRow> {
    const adapter = this.registry.get(opts.agent);
    if (!adapter) throw new Error(`Unknown agent: ${opts.agent}`);

    const threadId = nanoid(12);
    const title = opts.title || opts.prompt.slice(0, 80);
    let cwd = opts.repoPath;
    let worktree: string | null = null;
    let branch: string | null = null;

    if (opts.isolate) {
      const wt = await this.worktreeManager.create(threadId, opts.repoPath, opts.worktreeName);
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
    // Delete from map BEFORE killing so handleExit can't race and find the session
    this.sessions.delete(threadId);
    try {
      session.agentProc.proc.kill();
    } catch {
      // Process already exited — that's fine
    }
    updateThread(this.db, threadId, { status: "done", pid: null });
    this.notifyThread(threadId);
  }

  stopAll(): void {
    this.shuttingDown = true;
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
      // Delete from map BEFORE killing so handleExit can't race and find the session
      this.sessions.delete(threadId);
      try {
        existingSession.agentProc.proc.kill();
      } catch {
        // Process already exited — that's fine
      }
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
    updateThread(this.db, threadId, { status: "running", error_message: null });
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
      stderrBuffer: "",
      sessionId: resumeSessionId,
      cwd,
    };
    this.sessions.set(threadId, session);

    // Start reading stdout
    this.readStream(session, adapter);

    // Collect stderr for error reporting
    this.collectStderr(session);

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
      const errMsg = err instanceof Error ? err.message : String(err);
      updateThread(this.db, session.threadId, {
        error_message: `Stream read error: ${errMsg.slice(0, 200)}`,
      });
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

  private async collectStderr(session: ActiveSession): Promise<void> {
    const stderr = session.agentProc.proc.stderr;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stderr) {
        session.stderrBuffer += decoder.decode(chunk, { stream: true });
        // Cap at 4KB to avoid unbounded growth
        if (session.stderrBuffer.length > 4096) {
          session.stderrBuffer = session.stderrBuffer.slice(-4096);
        }
      }
    } catch {
      // stderr closed — expected on normal exit
    }
  }

  private handleExit(threadId: string, exitCode: number, pid: number): void {
    // During shutdown, stopAll/stopThread already handles cleanup
    if (this.shuttingDown) return;

    // Only act if this is still the current session (not superseded by sendMessage)
    const current = this.sessions.get(threadId);
    if (!current || current.agentProc.proc.pid !== pid) return;

    let errorMessage: string | null = null;

    // Surface stderr as an assistant error message when process fails
    if (exitCode !== 0) {
      const stderrText = current?.stderrBuffer.trim().slice(-2000) ?? "";
      const signalInfo = describeExitCode(exitCode);
      const summary = signalInfo ?? `Process exited with code ${exitCode}`;

      errorMessage = stderrText
        ? `${summary}: ${stderrText.slice(0, 200)}`
        : summary;

      this.persistMessage(threadId, {
        role: "assistant",
        content: stderrText
          ? `**${summary}**\n\n\`\`\`\n${stderrText}\n\`\`\``
          : `**${summary}**`,
      });
    }

    this.sessions.delete(threadId);
    const status = exitCode === 0 ? "done" : "error";
    updateThread(this.db, threadId, { status, pid: null, error_message: errorMessage });
    this.notifyThread(threadId);
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
      updateThread(this.db, thread.id, {
        status: "error",
        pid: null,
        error_message: "Process was orphaned (server restarted while thread was running)",
      });
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

/** Decode exit codes into human-readable descriptions, especially signal-based (128+N). */
function describeExitCode(exitCode: number): string | null {
  const signals: Record<number, [string, string]> = {
    // signal number → [name, likely cause]
    1:  ["SIGHUP",  "Terminal closed or server restarted"],
    2:  ["SIGINT",  "Process interrupted (Ctrl+C)"],
    6:  ["SIGABRT", "Process aborted — possible internal error"],
    9:  ["SIGKILL", "Process force-killed — likely OOM or system resource limit"],
    13: ["SIGPIPE", "Broken pipe — output reader disconnected"],
    14: ["SIGALRM", "Timeout expired"],
    15: ["SIGTERM", "Process terminated — server may have restarted or the session timed out"],
  };

  if (exitCode > 128 && exitCode <= 128 + 31) {
    const sigNum = exitCode - 128;
    const info = signals[sigNum];
    if (info) {
      return `Agent killed by ${info[0]} (exit ${exitCode}) — ${info[1]}`;
    }
    return `Agent killed by signal ${sigNum} (exit ${exitCode})`;
  }

  if (exitCode === 1) return "Agent exited with an error (exit 1)";

  return null;
}
