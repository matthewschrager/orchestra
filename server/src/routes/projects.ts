import { Hono } from "hono";
import { existsSync } from "fs";
import type { DB } from "../db";
import {
  deleteProject,
  getProject,
  getProjectThreadCounts,
  listProjects,
  projectRowToApi,
  updateProject,
  validateAndInsertProject,
} from "../db";
import { getCurrentBranch } from "../utils/git";
import type { ProjectWithStatus } from "shared";

export function createProjectRoutes(db: DB) {
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

  return app;
}
