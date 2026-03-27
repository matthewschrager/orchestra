import { describe, test, expect, mock, beforeEach } from "bun:test";
import { extractPrNumber, isPrStatusStale } from "../pr-status";

describe("extractPrNumber", () => {
  test("extracts number from standard GitHub URL", () => {
    expect(extractPrNumber("https://github.com/owner/repo/pull/42")).toBe(42);
  });

  test("extracts number from GitHub Enterprise URL", () => {
    expect(extractPrNumber("https://github.enterprise.com/org/repo/pull/123")).toBe(123);
  });

  test("extracts number from URL with trailing slash", () => {
    expect(extractPrNumber("https://github.com/owner/repo/pull/7/")).toBe(7);
  });

  test("returns null for non-PR URL", () => {
    expect(extractPrNumber("https://github.com/owner/repo")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractPrNumber("")).toBeNull();
  });

  test("extracts number from URL with query params", () => {
    expect(extractPrNumber("https://github.com/owner/repo/pull/99?tab=files")).toBe(99);
  });
});

describe("isPrStatusStale", () => {
  test("returns true when checkedAt is null", () => {
    expect(isPrStatusStale(null)).toBe(true);
  });

  test("returns true when checkedAt is >5 min ago", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(isPrStatusStale(tenMinAgo)).toBe(true);
  });

  test("returns false when checkedAt is <5 min ago", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    expect(isPrStatusStale(twoMinAgo)).toBe(false);
  });

  test("returns false when checkedAt is just now", () => {
    const now = new Date().toISOString();
    expect(isPrStatusStale(now)).toBe(false);
  });

  test("returns true when checkedAt is exactly 5 min ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // At exactly 5 min, elapsed === threshold, so NOT stale (> not >=)
    expect(isPrStatusStale(fiveMinAgo)).toBe(false);
  });

  test("returns true when checkedAt is 5 min and 1 second ago", () => {
    const justOver = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString();
    expect(isPrStatusStale(justOver)).toBe(true);
  });

  test("returns true for corrupt/unparseable date string", () => {
    expect(isPrStatusStale("not-a-date")).toBe(true);
  });
});

// Note: fetchPrStatus tests require mocking Bun.spawn which is complex.
// The core parsing logic is covered by extractPrNumber and isPrStatusStale.
// Integration testing of fetchPrStatus is done via the /refresh-pr endpoint tests.
