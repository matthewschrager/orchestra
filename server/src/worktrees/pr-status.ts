import type { PrStatus } from "shared";

/** Max concurrent `gh pr view` calls to avoid subprocess storms */
const MAX_CONCURRENT = 3;
let activeCalls = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT) {
    activeCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function releaseSlot(): void {
  activeCalls--;
  const next = queue.shift();
  if (next) {
    activeCalls++;
    next();
  }
}

/** Timeout in ms for `gh pr view` subprocess */
const GH_TIMEOUT_MS = 10_000;

/** Stale guard — only re-fetch if last check was >5 min ago */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Check if a PR status check is stale (should be refreshed).
 * Returns true if:
 * - checkedAt is null (never checked)
 * - checkedAt is older than STALE_THRESHOLD_MS
 */
export function isPrStatusStale(checkedAt: string | null): boolean {
  if (!checkedAt) return true;
  const elapsed = Date.now() - new Date(checkedAt).getTime();
  // Guard against corrupt/unparseable dates — treat as stale so refresh can fix them
  if (Number.isNaN(elapsed)) return true;
  return elapsed > STALE_THRESHOLD_MS;
}

/**
 * Extract PR number from a GitHub PR URL.
 * Handles: https://github.com/org/repo/pull/42
 *           https://github.enterprise.com/org/repo/pull/42
 */
export function extractPrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

interface GhPrViewResult {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  number: number;
}

/**
 * Fetch PR status from GitHub via `gh pr view`.
 *
 * @param prUrl - GitHub PR URL
 * @param cwd - Directory within the correct GitHub repo (for gh to resolve remote)
 * @returns PR status and number, or null on any failure
 */
export async function fetchPrStatus(
  prUrl: string,
  cwd: string,
): Promise<{ status: PrStatus; number: number } | null> {
  if (!prUrl) return null;

  await acquireSlot();
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", prUrl, "--json", "state,isDraft,number"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );

    // Race against timeout — clear timer on success to avoid resource leak
    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
      timerId = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, GH_TIMEOUT_MS);
    });

    const result = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        clearTimeout(timerId);

        if (proc.exitCode !== 0) return null;

        const parsed: GhPrViewResult = JSON.parse(stdout);
        const status: PrStatus = parsed.isDraft
          ? "draft"
          : parsed.state === "MERGED"
            ? "merged"
            : parsed.state === "CLOSED"
              ? "closed"
              : "open";

        return { status, number: parsed.number };
      })(),
      timeout,
    ]);

    return result;
  } catch {
    // gh not installed, JSON parse failure, or any other error
    return null;
  } finally {
    releaseSlot();
  }
}
