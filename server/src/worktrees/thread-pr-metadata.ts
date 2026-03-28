import type { DB, ThreadRow } from "../db";
import { updateThreadSilent } from "../db";
import type { PrLookupInfo, PrLookupResult } from "./pr-status";

export function persistThreadBranch(
  db: DB,
  thread: ThreadRow,
  branch: string | null,
): boolean {
  if (!branch || thread.branch === branch) return false;
  updateThreadSilent(db, thread.id, { branch });
  thread.branch = branch;
  return true;
}

export function persistResolvedPr(
  db: DB,
  thread: ThreadRow,
  pr: PrLookupInfo,
): boolean {
  const checkedAt = new Date().toISOString();
  const updates: Partial<ThreadRow> = {
    pr_status_checked_at: checkedAt,
  };
  let visibleChange = false;

  if (thread.pr_url !== pr.url) {
    updates.pr_url = pr.url;
    thread.pr_url = pr.url;
    visibleChange = true;
  }
  if (thread.pr_status !== pr.status) {
    updates.pr_status = pr.status;
    thread.pr_status = pr.status;
    visibleChange = true;
  }
  if (thread.pr_number !== pr.number) {
    updates.pr_number = pr.number;
    thread.pr_number = pr.number;
    visibleChange = true;
  }

  thread.pr_status_checked_at = checkedAt;
  updateThreadSilent(db, thread.id, updates);
  return visibleChange;
}

export function touchPrStatusCheckedAt(db: DB, thread: ThreadRow): void {
  const checkedAt = new Date().toISOString();
  updateThreadSilent(db, thread.id, { pr_status_checked_at: checkedAt });
  thread.pr_status_checked_at = checkedAt;
}

export function clearCachedPr(
  db: DB,
  thread: ThreadRow,
): boolean {
  const checkedAt = new Date().toISOString();
  const visibleChange =
    thread.pr_url !== null ||
    thread.pr_status !== null ||
    thread.pr_number !== null;

  updateThreadSilent(db, thread.id, {
    pr_url: null,
    pr_status: null,
    pr_number: null,
    pr_status_checked_at: checkedAt,
  });
  thread.pr_url = null;
  thread.pr_status = null;
  thread.pr_number = null;
  thread.pr_status_checked_at = checkedAt;
  return visibleChange;
}

export async function resolveThreadPrLookup(
  thread: ThreadRow,
  liveBranch: string | null,
  resolvers: {
    prByBranchResolver: (branch: string, cwd: string) => Promise<PrLookupResult>;
    prByUrlResolver: (prUrl: string, cwd: string) => Promise<PrLookupResult>;
  },
): Promise<PrLookupResult | null> {
  if (!liveBranch) {
    if (!thread.pr_url) return null;
    return await resolvers.prByUrlResolver(thread.pr_url, thread.repo_path);
  }

  const branchResult = await resolvers.prByBranchResolver(liveBranch, thread.repo_path);
  if (branchResult.kind === "found") {
    return branchResult;
  }
  if (!thread.pr_url) {
    return branchResult;
  }

  const urlResult = await resolvers.prByUrlResolver(thread.pr_url, thread.repo_path);
  if (urlResult.kind === "found") {
    if (urlResult.pr.headRefName === liveBranch) {
      return urlResult;
    }
    return branchResult;
  }

  if (branchResult.kind === "error") {
    return branchResult;
  }
  if (urlResult.kind === "error") {
    return urlResult;
  }
  return branchResult;
}
