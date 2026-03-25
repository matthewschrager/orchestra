import type { AttentionKind, StreamDelta } from "shared";

export interface StartOpts {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
}

export interface AgentSession {
  /** Async iterator of SDK messages (typed as unknown for adapter-agnosticism) */
  messages: AsyncIterable<unknown>;
  /** Cancel the running query */
  abort: () => void;
  /** Stateful per-session message parser */
  parseMessage(msg: unknown): ParseResult;
  /** Session ID for resume (set after first result) */
  sessionId?: string;
}

export interface ParsedMessage {
  role: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface AttentionEvent {
  kind: AttentionKind;
  prompt: string;
  options?: string[];
  metadata?: Record<string, unknown>;
}

export interface ParseResult {
  messages: ParsedMessage[];
  deltas: Omit<StreamDelta, "threadId">[];
  attention?: AttentionEvent;
  sessionId?: string;
  /** Set when the SDK result indicates an error (e.g., error_during_execution) */
  error?: string;
}

export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  start(opts: StartOpts): AgentSession;
  supportsResume(): boolean;
}
