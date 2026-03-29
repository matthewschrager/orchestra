import { describe, expect, test } from "bun:test";
import type { ProjectWithStatus, Thread } from "shared";
import {
  countOutstandingPrThreads,
  getEffectiveOutstandingPrCount,
} from "../prCounts";

const baseProject: ProjectWithStatus = {
  id: "proj-1",
  name: "Orchestra",
  path: "/tmp/orchestra",
  addedAt: "2026-03-27T00:00:00.000Z",
  updatedAt: "2026-03-27T00:00:00.000Z",
  currentBranch: "main",
  threadCount: 2,
  activeThreadCount: 0,
  outstandingPrCount: 0,
};

const baseThread: Thread = {
  id: "thread-1",
  title: "Fix auth edge case",
  agent: "codex",
  effortLevel: null,
  permissionMode: null,
  model: null,
  projectId: "proj-1",
  repoPath: "/tmp/orchestra",
  worktree: "/tmp/wt-auth",
  branch: "orchestra/auth-fix",
  prUrl: "https://github.com/acme/orchestra/pull/17",
  prStatus: "open",
  prNumber: 17,
  pid: null,
  status: "done",
  errorMessage: null,
  archivedAt: null,
  createdAt: "2026-03-27T00:00:00.000Z",
  updatedAt: "2026-03-27T00:00:00.000Z",
  lastInteractedAt: "2026-03-27T00:00:00.000Z",
};

describe("prCounts", () => {
  test("counts open and unknown PRs, but ignores merged and closed ones", () => {
    expect(countOutstandingPrThreads([
      baseThread,
      { ...baseThread, id: "thread-2", prStatus: null },
      { ...baseThread, id: "thread-3", prStatus: "draft" },
      { ...baseThread, id: "thread-4", prStatus: "merged" },
      { ...baseThread, id: "thread-5", prStatus: "closed" },
      { ...baseThread, id: "thread-6", prUrl: null, prStatus: null },
      { ...baseThread, id: "thread-7", archivedAt: "2026-03-27T00:00:00.000Z" },
    ])).toBe(3);
  });

  test("uses loaded thread state as a fallback when the project count is stale", () => {
    expect(getEffectiveOutstandingPrCount(baseProject, [baseThread])).toBe(1);
  });

  test("keeps the server count when it is already ahead of the loaded threads", () => {
    expect(getEffectiveOutstandingPrCount(
      { ...baseProject, outstandingPrCount: 4 },
      [baseThread],
    )).toBe(4);
  });
});
