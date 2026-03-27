import { Hono } from "hono";
import { readdirSync, existsSync, realpathSync } from "fs";
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

const HOME = homedir();

export function createFilesystemRoutes() {
  const app = new Hono();

  app.get("/browse", (c) => {
    const rawPath = c.req.query("path") || HOME;
    const resolvedPath = resolve(rawPath);

    // Fix 4: Restrict browsing to home directory (prevents full-disk enumeration)
    // Use realpath to follow symlinks before boundary check
    let realPath: string;
    try {
      realPath = realpathSync(resolvedPath);
    } catch {
      return c.json({ error: "Path does not exist" }, 400);
    }

    if (realPath !== HOME && !realPath.startsWith(HOME + "/")) {
      return c.json({ error: "Path must be under home directory" }, 403);
    }

    if (!existsSync(realPath)) {
      return c.json({ error: "Path does not exist" }, 400);
    }

    try {
      const entries = readdirSync(realPath, { withFileTypes: true });
      const directories: DirEntry[] = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const fullPath = resolve(realPath, e.name);
          return {
            name: e.name,
            path: fullPath,
            isGitRepo: existsSync(resolve(fullPath, ".git")),
          };
        });

      const parent = resolve(realPath, "..");
      // Don't allow navigating above HOME
      const parentAllowed = parent !== realPath && (parent === HOME || parent.startsWith(HOME + "/"));
      const response: BrowseResponse = {
        current: realPath,
        parent: parentAllowed ? parent : null,
        directories,
      };

      return c.json(response);
    } catch {
      return c.json({ error: "Cannot read directory" }, 400);
    }
  });

  return app;
}
