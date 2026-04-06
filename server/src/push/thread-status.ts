import type { ThreadStatus } from "shared";

const TERMINAL_THREAD_STATUSES = new Set<ThreadStatus>(["done", "error"]);

export function shouldNotifyThreadBecameIdle(
  previousStatus: ThreadStatus | undefined,
  nextStatus: ThreadStatus,
): boolean {
  if (!previousStatus) return false;
  if (previousStatus === nextStatus) return false;
  return TERMINAL_THREAD_STATUSES.has(nextStatus);
}
