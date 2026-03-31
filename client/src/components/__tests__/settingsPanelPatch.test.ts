import { describe, expect, test } from "bun:test";
import type { Settings } from "shared";
import { buildSettingsPatch } from "../SettingsPanel";

const baseSettings: Settings = {
  worktreeRoot: "/tmp/worktrees",
  inactivityTimeoutMinutes: 30,
  autoScrollThreads: true,
  remoteUrl: "",
  defaultModelClaude: "",
  defaultModelCodex: "",
  defaultEffortLevel: "",
  defaultAgent: "",
};

describe("settings panel patch builder", () => {
  test("returns an empty patch when nothing changed", () => {
    expect(buildSettingsPatch(baseSettings, {
      worktreeRoot: baseSettings.worktreeRoot,
      inactivityTimeout: String(baseSettings.inactivityTimeoutMinutes),
      autoScrollThreads: baseSettings.autoScrollThreads,
      defaultModelClaude: baseSettings.defaultModelClaude,
      defaultModelCodex: baseSettings.defaultModelCodex,
      defaultEffortLevel: baseSettings.defaultEffortLevel,
      defaultAgent: baseSettings.defaultAgent,
    })).toEqual({});
  });

  test("captures auto-scroll changes and trims the worktree root", () => {
    expect(buildSettingsPatch(baseSettings, {
      worktreeRoot: "  /tmp/alt-worktrees  ",
      inactivityTimeout: String(baseSettings.inactivityTimeoutMinutes),
      autoScrollThreads: false,
      defaultModelClaude: baseSettings.defaultModelClaude,
      defaultModelCodex: baseSettings.defaultModelCodex,
      defaultEffortLevel: baseSettings.defaultEffortLevel,
      defaultAgent: baseSettings.defaultAgent,
    })).toEqual({
      worktreeRoot: "/tmp/alt-worktrees",
      autoScrollThreads: false,
    });
  });

  test("ignores invalid timeouts and includes changed model defaults", () => {
    expect(buildSettingsPatch(baseSettings, {
      worktreeRoot: baseSettings.worktreeRoot,
      inactivityTimeout: "not-a-number",
      autoScrollThreads: baseSettings.autoScrollThreads,
      defaultModelClaude: "claude-3-7-sonnet",
      defaultModelCodex: "gpt-5.4-mini",
      defaultEffortLevel: "high",
      defaultAgent: "codex",
    })).toEqual({
      defaultModelClaude: "claude-3-7-sonnet",
      defaultModelCodex: "gpt-5.4-mini",
      defaultEffortLevel: "high",
      defaultAgent: "codex",
    });
  });
});
