export const COMMAND_REFRESH_MAX_AGE_MS = 10_000;
const GLOBAL_COMMANDS_KEY = "__global__";

export function getCommandsCacheKey(projectId: string | null): string {
  return projectId ?? GLOBAL_COMMANDS_KEY;
}

export function shouldRefreshCommands(
  lastFetchedAt: number | null | undefined,
  now = Date.now(),
  maxAgeMs = COMMAND_REFRESH_MAX_AGE_MS,
): boolean {
  if (lastFetchedAt == null) return true;
  return now - lastFetchedAt >= maxAgeMs;
}
