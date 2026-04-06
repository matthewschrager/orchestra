import { getAgentCommand, getAgentInstallHint, getAgentUnavailableReason } from "../agents";

describe("agent helper text", () => {
  test("returns the expected command names", () => {
    expect(getAgentCommand("claude")).toBe("claude");
    expect(getAgentCommand("codex")).toBe("codex");
    expect(getAgentCommand("custom-agent")).toBe("custom-agent");
  });

  test("builds a missing-command reason", () => {
    expect(getAgentUnavailableReason("claude")).toBe("Missing `claude` command on PATH.");
  });

  test("builds install hints", () => {
    expect(getAgentInstallHint("claude")).toContain("Install Claude Code");
    expect(getAgentInstallHint("codex")).toContain("Install the Codex CLI");
  });
});
