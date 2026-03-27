import { describe, expect, test } from "bun:test";
import { getEffortLabel, getEffortOptions, isEffortLevelSupported } from "../effort";

describe("effort helpers", () => {
  test("returns codex-specific effort options", () => {
    expect(getEffortOptions("codex").map((option) => option.value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getEffortLabel("codex", "xhigh")).toBe("Max");
  });

  test("returns claude-specific effort options", () => {
    expect(getEffortOptions("claude").map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(getEffortLabel("claude", "medium")).toBe("Medium");
  });

  test("validates effort support by agent", () => {
    expect(isEffortLevelSupported("codex", "xhigh")).toBe(true);
    expect(isEffortLevelSupported("claude", "xhigh")).toBe(false);
    expect(isEffortLevelSupported("claude", "minimal")).toBe(false);
    expect(isEffortLevelSupported("claude", "high")).toBe(true);
    expect(isEffortLevelSupported("unknown", "high")).toBe(false);
  });
});
