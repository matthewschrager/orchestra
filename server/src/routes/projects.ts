import { Hono } from "hono";
import { existsSync } from "fs";
import type { DB, ThreadRow } from "../db";
import {
  deleteProject,
  getProject,
  getProjectThreadCounts,
  listProjects,
  projectRowToApi,
  threadRowToApi,
  touchProjectUpdatedAt,
  updateThreadSilent,
  updateProject,
  validateAndInsertProject,
} from "../db";
import { getCurrentBranch } from "../utils/git";
import type { ProjectWithStatus } from "shared";
import type { SessionManager } from "../sessions/manager";
import type { WorktreeManager } from "../worktrees/manager";
import type { TerminalManager } from "../terminal/manager";
import { buildMergeAllPrsPrompt } from "../projects/merge-all-prs";
import {
  listOpenPrsByBranchCached,
  resolvePrByBranch,
  resolvePrByUrl,
  resolveThreadBranch,
  type PrLookupInfo,
} from "../worktrees/pr-status";
import type { CleanupPushedResponse, PrStatus } from "shared";
import {
  persistResolvedPr,
  persistThreadBranch,
  resolveThreadPrLookup,
  touchPrStatusCheckedAt,
} from "../worktrees/thread-pr-metadata";

interface ProjectRouteDeps {
  openPrLister?: typeof listOpenPrsByBranchCached;
  prByBranchResolver?: typeof resolvePrByBranch;
  prByUrlResolver?: typeof resolvePrByUrl;
}

function listProjectThreads(db: DB, projectId: string): ThreadRow[] {
  return db
    .query("SELECT * FROM threads WHERE project_id = ? AND archived_at IS NULL")
    .all(projectId) as ThreadRow[];
}

function buildLiveOpenPrMatches(
  threads: ThreadRow[],
  openPrsByBranch: Map<string, PrLookupInfo>,
): Array<{ thread: ThreadRow; branch: string; pr: PrLookupInfo }> {
  const matches: Array<{ thread: ThreadRow; branch: string; pr: PrLookupInfo }> = [];
  for (const thread of threads) {
    const branch = resolveThreadBranch(thread.worktree, thread.branch);
    if (!branch) continue;
    const pr = openPrsByBranch.get(branch);
    if (!pr) continue;
    matches.push({ thread, branch, pr });
  }
  return matches;
}

export function createProjectRoutes(
  db: DB,
  sessionManager?: SessionManager,
  worktreeManager?: WorktreeManager,
  terminalManager?: TerminalManager,
  deps: ProjectRouteDeps = {},
) {
  const app = new Hono();
  const openPrLister = deps.openPrLister ?? listOpenPrsByBranchCached;
  const prByBranchResolver = deps.prByBranchResolver ?? resolvePrByBranch;
  const prByUrlResolver = deps.prByUrlResolver ?? resolvePrByUrl;

  // List all projects with enriched status
  app.get("/", async (c) => {
    const rows = listProjects(db);

    const projects: ProjectWithStatus[] = await Promise.all(
      rows.map(async (row) => {
        const base = projectRowToApi(row);
        const pathExists = existsSync(row.path);
        const currentBranch = pathExists
          ? getCurrentBranch(row.path)
          : "unknown";
        const counts = getProjectThreadCounts(db, row.id);
        const projectThreads = listProjectThreads(db, row.id);
        const openPrs = pathExists
          ? await openPrLister(row.path)
          : new Map<string, PrLookupInfo>();
        const outstandingPrCount = buildLiveOpenPrMatches(projectThreads, openPrs).length;

        return {
          ...base,
          currentBranch,
          threadCount: counts.total,
          activeThreadCount: counts.active,
          outstandingPrCount,
        };
      }),
    );

    return c.json(projects);
  });

  // Register a new project
  app.post("/", async (c) => {
    const body = await c.req.json<{ path: string; name?: string }>();

    if (!body.path) {
      return c.json({ error: "path is required" }, 400);
    }

    try {
      const row = validateAndInsertProject(db, body.path, body.name);
      return c.json(projectRowToApi(row), 201);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        return c.json({ error: "Project already registered" }, 409);
      }
      return c.json({ error: msg }, 400);
    }
  });

  // Rename a project
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const project = getProject(db, id);
    if (!project) return c.json({ error: "Not found" }, 404);

    const { name } = await c.req.json<{ name?: string }>();
    if (name) {
      updateProject(db, id, { name });
    }

    const updated = getProject(db, id)!;
    return c.json(projectRowToApi(updated));
  });

  // Delete a project (archives associated threads)
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const project = getProject(db, id);
    if (!project) return c.json({ error: "Not found" }, 404);

    // Block if any threads are running
    const counts = getProjectThreadCounts(db, id);
    if (counts.active > 0) {
      return c.json(
        { error: "Cannot delete project with running threads. Stop them first." },
        400,
      );
    }

    deleteProject(db, id);
    return c.json({ ok: true });
  });

  // Cleanup all threads whose worktree branches are fully pushed to remote
  app.post("/:id/cleanup-pushed", async (c) => {
    if (!sessionManager || !worktreeManager) {
      return c.json({ error: "Managers not available" }, 500);
    }

    const body = await c.req.json<{ confirmedThreadIds?: string[]; dryRun?: boolean; scopeToThreadIds?: string[] }>().catch(() => ({}));
    const confirmedThreadIds = new Set(body.confirmedThreadIds ?? []);
    const dryRun = body.dryRun === true;
    // When provided, only process these thread IDs (prevents TOCTOU between preview and execute)
    const scopeToThreadIds = body.scopeToThreadIds ? new Set(body.scopeToThreadIds) : null;

    const projectId = c.req.param("id");
    const project = getProject(db, projectId);
    if (!project) return c.json({ error: "Not found" }, 404);

    // Fetch remote refs so isPushedToRemote uses up-to-date data
    // Non-fatal — isPushedToRemote will still work with stale refs (conservative)
    try {
      const fetchProc = Bun.spawn(["git", "fetch", "origin", "--prune"], {
        cwd: project.path,
        stdout: "pipe",
        stderr: "pipe",
      });
      await fetchProc.exited;
    } catch {
      // git not available or path invalid — continue with local refs
    }

    const threads = listProjectThreads(db, projectId);

    const cleaned: CleanupPushedResponse["cleaned"] = [];
    const skipped: CleanupPushedResponse["skipped"] = [];
    const needsConfirmation: CleanupPushedResponse["needsConfirmation"] = [];

    for (const thread of threads) {
      // When scoped, skip threads not in the preview set
      if (scopeToThreadIds && !scopeToThreadIds.has(thread.id)) continue;

      // Skip active threads
      if (["running", "pending", "waiting"].includes(thread.status)) {
        skipped.push({
          id: thread.id,
          title: thread.title,
          reason: "still_active",
        });
        continue;
      }

      // Only consider threads with worktrees
      if (!thread.worktree) continue;

      let mergedPrHeadOid: string | null = null;
      let prStatusVerified = false;
      let resolvedPrStatus: PrStatus | null = null;
      const liveBranch = resolveThreadBranch(thread.worktree, thread.branch);
      persistThreadBranch(db, thread, liveBranch);

      const lookupResult = await resolveThreadPrLookup(thread, liveBranch, {
        prByBranchResolver,
        prByUrlResolver,
      });

      if (lookupResult?.kind === "found") {
        const changed = persistResolvedPr(db, thread, lookupResult.pr);
        mergedPrHeadOid = lookupResult.pr.headRefOid;
        prStatusVerified = true;
        resolvedPrStatus = lookupResult.pr.status;
        if (changed) {
          sessionManager?.notifyThread(thread.id);
        }
      } else if (thread.pr_url) {
        touchPrStatusCheckedAt(db, thread);
      }

      const pushStatus = await worktreeManager.isPushedToRemote(thread.id, {
        mergedPrHeadOid,
        branchOverride: liveBranch,
        prStatusOverride: resolvedPrStatus,
      });
      if (pushStatus.requiresConfirmation && !confirmedThreadIds.has(thread.id)) {
        const canDefaultSelect = pushStatus.reason !== "post_merge_commits" &&
          (
            pushStatus.reason !== "remote_branch_deleted" ||
            prStatusVerified ||
            thread.pr_status !== "merged" ||
            !!mergedPrHeadOid
          );
        needsConfirmation.push({
          id: thread.id,
          title: thread.title,
          reason: pushStatus.reason || "remote_branch_deleted",
          defaultSelected: canDefaultSelect,
        });
        continue;
      }
      if (!pushStatus.pushed && !pushStatus.requiresConfirmation) {
        skipped.push({
          id: thread.id,
          title: thread.title,
          reason: pushStatus.reason || "git_error",
        });
        continue;
      }

      // Safe to clean up
      if (dryRun) {
        cleaned.push({ id: thread.id, title: thread.title });
        continue;
      }

      sessionManager.stopThread(thread.id);
      terminalManager?.closeForThread(thread.id);

      try {
        await worktreeManager.cleanup(thread.id, thread.repo_path);
      } catch {
        skipped.push({
          id: thread.id,
          title: thread.title,
          reason: "cleanup_failed",
        });
        continue;
      }

      db.query(
        "UPDATE threads SET archived_at = datetime('now') WHERE id = ?",
      ).run(thread.id);
      sessionManager.notifyThread(thread.id);
      cleaned.push({ id: thread.id, title: thread.title });
    }

    return c.json({ cleaned, skipped, needsConfirmation });
  });

  app.post("/:id/merge-all-prs", async (c) => {
    if (!sessionManager) {
      return c.json({ error: "Session manager not available" }, 500);
    }

    const projectId = c.req.param("id");
    const project = getProject(db, projectId);
    if (!project) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<{ agent?: string }>().catch(() => ({}));
    if (!body.agent) {
      return c.json({ error: "agent is required" }, 400);
    }

    if (!existsSync(project.path)) {
      return c.json({ error: "Project path no longer exists" }, 400);
    }

    const projectThreads = listProjectThreads(db, projectId);
    const openPrs = await openPrLister(project.path);
    const outstanding = buildLiveOpenPrMatches(projectThreads, openPrs);
    if (outstanding.length === 0) {
      return c.json({ error: "This project has no outstanding PRs" }, 400);
    }

    const prompt = buildMergeAllPrsPrompt(
      project.name,
      outstanding.map(({ thread, branch, pr }) => ({
        id: thread.id,
        title: thread.title,
        prUrl: pr.url,
        prNumber: pr.number,
        prStatus: pr.status,
        branch,
        worktree: thread.worktree,
      })),
    );

    try {
      const thread = await sessionManager.startThread({
        agent: body.agent,
        prompt,
        repoPath: project.path,
        projectId,
        title: `Merge all PRs (${outstanding.length})`,
      });
      touchProjectUpdatedAt(db, projectId);
      return c.json(threadRowToApi(thread), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
