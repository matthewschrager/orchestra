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
    contextTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: 0,
    modelName: null,
  };

  test("returns null when no token usage exists", () => {
    expect(getTokenUsageSummary(baseMetrics)).toBeNull();
  });

  test("returns null when no context window is available", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      contextTokens: 12_345,
      inputTokens: 12_000,
      outputTokens: 345,
    })).toBeNull();
  });

  test("includes context-window percentage when available", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      contextTokens: 100_000,
      inputTokens: 80_000,
      outputTokens: 20_000,
      contextWindow: 200_000,
    })).toEqual({
      totalTokens: 100_000,
      pct: 50,
      title: "100k / 200k tokens (50%)",
    });
  });

  test("non-Codex agents continue using the input/output breakdown for live updates", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      contextTokens: 80_000,
      inputTokens: 80_000,
      outputTokens: 3_500,
      contextWindow: 200_000,
    }, "claude")).toEqual({
      totalTokens: 83_500,
      pct: 41.75,
      title: "84k / 200k tokens (42%)",
    });
  });

  test("matches Codex effective-context usage instead of raw window usage", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      contextTokens: 12_700,
      inputTokens: 12_700,
      outputTokens: 0,
      contextWindow: 13_000,
    }, "codex")).toEqual({
      totalTokens: 12_700,
      pct: 70,
      title: "13k used (70% of effective context)",
    });
  });

  test("Codex context usage clamps baseline-only turns to zero", () => {
    expect(getTokenUsageSummary({
      ...baseMetrics,
      contextTokens: 11_500,
      inputTokens: 11_500,
      outputTokens: 0,
      contextWindow: 200_000,
    }, "codex")).toEqual({
      totalTokens: 11_500,
      pct: 0,
      title: "12k used (0% of effective context)",
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
