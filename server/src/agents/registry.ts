import type { AgentAdapter } from "./types";
import { ClaudeAdapter, getCachedClaudeModels } from "./claude";
import { CodexAdapter } from "./codex";
import { getModelOptions, type ModelOption } from "shared";

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

  async detectAll(): Promise<Array<{ name: string; detected: boolean; version: string | null; models: ModelOption[] }>> {
    const results = await Promise.all(
      this.list().map(async (a) => ({
        name: a.name,
        detected: await a.detect(),
        version: await a.getVersion(),
        models: a.name === "claude"
          ? (getCachedClaudeModels() ?? [...getModelOptions("claude")])
          : [...getModelOptions(a.name)],
      })),
    );
    return results;
  }
}
