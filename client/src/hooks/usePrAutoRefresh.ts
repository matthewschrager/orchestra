import { useEffect, useRef } from "react";
import type { Thread } from "shared";
import { api } from "./useApi";

export const PR_AUTO_REFRESH_INTERVAL_MS = 60_000;
export const PR_AUTO_REFRESH_MIN_GAP_MS = 15_000;

type RefreshablePrThread = Pick<Thread, "worktree" | "prUrl" | "prStatus">;

export function isPrAutoRefreshCandidate(thread: RefreshablePrThread): boolean {
  if (thread.prUrl) {
    return (
      thread.prStatus === null
      || thread.prStatus === "open"
      || thread.prStatus === "draft"
    );
  }
  return thread.worktree !== null;
}

export function hasPrAutoRefreshCandidates(threads: RefreshablePrThread[]): boolean {
  return threads.some(isPrAutoRefreshCandidate);
}

export function shouldThrottlePrAutoRefresh(
  lastRefreshAt: number,
  now: number,
  minGapMs = PR_AUTO_REFRESH_MIN_GAP_MS,
): boolean {
  return lastRefreshAt > 0 && now - lastRefreshAt < minGapMs;
}

interface UsePrAutoRefreshOpts {
  connected: boolean;
  onThreads: (threads: Thread[]) => void;
  threads: Thread[];
  intervalMs?: number;
}

export function usePrAutoRefresh({
  connected,
  onThreads,
  threads,
  intervalMs = PR_AUTO_REFRESH_INTERVAL_MS,
}: UsePrAutoRefreshOpts) {
  const lastRefreshAtRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const hasCandidates = hasPrAutoRefreshCandidates(threads);

  useEffect(() => {
    if (!connected || !hasCandidates) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const refreshThreads = () => {
      const now = Date.now();
      if (inFlightRef.current) return;
      if (shouldThrottlePrAutoRefresh(lastRefreshAtRef.current, now)) return;

      lastRefreshAtRef.current = now;
      const request = api.listThreads()
        .then(onThreads)
        .catch(() => {
          // Preserve the current UI when PR metadata refresh fails.
        })
        .finally(() => {
          inFlightRef.current = null;
        });

      inFlightRef.current = request;
    };

    const handleFocus = () => refreshThreads();
    const handleVisibility = () => {
      if (!document.hidden) {
        refreshThreads();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    const intervalId = window.setInterval(() => {
      if (!document.hidden) {
        refreshThreads();
      }
    }, intervalMs);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(intervalId);
    };
  }, [connected, hasCandidates, intervalMs, onThreads]);
}
