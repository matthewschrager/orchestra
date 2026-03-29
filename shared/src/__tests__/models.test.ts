import { describe, expect, test } from "bun:test";
import { getModelOptions, isModelSupported, getModelLabel } from "../models";

describe("getModelOptions", () => {
  test("returns claude models", () => {
    const options = getModelOptions("claude");
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.value === "claude-sonnet-4-6")).toBe(true);
    expect(options.some((o) => o.value === "claude-opus-4-6")).toBe(true);
    expect(options.some((o) => o.value === "claude-haiku-3-5")).toBe(true);
  });

  test("returns codex models", () => {
    const options = getModelOptions("codex");
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.value === "gpt-5.3-codex")).toBe(true);
    expect(options.some((o) => o.value === "gpt-5.4")).toBe(true);
    expect(options.some((o) => o.value === "gpt-5.4-mini")).toBe(true);
  });

  test("returns empty array for unknown agent", () => {
    expect(getModelOptions("unknown")).toEqual([]);
  });
});

describe("isModelSupported", () => {
  test("returns true for valid claude model", () => {
    expect(isModelSupported("claude", "claude-opus-4-6")).toBe(true);
  });

  test("returns true for valid codex model", () => {
    expect(isModelSupported("codex", "gpt-5.3-codex")).toBe(true);
  });

  test("returns false for wrong agent", () => {
    expect(isModelSupported("claude", "gpt-5.4")).toBe(false);
    expect(isModelSupported("codex", "claude-opus-4-6")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isModelSupported("claude", null)).toBe(false);
    expect(isModelSupported("claude", undefined)).toBe(false);
  });

  test("returns false for unknown model", () => {
    expect(isModelSupported("claude", "unknown-model")).toBe(false);
  });
});

describe("getModelLabel", () => {
  test("returns display name for valid model", () => {
    expect(getModelLabel("claude", "claude-opus-4-6")).toBe("Opus 4.6");
    expect(getModelLabel("claude", "claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(getModelLabel("codex", "gpt-5.4")).toBe("GPT-5.4");
  });

  test("returns null for null/undefined", () => {
    expect(getModelLabel("claude", null)).toBeNull();
    expect(getModelLabel("claude", undefined)).toBeNull();
  });

  test("returns null for unknown model", () => {
    expect(getModelLabel("claude", "unknown-model")).toBeNull();
  });
});
