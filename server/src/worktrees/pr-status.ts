import { existsSync } from "fs";
import type { PrStatus } from "shared";
import { getCurrentBranch } from "../utils/git";

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

/** Cache project-level open PR lookups so `/projects` and `/threads` can share them */
const OPEN_PR_CACHE_TTL_MS = 30_000;
const OPEN_PR_LIST_LIMIT = 500;

interface OpenPrCacheEntry {
  data: Map<string, PrLookupInfo>;
  expiresAt: number;
  inflight?: Promise<Map<string, PrLookupInfo>>;
}

const openPrCache = new Map<string, OpenPrCacheEntry>();

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

interface GhPrResult {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  number: number;
  url: string;
  headRefName: string | null;
  headRefOid: string | null;
  isCrossRepository?: boolean;
}

interface GhErrorResult {
  kind: "not_found" | "error";
  message: string;
}

export interface PrLookupInfo {
  url: string;
  number: number;
  status: PrStatus;
  headRefName: string | null;
  headRefOid: string | null;
}

export type PrLookupResult =
  | { kind: "found"; pr: PrLookupInfo }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

function toPrStatus(state: GhPrResult["state"], isDraft: boolean): PrStatus {
  return isDraft
    ? "draft"
    : state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : "open";
}

function buildPrLookupInfo(result: GhPrResult): PrLookupInfo {
  return {
    url: result.url,
    number: result.number,
    status: toPrStatus(result.state, result.isDraft),
    headRefName: result.headRefName,
    headRefOid: result.headRefOid,
  };
}

function classifyGhFailure(message: string): GhErrorResult {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("no pull requests found")
    || normalized.includes("could not resolve to a pull request")
  ) {
    return { kind: "not_found", message };
  }
  return { kind: "error", message };
}

async function runGhJson(
  args: string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: GhErrorResult }> {
  await acquireSlot();
  try {
    const proc = Bun.spawn(
      ["gh", ...args],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );

    let timedOut = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ ok: false; error: GhErrorResult }>((resolve) => {
      timerId = setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve({
          ok: false,
          error: { kind: "error", message: `gh timed out after ${GH_TIMEOUT_MS}ms` },
        });
      }, GH_TIMEOUT_MS);
    });

    const result = await Promise.race([
      (async (): Promise<{ ok: true; stdout: string } | { ok: false; error: GhErrorResult }> => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (timerId) clearTimeout(timerId);
        if (timedOut) {
          return {
            ok: false,
            error: { kind: "error", message: `gh timed out after ${GH_TIMEOUT_MS}ms` },
          };
        }
        if (proc.exitCode !== 0) {
          return {
            ok: false,
            error: classifyGhFailure(stderr.trim() || stdout.trim() || `gh exited ${proc.exitCode}`),
          };
        }
        return { ok: true, stdout };
      })(),
      timeout,
    ]);

    return result;
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    releaseSlot();
  }
}

export async function resolvePrByUrl(prUrl: string, cwd: string): Promise<PrLookupResult> {
  if (!prUrl) return { kind: "error", message: "Missing PR URL" };

  const result = await runGhJson(
    ["pr", "view", prUrl, "--json", "state,isDraft,number,url,headRefName,headRefOid,isCrossRepository"],
    cwd,
  );
  if (!result.ok) return result.error;

  try {
    const parsed = JSON.parse(result.stdout) as GhPrResult;
    return { kind: "found", pr: buildPrLookupInfo(parsed) };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to parse gh pr view output",
    };
  }
}

export async function resolvePrByBranch(branch: string, cwd: string): Promise<PrLookupResult> {
  if (!branch) return { kind: "not_found", message: "No branch provided" };

  const result = await runGhJson(
    ["pr", "view", branch, "--json", "state,isDraft,number,url,headRefName,headRefOid,isCrossRepository"],
    cwd,
  );
  if (!result.ok) return result.error;

  try {
    const parsed = JSON.parse(result.stdout) as GhPrResult;
    if (parsed.isCrossRepository) {
      return { kind: "not_found", message: `Ignoring cross-repo PR for branch ${branch}` };
    }
    return { kind: "found", pr: buildPrLookupInfo(parsed) };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to parse gh pr view output",
    };
  }
}

export function buildOpenPrMap(items: GhPrResult[]): Map<string, PrLookupInfo> {
  const map = new Map<string, PrLookupInfo>();
  for (const item of items) {
    if (item.isCrossRepository) continue;
    if (!item.headRefName) continue;
    map.set(item.headRefName, buildPrLookupInfo(item));
  }
  return map;
}

export async function listOpenPrsByBranch(cwd: string): Promise<Map<string, PrLookupInfo>> {
  const result = await runGhJson(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(OPEN_PR_LIST_LIMIT),
      "--json",
      "state,isDraft,number,url,headRefName,headRefOid,isCrossRepository",
    ],
    cwd,
  );
  if (!result.ok) throw new Error(result.error.message);

  try {
    const parsed = JSON.parse(result.stdout) as GhPrResult[];
    return buildOpenPrMap(parsed);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Failed to parse gh pr list output");
  }
}

export async function listOpenPrsByBranchCached(cwd: string): Promise<Map<string, PrLookupInfo>> {
  const cached = openPrCache.get(cwd);
  const now = Date.now();
  if (cached?.inflight) return cached.inflight;
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const previousData = cached?.data ?? new Map<string, PrLookupInfo>();
  const inflight = listOpenPrsByBranch(cwd)
    .then((data) => {
      openPrCache.set(cwd, {
        data,
        expiresAt: Date.now() + OPEN_PR_CACHE_TTL_MS,
      });
      return data;
    })
    .catch(() => {
      if (previousData.size > 0) {
        openPrCache.set(cwd, {
          data: previousData,
          expiresAt: Date.now() + OPEN_PR_CACHE_TTL_MS,
        });
        return previousData;
      }
      openPrCache.delete(cwd);
      return new Map<string, PrLookupInfo>();
    })
    .finally(() => {
      const latest = openPrCache.get(cwd);
      if (latest?.inflight) {
        delete latest.inflight;
      }
    });

  openPrCache.set(cwd, {
    data: previousData,
    expiresAt: cached?.expiresAt ?? 0,
    inflight,
  });

  return inflight;
}

export function clearOpenPrCache(): void {
  openPrCache.clear();
}

export function resolveThreadBranch(
  worktree: string | null,
  branch: string | null,
): string | null {
  if (worktree && existsSync(worktree)) {
    const liveBranch = getCurrentBranch(worktree).trim();
    if (liveBranch && liveBranch !== "unknown") {
      return liveBranch;
    }
  }
  const fallback = branch?.trim();
  return fallback && fallback !== "unknown" ? fallback : null;
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
): Promise<{ status: PrStatus; number: number; headRefOid: string | null } | null> {
  const result = await resolvePrByUrl(prUrl, cwd);
  if (result.kind !== "found") {
    return null;
  }
  return {
    status: result.pr.status,
    number: result.pr.number,
    headRefOid: result.pr.headRefOid,
  };
}
