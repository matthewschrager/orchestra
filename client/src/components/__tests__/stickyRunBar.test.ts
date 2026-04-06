import { describe, test, expect } from "bun:test";
import type { QueuedItem, TurnMetrics } from "shared";
import { formatModelName, formatTokenCount, getPendingQueueDisplayCount, getTokenUsageSummary } from "../StickyRunBar";

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

describe("formatTokenCount", () => {
  test("formats raw token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
  });

  test("formats thousands compactly", () => {
    expect(formatTokenCount(12_345)).toBe("12k");
  });
});

describe("getTokenUsageSummary", () => {
  const baseMetrics: TurnMetrics = {
    costUsd: 0,
    durationMs: 0,
    turnCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: 0,
    modelName: null,
  };

  test("returns null when no token usage exists", () => {
    expect(getTokenUsageSummary(baseMetrics)).toBeNull();
  });

  test("returns token totals without a context window", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      inputTokens: 12_000,
      outputTokens: 345,
    })).toEqual({
      totalTokens: 12_345,
      contextWindow: 0,
      pct: 0,
    });
  });

  test("includes context-window percentage when available", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      inputTokens: 80_000,
      outputTokens: 20_000,
      contextWindow: 200_000,
    })).toEqual({
      totalTokens: 100_000,
      contextWindow: 200_000,
      pct: 50,
    });
  });
});

describe("getPendingQueueDisplayCount", () => {
  test("counts only pending queue items when sent items are still visible", () => {
    const items: QueuedItem[] = [
      { id: "q1", content: "already injected", createdAt: "2026-04-05T00:00:00.000Z", state: "sent" },
      { id: "q2", content: "still pending", createdAt: "2026-04-05T00:00:01.000Z", state: "pending" },
    ];
    expect(getPendingQueueDisplayCount(items, 0)).toBe(1);
  });

  test("falls back to queuedCount when queue items are unavailable", () => {
    expect(getPendingQueueDisplayCount(undefined, 2)).toBe(2);
  });
});
