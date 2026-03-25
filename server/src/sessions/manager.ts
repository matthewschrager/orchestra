import { nanoid } from "nanoid";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { DB, MessageRow, ThreadRow, AttentionRow } from "../db";
import {
  getThread,
  getAttentionItem,
  getSetting,
  insertMessage,
  updateThread,
  createAttentionItem,
  resolveAttentionItem,
  orphanAttentionItems,
  attentionRowToApi,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentSession, AttentionEvent, ParsedMessage } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";
import type { Attachment, AttentionItem, StreamDelta } from "shared";
import { resolveAttachmentPaths } from "../routes/uploads";

export interface ActiveSession {
  threadId: string;
  session: AgentSession;
  adapter: AgentAdapter;
  sessionId: string | null;
  cwd: string;
  /** Set to true before calling abort() so the catch block knows this was intentional */
  aborted: boolean;
  /** Timestamp of last message received — used for inactivity timeout */
  lastMessageAt: number;
}

type MessageListener = (threadId: string, message: MessageRow) => void;
type ThreadListener = (thread: ThreadRow) => void;
type StreamDeltaListener = (threadId: string, delta: StreamDelta) => void;
type AttentionListener = (threadId: string, attention: AttentionItem) => void;
type AttentionResolvedListener = (attentionId: string, threadId: string) => void;

/** Default inactivity timeout: abort session if no SDK message arrives within this period */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INACTIVITY_CHECK_INTERVAL_MS = 30_000;
const DEBUG = process.env.ORCHESTRA_DEBUG === "1";

export class SessionManager {
  private sessions: Map<string, ActiveSession> = new Map();
  private messageListeners: Set<MessageListener> = new Set();
  private threadListeners: Set<ThreadListener> = new Set();
  private streamDeltaListeners: Set<StreamDeltaListener> = new Set();
  shuttingDown = false;
  private attentionListeners: Set<AttentionListener> = new Set();
  private attentionResolvedListeners: Set<AttentionResolvedListener> = new Set();
  private mainWorktreeLocks: Map<string, string> = new Map();

  private inactivityCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: DB,
    private registry: AgentRegistry,
    private worktreeManager: WorktreeManager,
    private uploadsDir: string,
  ) {
    this.recoverOrphanedThreads();
    this.startInactivityCheck();
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
    attachments?: Attachment[];
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

    // Validate and build prompt with attachment references
    const validAttachments = this.validateAttachments(opts.attachments);
    const agentPrompt = this.buildPromptWithAttachments(opts.prompt, validAttachments);

    // Persist user prompt as first message (with attachment metadata)
    this.persistMessage(threadId, {
      role: "user",
      content: opts.prompt,
      metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
    });

    // Start agent session
    this.startTurn(threadId, adapter, cwd, agentPrompt, null);

    const thread = getThread(this.db, threadId)!;

    // Broadcast to all WS clients so other devices see the new thread
    this.notifyThread(threadId);

    return thread;
  }

  stopThread(threadId: string): void {
    const active = this.sessions.get(threadId);
    if (!active) return;
    // 1. Delete from map FIRST so consumeStream bails on identity check
    this.sessions.delete(threadId);
    // 2. Mark as aborted so catch block knows this was intentional
    active.aborted = true;
    // 3. Then abort (may cause iterator to throw AbortError)
    try {
      active.session.abort();
    } catch {
      // Already aborted or completed
    }
    // 4. Cleanup
    this.clearMainWorktreeLock(threadId);
    orphanAttentionItems(this.db, threadId);
    updateThread(this.db, threadId, { status: "done", pid: null });
    this.notifyThread(threadId);
  }

  stopAll(): void {
    this.shuttingDown = true;
    if (this.inactivityCheckInterval) clearInterval(this.inactivityCheckInterval);
    for (const [id] of this.sessions) {
      this.stopThread(id);
    }
  }

  sendMessage(threadId: string, content: string, attachments?: Attachment[]): void {
    if (DEBUG) console.log(`[session] sendMessage thread=${threadId} content=${content.slice(0, 60)}`);
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const adapter = this.registry.get(thread.agent);
    if (!adapter) throw new Error(`Unknown agent: ${thread.agent}`);

    // If there's already a running session for this thread, abort it first
    const existing = this.sessions.get(threadId);
    if (existing) {
      // Delete from map FIRST, then abort
      this.sessions.delete(threadId);
      existing.aborted = true;
      try {
        existing.session.abort();
      } catch {
        // Already aborted or completed
      }
    }

    // Validate attachments and persist user message
    const validAttachments = this.validateAttachments(attachments);
    this.persistMessage(threadId, {
      role: "user",
      content,
      metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
    });

    // Build prompt with attachment references
    const agentPrompt = this.buildPromptWithAttachments(content, validAttachments);

    // Get the cwd — use worktree if isolated, otherwise repo_path
    const cwd = thread.worktree || thread.repo_path;

    // Get session_id: prefer in-memory (still running), fall back to DB
    const sessionId = existing?.sessionId
      ?? this.getPersistedSessionId(threadId)
      ?? null;

    // Start a new turn with resume
    updateThread(this.db, threadId, { status: "running", error_message: null });
    this.notifyThread(threadId);
    this.startTurn(threadId, adapter, cwd, agentPrompt, sessionId);
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

  private static readonly NANOID_RE = /^[a-zA-Z0-9_-]{8,24}$/;

  /** Filter out attachments with invalid/suspicious IDs */
  private validateAttachments(attachments?: Attachment[]): Attachment[] | undefined {
    if (!attachments?.length) return attachments;
    return attachments.filter((a) => SessionManager.NANOID_RE.test(a.id));
  }

  /** Build prompt text with file path references for attachments */
  private buildPromptWithAttachments(prompt: string, attachments?: Attachment[]): string {
    if (!attachments?.length) return prompt;

    const resolved = resolveAttachmentPaths(attachments, this.uploadsDir);
    if (resolved.length === 0) return prompt;

    const fileLines = resolved.map(({ attachment, absolutePath }) => {
      const isImage = attachment.mimeType.startsWith("image/");
      // Sanitize filename to prevent prompt injection — strip control chars and limit length
      const safeName = attachment.filename.replace(/[\n\r\t]/g, "_").slice(0, 100);
      return `- ${absolutePath} (${safeName}, ${attachment.mimeType})${isImage ? " — use Read tool to view this image" : ""}`;
    });

    return `${prompt}\n\n[The user has attached the following file(s):]\n${fileLines.join("\n")}`;
  }

  private startTurn(
    threadId: string,
    adapter: AgentAdapter,
    cwd: string,
    prompt: string,
    resumeSessionId: string | null,
  ): void {
    if (DEBUG) console.log(`[session] startTurn thread=${threadId} resume=${resumeSessionId ?? "new"} cwd=${cwd}`);
    const session = adapter.start({
      cwd,
      prompt,
      resumeSessionId: resumeSessionId ?? undefined,
    });

    updateThread(this.db, threadId, { pid: null, status: "running" });

    const active: ActiveSession = {
      threadId,
      session,
      adapter,
      sessionId: resumeSessionId,
      cwd,
      aborted: false,
      lastMessageAt: Date.now(),
    };
    this.sessions.set(threadId, active);

    // Fire and forget — consumeStream handles its own lifecycle
    this.consumeStream(active).catch((err) => {
      // Safety net: catch any errors that escape the try/catch inside consumeStream
      console.error(`[stream] Thread ${threadId} — unhandled consumeStream error:`, err);
      if (this.sessions.get(threadId) === active) {
        this.sessions.delete(threadId);
        updateThread(this.db, threadId, {
          status: "error",
          pid: null,
          error_message: `Unexpected stream error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
        });
        this.notifyThread(threadId);
      }
    });
  }

  private async consumeStream(activeSession: ActiveSession): Promise<void> {
    const { threadId } = activeSession;
    let messageCount = 0;
    const startTime = Date.now();
    if (DEBUG) console.log(`[stream] Thread ${threadId} — consumeStream started`);

    try {
      for await (const msg of activeSession.session.messages) {
        // Check if session was stopped/superseded (object identity)
        if (this.sessions.get(threadId) !== activeSession) {
          if (DEBUG) console.log(`[stream] Thread ${threadId} — session superseded after ${messageCount} msgs`);
          return;
        }

        messageCount++;
        const m = msg as Record<string, unknown>;
        if (DEBUG && (messageCount <= 3 || m.type === "result")) {
          const extra = m.type === "result"
            ? ` subtype=${m.subtype} is_error=${m.is_error} errors=${JSON.stringify(m.errors ?? [])}`
            : "";
          console.log(`[stream] Thread ${threadId} msg#${messageCount} type=${m.type}${extra} (${Date.now() - startTime}ms)`);
        }

        activeSession.lastMessageAt = Date.now();

        const { messages, deltas, attention, sessionId, error: sdkError } =
          activeSession.session.parseMessage(msg);

        if (sessionId) {
          activeSession.sessionId = sessionId;
          this.persistSessionId(threadId, sessionId);
        }

        // If the SDK reported an error result, surface it to the user
        if (sdkError) {
          console.error(`[stream] Thread ${threadId} — SDK error result: ${sdkError}`);
          this.persistMessage(threadId, {
            role: "assistant",
            content: `**Agent error:** ${sdkError}`,
          });
        }

        for (const msg of messages) {
          this.persistMessage(threadId, msg);
        }
        for (const delta of deltas) {
          if (delta.deltaType === "turn_end" && delta.text) {
            activeSession.sessionId = delta.text;
            this.persistSessionId(threadId, delta.text);
          }
          this.notifyStreamDelta(threadId, {
            ...delta,
            threadId,
          });
        }
        if (attention) {
          this.handleAttentionEvent(activeSession, attention);
        }
      }

      // ── Iterator completed normally ──
      if (DEBUG) console.log(`[stream] Thread ${threadId} — iterator completed after ${messageCount} msgs (${Date.now() - startTime}ms)`);
      // CRITICAL: Final identity check after loop (prevents marking superseded thread as "done")
      if (this.sessions.get(threadId) !== activeSession) return;

      this.sessions.delete(threadId);
      this.clearMainWorktreeLock(threadId);

      // Detect silent failure: if the SDK produced 0 messages (or only system init),
      // something went wrong — mark as error instead of "done"
      if (messageCount <= 1) {
        console.warn(`[stream] Thread ${threadId} — SDK produced ${messageCount} messages, treating as error`);
        orphanAttentionItems(this.db, threadId);
        this.persistMessage(threadId, {
          role: "assistant",
          content: "**Agent session ended without producing a response.** This may indicate an SDK initialization failure. Try again.",
        });
        updateThread(this.db, threadId, {
          status: "error",
          pid: null,
          error_message: `SDK produced ${messageCount} messages without a response`,
        });
        this.notifyThread(threadId);
        return;
      }

      const thread = getThread(this.db, threadId);
      if (thread?.status === "waiting") {
        // Process ended while waiting for user input — expected
        updateThread(this.db, threadId, { pid: null });
      } else {
        const orphaned = orphanAttentionItems(this.db, threadId);
        if (orphaned > 0) {
          console.log(`Orphaned ${orphaned} attention items for thread ${threadId}`);
        }
        updateThread(this.db, threadId, { status: "done", pid: null });
      }
      this.notifyThread(threadId);

    } catch (err) {
      // Check if this was a user-initiated abort or session superseded
      if (this.sessions.get(threadId) !== activeSession) return;
      if (activeSession.aborted || err instanceof AbortError) {
        if (DEBUG) console.log(`[stream] Thread ${threadId} — aborted after ${messageCount} msgs (${Date.now() - startTime}ms)`);
        return;
      }

      console.error(`[stream] Thread ${threadId} — error after ${messageCount} msgs (${Date.now() - startTime}ms):`, err);

      // Real SDK error
      this.sessions.delete(threadId);
      this.clearMainWorktreeLock(threadId);
      orphanAttentionItems(this.db, threadId);

      const errMsg = err instanceof Error ? err.message : String(err);
      this.persistMessage(threadId, {
        role: "assistant",
        content: `**Agent error:** ${errMsg}`,
      });
      updateThread(this.db, threadId, {
        status: "error",
        pid: null,
        error_message: errMsg.slice(0, 200),
      });
      this.notifyThread(threadId);
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

  private handleAttentionEvent(session: ActiveSession, event: AttentionEvent): void {
    try {
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

  notifyThread(threadId: string): void {
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
    for (const [key, holder] of this.mainWorktreeLocks) {
      if (holder === threadId) {
        this.mainWorktreeLocks.delete(key);
        break;
      }
    }
  }

  /** Read inactivity timeout from settings DB, falling back to compiled default */
  private getInactivityTimeoutMs(): number {
    const raw = getSetting(this.db, "inactivityTimeoutMinutes");
    if (raw) {
      const mins = Number(raw);
      if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
    }
    return DEFAULT_INACTIVITY_TIMEOUT_MS;
  }

  /** Abort a session due to inactivity timeout — surfaces the error to the user */
  private timeoutThread(threadId: string, elapsedSec: number): void {
    const active = this.sessions.get(threadId);
    if (!active) return;

    const timeoutMin = Math.round(this.getInactivityTimeoutMs() / 60_000);
    const errMsg = `Session timed out after ${Math.round(elapsedSec)}s of inactivity (limit: ${timeoutMin}min). Long-running sub-agents may need a higher timeout — adjust in Settings.`;

    // 1. Remove from active sessions
    this.sessions.delete(threadId);
    active.aborted = true;

    // 2. Abort the SDK session
    try {
      active.session.abort();
    } catch {
      // Already aborted or completed
    }

    // 3. Cleanup
    this.clearMainWorktreeLock(threadId);
    orphanAttentionItems(this.db, threadId);

    // 4. Persist a visible error message so the user sees it in chat
    this.persistMessage(threadId, {
      role: "assistant",
      content: `**Inactivity timeout:** No messages received from the agent for ${Math.round(elapsedSec)} seconds. The session has been stopped.\n\nYou can increase the timeout in **Settings** and then send a follow-up message to resume.`,
    });

    // 5. Mark thread as error with descriptive message
    updateThread(this.db, threadId, {
      status: "error",
      pid: null,
      error_message: errMsg,
    });
    this.notifyThread(threadId);
  }

  /** Periodically check for sessions that haven't received any SDK messages.
   *  This replaces the PID-based health check from the CLI approach. */
  private startInactivityCheck(): void {
    this.inactivityCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeoutMs = this.getInactivityTimeoutMs();
      for (const [threadId, session] of this.sessions) {
        const elapsed = now - session.lastMessageAt;
        if (elapsed > timeoutMs) {
          const elapsedSec = Math.round(elapsed / 1000);
          console.warn(`[health] Thread ${threadId} inactive for ${elapsedSec}s (limit: ${Math.round(timeoutMs / 1000)}s) — aborting`);
          this.timeoutThread(threadId, elapsedSec);
        }
      }
    }, INACTIVITY_CHECK_INTERVAL_MS);
  }

  /** Mark any threads that were running when the server crashed as errored.
   *  With SDK sessions (no orphan processes), we just update the DB. */
  private recoverOrphanedThreads(): void {
    const running = this.db
      .query("SELECT id FROM threads WHERE status IN ('running', 'waiting')")
      .all() as Pick<ThreadRow, "id">[];

    for (const thread of running) {
      orphanAttentionItems(this.db, thread.id);
      updateThread(this.db, thread.id, {
        status: "error",
        pid: null,
        error_message: "Process was orphaned (server restarted while thread was running)",
      });
    }
  }
}
