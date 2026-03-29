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
  enqueueMessage,
  dequeueNextMessage,
  countPendingQueue,
  cleanDeliveredQueue,
} from "../db";
import type { AgentRegistry } from "../agents/registry";
import type { AgentAdapter, AgentSession, AttentionEvent, ParsedMessage, PersistentSession } from "../agents/types";
import type { WorktreeManager } from "../worktrees/manager";
import { isEffortLevelSupported, isPermissionModeSupported } from "shared";
import type { Attachment, AttentionItem, AttentionResolution, EffortLevel, PermissionMode, StreamDelta } from "shared";
import { resolveAttachmentPaths } from "../routes/uploads";
import { generateTitle } from "../titles/generator";
import { detectWorktree } from "../utils/git";
import {
  getDefaultWorktreeDataDir,
  getIsolatedWorktreePort,
} from "../utils/worktree";

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
  /** Number of messages injected during the current turn (persistent sessions only, reset on turn_end) */
  queuedThisTurn: number;
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
    effortLevel?: EffortLevel;
    permissionMode?: PermissionMode;
    model?: string;
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
    if (opts.effortLevel && !isEffortLevelSupported(opts.agent, opts.effortLevel)) {
      throw new Error(`Effort level "${opts.effortLevel}" is not supported for ${opts.agent}`);
    }
    if (opts.permissionMode && !isPermissionModeSupported(opts.agent, opts.permissionMode)) {
      throw new Error(`Permission mode "${opts.permissionMode}" is not supported for ${opts.agent}`);
    }
    const effortLevel = opts.effortLevel ?? null;
    const permissionMode = opts.permissionMode ?? null;
    const model = opts.model ?? null;

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
        `INSERT INTO threads (id, title, agent, effort_level, permission_mode, model, repo_path, project_id, worktree, branch, status, last_interacted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))`,
      )
      .run(threadId, title, opts.agent, effortLevel, permissionMode, model, opts.repoPath, opts.projectId, worktree, branch);

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
      this.startPersistentSession(threadId, adapter, cwd, agentPrompt, null, effortLevel, model, 0, permissionMode);
    } else {
      this.startTurn(threadId, adapter, cwd, agentPrompt, null, effortLevel, model, permissionMode);
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
    this.orphanPendingAttention(threadId, { type: "orphaned", reason: "session_stopped" });
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

  /** Change the model for a thread. For Claude persistent sessions, calls setModel() immediately.
   *  For non-persistent (Codex), updates DB only — next startTurn picks up the new model. */
  async changeModel(threadId: string, model: string | null): Promise<void> {
    const active = this.sessions.get(threadId);
    if (active && active.state === "thinking") {
      throw new Error("Cannot change model while agent is mid-turn");
    }

    if (DEBUG) console.log(`[session] changeModel thread=${threadId} model=${model} hasActive=${!!active} persistent=${active?.persistent} state=${active?.state}`);

    // Update DB
    updateThread(this.db, threadId, { model });

    // For persistent Claude sessions: call setModel() immediately on the live subprocess
    if (active?.persistent && model) {
      const persistentSession = active.session as PersistentSession;
      if (persistentSession.setModel) {
        if (DEBUG) console.log(`[session] calling setModel(${model}) on persistent session`);
        await persistentSession.setModel(model);
      }
    } else {
      // No active session — clear persisted session_id so the next sendMessage
      // starts a fresh session with the new model instead of resuming the old one
      // (resumed sessions ignore the model parameter and keep the original model)
      updateThread(this.db, threadId, { session_id: null });
      if (DEBUG) console.log(`[session] cleared session_id for ${threadId} — next message will start fresh with model=${model}`);
    }

    this.notifyThread(threadId);
  }

  /** Change the permission mode for a thread. For Claude persistent sessions, calls setPermissionMode()
   *  immediately when idle. When mid-turn, updates DB only — deferred until next idle point.
   *  For non-persistent (Codex), updates DB only — next startTurn picks up the new mode. */
  async changePermissionMode(threadId: string, permissionMode: string | null): Promise<void> {
    if (DEBUG) console.log(`[session] changePermissionMode thread=${threadId} mode=${permissionMode}`);

    // Update DB
    updateThread(this.db, threadId, { permission_mode: permissionMode });

    // For persistent Claude sessions: call setPermissionMode() if not mid-turn
    const active = this.sessions.get(threadId);
    if (active?.persistent && permissionMode && active.state !== "thinking") {
      const persistentSession = active.session as PersistentSession;
      if (persistentSession.setPermissionMode) {
        try {
          await persistentSession.setPermissionMode(permissionMode);
          if (DEBUG) console.log(`[session] setPermissionMode("${permissionMode}") applied immediately`);
        } catch (err) {
          console.error(`[session] setPermissionMode failed for thread ${threadId}:`, err);
          // DB is already updated — next turn will pick it up
        }
      }
    }

    this.notifyThread(threadId);
  }

  /** Change the effort level for a thread. Updates DB only — effort is baked into the Query
   *  constructor for persistent sessions, so it takes effect on session restart.
   *  For non-persistent sessions, next startTurn picks it up. */
  async changeEffortLevel(threadId: string, effortLevel: string | null): Promise<void> {
    if (DEBUG) console.log(`[session] changeEffortLevel thread=${threadId} effort=${effortLevel}`);

    // Update DB only — no live SDK call (effort is fixed at Query construction)
    updateThread(this.db, threadId, { effort_level: effortLevel });

    this.notifyThread(threadId);
  }

  sendMessage(threadId: string, content: string, attachments?: Attachment[], opts?: { internal?: boolean; interrupt?: boolean }): void {
    if (DEBUG) console.log(`[session] sendMessage thread=${threadId} content=${content.slice(0, 60)} interrupt=${!!opts?.interrupt}`);
    const thread = getThread(this.db, threadId) as ThreadRow | null;
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    const adapter = this.registry.get(thread.agent);
    if (!adapter) throw new Error(`Unknown agent: ${thread.agent}`);
    const effortLevel = isEffortLevelSupported(thread.agent, thread.effort_level) ? thread.effort_level : null;
    const permissionMode = this.getThreadPermissionMode(threadId);
    const model = thread.model ?? null;

    const existing = this.sessions.get(threadId);

    // ── QUEUE PATH: any session mid-turn — queue for delivery ──
    if (existing && existing.state === "thinking") {
      if (!content.trim()) {
        throw new Error("Cannot queue an empty message");
      }
      // Queue depth limit: persistent uses per-turn counter (messages are injected immediately),
      // non-persistent uses total pending in SQLite (messages wait for turn to complete)
      const queueCount = existing.persistent
        ? existing.queuedThisTurn
        : countPendingQueue(this.db, threadId);
      if (queueCount >= MAX_QUEUED_MESSAGES) {
        throw new Error("Queue full — wait for the agent to finish");
      }

      // Persist user message immediately so it appears in chat
      const validAttachments = this.validateAttachments(attachments);
      this.persistMessage(threadId, {
        role: "user",
        content,
        metadata: validAttachments?.length ? { attachments: validAttachments } : undefined,
      });

      const agentPrompt = this.buildPromptWithAttachments(content, validAttachments);
      const isInterrupt = !!opts?.interrupt;

      // Persist to message_queue for crash recovery + delivery tracking
      const serializedAttachments = validAttachments?.length ? JSON.stringify(validAttachments) : null;
      const queueRow = enqueueMessage(this.db, threadId, agentPrompt, serializedAttachments, isInterrupt);

      // For interrupt messages, orphan pending attention immediately (user is overriding)
      if (isInterrupt) {
        this.orphanPendingAttention(threadId, { type: "orphaned", reason: "superseded_by_interrupt" });
      }

      // For persistent sessions, also inject into the living subprocess.
      // On successful inject, mark the queue entry as delivered immediately
      // (the CLI subprocess has it — queue entry is only for crash recovery).
      if (existing.persistent) {
        const priority = isInterrupt ? "now" as const : "next" as const;
        const sessionId = existing.sessionId ?? this.getPersistedSessionId(threadId);
        if (sessionId) {
          let injected = false;
          try {
            const injectPromise = (existing.session as PersistentSession).injectMessage(agentPrompt, sessionId, priority);
            injected = true; // streamInput accepted the message synchronously
            // Mark as delivered — CLI has it now
            this.markQueueDelivered(queueRow.id);
            injectPromise.catch((err) => {
              if (existing.aborted || !this.sessions.has(threadId)) return;
              console.error(`[session] queued streamInput failed for ${threadId}:`, err);
              // Message was marked delivered but CLI may not have it — user can resend
            });
          } catch (err) {
            if (!injected) {
              // Synchronous throw — message stays pending in queue for drain
              if (existing.aborted || !this.sessions.has(threadId)) return;
              console.error(`[session] queued streamInput threw for ${threadId}:`, err);
            }
          }
        } else {
          if (DEBUG) console.log(`[session] No sessionId for queue inject on ${threadId} — persisted to queue, will drain on turn_end`);
        }
      }
      // Non-persistent sessions: message stays in SQLite queue, drained after iterator completes

      if (existing.persistent) {
        existing.queuedThisTurn++;
      }
      const newCount = existing.persistent
        ? existing.queuedThisTurn
        : countPendingQueue(this.db, threadId);
      this.notifyStreamDelta(threadId, { threadId, deltaType: "queued_message", queuedCount: newCount });
      return;
    }

    // ── IMMEDIATE DELIVERY PATH (not mid-turn) ──

    // Orphan any pending attention items — user is moving on by sending a new message,
    // so old AskUserQuestions are no longer relevant. Without this, stale attention items
    // cause the turn_end handler to skip the status→"done" transition, leaving the thread
    // stuck in "running" forever.
    const orphaned = this.orphanPendingAttention(threadId, { type: "orphaned", reason: "superseded_by_user_message" });
    if (orphaned > 0 && DEBUG) {
      console.log(`[session] Orphaned ${orphaned} stale attention items for ${threadId} on sendMessage`);
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
      existing.queuedThisTurn = 0;
      updateThread(this.db, threadId, { status: "running", error_message: null });
      this.notifyThread(threadId);

      // Reset parser turn-level state for clean dedup
      (existing.session as PersistentSession).resetTurnState();

      const sessionId = existing.sessionId ?? this.getPersistedSessionId(threadId);
      if (!sessionId) {
        // No session_id — can't inject. Fall back to restart.
        console.warn(`[session] No sessionId for persistent inject on ${threadId}, falling back to restart`);
        this.teardownSession(threadId);
        this.startTurn(threadId, adapter, cwd, agentPrompt, null, effortLevel, model, permissionMode);
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
      this.startPersistentSession(threadId, adapter, cwd, agentPrompt, sessionId, effortLevel, model, 0, permissionMode);
    } else {
      this.startTurn(threadId, adapter, cwd, agentPrompt, sessionId, effortLevel, model, permissionMode);
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
  async resolveAttention(attentionId: string, resolution: object): Promise<AttentionRow | null> {
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
        // ── ExitPlanMode approval: programmatically exit plan mode ──
        // ExitPlanMode is denied in canUseTool (Zod error workaround), so the CLI subprocess
        // never actually exits plan mode. On approval, we call setPermissionMode to flip the
        // CLI back to bypassPermissions before telling the agent to proceed.
        const metadata = existing.metadata ? JSON.parse(existing.metadata) : {};
        if (metadata.source === "exit_plan_mode") {
          await this.handleExitPlanModeResolution(threadId, res);
          this.notifyAttentionResolved(attentionId, threadId);
          return resolved;
        }

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
  /** Mark a queue entry as delivered (CLI subprocess accepted it via streamInput) */
  private markQueueDelivered(queueId: string): void {
    this.db.query("UPDATE message_queue SET delivered_at = datetime('now') WHERE id = ?").run(queueId);
  }

  private validateAttachments(attachments?: Attachment[]): Attachment[] | undefined {
    if (!attachments?.length) return attachments;
    return attachments.filter((a) => SessionManager.NANOID_RE.test(a.id));
  }

  /** Build isolation preamble for worktree-isolated agent sessions.
   *  Gives the agent operational context about Orchestra to avoid accidental interference. */
  buildIsolationPreamble(cwd: string): string {
    // Sanitize cwd to prevent prompt injection via crafted worktree names
    const safeCwd = cwd.replace(/[\n\r\t]/g, "_").slice(0, 200);
    const worktreeName = detectWorktree(cwd);
    const nestedPort = worktreeName ? getIsolatedWorktreePort(worktreeName) : this.orchestraPort;
    const nestedDataDir = worktreeName
      ? getDefaultWorktreeDataDir(worktreeName, safeCwd, { orchestraManaged: true })
      : `${safeCwd}/.orchestra-worktree`;
    return [
      "[Orchestra context — you are running inside an Orchestra-managed session]",
      `- Orchestra server is on localhost:${this.orchestraPort} — do NOT interact with it`,
      "- Do NOT modify ~/.orchestra/ or kill processes you didn't start",
      `- Confine your work to this directory: ${safeCwd}`,
      `- If you need a nested Orchestra server for QA from this worktree, use ORCHESTRA_ALLOW_NESTED=1 ORCHESTRA_PORT=${nestedPort} ORCHESTRA_DATA_DIR=${nestedDataDir} bun run --filter server start`,
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
    effortLevel: EffortLevel | null,
    model?: string | null,
    permissionMode?: string | null,
  ): void {
    if (DEBUG) console.log(`[session] startTurn thread=${threadId} resume=${resumeSessionId ?? "new"} cwd=${cwd} permissionMode=${permissionMode ?? "default"}`);
    const session = adapter.start({
      cwd,
      effortLevel: effortLevel ?? undefined,
      permissionMode: permissionMode ?? undefined,
      model: model ?? undefined,
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
      queuedThisTurn: 0,
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
    effortLevel: EffortLevel | null,
    model?: string | null,
    restartCount: number = 0,
    permissionMode?: string | null,
  ): void {
    if (DEBUG) console.log(`[session] startPersistentSession thread=${threadId} resume=${resumeSessionId ?? "new"} cwd=${cwd} restarts=${restartCount} permissionMode=${permissionMode ?? "default"}`);

    // Fix #11: Validate startPersistent exists before calling
    if (!adapter.startPersistent) {
      throw new Error(`Adapter "${adapter.name}" claims supportsPersistent() but has no startPersistent method`);
    }

    const session = adapter.startPersistent({
      cwd,
      effortLevel: effortLevel ?? undefined,
      permissionMode: permissionMode ?? undefined,
      model: model ?? undefined,
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
      queuedThisTurn: 0,
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

        // ── Turn boundary for persistent sessions ──
        // On turn_end, transition to idle (or waiting if attention pending).
        // The iterator stays alive — next message arrives when user sends follow-up.
        if (isTurnEnd && activeSession.persistent) {
          // Check DB for pending attention — more reliable than per-message variable,
          // which misses attention created in earlier messages of the same turn (#9)
          const hasPendingAttention = getPendingAttention(this.db, threadId).length > 0;
          const newState: SessionState = hasPendingAttention ? "waiting" : "idle";
          activeSession.state = newState;
          activeSession.queuedThisTurn = 0;
          turnMessageCount = 0;

          if (DEBUG) console.log(`[stream] Thread ${threadId} — persistent turn ended, state → ${newState}`);

          if (hasPendingAttention) {
            // Turn ended with pending attention — ensure status is "waiting" and notify.
            // Defensive: status may have been overwritten to "running" by sendMessage()
            // if the user answered by typing directly instead of resolving the attention item.
            // Queue drain pauses while waiting — queued messages will drain after attention resolves.
            updateThread(this.db, threadId, { status: "waiting", pid: null });
            this.notifyThread(threadId);
          } else {
            // ── Queue drain for persistent sessions ──
            // Check SQLite queue for pending messages. If found, route through sendMessage()
            // which handles state transitions, resetTurnState(), and inject.
            const nextQueued = dequeueNextMessage(this.db, threadId);
            if (nextQueued) {
              if (DEBUG) console.log(`[stream] Thread ${threadId} — draining queued message from SQLite`);
              // sendMessage with internal flag (skip touchThreadInteraction)
              // This transitions state back to "thinking" and injects the message.
              try {
                const drainAttachments = nextQueued.attachments ? JSON.parse(nextQueued.attachments) : undefined;
                this.sendMessage(threadId, nextQueued.content, drainAttachments, { internal: true });
              } catch (drainErr) {
                console.error(`[stream] Thread ${threadId} — queue drain failed:`, drainErr);
                updateThread(this.db, threadId, { status: "done", pid: null });
                this.notifyThread(threadId);
              }
            } else {
              // Turn completed normally — mark done but keep session alive
              updateThread(this.db, threadId, { status: "done", pid: null });
              this.notifyThread(threadId);
            }
          }
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

        // Check if attention items were created during the turn (e.g., ExitPlanMode)
        // before treating as mid-turn death. The attention may have been created from the
        // parser (like AskUserQuestion), setting DB to "waiting" without reaching a turn boundary.
        const hasPendingOnDeath = getPendingAttention(this.db, threadId).length > 0;
        if (hasPendingOnDeath) {
          if (DEBUG) console.log(`[stream] Thread ${threadId} — persistent session died with pending attention, keeping "waiting"`);
          updateThread(this.db, threadId, { status: "waiting", pid: null });
          this.notifyThread(threadId);
          return;
        }

        // Subprocess died mid-turn — surface error, enable resume on next message
        const pendingQueueCount = countPendingQueue(this.db, threadId);
        console.warn(`[stream] Thread ${threadId} — persistent session died mid-turn after ${turnMessageCount} msgs (${pendingQueueCount} queued)`);
        this.orphanPendingAttention(threadId, { type: "orphaned", reason: "session_ended_unexpectedly" });
        const queueNote = pendingQueueCount > 0
          ? ` ${pendingQueueCount} queued message${pendingQueueCount !== 1 ? "s" : ""} will be delivered when you send a follow-up.`
          : "";
        this.persistMessage(threadId, {
          role: "assistant",
          content: `**Session ended unexpectedly.** Send a follow-up message to resume.${queueNote}`,
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
        this.orphanPendingAttention(threadId, { type: "orphaned", reason: "agent_session_failed" });
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
        // Agent asked a question — don't drain queue while waiting for user answer
        updateThread(this.db, threadId, { pid: null });
      } else {
        // ── Queue drain for non-persistent sessions ──
        // Check SQLite queue before marking done. If messages are pending, start a new turn.
        const nextQueued = dequeueNextMessage(this.db, threadId);
        if (nextQueued) {
          if (DEBUG) console.log(`[stream] Thread ${threadId} — draining queued message (non-persistent), starting new turn`);
          const freshThread = getThread(this.db, threadId) as ThreadRow | null;
          const drainAdapter = freshThread ? this.registry.get(freshThread.agent) : adapter;
          const drainCwd = freshThread ? (freshThread.worktree || freshThread.repo_path) : activeSession.cwd;
          const drainEffort = freshThread && isEffortLevelSupported(freshThread.agent, freshThread.effort_level)
            ? freshThread.effort_level : null;
          const drainPermMode = freshThread ? this.getThreadPermissionMode(threadId) : null;
          const drainSessionId = activeSession.sessionId ?? this.getPersistedSessionId(threadId) ?? null;

          if (drainAdapter) {
            updateThread(this.db, threadId, { status: "running", error_message: null });
            this.notifyThread(threadId);
            if (drainAdapter.supportsPersistent?.()) {
              this.startPersistentSession(threadId, drainAdapter, drainCwd, nextQueued.content, drainSessionId, drainEffort, undefined, 0, drainPermMode);
            } else {
              this.startTurn(threadId, drainAdapter, drainCwd, nextQueued.content, drainSessionId, drainEffort, undefined, drainPermMode);
            }
          } else {
            // Adapter disappeared? Shouldn't happen, but handle gracefully
            console.error(`[stream] Thread ${threadId} — queue drain failed: adapter not found`);
            updateThread(this.db, threadId, { status: "done", pid: null });
            this.notifyThread(threadId);
          }
          return; // Skip normal completion — new turn handles lifecycle
        }

        const orphanedCount = this.orphanPendingAttention(threadId, { type: "orphaned", reason: "session_completed_without_resolution" });
        if (orphanedCount > 0) {
          console.log(`Orphaned ${orphanedCount} attention items for thread ${threadId}`);
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
      this.orphanPendingAttention(threadId, { type: "orphaned", reason: "agent_error" });

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
      this.startPersistentSession(threadId, adapter, cwd, prompt, sessionId, this.getThreadEffortLevel(threadId), this.getThreadModel(threadId), restartCount, this.getThreadPermissionMode(threadId));
    } else {
      this.startTurn(threadId, adapter, cwd, prompt, sessionId, this.getThreadEffortLevel(threadId), this.getThreadModel(threadId), this.getThreadPermissionMode(threadId));
    }
  }

  private getThreadEffortLevel(threadId: string): EffortLevel | null {
    const thread = getThread(this.db, threadId);
    if (!thread) return null;
    return isEffortLevelSupported(thread.agent, thread.effort_level) ? thread.effort_level : null;
  }

  private getThreadModel(threadId: string): string | null {
    const thread = getThread(this.db, threadId);
    return thread?.model ?? null;
  }

  private getThreadPermissionMode(threadId: string): string | null {
    const thread = getThread(this.db, threadId);
    if (!thread) return null;
    return isPermissionModeSupported(thread.agent, thread.permission_mode) ? thread.permission_mode : null;
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

  /** Handle user resolution of an ExitPlanMode attention item.
   *  On approval: call setPermissionMode("bypassPermissions") to exit plan mode at the
   *  CLI level, then message the agent to proceed. On rejection: message the agent to revise. */
  private async handleExitPlanModeResolution(
    threadId: string,
    res: { optionIndex?: number; text?: string },
  ): Promise<void> {
    const isApproved = res.optionIndex === 0; // "Approve plan" is index 0
    const activeSession = this.sessions.get(threadId);

    if (isApproved && activeSession?.persistent) {
      // Exit plan mode at the CLI level before telling the agent to proceed.
      // Restore the thread's configured permission mode (or bypassPermissions if it was plan mode).
      const configuredMode = this.getThreadPermissionMode(threadId);
      const targetMode = configuredMode === "plan" ? "bypassPermissions" : (configuredMode || "bypassPermissions");
      const persistentSession = activeSession.session as PersistentSession;
      if (persistentSession.setPermissionMode) {
        try {
          await persistentSession.setPermissionMode(targetMode);
          if (DEBUG) console.log(`[session] Thread ${threadId} — setPermissionMode("${targetMode}") for ExitPlanMode approval`);
        } catch (err) {
          console.error(`[session] Thread ${threadId} — failed to setPermissionMode:`, err);
          // Continue anyway — the message alone may be enough if plan mode is model-level only
        }
      }
    }

    const message = isApproved
      ? "Plan approved by user. Plan mode has been exited. Proceed with implementation."
      : "Plan rejected by user. Please revise your plan based on their feedback and try again.";

    this.sendMessage(threadId, message);
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

  private orphanPendingAttention(threadId: string, resolution: Extract<AttentionResolution, { type: "orphaned" }>): number {
    const pending = getPendingAttention(this.db, threadId);
    if (pending.length === 0) return 0;

    const orphaned = orphanAttentionItems(this.db, threadId, resolution.reason);
    if (orphaned === 0) return 0;

    for (const item of pending) {
      this.notifyAttentionResolved(item.id, threadId);
    }
    return orphaned;
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
    this.orphanPendingAttention(threadId, { type: "orphaned", reason: "session_timed_out" });

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
      // Housekeeping: clean up delivered queue entries older than 1 hour
      cleanDeliveredQueue(this.db);
    }, INACTIVITY_CHECK_INTERVAL_MS);
  }

  /** Mark any threads that were running when the server crashed as errored.
   *  With SDK sessions (no orphan processes), we just update the DB. */
  private recoverOrphanedThreads(): void {
    const running = this.db
      .query("SELECT id FROM threads WHERE status IN ('running', 'waiting')")
      .all() as Pick<ThreadRow, "id">[];

    for (const thread of running) {
      this.orphanPendingAttention(thread.id, { type: "orphaned", reason: "server_restarted" });
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
