export function shouldTrackQueuedFallback(status: string | null | undefined, interrupt?: boolean): boolean {
  return status === "running" && interrupt !== true;
}

export function incrementQueuedFallback(counts: Map<string, number>, threadId: string): Map<string, number> {
  const nextCounts = new Map(counts);
  nextCounts.set(threadId, (nextCounts.get(threadId) ?? 0) + 1);
  return nextCounts;
}

export function consumeQueuedFallback(
  counts: Map<string, number>,
  threadId: string,
): { nextCounts: Map<string, number>; shouldMarkQueued: boolean } {
  const pendingCount = counts.get(threadId) ?? 0;
  if (pendingCount <= 0) {
    return { nextCounts: counts, shouldMarkQueued: false };
  }

  const nextCounts = new Map(counts);
  if (pendingCount === 1) nextCounts.delete(threadId);
  else nextCounts.set(threadId, pendingCount - 1);
  return { nextCounts, shouldMarkQueued: true };
}
