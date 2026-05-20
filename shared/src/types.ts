import type { EffortLevel } from "./effort";
import type { PermissionMode } from "./permissions";

// ── Project ─────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
  addedAt: string;
}

export interface ProjectWithStatus extends Project {
  currentBranch: string;
  threadCount: number;
  activeThreadCount: number;
  outstandingPrCount: number;
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
}

export type CleanupReason =
  | "still_active"
  | "uncommitted_changes"
  | "unpushed_commits"
  | "not_on_remote"
  | "remote_branch_deleted"
  | "post_merge_commits"
  | "worktree_missing"
  | "cleanup_failed"
  | "git_error"
  | "no_worktree";

export interface CleanupThreadSummary {
  id: string;
  title: string;
}

export interface CleanupThreadIssue extends CleanupThreadSummary {
  reason: CleanupReason;
}

export interface CleanupConfirmationCandidate extends CleanupThreadIssue {
  defaultSelected: boolean;
}

export interface CleanupPushedResponse {
  cleaned: CleanupThreadSummary[];
  skipped: CleanupThreadIssue[];
  needsConfirmation: CleanupConfirmationCandidate[];
}

// ── Thread ──────────────────────────────────────────────

export type ThreadStatus = "running" | "pending" | "paused" | "waiting" | "done" | "error";

export type PrStatus = "draft" | "open" | "merged" | "closed";

export interface PersistedThreadMetrics {
  costUsd: number;
  durationMs: number;
  turnCount: number;
  /** Actual tokens occupying the model context window for the latest request */
  contextTokens: number;
  /** Per-request input tokens from the latest primary-model API call */
  inputTokens: number;
  /** Per-request output tokens from the latest primary-model API call */
  outputTokens: number;
  contextWindow: number;
  modelName: string | null;
  /** ISO timestamp when the current turn started, or null when idle */
  activeTurnStartedAt: string | null;
}

export interface Thread {
  id: string;
  title: string;
  agent: string;
  effortLevel: EffortLevel | null;
  permissionMode: PermissionMode | null;
  model: string | null;
  projectId: string;
  repoPath: string;
  worktree: string | null;
  branch: string | null;
  /** The branch the worktree was created from (e.g. "staging", "main") */
  baseBranch: string | null;
  prUrl: string | null;
  prStatus: PrStatus | null;
  prNumber: number | null;
  pid: number | null;
  status: ThreadStatus;
  errorMessage: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the last user-initiated message (used for sidebar sort order) */
  lastInteractedAt: string;
  metrics: PersistedThreadMetrics;
}

// ── Message ─────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  threadId: string;
  seq: number;
  role: MessageRole;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ── Agent Config ────────────────────────────────────────

export interface AgentConfig {
  name: string;
  command: string;
  args: string[];
  detected: boolean;
  version: string | null;
}

// ── Streaming ──────────────────────────────────────────

/** A single queued message visible to the client */
export interface QueuedItem {
  id: string;
  /** First 200 chars of the message content */
  content: string;
  createdAt: string;
  /** pending = cancellable, sent = already injected via streamInput */
  state: "pending" | "sent";
}

export interface StreamDelta {
  threadId: string;
  deltaType: "text" | "tool_start" | "tool_input" | "tool_end" | "turn_end" | "metrics" | "queued_message" | "queue_updated";
  text?: string;
  toolName?: string;
  toolInput?: string;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  /** Actual tokens occupying the model context window for this request */
  contextTokens?: number;
  /** Per-request input tokens (including cache reads) */
  inputTokens?: number;
  /** Per-request output tokens */
  outputTokens?: number;
  /** Model context window size (from the primary model used) */
  contextWindow?: number;
  /** Primary model name (e.g. "claude-sonnet-4-20250514") */
  modelName?: string;
  /** True when this metrics delta came from a completed turn result, not an intermediate stream update */
  finalMetrics?: boolean;
  /** Current queue depth (for queued_message deltas — backward compat) */
  queuedCount?: number;
  /** Full queue state (for queue_updated deltas) */
  queueItems?: QueuedItem[];
}

// ── Turn Metrics ──────────────────────────────────────

export interface TurnMetrics {
  costUsd: number;
  durationMs: number;
  turnCount: number;
  /** Actual tokens occupying the model context window for the latest request */
  contextTokens: number;
  /** Per-request input tokens from latest primary-model API call */
  inputTokens: number;
  /** Per-request output tokens from latest primary-model API call */
  outputTokens: number;
  /** Model context window size (latest reported) */
  contextWindow: number;
  /** Primary model name (latest reported, e.g. "claude-sonnet-4-20250514") */
  modelName: string | null;
}

// ── WebSocket Messages ──────────────────────────────────

export type WSClientMessage =
  | { type: "subscribe"; threadId: string; lastSeq?: number }
  | { type: "unsubscribe"; threadId: string }
  | { type: "set_presence"; threadId: string | null }
  | { type: "send_message"; threadId: string; content: string; attachments?: Attachment[]; interrupt?: boolean }
  | { type: "stop_thread"; threadId: string }
  | { type: "resolve_attention"; attentionId: string; resolution: AttentionResolution }
  | { type: "cancel_queued"; threadId: string; queueId: string }
  | { type: "clear_queue"; threadId: string }
  | { type: "terminal_create"; threadId: string }
  | { type: "terminal_input"; terminalId: string; data: string }
  | { type: "terminal_resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal_close"; terminalId: string }
  | { type: "ping" };

export type WSServerMessage =
  | { type: "message"; message: Message }
  | { type: "thread_updated"; thread: Thread }
  | { type: "error"; error: string }
  | { type: "replay_done"; threadId: string }
  | { type: "stream_delta"; delta: StreamDelta }
  | { type: "attention_required"; attention: AttentionItem }
  | { type: "attention_resolved"; attentionId: string; threadId: string }
  | { type: "terminal_created"; terminalId: string; threadId: string; reconnect?: boolean; replay?: string }
  | { type: "terminal_output"; terminalId: string; data: string }
  | { type: "terminal_exit"; terminalId: string; exitCode: number }
  | { type: "terminal_error"; terminalId: string; error: string };

// ── Attention ──────────────────────────────────────────

export type AttentionKind = "ask_user" | "permission" | "confirmation";

export interface AttentionItem {
  id: string;
  threadId: string;
  kind: AttentionKind;
  prompt: string;
  options: string[] | null;        // For ask_user: list of option labels
  metadata: Record<string, unknown> | null; // Tool name, command, file path, etc.
  continuationToken: string | null; // session_id for --resume
  resolvedAt: string | null;
  resolution: AttentionResolution | null;
  expiresAt: string | null;
  createdAt: string;
}

export type AttentionResolution =
  | { type: "user"; optionIndex?: number; text?: string; action?: "allow" | "deny" }
  | { type: "orphaned"; reason: string }
  | { type: "expired" };

// ── Todo Items ────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// ── Attachments ──────────────────────────────────────────

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;          // relative URL to serve the file: /api/uploads/:id
}

// ── Slash Commands ─────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "plugin" | "skill";
}

// ── Settings ─────────────────────────────────────────────

export interface Settings {
  worktreeRoot: string;
  /** Inactivity timeout in minutes — abort sessions with no SDK messages for this long (default: 30) */
  inactivityTimeoutMinutes: number;
  /** Whether thread views should follow new messages and streaming output automatically */
  autoScrollThreads: boolean;
  /** Display-only remote URL (Tailscale HTTPS, VPN, tunnel, etc.) — shown in Settings panel */
  remoteUrl: string;
  /** Default model for Claude agent (empty string = SDK default) */
  defaultModelClaude: string;
  /** Default model for Codex agent (empty string = SDK default) */
  defaultModelCodex: string;
  /** Default effort level for new threads — applied when supported by the selected agent */
  defaultEffortLevel: EffortLevel | "";
  /** Default agent for new threads — must be a detected agent name, or empty for auto-detect */
  defaultAgent: string;
}

// ── LSP Plugin Diagnostics ──────────────────────────────

/**
 * One entry per enabled LSP plugin found in `~/.claude/settings.json`.
 * Orchestra inherits the user's CLI plugin config via `settingSources: ["user", ...]`,
 * which means any enabled `*-lsp@*` plugin will cause the SDK to spawn its language
 * server. If the binary is missing from PATH, that spawn fails and the agent turn
 * errors out. This diagnostic surfaces the mismatch on server startup so the user
 * can install the binary (or disable the plugin) before hitting the error mid-turn.
 */
export interface LspPluginDiagnostic {
  /** Full plugin ID, e.g. "pyright-lsp@claude-plugins-official" */
  pluginId: string;
  /** Plugin short name, e.g. "pyright-lsp" */
  pluginName: string;
  /** Marketplace name, e.g. "claude-plugins-official" */
  marketplace: string;
  /** LSP server identifier within the plugin (e.g. "pyright", "typescript") */
  serverName: string;
  /** Binary the plugin expects, e.g. "pyright-langserver" */
  command: string;
  /**
   * - `"ok"`: binary was resolved on PATH
   * - `"missing"`: binary not found on PATH (primary failure mode)
   * - `"manifest-missing"`: plugin is enabled in settings but we couldn't find
   *    its marketplace manifest — the SDK will fail with a different error.
   */
  status: "ok" | "missing" | "manifest-missing";
  /**
   * When status === "ok", indicates the binary was resolved. We intentionally
   * do NOT include the absolute path — returning it would leak the server
   * user's home directory layout and toolchain choices to any authenticated
   * client (see adversarial review #19).
   */
  resolved: boolean;
  /** Human-readable install hint from the curated map, if any. */
  installHint: string | null;
  /**
   * Populated when status === "manifest-missing" — tells the user *why* we
   * couldn't check this plugin. Null for "ok" / "missing".
   */
  reason: string | null;
}

export interface LspDiagnosticsResponse {
  diagnostics: LspPluginDiagnostic[];
  /** ISO timestamp of the last check */
  checkedAt: string;
}

// ── Tailscale Detection ─────────────────────────────────

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  ip: string | null;
  hostname: string | null;
  httpsAvailable: boolean;
  httpsUrl: string | null;
  /** Whether tailscale serve maps to this Orchestra instance's port */
  portMatch: boolean;
  /** Proxy target uses HTTPS but Orchestra is HTTP — will cause 502 */
  proxyMismatch: boolean;
  /** Orchestra server port (for generating correct tailscale serve command) */
  orchestraPort: number;
  /** Current remoteUrl setting value */
  remoteUrl: string;
}

// ── API Types ───────────────────────────────────────────

export interface CreateThreadRequest {
  agent: string;
  effortLevel?: EffortLevel;
  permissionMode?: PermissionMode;
  model?: string;
  prompt: string;
  projectId: string;
  title?: string;
  isolate?: boolean;
  worktreeName?: string;
  /** Override the base branch for the worktree (defaults to project's checked-out branch) */
  baseBranch?: string;
  attachments?: Attachment[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** The branch the worktree was created from (e.g. "staging", "main") */
  baseBranch: string | null;
  aheadBehind: { ahead: number; behind: number };
  changedFiles: string[];
  diffStats?: { insertions: number; deletions: number };
}

export interface FileDiff {
  filePath: string;
  oldContent: string;
  newContent: string;
  binary?: boolean;
  truncated?: boolean;
}
