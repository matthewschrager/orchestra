import { nanoid } from "nanoid";
import type { DB, MessageRow, ThreadRow, AttentionRow } from "../db";
import {
  getThread,
  getAttentionItem,
  insertMessage,
  updateThread,
  createAttentionItem,
  resolveAttentionItem,
  orphanAttentionItems,
  attentionRowToApi,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentProcess, AttentionEvent, ParsedMessage } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";
import type { AttentionItem, StreamDelta } from "shared";

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
type AttentionListener = (threadId: string, attention: AttentionItem) => void;
type AttentionResolvedListener = (attentionId: string, threadId: string) => void;

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private messageListeners: Set<MessageListener> = new Set();
  private threadListeners: Set<ThreadListener> = new Set();
  private streamDeltaListeners: Set<StreamDeltaListener> = new Set();
  private shuttingDown = false;
  private attentionListeners: Set<AttentionListener> = new Set();
  private attentionResolvedListeners: Set<AttentionResolvedListener> = new Set();
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
    this.clearMainWorktreeLock(threadId);
    orphanAttentionItems(this.db, threadId);
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

  onAttention(fn: AttentionListener): () => void {
    this.attentionListeners.add(fn);
    return () => this.attentionListeners.delete(fn);
  }

  onAttentionResolved(fn: AttentionResolvedListener): () => void {
    this.attentionResolvedListeners.add(fn);
    return () => this.attentionResolvedListeners.delete(fn);
  }

  /** Resolve an attention item and resume the agent with the user's response. */
  resolveAttention(attentionId: string, resolution: object): AttentionRow | null {
    // Check if already resolved BEFORE attempting — prevents double-resume race
    const existing = getAttentionItem(this.db, attentionId);
    if (!existing) return null;
    if (existing.resolved_at) return existing; // Already resolved by another caller

    const resolved = resolveAttentionItem(this.db, attentionId, resolution);
    if (!resolved || !resolved.thread_id) return null;

    // Only resume if WE actually performed the resolution (resolved_at was null before)
    const threadId = resolved.thread_id;
    const res = resolution as { type?: string; text?: string; optionIndex?: number; action?: string };
    if (res.type === "user") {
      const thread = getThread(this.db, threadId);
      if (thread && (thread.status === "waiting" || thread.status === "done")) {
        let answer: string;
        if (res.action) {
          answer = `User ${res.action === "allow" ? "approved" : "denied"} the action.`;
        } else if (res.optionIndex !== undefined && resolved.options) {
          const options = JSON.parse(resolved.options) as string[];
          answer = `User selected: "${options[res.optionIndex] ?? `option ${res.optionIndex}`}"`;
        } else if (res.text) {
          answer = res.text;
        } else {
          answer = "User acknowledged.";
        }

        this.sendMessage(threadId, answer);
      }
    }

    // Notify listeners so WS clients learn about the resolution
    this.notifyAttentionResolved(attentionId, threadId);

    return resolved;
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
          const { messages, deltas, attention } = adapter.parseOutput(line);
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
          if (attention) {
            this.handleAttentionEvent(session, attention);
          }
        }
      }

      // Flush remaining buffer — even if superseded, persist messages so
      // no data is silently lost. Skip session_id updates if superseded
      // since the new process owns the session now.
      const isSuperseded = (() => {
        const current = this.sessions.get(session.threadId);
        return !current || current.agentProc.proc.pid !== pid;
      })();

      if (session.lineBuffer.trim() && !isSuperseded) {
        const { messages, deltas, attention } = adapter.parseOutput(session.lineBuffer);
        for (const msg of messages) {
          this.persistMessage(session.threadId, msg);
        }
        {
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
          if (attention) {
            this.handleAttentionEvent(session, attention);
          }
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

    this.sessions.delete(threadId);
    this.clearMainWorktreeLock(threadId);

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

    // Check if thread is in "waiting" state (attention pending) — don't overwrite
    const thread = getThread(this.db, threadId);
    if (thread?.status === "waiting") {
      // Process exited while waiting for user input — this is expected
      updateThread(this.db, threadId, { pid: null });
    } else {
      // Orphan any pending attention items for this thread
      const orphaned = orphanAttentionItems(this.db, threadId);
      if (orphaned > 0) {
        console.log(`Orphaned ${orphaned} attention items for thread ${threadId}`);
      }
      const status = exitCode === 0 ? "done" : "error";
      updateThread(this.db, threadId, { status, pid: null, error_message: errorMessage });
    }
    this.notifyThread(threadId);
  }

  private persistSessionId(threadId: string, sessionId: string): void {
    this.db.query(
      "UPDATE threads SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(sessionId, threadId);
  }

  private getPersistedSessionId(threadId: string): string | null {
    const row = this.db.query(
      "SELECT session_id FROM threads WHERE id = ?",
    ).get(threadId) as { session_id: string | null } | null;
    return row?.session_id ?? null;
  }

  private handleAttentionEvent(session: ActiveSession, event: AttentionEvent): void {
    try {
      // Use in-memory sessionId, falling back to DB (covers first-turn race
      // where result event with session_id hasn't arrived yet)
      const continuationToken = session.sessionId
        ?? this.getPersistedSessionId(session.threadId);

      const row = createAttentionItem(this.db, {
        threadId: session.threadId,
        kind: event.kind,
        prompt: event.prompt,
        options: event.options ?? null,
        metadata: event.metadata ?? null,
        continuationToken,
      });

      // Update thread status to "waiting"
      updateThread(this.db, session.threadId, { status: "waiting" });
      this.notifyThread(session.threadId);

      // Notify attention listeners
      const item = attentionRowToApi(row);
      this.notifyAttention(session.threadId, item);
    } catch (err) {
      console.error(`Failed to create attention item for thread ${session.threadId}:`, err);
      updateThread(this.db, session.threadId, { status: "error" });
      this.notifyThread(session.threadId);
    }
  }

  private notifyAttention(threadId: string, item: AttentionItem): void {
    for (const fn of this.attentionListeners) {
      try {
        fn(threadId, item);
      } catch {}
    }
  }

  private notifyAttentionResolved(attentionId: string, threadId: string): void {
    for (const fn of this.attentionResolvedListeners) {
      try {
        fn(attentionId, threadId);
      } catch {}
    }
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

  private clearMainWorktreeLock(threadId: string): void {
    // Remove worktree lock if this thread holds one
    for (const [key, holder] of this.mainWorktreeLocks) {
      if (holder === threadId) {
        this.mainWorktreeLocks.delete(key);
        break;
      }
    }
  }

  private recoverOrphanedThreads(): void {
    const running = this.db
      .query("SELECT * FROM threads WHERE status IN ('running', 'waiting')")
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
      // Orphan any pending attention items so they don't linger in the inbox
      orphanAttentionItems(this.db, thread.id);
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
