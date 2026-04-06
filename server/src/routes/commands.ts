import { Hono } from "hono";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SlashCommand } from "shared";
import type { DB } from "../db";
import { getProject } from "../db";

interface CommandRouteDeps {
  getHomeDir?: () => string;
}

/** Built-in Orchestra commands handled by the UI itself. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "/new", description: "Start a new thread", source: "builtin" },
  { name: "/stop", description: "Stop the running thread", source: "builtin" },
];

// ── Settings / Plugin Config Readers ────────────────────

interface InstalledPlugin {
  scope: string;
  installPath: string;
  version: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

/** Read enabledPlugins from a Claude settings.json file. Returns null if unreadable. */
function readEnabledPlugins(
  settingsPath: string,
): Record<string, boolean> | null {
  try {
    const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return data.enabledPlugins ?? null;
  } catch {
    return null;
  }
}

/** Read installed_plugins.json and return a map of plugin key → installPath. */
function readInstalledPlugins(homeDir: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const filePath = join(homeDir, ".claude", "plugins", "installed_plugins.json");
    const data: InstalledPluginsFile = JSON.parse(readFileSync(filePath, "utf-8"));
    for (const [key, entries] of Object.entries(data.plugins)) {
      // Use the first (most recent) entry
      if (entries.length > 0) {
        result.set(key, entries[0].installPath);
      }
    }
  } catch {
    // File missing or unreadable — will fall back to full scan
  }
  return result;
}

/**
 * Resolve which plugin installPaths to scan, based on global + project enabledPlugins.
 *
 * Merge logic: project-level values override global values. A plugin is enabled if:
 *   - It's explicitly `true` in either layer, OR
 *   - It's in installed_plugins.json but not mentioned in enabledPlugins at all
 *     (i.e., only an explicit `false` disables)
 *
 * Returns null if we can't determine installed plugins (triggers full-scan fallback).
 */
function resolveEnabledPluginPaths(
  homeDir: string,
  projectPath: string | null,
): string[] | null {
  const installed = readInstalledPlugins(homeDir);
  if (installed.size === 0) return null; // No installed_plugins.json → fall back

  const globalEnabled = readEnabledPlugins(join(homeDir, ".claude", "settings.json"));
  const projectEnabled = projectPath
    ? readEnabledPlugins(join(projectPath, ".claude", "settings.json"))
    : null;

  // Merge: project overrides global
  const merged: Record<string, boolean> = { ...globalEnabled, ...projectEnabled };

  const paths: string[] = [];
  for (const [pluginKey, installPath] of installed) {
    // Only an explicit `false` disables a plugin
    if (merged[pluginKey] === false) continue;
    paths.push(installPath);
  }

  return paths;
}

// ── SKILL.md Discovery ──────────────────────────────────

/** Parse a YAML value that may be single-line or multiline (| or > block). */
function parseYamlValue(fm: string, key: string): string | null {
  // Single-line: key: "value" or key: value
  const singleLine = fm.match(new RegExp(`^${key}:\\s*"?([^"|\\n]+)"?\\s*$`, "m"));
  if (singleLine) return singleLine[1].trim();

  // Multiline block scalar: key: | or key: >
  const blockMatch = fm.match(new RegExp(`^${key}:\\s*[|>]-?\\s*\\n((?:[ \\t]+.+\\n?)*)`, "m"));
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return null;
}

/** Parse YAML frontmatter from a SKILL.md file for name + description. */
function parseSkillFrontmatter(
  filePath: string,
): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const name = parseYamlValue(fm, "name");
    if (!name) return null;

    const description = parseYamlValue(fm, "description") ?? "";

    return {
      name,
      description: description.slice(0, 120),
    };
  } catch {
    return null;
  }
}

/** Recursively find all SKILL.md files under a directory, skipping .agents/ dirs. */
function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      // Skip internal agent skill directories
      if (entry === ".agents") continue;

      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...findSkillFiles(full));
        } else if (entry === "SKILL.md") {
          results.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // dir doesn't exist or isn't readable
  }
  return results;
}

/** Collect SlashCommands from a list of SKILL.md files, deduplicating by name. */
function collectCommands(
  skillFiles: string[],
  seen: Set<string>,
  source: "plugin" | "skill",
): SlashCommand[] {
  const commands: SlashCommand[] = [];
  for (const skillFile of skillFiles) {
    const parsed = parseSkillFrontmatter(skillFile);
    if (!parsed) continue;

    const cmdName = parsed.name.startsWith("/")
      ? parsed.name
      : `/${parsed.name}`;

    if (seen.has(cmdName)) continue;
    seen.add(cmdName);

    commands.push({
      name: cmdName,
      description: parsed.description,
      source,
    });
  }
  return commands;
}

/**
 * Discover slash commands from Claude Code plugins and user skills.
 *
 * When projectPath is provided, the enabled plugin set is scoped to that project's
 * settings (merged with global). When null, only global settings are used.
 */
function discoverPluginCommands(homeDir: string, projectPath: string | null): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];

  // 1. Scan enabled plugin installPaths (or full cache as fallback)
  const enabledPaths = resolveEnabledPluginPaths(homeDir, projectPath);

  if (enabledPaths) {
    // Scoped scan: only installed + enabled plugins
    for (const installPath of enabledPaths) {
      if (!existsSync(installPath)) continue;
      const files = findSkillFiles(installPath);
      commands.push(...collectCommands(files, seen, "plugin"));
    }
  } else {
    // Fallback: no installed_plugins.json → scan entire cache (old behavior, minus .agents/)
    const cacheDir = join(homeDir, ".claude", "plugins", "cache");
    const files = findSkillFiles(cacheDir);
    commands.push(...collectCommands(files, seen, "plugin"));
  }

  // 2. Always scan user skills directory
  const skillsDir = join(homeDir, ".claude", "skills");
  const skillFiles = findSkillFiles(skillsDir);
  commands.push(...collectCommands(skillFiles, seen, "skill"));

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Route ────────────────────────────────────────────────

export function createCommandRoutes(db: DB, deps: CommandRouteDeps = {}) {
  const app = new Hono();
  const getHomeDir = deps.getHomeDir ?? homedir;

  // Cache per project (projectId → commands). null key = no project context.
  const cache = new Map<string | null, SlashCommand[]>();

  app.get("/", (c) => {
    const projectId = c.req.query("projectId") ?? null;

    // Resolve project path from DB if projectId is provided
    let projectPath: string | null = null;
    if (projectId) {
      const project = getProject(db, projectId);
      if (project) projectPath = project.path;
    }

    // Check cache (keyed by projectId, since same project = same settings)
    if (!cache.has(projectId)) {
      const homeDir = getHomeDir();
      cache.set(projectId, [
        ...BUILTIN_COMMANDS,
        ...discoverPluginCommands(homeDir, projectPath),
      ]);
    }

    return c.json(cache.get(projectId)!);
  });

  return app;
}
