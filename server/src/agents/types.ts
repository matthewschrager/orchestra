import type { Subprocess } from "bun";
import type { AttentionKind, StreamDelta } from "shared";

export interface SpawnOpts {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
}

export interface AgentProcess {
  proc: Subprocess<"ignore", "pipe", "pipe">;
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
}

export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  spawn(opts: SpawnOpts): AgentProcess;
  parseOutput(line: string): ParseResult;
  supportsResume(): boolean;
  getBypassFlags(): string[];
}
