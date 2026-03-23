import type { Subprocess } from "bun";

export interface SpawnOpts {
  cwd: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
}

export interface AgentProcess {
  proc: Subprocess<"pipe", "pipe", "pipe">;
}

export interface ParsedMessage {
  role: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  spawn(opts: SpawnOpts): AgentProcess;
  parseOutput(line: string): ParsedMessage[];
  sendInput(proc: AgentProcess, text: string): void;
  supportsResume(): boolean;
  getBypassFlags(): string[];
}
