import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Thread } from "shared";
import { ContextPanel } from "../ContextPanel";

const baseThread: Thread = {
  id: "thread-1",
  title: "Fix PR discovery",
  agent: "codex",
  effortLevel: null,
  permissionMode: null,
  model: null,
  projectId: "proj-1",
  repoPath: "/tmp/orchestra",
  worktree: "/tmp/wt-pr-discovery",
  branch: "orchestra/pr-discovery",
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

describe("ContextPanel PR actions", () => {
  test("shows both create and branch-refresh actions when no PR is cached yet", () => {
    const markup = renderToStaticMarkup(
      <ContextPanel thread={baseThread} onClose={() => {}} />,
    );

    expect(markup).toContain("Create PR");
    expect(markup).toContain("Check existing PR");
  });

  test("shows the refresh affordance inline when a PR already exists", () => {
    const markup = renderToStaticMarkup(
      <ContextPanel
        thread={{
          ...baseThread,
          prUrl: "https://github.com/acme/orchestra/pull/17",
          prStatus: "open",
          prNumber: 17,
        }}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Refresh PR status");
    expect(markup).not.toContain("Check existing PR");
  });
});
