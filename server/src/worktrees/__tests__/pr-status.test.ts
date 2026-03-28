import { describe, test, expect } from "bun:test";
import {
  buildOpenPrMap,
  extractPrNumber,
  isPrStatusStale,
  resolveThreadBranch,
} from "../pr-status";

function withMockedNow(nowMs: number, fn: () => void) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    fn();
  } finally {
    Date.now = originalNow;
  }
}

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

  test("returns false when checkedAt is exactly 5 min ago", () => {
    withMockedNow(Date.parse("2026-03-28T12:00:00.000Z"), () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      // At exactly 5 min, elapsed === threshold, so NOT stale (> not >=)
      expect(isPrStatusStale(fiveMinAgo)).toBe(false);
    });
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

describe("buildOpenPrMap", () => {
  test("indexes open PRs by branch and skips cross-repo branches", () => {
    const map = buildOpenPrMap([
      {
        state: "OPEN",
        isDraft: false,
        number: 41,
        url: "https://github.com/acme/repo/pull/41",
        headRefName: "orchestra/open-pr",
        headRefOid: "abc123",
      },
      {
        state: "OPEN",
        isDraft: true,
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        headRefName: "orchestra/draft-pr",
        headRefOid: "def456",
      },
      {
        state: "OPEN",
        isDraft: false,
        number: 99,
        url: "https://github.com/fork/repo/pull/99",
        headRefName: "orchestra/fork-pr",
        headRefOid: "ghi789",
        isCrossRepository: true,
      },
    ]);

    expect(map.size).toBe(2);
    expect(map.get("orchestra/open-pr")).toEqual({
      url: "https://github.com/acme/repo/pull/41",
      number: 41,
      status: "open",
      headRefName: "orchestra/open-pr",
      headRefOid: "abc123",
    });
    expect(map.get("orchestra/draft-pr")?.status).toBe("draft");
    expect(map.has("orchestra/fork-pr")).toBe(false);
  });
});

describe("resolveThreadBranch", () => {
  test("falls back to stored branch when worktree is missing", () => {
    expect(resolveThreadBranch("/tmp/does-not-exist", "orchestra/fallback")).toBe(
      "orchestra/fallback",
    );
  });

  test("returns null when neither live nor stored branch is usable", () => {
    expect(resolveThreadBranch(null, null)).toBeNull();
    expect(resolveThreadBranch(null, "unknown")).toBeNull();
  });
});
