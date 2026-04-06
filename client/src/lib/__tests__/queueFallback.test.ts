import { describe, expect, test } from "bun:test";
import { consumeQueuedFallback, incrementQueuedFallback, shouldTrackQueuedFallback } from "../queueFallback";

describe("queued fallback tracking", () => {
  test("tracks non-interrupt sends only while the thread is running", () => {
    expect(shouldTrackQueuedFallback("running", false)).toBe(true);
    expect(shouldTrackQueuedFallback("running", true)).toBe(false);
    expect(shouldTrackQueuedFallback("done", false)).toBe(false);
  });

  test("increments counts for only the targeted thread", () => {
    const counts = incrementQueuedFallback(new Map([["thread-a", 1]]), "thread-b");
    expect(counts.get("thread-a")).toBe(1);
    expect(counts.get("thread-b")).toBe(1);
  });

  test("consumes counts from only the matching thread", () => {
    const { nextCounts, shouldMarkQueued } = consumeQueuedFallback(
      new Map([
        ["thread-a", 1],
        ["thread-b", 2],
      ]),
      "thread-b",
    );

    expect(shouldMarkQueued).toBe(true);
    expect(nextCounts.get("thread-a")).toBe(1);
    expect(nextCounts.get("thread-b")).toBe(1);
  });

  test("does not mark unrelated threads as queued", () => {
    const counts = new Map([["thread-a", 1]]);
    const { nextCounts, shouldMarkQueued } = consumeQueuedFallback(counts, "thread-b");

    expect(shouldMarkQueued).toBe(false);
    expect(nextCounts).toBe(counts);
    expect(nextCounts.get("thread-a")).toBe(1);
  });
});
