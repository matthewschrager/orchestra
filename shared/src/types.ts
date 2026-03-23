// ── Thread ──────────────────────────────────────────────

export type ThreadStatus = "running" | "pending" | "paused" | "done" | "error";

export interface Thread {
  id: string;
  title: string;
  agent: string;
  repoPath: string;
  worktree: string | null;
  branch: string | null;
  prUrl: string | null;
  pid: number | null;
  status: ThreadStatus;
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
  | { type: "replay_done"; threadId: string };

// ── API Types ───────────────────────────────────────────

export interface CreateThreadRequest {
  agent: string;
  prompt: string;
  title?: string;
  isolate?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  aheadBehind: { ahead: number; behind: number };
  changedFiles: string[];
}
