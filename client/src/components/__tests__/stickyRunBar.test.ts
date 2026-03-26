import { describe, test, expect } from "bun:test";
import { formatModelName } from "../StickyRunBar";

describe("formatModelName", () => {
  test("strips YYYYMMDD date suffix", () => {
    expect(formatModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
  });

  test("strips YYYY-MM-DD date suffix", () => {
    expect(formatModelName("gpt-4o-2024-11-20")).toBe("gpt-4o");
  });

  test("handles old-style claude model names", () => {
    expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
  });

  test("returns model name as-is when no date suffix", () => {
    expect(formatModelName("gpt-4o")).toBe("gpt-4o");
  });

  test("handles claude-opus", () => {
    expect(formatModelName("claude-opus-4-20250514")).toBe("claude-opus-4");
  });

  test("handles claude-haiku", () => {
    expect(formatModelName("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku");
  });
});
