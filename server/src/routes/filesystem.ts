import { Hono } from "hono";
import { readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseResponse {
  current: string;
  parent: string | null;
  directories: DirEntry[];
}

export function createFilesystemRoutes() {
  const app = new Hono();

  app.get("/browse", (c) => {
    const rawPath = c.req.query("path") || homedir();
    const resolvedPath = resolve(rawPath);

    if (!existsSync(resolvedPath)) {
      return c.json({ error: "Path does not exist" }, 400);
    }

    try {
      const entries = readdirSync(resolvedPath, { withFileTypes: true });
      const directories: DirEntry[] = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const fullPath = resolve(resolvedPath, e.name);
          return {
            name: e.name,
            path: fullPath,
            isGitRepo: existsSync(resolve(fullPath, ".git")),
          };
        });

      const parent = resolve(resolvedPath, "..");
      const response: BrowseResponse = {
        current: resolvedPath,
        parent: parent !== resolvedPath ? parent : null,
        directories,
      };

      return c.json(response);
    } catch {
      return c.json({ error: "Cannot read directory" }, 400);
    }
  });

  return app;
}
