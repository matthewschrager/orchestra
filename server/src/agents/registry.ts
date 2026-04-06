import type { AgentAdapter } from "./types";
import { ClaudeAdapter, getCachedClaudeModels } from "./claude";
import { CodexAdapter } from "./codex";
import {
  getAgentInstallHint,
  getAgentUnavailableReason,
  getModelOptions,
  type AgentStatus,
} from "shared";

export class AgentRegistry {
  private adapters: Map<string, AgentAdapter> = new Map();

  constructor() {
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async detectAll(): Promise<AgentStatus[]> {
    const results = await Promise.all(
      this.list().map(async (a) => {
        const detected = await a.detect();
        return {
          name: a.name,
          detected,
          version: detected ? await a.getVersion() : null,
          models: a.name === "claude"
            ? (getCachedClaudeModels() ?? [...getModelOptions("claude")])
            : [...getModelOptions(a.name)],
          unavailableReason: detected ? null : getAgentUnavailableReason(a.name),
          installHint: detected ? null : getAgentInstallHint(a.name),
        };
      }),
    );
    return results;
  }
}
