import { nanoid } from "nanoid";
import type { DB, MessageRow, ThreadRow, AttentionRow } from "../db";
import {
  getThread,
  getAttentionItem,
  getPendingAttention,
  getSetting,
  insertMessage,
  updateThread,
  touchThreadInteraction,
  createAttentionItem,
  resolveAttentionItem,
  orphanAttentionItems,
  attentionRowToApi,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentSession, AttentionEvent, ParsedMessage, PersistentSession } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";
import type { Attachment, AttentionItem, StreamDelta } from "shared";
import { resolveAttachmentPaths } from "../routes/uploads";
import { generateTitle } from "../titles/generator";

/** State machine for persistent sessions: thinking → idle/waiting → thinking */
export type SessionState = "thinking" | "idle" | "waiting";

/** Max auto-restart attempts before giving up (prevents infinite restart loops) */
const MAX_AUTO_RESTARTS = 2;

/** Max messages that can be queued during a single agent turn */
const MAX_QUEUED_MESSAGES = 5;

export interface ActiveSession {
  threadId: string;
  session: AgentSession;
  adapter: AgentAdapter;
  sessionId: string | null;
  cwd: string;
  /** Set to true before calling abort()/close() so the catch block knows this was intentional */
  aborted: boolean;
  /** Timestamp of last message received — used for inactivity timeout */
  lastMessageAt: number;
  /** Whether this is a persistent (long-lived) session using streamInput() */
  persistent: boolean;
  /** State machine for persistent sessions */
  state: SessionState;
  /** Number of auto-restarts attempted (circuit breaker for restart loops) */
  restartCount: number;
  /** Number of messages queued during the current turn (reset on turn_end) */
  queuedCount: number;
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
    private orchestraPort: number = 3847,
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
        `INSERT INTO threads (id, title, agent, repo_path, project_id, worktree, branch, status, last_interacted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))`,
      )
      .run(threadId, title, opts.agent, opts.repoPath, opts.projectId, worktree, branch);

    // Validate and build prompt with attachment references
    const validAttachments = this.validateAttachments(opts.attachments);
    let agentPrompt = this.buildPromptWithAttachments(opts.prompt, validAttachments);

    // Inject isolation preamble for worktree-isolated threads (first message only)
    if (worktree) {
      agentPrompt = `${this.buildIsolationPreamble(cwd)}\n\n${agentPrompt}`;
    }

    // Persist user prompt as first message (with attachment metadata)
    this.persistMessage(threadId, {
      role: "user",
      content: opts.prompt,
      metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
    });

    // Start agent session — use persistent mode when supported
    if (adapter.supportsPersistent?.()) {
      this.startPersistentSession(threadId, adapter, cwd, agentPrompt, null);
    } else {
      this.startTurn(threadId, adapter, cwd, agentPrompt, null);
    }

    const thread = getThread(this.db, threadId)!;

    // Broadcast to all WS clients so other devices see the new thread
    this.notifyThread(threadId);

    // Fire-and-forget: generate AI title from prompt (unless user supplied one)
    if (!opts.title) {
      const originalTitle = title;
      generateTitle(opts.prompt)
        .then((aiTitle) => {
          if (!aiTitle) return;
          // Race guard: only update if user hasn't manually edited the title
          const current = getThread(this.db, threadId);
          if (current && current.title === originalTitle) {
            updateThread(this.db, threadId, { title: aiTitle });
            this.notifyThread(threadId);
          }
        })
        .catch(() => {});
    }

    return thread;
  }

  stopThread(threadId: string): void {
    const active = this.sessions.get(threadId);
    if (!active) return;
    // 1. Delete from map FIRST so consumeStream bails on identity check
    this.sessions.delete(threadId);
    // 2. Mark as aborted so catch block knows this was intentional
    active.aborted = true;
    // 3. Close or abort the session
    if (active.persistent) {
      try {
        (active.session as PersistentSession).close();
      } catch {
        // Already closed
      }
    } else {
      try {
        active.session.abort();
      } catch {
        // Already aborted or completed
      }
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
    for (const id of [...this.sessions.keys()]) {
      this.stopThread(id);
    }
  }

  sendMessage(threadId: string, content: string, attachments?: Attachment[], opts?: { internal?: boolean; interrupt?: boolean }): void {
    if (DEBUG) console.log(`[session] sendMessage thread=${threadId} content=${content.slice(0, 60)} interrupt=${!!opts?.interrupt}`);
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const adapter = this.registry.get(thread.agent);
    if (!adapter) throw new Error(`Unknown agent: ${thread.agent}`);

    const existing = this.sessions.get(threadId);

    // Guard: non-persistent sessions still block during thinking (no queue support)
    if (existing && !existing.persistent && existing.state === "thinking") {
      throw new Error("Agent is still processing — wait for it to finish");
    }

    // Orphan any pending attention items — user is moving on by sending a new message,
    // so old AskUserQuestions are no longer relevant. Without this, stale attention items
    // cause the turn_end handler to skip the status→"done" transition, leaving the thread
    // stuck in "running" forever.
    const orphaned = orphanAttentionItems(this.db, threadId);
    if (orphaned > 0 && DEBUG) {
      console.log(`[session] Orphaned ${orphaned} stale attention items for ${threadId} on sendMessage`);
    }

    // ── QUEUE PATH: persistent session mid-turn — queue message for next turn ──
    if (existing?.persistent && existing.state === "thinking") {
      // Content validation: reject empty/whitespace before consuming queue slot
      if (!content.trim()) {
        throw new Error("Cannot queue an empty message");
      }
      // Queue depth limit
      if (existing.queuedCount >= MAX_QUEUED_MESSAGES) {
        throw new Error("Queue full — wait for the agent to finish this turn");
      }

      // Persist user message immediately so it appears in chat
      const validAttachments = this.validateAttachments(attachments);
      this.persistMessage(threadId, {
        role: "user",
        content,
        metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
      });

      const agentPrompt = this.buildPromptWithAttachments(content, validAttachments);

      // Phase 1: interrupt param is accepted but ignored (always queue as 'next')
      const priority = "next" as const;
      if (opts?.interrupt && DEBUG) {
        console.log(`[session] interrupt=true requested for ${threadId} but not yet implemented (Phase 2) — queuing as 'next'`);
      }

      const sessionId = existing.sessionId ?? this.getPersistedSessionId(threadId);
      if (!sessionId) {
        console.warn(`[session] No sessionId for queue inject on ${threadId} — message persisted but not injected`);
        existing.queuedCount++;
        this.notifyStreamDelta(threadId, { threadId, deltaType: "queued_message", queuedCount: existing.queuedCount });
        return;
      }

      // Inject with priority — async errors handled via catch
      try {
        const injectPromise = (existing.session as PersistentSession).injectMessage(agentPrompt, sessionId, priority);
        injectPromise.catch((err) => {
          if (existing.aborted || !this.sessions.has(threadId)) return;
          console.error(`[session] queued streamInput failed for ${threadId}:`, err);
          // Message is persisted — user can resend if agent restarts
        });
      } catch (err) {
        // Synchronous throw: don't count as queued (inject never reached CLI)
        if (existing.aborted || !this.sessions.has(threadId)) return;
        console.error(`[session] queued streamInput threw for ${threadId}:`, err);
        return;
      }

      existing.queuedCount++;
      this.notifyStreamDelta(threadId, { threadId, deltaType: "queued_message", queuedCount: existing.queuedCount });
      return;
    }

    // Validate attachments and persist user message
    const validAttachments = this.validateAttachments(attachments);
    this.persistMessage(threadId, {
      role: "user",
      content,
      metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
    });

    // Bump interaction timestamp for sidebar sort order (skip for internal/synthetic messages)
    if (!opts?.internal) {
      touchThreadInteraction(this.db, threadId);
    }

    // Build prompt with attachment references
    const agentPrompt = this.buildPromptWithAttachments(content, validAttachments);

    // Get the cwd — use worktree if isolated, otherwise repo_path
    const cwd = thread.worktree || thread.repo_path;

    // ── PERSISTENT PATH: inject into living subprocess (idle/waiting state) ──
    if (existing?.persistent) {

      // Transition to thinking + refresh inactivity timestamp
      existing.state = "thinking";
      existing.lastMessageAt = Date.now();
      existing.queuedCount = 0;
      updateThread(this.db, threadId, { status: "running", error_message: null });
      this.notifyThread(threadId);

      // Reset parser turn-level state for clean dedup
      (existing.session as PersistentSession).resetTurnState();

      const sessionId = existing.sessionId ?? this.getPersistedSessionId(threadId);
      if (!sessionId) {
        // No session_id — can't inject. Fall back to restart.
        console.warn(`[session] No sessionId for persistent inject on ${threadId}, falling back to restart`);
        this.teardownSession(threadId);
        this.startTurn(threadId, adapter, cwd, agentPrompt, null);
        return;
      }

      // Wrap injectMessage in try/catch to handle both sync throws and async rejections (#3)
      try {
        const injectPromise = (existing.session as PersistentSession).injectMessage(agentPrompt, sessionId);
        injectPromise.catch((err) => {
          // Check if session was stopped while inject was pending (#6)
          if (existing.aborted || !this.sessions.has(threadId)) {
            if (DEBUG) console.log(`[session] streamInput failed for ${threadId} but session already stopped, ignoring`);
            return;
          }
          console.error(`[session] streamInput failed for ${threadId}, falling back to resume:`, err);
          this.teardownSession(threadId);
          this.restartWithResume(threadId, adapter, cwd, agentPrompt);
        });
      } catch (err) {
        // Synchronous throw from injectMessage (#3) — same fallback path
        if (existing.aborted || !this.sessions.has(threadId)) return;
        console.error(`[session] streamInput threw synchronously for ${threadId}, falling back to resume:`, err);
        this.teardownSession(threadId);
        this.restartWithResume(threadId, adapter, cwd, agentPrompt);
      }
      return;
    }

    // ── NO ACTIVE SESSION: start fresh ──
    if (existing) {
      // Abort non-persistent existing session
      this.sessions.delete(threadId);
      existing.aborted = true;
      try {
        existing.session.abort();
      } catch {
        // Already aborted or completed
      }
    }

    // Get session_id: prefer in-memory (still running), fall back to DB
    const sessionId = existing?.sessionId
      ?? this.getPersistedSessionId(threadId)
      ?? null;

    // Start a new session — prefer persistent when available
    updateThread(this.db, threadId, { status: "running", error_message: null });
    this.notifyThread(threadId);
    if (adapter.supportsPersistent?.()) {
      this.startPersistentSession(threadId, adapter, cwd, agentPrompt, sessionId);
    } else {
      this.startTurn(threadId, adapter, cwd, agentPrompt, sessionId);
    }
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

  /** Build isolation preamble for worktree-isolated agent sessions.
   *  Gives the agent operational context about Orchestra to avoid accidental interference. */
  buildIsolationPreamble(cwd: string): string {
    // Sanitize cwd to prevent prompt injection via crafted worktree names
    const safeCwd = cwd.replace(/[\n\r\t]/g, "_").slice(0, 200);
    return [
      "[Orchestra context — you are running inside an Orchestra-managed session]",
      `- Orchestra server is on localhost:${this.orchestraPort} — do NOT interact with it`,
      "- Do NOT modify ~/.orchestra/ or kill processes you didn't start",
      `- Confine your work to this directory: ${safeCwd}`,
    ].join("\n");
  }

  /** Build prompt text with file path references for attachments */
  private buildPromptWithAttachments(prompt: string, attachments?: Attachment[]): string {
    if (!attachments?.length) return prompt;

    const resolved = resolveAttachmentPaths(attachments, this.uploadsDir);
    if (resolved.length === 0) return prompt;

    const fileLines = resolved.map(({ attachment, absolutePath }) => {
      const isImage = attachment.mimeType.startsWith("image/");
      // Sanitize filename and mimeType to prevent prompt injection — strip control chars and limit length
      const safeName = attachment.filename.replace(/[\n\r\t\x00-\x1f]/g, "_").slice(0, 100);
      const safeMime = attachment.mimeType.replace(/[\n\r\t\x00-\x1f]/g, "_").slice(0, 100);
      return `- ${absolutePath} (${safeName}, ${safeMime})${isImage ? " — use Read tool to view this image" : ""}`;
    });

    return `${prompt}\n\n[The user has attached the following file(s):]\n${fileLines.join("\n")}`;
  }

  /** Legacy per-turn session — creates a new subprocess for this turn */
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
      persistent: false,
      state: "thinking",
      restartCount: 0,
      queuedCount: 0,
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

  /** Persistent session — subprocess stays alive between turns, follow-ups via streamInput() */
  private startPersistentSession(
    threadId: string,
    adapter: AgentAdapter,
    cwd: string,
    prompt: string,
    resumeSessionId: string | null,
    restartCount: number = 0,
  ): void {
    if (DEBUG) console.log(`[session] startPersistentSession thread=${threadId} resume=${resumeSessionId ?? "new"} cwd=${cwd} restarts=${restartCount}`);

    // Fix #11: Validate startPersistent exists before calling
    if (!adapter.startPersistent) {
      throw new Error(`Adapter "${adapter.name}" claims supportsPersistent() but has no startPersistent method`);
    }

    const session = adapter.startPersistent({
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
      persistent: true,
      state: "thinking",
      restartCount,
      queuedCount: 0,
    };
    this.sessions.set(threadId, active);

    // consumeStream runs for the LIFETIME of the persistent session
    this.consumeStream(active).catch((err) => {
      console.error(`[stream] Thread ${threadId} — unhandled persistent stream error:`, err);
      if (this.sessions.get(threadId) === active) {
        this.sessions.delete(threadId);
        updateThread(this.db, threadId, {
          status: "error",
          pid: null,
          error_message: `Persistent session error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
        });
        this.notifyThread(threadId);
      }
    });
  }

  private async consumeStream(activeSession: ActiveSession): Promise<void> {
    const { threadId } = activeSession;
    let messageCount = 0;
    let turnMessageCount = 0;
    /** Tracks whether ExitPlanMode was called during the current turn.
     *  SDK bug: requiresUserInteraction() short-circuits bypassPermissions, causing
     *  ExitPlanMode to be denied in headless mode. We surface it as an attention item
     *  so the user can review the plan and decide whether to approve. */
    let sawExitPlanMode = false;
    const startTime = Date.now();
    if (DEBUG) console.log(`[stream] Thread ${threadId} — consumeStream started (persistent=${activeSession.persistent})`);

    try {
      for await (const msg of activeSession.session.messages) {
        // Check if session was stopped/superseded (object identity)
        if (this.sessions.get(threadId) !== activeSession) {
          if (DEBUG) console.log(`[stream] Thread ${threadId} — session superseded after ${messageCount} msgs`);
          return;
        }

        messageCount++;
        turnMessageCount++;
        const m = msg as Record<string, unknown>;
        if (DEBUG && (messageCount <= 3 || m.type === "result")) {
          const extra = m.type === "result"
            ? ` subtype=${m.subtype} is_error=${m.is_error} errors=${JSON.stringify(m.errors ?? [])}`
            : "";
          console.log(`[stream] Thread ${threadId} msg#${messageCount} type=${m.type}${extra} (${Date.now() - startTime}ms)`);
        }

        activeSession.lastMessageAt = Date.now();

        const { messages, deltas, attention, sessionId, error: sdkError, exitPlanMode } =
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

        for (const parsed of messages) {
          this.persistMessage(threadId, parsed);
        }

        // Track if this message contains a turn_end
        let isTurnEnd = false;
        for (const delta of deltas) {
          if (delta.deltaType === "turn_end") {
            isTurnEnd = true;
            if (delta.text) {
              activeSession.sessionId = delta.text;
              this.persistSessionId(threadId, delta.text);
            }
          }
          this.notifyStreamDelta(threadId, {
            ...delta,
            threadId,
          });
        }

        if (attention) {
          this.handleAttentionEvent(activeSession, attention);
        }

        // Track ExitPlanMode for attention item creation at turn end
        if (exitPlanMode) sawExitPlanMode = true;

        // ── Turn boundary for persistent sessions ──
        // On turn_end, transition to idle (or waiting if attention pending).
        // The iterator stays alive — next message arrives when user sends follow-up.
        if (isTurnEnd && activeSession.persistent) {
          // Check DB for pending attention — more reliable than per-message variable,
          // which misses attention created in earlier messages of the same turn (#9)
          const hasPendingAttention = getPendingAttention(this.db, threadId).length > 0;
          const newState: SessionState = hasPendingAttention ? "waiting" : "idle";
          activeSession.state = newState;
          activeSession.queuedCount = 0;
          turnMessageCount = 0;

          if (DEBUG) console.log(`[stream] Thread ${threadId} — persistent turn ended, state → ${newState}`);

          if (hasPendingAttention) {
            // Turn ended with pending attention — ensure status is "waiting" and notify.
            // Defensive: status may have been overwritten to "running" by sendMessage()
            // if the user answered by typing directly instead of resolving the attention item.
            updateThread(this.db, threadId, { status: "waiting", pid: null });
            this.notifyThread(threadId);
          } else if (sawExitPlanMode) {
            // ── ExitPlanMode → surface to user for approval ──
            // SDK bug: ExitPlanMode.requiresUserInteraction() returns true, which
            // short-circuits bypassPermissions in the CLI permission flow. The tool
            // gets denied with "Permission prompts are not available in this context".
            // Instead of auto-approving, let the user review and approve the plan.
            sawExitPlanMode = false;
            if (DEBUG) console.log(`[stream] Thread ${threadId} — ExitPlanMode detected, creating attention item for user approval`);
            this.createExitPlanModeAttention(activeSession);
            // Sync in-memory state — handleAttentionEvent updates DB to "waiting"
            // but doesn't touch activeSession.state (which was set to "idle" above)
            activeSession.state = "waiting";
          } else {
            // Turn completed normally — mark done but keep session alive
            updateThread(this.db, threadId, { status: "done", pid: null });
            this.notifyThread(threadId);
          }
          // Reset per-turn tracking
          sawExitPlanMode = false;
          // Don't break — iterator stays alive for next turn
        }
      }

      // ── Iterator completed ──
      if (DEBUG) console.log(`[stream] Thread ${threadId} — iterator completed after ${messageCount} msgs (${Date.now() - startTime}ms)`);
      // CRITICAL: Final identity check after loop
      if (this.sessions.get(threadId) !== activeSession) return;

      // ── Persistent session: iterator end = subprocess died ──
      if (activeSession.persistent) {
        this.sessions.delete(threadId);
        this.clearMainWorktreeLock(threadId);

        if (activeSession.aborted) {
          // User stopped the session — already handled in stopThread()
          return;
        }

        if (activeSession.state === "idle" || activeSession.state === "waiting") {
          // Subprocess exited while idle — could be normal (inactivity) or unexpected.
          // Don't overwrite status if already "done"/"waiting".
          if (DEBUG) console.log(`[stream] Thread ${threadId} — persistent session ended while ${activeSession.state}`);
          return;
        }

        // ── ExitPlanMode: stream died before turn boundary could surface attention ──
        // Create attention item so user can manually approve the plan
        if (sawExitPlanMode) {
          console.warn(`[stream] Thread ${threadId} — persistent session died with ExitPlanMode unresolved, creating attention item`);
          this.createExitPlanModeAttention(activeSession);
          return;
        }

        // Subprocess died mid-turn — surface error, enable resume on next message
        console.warn(`[stream] Thread ${threadId} — persistent session died mid-turn after ${turnMessageCount} msgs`);
        orphanAttentionItems(this.db, threadId);
        this.persistMessage(threadId, {
          role: "assistant",
          content: "**Session ended unexpectedly.** Send a follow-up message to resume.",
        });
        updateThread(this.db, threadId, {
          status: "error",
          pid: null,
          error_message: "Subprocess ended unexpectedly during turn",
        });
        this.notifyThread(threadId);
        return;
      }

      // ── Legacy (non-persistent): existing completion logic ──
      this.sessions.delete(threadId);
      this.clearMainWorktreeLock(threadId);

      // Detect silent failure
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
      if (activeSession.aborted || isAbortError(err)) {
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

      // For persistent sessions, attempt auto-restart with resume (circuit breaker)
      if (activeSession.persistent && activeSession.sessionId && !activeSession.aborted) {
        if (activeSession.restartCount >= MAX_AUTO_RESTARTS) {
          console.error(`[stream] Thread ${threadId} — restart limit reached (${activeSession.restartCount}), giving up`);
        } else {
          const nextRestartCount = activeSession.restartCount + 1;
          if (DEBUG) console.log(`[stream] Thread ${threadId} — auto-restart attempt ${nextRestartCount}/${MAX_AUTO_RESTARTS}`);
          this.restartWithResume(threadId, activeSession.adapter, activeSession.cwd, "Continue from where you left off.", nextRestartCount);
        }
      }
    }
  }

  /** Tear down a session (persistent or legacy) without updating thread status */
  private teardownSession(threadId: string): void {
    const active = this.sessions.get(threadId);
    if (!active) return;
    this.sessions.delete(threadId);
    active.aborted = true;
    if (active.persistent) {
      try { (active.session as PersistentSession).close(); } catch {}
    } else {
      try { active.session.abort(); } catch {}
    }
    this.clearMainWorktreeLock(threadId);
  }

  /** Restart a session with resume from persisted session_id — prefers persistent mode */
  private restartWithResume(
    threadId: string,
    adapter: AgentAdapter,
    cwd: string,
    prompt: string,
    restartCount: number = 0,
  ): void {
    const sessionId = this.getPersistedSessionId(threadId);
    if (!sessionId) {
      updateThread(this.db, threadId, {
        status: "error",
        error_message: "No session to resume — send a new message to start fresh",
      });
      this.notifyThread(threadId);
      return;
    }
    updateThread(this.db, threadId, { status: "running", error_message: null });
    this.notifyThread(threadId);
    if (adapter.supportsPersistent?.()) {
      this.startPersistentSession(threadId, adapter, cwd, prompt, sessionId, restartCount);
    } else {
      this.startTurn(threadId, adapter, cwd, prompt, sessionId);
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

  /** Returns true if attention was successfully created, false on error */
  private handleAttentionEvent(session: ActiveSession, event: AttentionEvent): boolean {
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
      return true;
    } catch (err) {
      console.error(`Failed to create attention item for thread ${session.threadId}:`, err);
      updateThread(this.db, session.threadId, { status: "error" });
      this.notifyThread(session.threadId);
      return false;
    }
  }

  /** Create a "confirmation" attention item for ExitPlanMode.
   *  SDK bug prevents ExitPlanMode from working in headless mode, so we surface
   *  it as an attention item for the user to review and approve the plan. */
  private createExitPlanModeAttention(session: ActiveSession): void {
    this.handleAttentionEvent(session, {
      kind: "confirmation",
      prompt: "Agent has a plan ready and wants to proceed with implementation.",
      options: ["Approve plan", "Reject plan"],
      metadata: { source: "exit_plan_mode" },
    });
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

    // For persistent sessions in idle/waiting state, inactivity is expected — don't timeout
    // (idle = waiting for user follow-up; waiting = AskUserQuestion pending)
    if (active.persistent && (active.state === "idle" || active.state === "waiting")) return;

    const timeoutMin = Math.round(this.getInactivityTimeoutMs() / 60_000);
    const errMsg = `Session timed out after ${Math.round(elapsedSec)}s of inactivity (limit: ${timeoutMin}min). Long-running sub-agents may need a higher timeout — adjust in Settings.`;

    // 1. Remove from active sessions
    this.sessions.delete(threadId);
    active.aborted = true;

    // 2. Close or abort the session
    if (active.persistent) {
      try { (active.session as PersistentSession).close(); } catch {}
    } else {
      try { active.session.abort(); } catch {}
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

/** Adapter-agnostic check for abort errors from any SDK */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}
