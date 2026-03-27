interface MergeAllPrCandidate {
  id: string;
  title: string;
  prUrl: string | null;
  prNumber: number | null;
  prStatus: string | null;
  branch: string | null;
  worktree: string | null;
}

function formatPrStatus(status: string | null): string {
  if (!status) return "status unknown";
  return status;
}

export function buildMergeAllPrsPrompt(
  projectName: string,
  candidates: MergeAllPrCandidate[],
): string {
  const prCount = candidates.length;
  const header =
    prCount === 1
      ? `This project has 1 outstanding pull request.`
      : `This project has ${prCount} outstanding pull requests. Some of them may have conflicts, mostly with each other.`;

  const prLines = candidates.map((candidate) => {
    const parts = [
      `- PR ${candidate.prNumber ? `#${candidate.prNumber}` : "(unparsed number)"}: ${candidate.title}`,
      `  URL: ${candidate.prUrl ?? "missing"}`,
      `  Status: ${formatPrStatus(candidate.prStatus)}`,
    ];
    if (candidate.branch) {
      parts.push(`  Branch: ${candidate.branch}`);
    }
    if (candidate.worktree) {
      parts.push(`  Worktree: ${candidate.worktree}`);
    }
    return parts.join("\n");
  });

  return [
    `Project: ${projectName}`,
    "",
    header,
    "",
    "Get all these PRs merged into main, fixing conflicts along the way.",
    "Do not simply merge locally and then manually close the PRs. Fix the conflicts and then merge via GitHub.",
    "Use GitHub and the local repo together: inspect each PR, resolve conflicts on the appropriate branch, push the fixes, and merge via GitHub.",
    "If a PR should not merge, close it on GitHub with a clear explanation.",
    "",
    "Outstanding PRs:",
    ...prLines,
  ].join("\n");
}
