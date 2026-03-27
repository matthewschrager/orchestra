import type {
  CleanupConfirmationCandidate,
  CleanupPushedResponse,
  CleanupReason,
  CleanupThreadIssue,
} from "shared";

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

function formatIssues(label: string, issues: CleanupThreadIssue[]): string {
  const uniqueIssues = dedupeCleanupIssues(issues);
  if (uniqueIssues.length === 0) return "";
  return `\n\n${label}:\n${uniqueIssues.map((issue) => `  ${issue.title}: ${formatCleanupReason(issue.reason)}`).join("\n")}`;
}

function asIssues(candidates: CleanupConfirmationCandidate[]): CleanupThreadIssue[] {
  return candidates.map(({ id, title, reason }) => ({ id, title, reason }));
}

function dedupeCleanupIssues<T extends CleanupThreadIssue>(issues: T[]): T[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.id}:${issue.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildCleanupAlert({
  cleanedCount,
  skipped,
  needsConfirmation,
}: {
  cleanedCount: number;
  skipped: CleanupPushedResponse["skipped"];
  needsConfirmation: CleanupPushedResponse["needsConfirmation"];
}): string {
  if (cleanedCount === 0 && skipped.length === 0 && needsConfirmation.length === 0) {
    return "No threads to clean up.";
  }

  const summary = cleanedCount === 0
    ? "No threads cleaned."
    : `Cleaned up ${cleanedCount} thread(s) and worktrees.`;

  return (
    summary +
    formatIssues("Left untouched", asIssues(needsConfirmation)) +
    formatIssues("Skipped", skipped)
  );
}
