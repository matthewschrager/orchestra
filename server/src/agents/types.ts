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

/** Extended session that keeps the subprocess alive between turns */
export interface PersistentSession extends AgentSession {
  /** Inject a follow-up user message into the running subprocess.
   *  @param priority - 'next' queues for after current turn (default), 'now' interrupts current turn */
  injectMessage(text: string, sessionId: string, priority?: "now" | "next"): Promise<void>;
  /** Cleanly close the subprocess and all MCP connections */
  close(): void;
  /** Reset parser turn-level state (tool dedup sets, active blocks) between turns */
  resetTurnState(): void;
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
  /** Set when ExitPlanMode tool_use is detected — surfaces an attention item for user approval.
   *  Works around SDK bug where requiresUserInteraction() short-circuits bypassPermissions. */
  exitPlanMode?: boolean;
}

export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  start(opts: StartOpts): AgentSession;
  supportsResume(): boolean;
  /** Whether this adapter supports persistent (long-lived) sessions */
  supportsPersistent?(): boolean;
  /** Start a persistent session — subprocess stays alive between turns */
  startPersistent?(opts: StartOpts): PersistentSession;
}
