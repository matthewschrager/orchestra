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
    expect(getEffortLabel("codex", "xhigh")).toBe("Extra High");
  });

  test("returns claude-specific effort options", () => {
    expect(getEffortOptions("claude").map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getEffortLabel("claude", "medium")).toBe("Medium");
    expect(getEffortLabel("claude", "xhigh")).toBe("Extra High");
  });

  test("validates effort support by agent", () => {
    expect(isEffortLevelSupported("codex", "xhigh")).toBe(true);
    expect(isEffortLevelSupported("claude", "xhigh")).toBe(true);
    expect(isEffortLevelSupported("claude", "minimal")).toBe(false);
    expect(isEffortLevelSupported("claude", "high")).toBe(true);
    expect(isEffortLevelSupported("unknown", "high")).toBe(false);
  });
});
