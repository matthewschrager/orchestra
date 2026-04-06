import { AgentRegistry } from "../registry";
import type { AgentAdapter, AgentSession, StartOpts } from "../types";

function createAdapter(name: string, detected: boolean, version: string | null): AgentAdapter {
  return {
    name,
    async detect() {
      return detected;
    },
    async getVersion() {
      return version;
    },
    start(_opts: StartOpts): AgentSession {
      throw new Error("not used");
    },
    supportsResume() {
      return false;
    },
  };
}

describe("AgentRegistry.detectAll", () => {
  test("includes install guidance for missing agents", async () => {
    const registry = new AgentRegistry();
    (registry as any).adapters = new Map();
    registry.register(createAdapter("codex", false, "codex-cli 0.118.0"));

    const agents = await registry.detectAll();

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "codex",
      detected: false,
      version: null,
      unavailableReason: "Missing `codex` command on PATH.",
    });
    expect(agents[0]?.installHint).toContain("Install the Codex CLI");
    expect(agents[0]?.models.length).toBeGreaterThan(0);
  });

  test("returns version for detected agents", async () => {
    const registry = new AgentRegistry();
    (registry as any).adapters = new Map();
    registry.register(createAdapter("claude", true, "2.1.92 (Claude Code)"));

    const agents = await registry.detectAll();

    expect(agents[0]).toMatchObject({
      name: "claude",
      detected: true,
      version: "2.1.92 (Claude Code)",
      unavailableReason: null,
      installHint: null,
    });
  });
});
