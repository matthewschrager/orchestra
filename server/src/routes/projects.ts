import { Hono } from "hono";
import { existsSync } from "fs";
import type { DB, ThreadRow } from "../db";
import {
  deleteProject,
  getProject,
  getProjectThreadCounts,
  listOutstandingPrThreads,
  listProjects,
  projectRowToApi,
  threadRowToApi,
  touchProjectUpdatedAt,
  updateProject,
  validateAndInsertProject,
} from "../db";
import { getCurrentBranch } from "../utils/git";
import type { ProjectWithStatus } from "shared";
import type { SessionManager } from "../sessions/manager";
import type { WorktreeManager } from "../worktrees/manager";
import type { TerminalManager } from "../terminal/manager";
import { buildMergeAllPrsPrompt } from "../projects/merge-all-prs";

export function createProjectRoutes(
  db: DB,
  sessionManager?: SessionManager,
  worktreeManager?: WorktreeManager,
  terminalManager?: TerminalManager,
) {
  const app = new Hono();

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

        return {
          ...base,
          currentBranch,
          threadCount: counts.total,
          activeThreadCount: counts.active,
          outstandingPrCount: counts.outstandingPrs,
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

    const threads = db
      .query(
        "SELECT * FROM threads WHERE project_id = ? AND archived_at IS NULL",
      )
      .all(projectId) as ThreadRow[];

    const cleaned: Array<{ id: string; title: string }> = [];
    const skipped: Array<{ id: string; title: string; reason: string }> = [];

    for (const thread of threads) {
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

      const pushStatus = await worktreeManager.isPushedToRemote(thread.id);
      if (!pushStatus.pushed) {
        skipped.push({
          id: thread.id,
          title: thread.title,
          reason: pushStatus.reason || "not_pushed",
        });
        continue;
      }

      // Safe to clean up
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

    return c.json({ cleaned, skipped });
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

    const outstanding = listOutstandingPrThreads(db, projectId);
    if (outstanding.length === 0) {
      return c.json({ error: "This project has no outstanding PRs" }, 400);
    }

    const prompt = buildMergeAllPrsPrompt(
      project.name,
      outstanding.map((thread) => ({
        id: thread.id,
        title: thread.title,
        prUrl: thread.pr_url,
        prNumber: thread.pr_number,
        prStatus: thread.pr_status,
        branch: thread.branch,
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
