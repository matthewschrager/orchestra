import { describe, expect, test } from "bun:test";
import type { Thread } from "shared";
import {
  hasPrAutoRefreshCandidates,
  isPrAutoRefreshCandidate,
  shouldThrottlePrAutoRefresh,
} from "../usePrAutoRefresh";

const baseThread: Thread = {
  id: "thread-1",
  title: "Fix PR sync",
  agent: "codex",
  effortLevel: null,
  projectId: "proj-1",
  repoPath: "/tmp/orchestra",
  worktree: "/tmp/wt-pr-sync",
  branch: "orchestra/pr-sync",
  prUrl: null,
  prStatus: null,
  prNumber: null,
  pid: null,
  status: "done",
  errorMessage: null,
  archivedAt: null,
  createdAt: "2026-03-28T00:00:00.000Z",
  updatedAt: "2026-03-28T00:00:00.000Z",
  lastInteractedAt: "2026-03-28T00:00:00.000Z",
};

describe("usePrAutoRefresh helpers", () => {
  test("treats worktree threads without a cached PR as refresh candidates", () => {
    expect(isPrAutoRefreshCandidate(baseThread)).toBe(true);
  });

  test("treats known open PRs as refresh candidates even without a worktree", () => {
    expect(isPrAutoRefreshCandidate({
      ...baseThread,
      worktree: null,
      prUrl: "https://github.com/acme/orchestra/pull/17",
      prStatus: "open",
      prNumber: 17,
    })).toBe(true);
  });

  test("ignores merged and closed PRs", () => {
    expect(hasPrAutoRefreshCandidates([
      { ...baseThread, prUrl: "https://github.com/acme/orchestra/pull/18", prStatus: "merged", prNumber: 18 },
      { ...baseThread, id: "thread-2", prUrl: "https://github.com/acme/orchestra/pull/19", prStatus: "closed", prNumber: 19 },
    ])).toBe(false);
  });

  test("throttles refreshes that happen too close together", () => {
    expect(shouldThrottlePrAutoRefresh(10_000, 20_000, 15_000)).toBe(true);
    expect(shouldThrottlePrAutoRefresh(10_000, 30_000, 15_000)).toBe(false);
  });
});
