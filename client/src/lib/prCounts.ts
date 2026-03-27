import type { ProjectWithStatus, Thread } from "shared";

export function countOutstandingPrThreads(
  threads: Array<Pick<Thread, "archivedAt" | "prStatus" | "prUrl">>,
): number {
  return threads.reduce((count, thread) => {
    if (thread.archivedAt) return count;
    if (!thread.prUrl) return count;
    if (thread.prStatus === "merged" || thread.prStatus === "closed") return count;
    return count + 1;
  }, 0);
}

export function getEffectiveOutstandingPrCount(
  project: Pick<ProjectWithStatus, "outstandingPrCount">,
  threads: Array<Pick<Thread, "archivedAt" | "prStatus" | "prUrl">>,
): number {
  return Math.max(project.outstandingPrCount, countOutstandingPrThreads(threads));
}
