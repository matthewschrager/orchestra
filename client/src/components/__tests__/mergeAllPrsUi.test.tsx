import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectWithStatus, Thread } from "shared";
import { MobileSessions } from "../MobileSessions";
import { ProjectSidebar } from "../ProjectSidebar";

const baseProject: ProjectWithStatus = {
  id: "proj-1",
  name: "Orchestra",
  path: "/tmp/orchestra",
  addedAt: "2026-03-27T00:00:00.000Z",
  updatedAt: "2026-03-27T00:00:00.000Z",
  currentBranch: "main",
  threadCount: 2,
  activeThreadCount: 0,
  outstandingPrCount: 2,
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

describe("merge-all PR UI affordances", () => {
  test("shows the inline merge icon affordance in the desktop sidebar when PRs are outstanding", () => {
    const markup = renderToStaticMarkup(
      <ProjectSidebar
        projects={[baseProject]}
        threads={[baseThread]}
        activeProjectId="proj-1"
        activeThreadId={null}
        unreadThreadIds={new Set<string>()}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onMergeAllPrs={() => {}}
        onArchiveThread={() => {}}
        onRemoveProject={() => {}}
        onCleanupPushed={() => {}}
        onAddProject={() => {}}
        onOpenSettings={() => {}}
        mergingProjectId={null}
        open
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Merge all outstanding PRs");
  });

  test("hides the button when a project has no outstanding PRs", () => {
    const markup = renderToStaticMarkup(
      <ProjectSidebar
        projects={[{ ...baseProject, outstandingPrCount: 0 }]}
        threads={[{ ...baseThread, prUrl: null, prStatus: null }]}
        activeProjectId="proj-1"
        activeThreadId={null}
        unreadThreadIds={new Set<string>()}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onMergeAllPrs={() => {}}
        onArchiveThread={() => {}}
        onRemoveProject={() => {}}
        onCleanupPushed={() => {}}
        onAddProject={() => {}}
        onOpenSettings={() => {}}
        mergingProjectId={null}
        open
        onClose={() => {}}
      />,
    );

    expect(markup).not.toContain("Merge all outstanding PRs");
  });

  test("falls back to loaded thread PR state when the project count is stale", () => {
    const markup = renderToStaticMarkup(
      <ProjectSidebar
        projects={[{ ...baseProject, outstandingPrCount: 0 }]}
        threads={[baseThread]}
        activeProjectId="proj-1"
        activeThreadId={null}
        unreadThreadIds={new Set<string>()}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onMergeAllPrs={() => {}}
        onArchiveThread={() => {}}
        onRemoveProject={() => {}}
        onCleanupPushed={() => {}}
        onAddProject={() => {}}
        onOpenSettings={() => {}}
        mergingProjectId={null}
        open
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Merge all outstanding PRs");
  });

  test("shows the button in mobile project headers too", () => {
    const markup = renderToStaticMarkup(
      <MobileSessions
        projects={[baseProject]}
        threads={[baseThread]}
        activeThreadId={null}
        unreadThreadIds={new Set<string>()}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onArchiveThread={() => {}}
        onMergeAllPrs={() => {}}
        mergingProjectId={null}
      />,
    );

    expect(markup).toContain("Merge all PRs");
  });

  test("shows the mobile button when project metadata is stale but thread PR state is not", () => {
    const markup = renderToStaticMarkup(
      <MobileSessions
        projects={[{ ...baseProject, outstandingPrCount: 0 }]}
        threads={[baseThread]}
        activeThreadId={null}
        unreadThreadIds={new Set<string>()}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onArchiveThread={() => {}}
        onMergeAllPrs={() => {}}
        mergingProjectId={null}
      />,
    );

    expect(markup).toContain("Merge all PRs");
  });
});
