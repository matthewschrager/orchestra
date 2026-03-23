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
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
}

// ── Thread ──────────────────────────────────────────────

export type ThreadStatus = "running" | "pending" | "paused" | "done" | "error";

export interface Thread {
  id: string;
  title: string;
  agent: string;
  projectId: string;
  repoPath: string;
  worktree: string | null;
  branch: string | null;
  prUrl: string | null;
  pid: number | null;
  status: ThreadStatus;
  errorMessage: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface StreamDelta {
  threadId: string;
  deltaType: "text" | "tool_start" | "tool_input" | "tool_end" | "turn_end" | "metrics";
  text?: string;
  toolName?: string;
  toolInput?: string;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
}

// ── Turn Metrics ──────────────────────────────────────

export interface TurnMetrics {
  costUsd: number;
  durationMs: number;
  turnCount: number;
}

// ── WebSocket Messages ──────────────────────────────────

export type WSClientMessage =
  | { type: "subscribe"; threadId: string; lastSeq?: number }
  | { type: "unsubscribe"; threadId: string }
  | { type: "send_message"; threadId: string; content: string }
  | { type: "stop_thread"; threadId: string };

export type WSServerMessage =
  | { type: "message"; message: Message }
  | { type: "thread_updated"; thread: Thread }
  | { type: "error"; error: string }
  | { type: "replay_done"; threadId: string }
  | { type: "stream_delta"; delta: StreamDelta };

// ── Slash Commands ─────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "plugin" | "skill";
}

// ── API Types ───────────────────────────────────────────

export interface CreateThreadRequest {
  agent: string;
  prompt: string;
  projectId: string;
  title?: string;
  isolate?: boolean;
  worktreeName?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  aheadBehind: { ahead: number; behind: number };
  changedFiles: string[];
}
