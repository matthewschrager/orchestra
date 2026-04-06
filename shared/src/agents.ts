import type { ModelOption } from "./models";

export interface AgentStatus {
  name: string;
  detected: boolean;
  version: string | null;
  models: ModelOption[];
  unavailableReason: string | null;
  installHint: string | null;
}

export function getAgentCommand(agent: string): string {
  switch (agent) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    default:
      return agent;
  }
}

export function getAgentInstallHint(agent: string): string {
  const command = getAgentCommand(agent);
  switch (agent) {
    case "claude":
      return `Install Claude Code and ensure the \`${command}\` command is on your PATH, then reload Orchestra.`;
    case "codex":
      return `Install the Codex CLI and ensure the \`${command}\` command is on your PATH, then reload Orchestra.`;
    default:
      return `Install ${agent} and ensure the \`${command}\` command is on your PATH, then reload Orchestra.`;
  }
}

export function getAgentUnavailableReason(agent: string): string {
  return `Missing \`${getAgentCommand(agent)}\` command on PATH.`;
}
