import { Hono } from "hono";
import { isEffortLevelSupported, isPermissionModeSupported } from "shared";
import type { DB, ThreadRow } from "../db";
import {
  getMessages,
  getProject,
  getThread,
  listThreads,
  messageRowToApi,
  threadRowToApi,
  touchProjectUpdatedAt,
  updateThread,
  updateThreadSilent,
} from "../db";
import type { SessionManager } from "../sessions/manager";
import type { WorktreeManager } from "../worktrees/manager";
import type { TerminalManager } from "../terminal/manager";
import {
  isPrStatusStale,
  listOpenPrsByBranchCached,
  resolvePrByBranch,
  resolvePrByUrl,
  resolveThreadBranch,
  type PrLookupInfo,
  type PrLookupResult,
} from "../worktrees/pr-status";
import {
  clearCachedPr,
  persistResolvedPr,
  persistThreadBranch,
  resolveThreadPrLookup,
  touchPrStatusCheckedAt,
} from "../worktrees/thread-pr-metadata";

interface ThreadRouteDeps {
  openPrLister?: typeof listOpenPrsByBranchCached;
  prByBranchResolver?: typeof resolvePrByBranch;
  prByUrlResolver?: typeof resolvePrByUrl;
}

export function createThreadRoutes(
  db: DB,
  sessionManager: SessionManager,
  worktreeManager: WorktreeManager,
  terminalManager?: TerminalManager,
  deps: ThreadRouteDeps = {},
) {
  const app = new Hono();
  const openPrLister = deps.openPrLister ?? listOpenPrsByBranchCached;
  const prByBranchResolver = deps.prByBranchResolver ?? resolvePrByBranch;
  const prByUrlResolver = deps.prByUrlResolver ?? resolvePrByUrl;

  // List threads
  app.get("/", async (c) => {
    const threadRows = listThreads(db);

    await enrichThreadsWithOpenPrs(
      db,
      threadRows,
      sessionManager,
      openPrLister,
      prByBranchResolver,
      prByUrlResolver,
    );
    const threads = threadRows.map(threadRowToApi);

    // Fire-and-forget: refresh PR status for open/draft threads with stale checks
    refreshStalePrStatuses(db, threadRows, sessionManager, prByUrlResolver);

    return c.json(threads);
  });

  // Get thread
  app.get("/:id", (c) => {
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json(threadRowToApi(thread));
  });

  // Get thread messages
  app.get("/:id/messages", (c) => {
    const afterSeq = parseInt(c.req.query("after_seq") || "0", 10);
    const messages = getMessages(db, c.req.param("id"), afterSeq).map(messageRowToApi);
    return c.json(messages);
  });

  // Create thread + start agent
  app.post("/", async (c) => {
    const body = await c.req.json<{
      agent: string;
      effortLevel?: import("shared").EffortLevel;
      permissionMode?: import("shared").PermissionMode;
      model?: string;
      prompt: string;
      projectId: string;
      title?: string;
      isolate?: boolean;
      worktreeName?: string;
      attachments?: import("shared").Attachment[];
    }>();

    if (!body.agent || !body.prompt) {
      return c.json({ error: "agent and prompt are required" }, 400);
    }

    if (!body.projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    // Resolve project path
    const project = getProject(db, body.projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const { existsSync } = await import("fs");
    if (!existsSync(project.path)) {
      return c.json({ error: "Project path no longer exists" }, 400);
    }

    try {
      const thread = await sessionManager.startThread({
        agent: body.agent,
        effortLevel: body.effortLevel,
        permissionMode: body.permissionMode,
        model: body.model,
        prompt: body.prompt,
        repoPath: project.path,
        projectId: body.projectId,
        title: body.title,
        isolate: body.isolate,
        worktreeName: body.worktreeName,
        attachments: body.attachments,
      });
      touchProjectUpdatedAt(db, body.projectId);
      return c.json(threadRowToApi(thread), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Stop thread
  app.post("/:id/stop", (c) => {
    sessionManager.stopThread(c.req.param("id"), { drainQueued: true });
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json(threadRowToApi(thread));
  });

  // Send message to running thread
  app.post("/:id/messages", async (c) => {
    const { content, attachments, interrupt } = await c.req.json<{
      content: string;
      attachments?: import("shared").Attachment[];
      interrupt?: boolean;
    }>();
    if (!content) return c.json({ error: "content is required" }, 400);
    try {
      sessionManager.sendMessage(c.req.param("id"), content, attachments, { interrupt: interrupt === true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Isolate to worktree
  app.post("/:id/isolate", async (c) => {
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId) as ThreadRow | null;
    if (!thread) return c.json({ error: "Not found" }, 404);
    if (thread.worktree) return c.json({ error: "Already isolated" }, 400);

    try {
      // Stop current session
      sessionManager.stopThread(threadId);

      // Create worktree
      const wt = await worktreeManager.create(threadId, thread.repo_path);
      updateThread(db, threadId, {
        worktree: wt.path,
        branch: wt.branch,
        status: "paused",
      });

      const updated = getThread(db, threadId)!;
      return c.json(threadRowToApi(updated));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Get file diff (relative to main branch)
  app.get("/:id/worktree/diff", async (c) => {
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file query param required" }, 400);
    const diff = await worktreeManager.getFileDiff(c.req.param("id"), file);
    if (!diff) return c.json({ error: "Not found" }, 404);
    return c.json(diff);
  });

  // Get worktree status
  app.get("/:id/worktree", async (c) => {
    const status = await worktreeManager.getStatus(c.req.param("id"));
    if (!status) return c.json({ error: "No worktree" }, 404);
    return c.json(status);
  });

  // Create PR
  app.post("/:id/pr", async (c) => {
    const threadId = c.req.param("id");
    const body = await c.req.json<{
      title?: string;
      body?: string;
      commitMessage?: string;
    }>().catch(() => ({}));

    try {
      await worktreeManager.createPR(threadId, body);
      const updated = getThread(db, threadId);
      if (!updated) return c.json({ error: "Not found" }, 404);
      sessionManager.notifyThread(threadId);
      return c.json(threadRowToApi(updated));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Cleanup worktree
  app.post("/:id/cleanup", async (c) => {
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId) as ThreadRow | null;
    if (!thread) return c.json({ error: "Not found" }, 404);

    try {
      await worktreeManager.cleanup(threadId, thread.repo_path);
      const updated = getThread(db, threadId)!;
      return c.json(threadRowToApi(updated));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Refresh PR status for a single thread
  app.post("/:id/refresh-pr", async (c) => {
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId) as ThreadRow | null;
    if (!thread) return c.json({ error: "Not found" }, 404);

    const liveBranch = resolveThreadBranch(thread.worktree, thread.branch);
    let shouldNotify = persistThreadBranch(db, thread, liveBranch);
    const result = await resolveThreadPrLookup(thread, liveBranch, {
      prByBranchResolver,
      prByUrlResolver,
    });

    if (result?.kind === "found") {
      shouldNotify = persistResolvedPr(db, thread, result.pr) || shouldNotify;
    } else if (result?.kind === "not_found") {
      shouldNotify = clearCachedPr(db, thread) || shouldNotify;
    } else {
      touchPrStatusCheckedAt(db, thread);
    }

    if (shouldNotify) {
      sessionManager.notifyThread(threadId);
    }

    const updated = getThread(db, threadId)!;
    return c.json(threadRowToApi(updated));
  });

  // Update thread title, model, permissionMode, or effortLevel
  app.patch("/:id", async (c) => {
    const { title, model, permissionMode, effortLevel } = await c.req.json<{
      title?: string;
      model?: string | null;
      permissionMode?: import("shared").PermissionMode | null;
      effortLevel?: import("shared").EffortLevel | null;
    }>();
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId);
    if (!thread) return c.json({ error: "Not found" }, 404);

    // ── Validate ALL fields before any writes ──
    if (model !== undefined && model !== null && model !== "") {
      if (model.length > 100 || !/^[a-zA-Z0-9.\-]+$/.test(model)) {
        return c.json({ error: "Invalid model format" }, 400);
      }
    }

    if (permissionMode !== undefined && permissionMode !== null) {
      if (!isPermissionModeSupported(thread.agent, permissionMode)) {
        return c.json({ error: `Permission mode "${permissionMode}" is not supported for ${thread.agent}` }, 400);
      }
    }

    if (effortLevel !== undefined && effortLevel !== null) {
      if (!isEffortLevelSupported(thread.agent, effortLevel)) {
        return c.json({ error: `Effort level "${effortLevel}" is not supported for ${thread.agent}` }, 400);
      }
    }

    // ── Apply changes (session manager owns DB writes for model/permission/effort) ──
    if (title) {
      updateThread(db, threadId, { title });
      sessionManager.notifyThread(threadId);
    }

    if (model !== undefined) {
      try {
        await sessionManager.changeModel(threadId, model || null);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("mid-turn")) {
          return c.json({ error: message }, 409);
        }
        return c.json({ error: message }, 400);
      }
    }

    if (permissionMode !== undefined) {
      try {
        await sessionManager.changePermissionMode(threadId, permissionMode || null);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }

    if (effortLevel !== undefined) {
      try {
        await sessionManager.changeEffortLevel(threadId, effortLevel || null);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }

    const updated = getThread(db, threadId);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(threadRowToApi(updated));
  });

  // Archive (soft-delete) thread
  app.delete("/:id", async (c) => {
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId) as ThreadRow | null;
    if (!thread) return c.json({ error: "Not found" }, 404);

    // Stop the thread if it's running
    sessionManager.stopThread(threadId);

    // Close terminal for this thread (server-side lifecycle — not client-dependent)
    terminalManager?.closeForThread(threadId);

    // Optionally cleanup worktree before archiving
    const cleanupWorktree = c.req.query("cleanup_worktree") === "true";
    let cleanupFailed = false;
    if (cleanupWorktree && thread.worktree) {
      try {
        await worktreeManager.cleanup(threadId, thread.repo_path);
      } catch (err) {
        // Still archive the thread even if worktree cleanup fails
        cleanupFailed = true;
        console.error(`Worktree cleanup failed for thread ${threadId}:`, err);
      }
    }

    // Soft-delete by setting archived_at
    db.query(
      "UPDATE threads SET archived_at = datetime('now') WHERE id = ?",
    ).run(threadId);

    // Broadcast so other clients remove from sidebar
    sessionManager.notifyThread(threadId);

    return c.json({ ok: true, cleanupFailed });
  });

  return app;
}

async function enrichThreadsWithOpenPrs(
  db: DB,
  threads: ThreadRow[],
  sessionManager: SessionManager,
  openPrLister: (cwd: string) => Promise<Map<string, PrLookupInfo>>,
  prByBranchResolver: (branch: string, cwd: string) => Promise<PrLookupResult>,
  prByUrlResolver: (prUrl: string, cwd: string) => Promise<PrLookupResult>,
): Promise<void> {
  const threadsByRepo = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    const group = threadsByRepo.get(thread.repo_path) ?? [];
    group.push(thread);
    threadsByRepo.set(thread.repo_path, group);
  }

  const openPrsByRepo = new Map<string, Map<string, PrLookupInfo>>();
  await Promise.all(
    Array.from(threadsByRepo.keys()).map(async (repoPath) => {
      try {
        openPrsByRepo.set(repoPath, await openPrLister(repoPath));
      } catch {
        openPrsByRepo.set(repoPath, new Map<string, PrLookupInfo>());
      }
    }),
  );

  for (const thread of threads) {
    const liveBranch = resolveThreadBranch(thread.worktree, thread.branch);
    let shouldNotify = persistThreadBranch(db, thread, liveBranch);
    const repoPrs = openPrsByRepo.get(thread.repo_path) ?? new Map<string, PrLookupInfo>();
    const livePr = liveBranch ? repoPrs.get(liveBranch) : null;
    if (livePr) {
      shouldNotify = persistResolvedPr(db, thread, livePr) || shouldNotify;
    } else if (
      thread.pr_url &&
      (thread.pr_status === "open" || thread.pr_status === "draft" || thread.pr_status === null)
    ) {
      const exactResult = await resolveThreadPrLookup(thread, liveBranch, {
        prByBranchResolver,
        prByUrlResolver,
      });
      if (exactResult?.kind === "found") {
        shouldNotify = persistResolvedPr(db, thread, exactResult.pr) || shouldNotify;
      } else if (exactResult?.kind === "not_found") {
        shouldNotify = clearCachedPr(db, thread) || shouldNotify;
      } else if (exactResult?.kind === "error") {
        touchPrStatusCheckedAt(db, thread);
      }
    }

    if (shouldNotify) {
      sessionManager.notifyThread(thread.id);
    }
  }
}

/**
 * Fire-and-forget: refresh PR statuses for threads with open/draft PRs
 * that haven't been checked recently. Only broadcasts WS when status changes.
 */
function refreshStalePrStatuses(
  db: DB,
  threads: ThreadRow[],
  sessionManager: SessionManager,
  prByUrlResolver: (prUrl: string, cwd: string) => Promise<PrLookupResult>,
): void {
  const refreshable = threads.filter(
    (t) =>
      t.pr_url &&
      (t.pr_status === "open" || t.pr_status === "draft" || t.pr_status === null) &&
      isPrStatusStale(t.pr_status_checked_at),
  );

  for (const thread of refreshable) {
    // Each call is individually fire-and-forget; semaphore in pr-status.ts
    // handles concurrency limiting
    prByUrlResolver(thread.pr_url!, thread.repo_path).then((result) => {
      if (result.kind === "found") {
        const changed = persistResolvedPr(db, thread, result.pr);
        if (changed) {
          sessionManager.notifyThread(thread.id);
        }
      } else if (result.kind === "not_found") {
        if (clearCachedPr(db, thread)) {
          sessionManager.notifyThread(thread.id);
        }
      } else {
        touchPrStatusCheckedAt(db, thread);
      }
    }).catch(() => {
      // Silently ignore — fire-and-forget
    });
  }
}
