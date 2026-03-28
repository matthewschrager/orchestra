import { Hono } from "hono";
import { readdirSync, existsSync, realpathSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { DB } from "../db";
import { getProject } from "../db";
import { gitSpawn } from "../utils/git";

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

// ── File list cache ─────────────────────────────────────
// Caches git ls-files output per project path. LRU eviction at MAX_CACHE_ENTRIES.

const MAX_CACHE_ENTRIES = 10;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  files: string[];
  ts: number;
}

const fileListCache = new Map<string, CacheEntry>();

function evictOldest(): void {
  if (fileListCache.size < MAX_CACHE_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [key, entry] of fileListCache) {
    if (entry.ts < oldestTs) {
      oldestTs = entry.ts;
      oldestKey = key;
    }
  }
  if (oldestKey) fileListCache.delete(oldestKey);
}

const MAX_FILES = 5000;

/**
 * Get tracked files for a project path, with caching.
 * Stream-reads git ls-files and stops at MAX_FILES to avoid OOM on monorepos.
 */
async function getTrackedFiles(projectPath: string): Promise<{ files: string[]; truncated: boolean }> {
  const cached = fileListCache.get(projectPath);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { files: cached.files, truncated: cached.files.length >= MAX_FILES };
  }

  const proc = gitSpawn(["ls-files"], { cwd: projectPath, stdout: "pipe", stderr: "pipe" });

  // Stream-read lines, stop at MAX_FILES
  const files: string[] = [];
  let truncated = false;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          files.push(line);
          if (files.length >= MAX_FILES) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    // Handle remaining buffer (no trailing newline)
    if (!truncated && buffer.trim()) {
      files.push(buffer.trim());
    }
  } finally {
    reader.releaseLock();
    // Kill the process if we stopped early
    if (truncated) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  evictOldest();
  fileListCache.set(projectPath, { files, ts: Date.now() });
  return { files, truncated };
}

/**
 * Filter and rank file paths by query relevance.
 * Ranking: basename-start > path-start > substring. Tiebreak: shorter path, then alpha.
 */
export function filterFiles(files: string[], query: string, limit = 20): string[] {
  if (!query) return [];
  const q = query.toLowerCase();

  const matches: Array<{ path: string; rank: number }> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!lower.includes(q)) continue;

    const lastSlash = f.lastIndexOf("/");
    const basename = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;

    let rank: number;
    if (basename.startsWith(q)) {
      rank = 0; // best: basename starts with query
    } else if (lower.startsWith(q)) {
      rank = 1; // good: full path starts with query
    } else {
      rank = 2; // ok: substring match
    }
    matches.push({ path: f, rank });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  return matches.slice(0, limit).map((m) => m.path);
}

// ── Routes ──────────────────────────────────────────────

const HOME = homedir();

export function createFilesystemRoutes(db: DB) {
  const app = new Hono();

  // ── Browse directories ──────────────────────────────
  app.get("/browse", (c) => {
    const rawPath = c.req.query("path") || HOME;
    const resolvedPath = resolve(rawPath);

    // Restrict browsing to home directory (prevents full-disk enumeration)
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

  // ── File search (for @ autocomplete) ────────────────
  app.get("/files", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId is required" }, 400);
    }

    const project = getProject(db, projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const query = c.req.query("query");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;

    try {
      const { files, truncated } = await getTrackedFiles(project.path);

      if (query) {
        // Server-side filtered mode
        const filtered = filterFiles(files, query, limit);
        return c.json({ files: filtered, truncated: false });
      }

      // Full list mode
      return c.json({ files, truncated });
    } catch {
      return c.json({ files: [], truncated: false });
    }
  });

  return app;
}
