import { Hono } from "hono";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { SlashCommand } from "shared";

/** Built-in Orchestra commands handled by the UI itself. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "/new", description: "Start a new thread", source: "builtin" },
  { name: "/stop", description: "Stop the running thread", source: "builtin" },
];

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

/** Recursively find all SKILL.md files under a directory. */
function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
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

/** Discover slash commands from Claude Code plugins and user skills. */
function discoverPluginCommands(): SlashCommand[] {
  const home = homedir();
  const searchDirs = [
    join(home, ".claude", "plugins", "cache"),
    join(home, ".claude", "skills"),
  ];

  const seen = new Set<string>();
  const commands: SlashCommand[] = [];

  for (const dir of searchDirs) {
    for (const skillFile of findSkillFiles(dir)) {
      const parsed = parseSkillFrontmatter(skillFile);
      if (!parsed) continue;

      // Normalize: skill names use ":" separator, convert to slash command format
      // e.g. "ce:ideate" → "/ce:ideate", "browse" → "/browse"
      const cmdName = parsed.name.startsWith("/")
        ? parsed.name
        : `/${parsed.name}`;

      if (seen.has(cmdName)) continue;
      seen.add(cmdName);

      commands.push({
        name: cmdName,
        description: parsed.description,
        source: "plugin",
      });
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function createCommandRoutes() {
  const app = new Hono();

  // Cache discovered commands (rescan on server restart)
  let cachedCommands: SlashCommand[] | null = null;

  app.get("/", (c) => {
    if (!cachedCommands) {
      cachedCommands = [...BUILTIN_COMMANDS, ...discoverPluginCommands()];
    }
    return c.json(cachedCommands);
  });

  return app;
}
