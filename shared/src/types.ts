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
  /** Per-request input tokens (including cache reads) — actual context occupancy */
  inputTokens?: number;
  /** Per-request output tokens — actual context occupancy */
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
  /** Per-request input tokens from latest primary-model API call (actual context occupancy) */
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
  attachments?: Attachment[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  aheadBehind: { ahead: number; behind: number };
  changedFiles: string[];
  diffStats?: { insertions: number; deletions: number };
}
