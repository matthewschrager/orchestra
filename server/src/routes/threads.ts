import { Hono } from "hono";
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
} from "../db";
import type { SessionManager } from "../sessions/manager";
import type { WorktreeManager } from "../worktrees/manager";

export function createThreadRoutes(
  db: DB,
  sessionManager: SessionManager,
  worktreeManager: WorktreeManager,
) {
  const app = new Hono();

  // List threads
  app.get("/", (c) => {
    const threads = listThreads(db).map(threadRowToApi);
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
    sessionManager.stopThread(c.req.param("id"));
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json(threadRowToApi(thread));
  });

  // Send message to running thread
  app.post("/:id/messages", async (c) => {
    const { content, attachments } = await c.req.json<{
      content: string;
      attachments?: import("shared").Attachment[];
    }>();
    if (!content) return c.json({ error: "content is required" }, 400);
    try {
      sessionManager.sendMessage(c.req.param("id"), content, attachments);
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

  // Get worktree status
  app.get("/:id/worktree", async (c) => {
    const status = await worktreeManager.getStatus(c.req.param("id"));
    if (!status) return c.json({ error: "No worktree" }, 404);
    return c.json(status);
  });

  // Create PR
  app.post("/:id/pr", async (c) => {
    const body = await c.req.json<{
      title?: string;
      body?: string;
      commitMessage?: string;
    }>().catch(() => ({}));

    try {
      const prUrl = await worktreeManager.createPR(c.req.param("id"), body);
      return c.json({ prUrl });
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

  // Update thread title
  app.patch("/:id", async (c) => {
    const { title } = await c.req.json<{ title?: string }>();
    if (title) {
      updateThread(db, c.req.param("id"), { title });
    }
    const thread = getThread(db, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    return c.json(threadRowToApi(thread));
  });

  // Archive (soft-delete) thread
  app.delete("/:id", async (c) => {
    const threadId = c.req.param("id");
    const thread = getThread(db, threadId) as ThreadRow | null;
    if (!thread) return c.json({ error: "Not found" }, 404);

    // Stop the thread if it's running
    sessionManager.stopThread(threadId);

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
