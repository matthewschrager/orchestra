import type { AgentAdapter } from "./types";
import { ClaudeAdapter } from "./claude";

export class AgentRegistry {
  private adapters: Map<string, AgentAdapter> = new Map();

  constructor() {
    this.register(new ClaudeAdapter());
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

  async detectAll(): Promise<Array<{ name: string; detected: boolean; version: string | null }>> {
    const results = await Promise.all(
      this.list().map(async (a) => ({
        name: a.name,
        detected: await a.detect(),
        version: await a.getVersion(),
      })),
    );
    return results;
  }
}
