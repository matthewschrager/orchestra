import type { CleanupReason } from "shared";

const CLEANUP_REASON_LABELS: Record<CleanupReason, string> = {
  still_active: "still active",
  uncommitted_changes: "tracked local changes",
  unpushed_commits: "local commits not pushed",
  not_on_remote: "remote branch missing",
  remote_branch_deleted: "merged PR, remote branch deleted",
  post_merge_commits: "new local commits after merge",
  worktree_missing: "worktree missing on disk",
  cleanup_failed: "cleanup failed",
  git_error: "git check failed",
  no_worktree: "no worktree",
};

export function formatCleanupReason(reason: CleanupReason): string {
  return CLEANUP_REASON_LABELS[reason] || reason.replace(/_/g, " ");
}

export function isCleanupReasonDangerous(reason: CleanupReason): boolean {
  return reason === "post_merge_commits";
}
