import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// ── Helpers ─────────────────────────────────────────────

/** Create an in-memory SQLite database with the projects table. */
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

/** Create a SKILL.md file with YAML frontmatter. */
function writeSkillMd(
  dir: string,
  name: string,
  description: string,
): void {
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody content here.\n`,
  );
}

/** Temp dir prefix for cleanup tracking. */
let tempDirs: string[] = [];

function makeTmpDir(prefix = "orchestra-cmd-test-"): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
});

// ── We need to mock `os.homedir` so that the commands module reads our fixture dirs ──
// The module also uses `readFileSync`, `readdirSync`, `statSync`, `existsSync` from `fs`
// but those operate on real paths, so we just need to control `homedir()`.

let fakeHome: string;

/**
 * Build a Hono app that routes through the commands route.
 * Because commands.ts caches results, we must re-import each time to get a fresh module.
 * We use `mock.module` to redirect `os.homedir` before the import.
 */
async function createApp(
  db: Database,
): Promise<Hono> {
  // Clear module cache so each test gets a fresh cache Map
  // and picks up the mocked homedir
  const modulePath = resolve(
    import.meta.dir,
    "../commands.ts",
  );

  // Use dynamic import with a cache-busting query to avoid stale module cache
  const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
  const mod = await import(modulePath + cacheBuster);
  const { createCommandRoutes } = mod;

  const app = new Hono();
  app.route("/api/commands", createCommandRoutes(db));
  return app;
}

// ── Tests ───────────────────────────────────────────────

describe("GET /api/commands", () => {
  let db: Database;

  beforeEach(() => {
    fakeHome = makeTmpDir();
    // Mock os.homedir to return our temp directory
    mock.module("os", () => ({
      homedir: () => fakeHome,
    }));
    db = createTestDb();
  });

  // ── readEnabledPlugins paths ──────────────────────────

  describe("readEnabledPlugins", () => {
    test("valid settings.json returns enabledPlugins map", async () => {
      // Set up: installed_plugins.json with a plugin, and settings.json with enabledPlugins
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "my-plugin-cmd", "A plugin command");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "my-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      // settings.json with enabledPlugins — explicitly enable the plugin
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "my-plugin": true } }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      expect(res.status).toBe(200);

      const commands = await res.json();
      const pluginCmd = commands.find(
        (c: { name: string }) => c.name === "/my-plugin-cmd",
      );
      expect(pluginCmd).toBeTruthy();
      expect(pluginCmd.source).toBe("plugin");
    });

    test("missing settings.json returns null (uses installed plugins as default-on)", async () => {
      // installed_plugins.json exists but NO settings.json
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "default-on-cmd", "Should appear since not explicitly disabled");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "default-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      // Plugin should appear because it's installed and not explicitly disabled
      const cmd = commands.find(
        (c: { name: string }) => c.name === "/default-on-cmd",
      );
      expect(cmd).toBeTruthy();
    });

    test("malformed JSON settings.json returns null (treated as unreadable)", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "mal-cmd", "Should still appear");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "mal-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".claude", "settings.json"),
        "NOT VALID JSON {{{",
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      // Plugin should appear: malformed settings => null => default-on for installed plugins
      const cmd = commands.find(
        (c: { name: string }) => c.name === "/mal-cmd",
      );
      expect(cmd).toBeTruthy();
    });
  });

  // ── readInstalledPlugins paths ────────────────────────

  describe("readInstalledPlugins", () => {
    test("valid installed_plugins.json returns Map of plugin key to installPath", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "installed-cmd", "From installed plugin");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "test-plugin": [
              { scope: "global", installPath, version: "2.0.0" },
            ],
          },
        }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/installed-cmd",
      );
      expect(cmd).toBeTruthy();
      expect(cmd.source).toBe("plugin");
    });

    test("missing installed_plugins.json returns empty Map (falls back to cache scan)", async () => {
      // No installed_plugins.json at all — should fall back to scanning cache dir
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      const pluginDir = join(cacheDir, "some-plugin");
      mkdirSync(pluginDir);
      writeSkillMd(pluginDir, "cache-cmd", "Found via cache scan fallback");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/cache-cmd",
      );
      expect(cmd).toBeTruthy();
      expect(cmd.source).toBe("plugin");
    });

    test("plugin with empty entries array is skipped", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      // One plugin with entries, one with empty array
      const installPath = makeTmpDir();
      writeSkillMd(installPath, "has-entries", "This one has entries");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "empty-plugin": [],
            "real-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/has-entries",
      );
      expect(cmd).toBeTruthy();

      // Only builtin commands + the one real plugin should be present (no phantom entries)
      const nonBuiltin = commands.filter(
        (c: { source: string }) => c.source === "plugin",
      );
      expect(nonBuiltin).toHaveLength(1);
    });
  });

  // ── resolveEnabledPluginPaths paths ───────────────────

  describe("resolveEnabledPluginPaths", () => {
    test("no installed plugins returns null (fallback to cache scan)", async () => {
      // No installed_plugins.json AND no cache dir — should get only builtins
      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      // Should only contain builtin commands
      const allSources = commands.map((c: { source: string }) => c.source);
      expect(allSources.every((s: string) => s === "builtin")).toBe(true);
    });

    test("global enabled + project override merge", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      // Two plugins installed
      const installPath1 = makeTmpDir();
      writeSkillMd(installPath1, "global-cmd", "Global plugin");

      const installPath2 = makeTmpDir();
      writeSkillMd(installPath2, "project-cmd", "Project plugin");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "global-plugin": [
              { scope: "global", installPath: installPath1, version: "1.0.0" },
            ],
            "project-plugin": [
              { scope: "global", installPath: installPath2, version: "1.0.0" },
            ],
          },
        }),
      );

      // Global settings: enable global-plugin, disable project-plugin
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "global-plugin": true,
            "project-plugin": false,
          },
        }),
      );

      // Project settings: override project-plugin to true
      const projectPath = makeTmpDir();
      mkdirSync(join(projectPath, ".claude"), { recursive: true });
      writeFileSync(
        join(projectPath, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: { "project-plugin": true },
        }),
      );

      // Insert project into DB
      db.query("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(
        "proj-1",
        "Test Project",
        projectPath,
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands?projectId=proj-1");
      const commands = await res.json();

      // Both plugins should appear: global-plugin (globally enabled) + project-plugin (project override)
      const globalCmd = commands.find(
        (c: { name: string }) => c.name === "/global-cmd",
      );
      const projectCmd = commands.find(
        (c: { name: string }) => c.name === "/project-cmd",
      );

      expect(globalCmd).toBeTruthy();
      expect(projectCmd).toBeTruthy();
    });

    test("explicitly disabled plugin (false) is excluded", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "disabled-cmd", "Should be excluded");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "disabled-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: { "disabled-plugin": false },
        }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/disabled-cmd",
      );
      expect(cmd).toBeUndefined();
    });

    test("plugin not in enabledPlugins is included (default-on)", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "unlisted-cmd", "Not mentioned in enabledPlugins");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "unlisted-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      // settings.json exists but does NOT mention unlisted-plugin
      mkdirSync(join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: { "some-other-plugin": true },
        }),
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/unlisted-cmd",
      );
      expect(cmd).toBeTruthy();
    });
  });

  // ── findSkillFiles paths ──────────────────────────────

  describe("findSkillFiles", () => {
    test("skips .agents/ directories", async () => {
      // Set up cache fallback (no installed_plugins.json)
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      // Create a SKILL.md inside .agents/ — should be skipped
      const agentsDir = join(cacheDir, ".agents");
      mkdirSync(agentsDir);
      writeSkillMd(agentsDir, "agent-skill", "Should be hidden");

      // Create a normal SKILL.md — should be found
      const normalDir = join(cacheDir, "normal-plugin");
      mkdirSync(normalDir);
      writeSkillMd(normalDir, "normal-skill", "Should appear");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const agentCmd = commands.find(
        (c: { name: string }) => c.name === "/agent-skill",
      );
      const normalCmd = commands.find(
        (c: { name: string }) => c.name === "/normal-skill",
      );

      expect(agentCmd).toBeUndefined();
      expect(normalCmd).toBeTruthy();
    });

    test("finds nested SKILL.md files", async () => {
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      // Deeply nested SKILL.md
      const deepDir = join(cacheDir, "plugin", "sub", "deep");
      mkdirSync(deepDir, { recursive: true });
      writeSkillMd(deepDir, "deep-skill", "Deeply nested");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/deep-skill",
      );
      expect(cmd).toBeTruthy();
    });

    test("handles missing/unreadable dirs gracefully", async () => {
      // Don't create any dirs at all — homedir exists but no .claude
      const app = await createApp(db);
      const res = await app.request("/api/commands");
      expect(res.status).toBe(200);

      const commands = await res.json();
      // Should still have builtin commands
      const builtinCmds = commands.filter(
        (c: { source: string }) => c.source === "builtin",
      );
      expect(builtinCmds.length).toBeGreaterThan(0);
    });
  });

  // ── collectCommands paths ─────────────────────────────

  describe("collectCommands", () => {
    test("deduplicates by name", async () => {
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      // Two plugins with the same command name
      const dir1 = join(cacheDir, "plugin-a");
      mkdirSync(dir1);
      writeSkillMd(dir1, "dupe-cmd", "First occurrence");

      const dir2 = join(cacheDir, "plugin-b");
      mkdirSync(dir2);
      writeSkillMd(dir2, "dupe-cmd", "Second occurrence (should be deduped)");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const dupes = commands.filter(
        (c: { name: string }) => c.name === "/dupe-cmd",
      );
      expect(dupes).toHaveLength(1);
    });

    test("normalizes name with '/' prefix", async () => {
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      const dir = join(cacheDir, "my-plugin");
      mkdirSync(dir);
      // Name without leading slash
      writeSkillMd(dir, "no-slash", "Name lacks slash prefix");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const cmd = commands.find(
        (c: { name: string }) => c.name === "/no-slash",
      );
      expect(cmd).toBeTruthy();
      expect(cmd.name.startsWith("/")).toBe(true);
    });

    test("skips files with no frontmatter", async () => {
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      const dir = join(cacheDir, "bad-plugin");
      mkdirSync(dir);
      // SKILL.md with no frontmatter
      writeFileSync(join(dir, "SKILL.md"), "Just plain text, no YAML frontmatter.\n");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      // Only builtins should be present
      const plugins = commands.filter(
        (c: { source: string }) => c.source === "plugin",
      );
      expect(plugins).toHaveLength(0);
    });
  });

  // ── GET /api/commands route paths ─────────────────────

  describe("route behavior", () => {
    test("no projectId returns commands (global-only)", async () => {
      const skillsDir = join(fakeHome, ".claude", "skills");
      mkdirSync(skillsDir, { recursive: true });

      const skillDir = join(skillsDir, "my-skill");
      mkdirSync(skillDir);
      writeSkillMd(skillDir, "global-skill", "A global user skill");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      expect(res.status).toBe(200);

      const commands = await res.json();
      // Should include builtins
      const builtinNew = commands.find(
        (c: { name: string }) => c.name === "/new",
      );
      const builtinStop = commands.find(
        (c: { name: string }) => c.name === "/stop",
      );
      expect(builtinNew).toBeTruthy();
      expect(builtinStop).toBeTruthy();
      expect(builtinNew.source).toBe("builtin");

      // Should include user skills
      const skill = commands.find(
        (c: { name: string }) => c.name === "/global-skill",
      );
      expect(skill).toBeTruthy();
      expect(skill.source).toBe("skill");
    });

    test("with projectId looks up project from DB, returns project-scoped commands", async () => {
      const pluginsDir = join(fakeHome, ".claude", "plugins");
      mkdirSync(pluginsDir, { recursive: true });

      const installPath = makeTmpDir();
      writeSkillMd(installPath, "proj-scoped", "Project scoped command");

      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            "proj-plugin": [
              { scope: "global", installPath, version: "1.0.0" },
            ],
          },
        }),
      );

      const projectPath = makeTmpDir();
      mkdirSync(join(projectPath, ".claude"), { recursive: true });
      writeFileSync(
        join(projectPath, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "proj-plugin": true } }),
      );

      db.query("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(
        "proj-2",
        "My Project",
        projectPath,
      );

      const app = await createApp(db);
      const res = await app.request("/api/commands?projectId=proj-2");
      expect(res.status).toBe(200);

      const commands = await res.json();
      const cmd = commands.find(
        (c: { name: string }) => c.name === "/proj-scoped",
      );
      expect(cmd).toBeTruthy();
    });

    test("invalid projectId results in null projectPath, global fallback", async () => {
      const app = await createApp(db);
      const res = await app.request("/api/commands?projectId=nonexistent-id");
      expect(res.status).toBe(200);

      const commands = await res.json();
      // Should still return builtins at minimum
      const builtins = commands.filter(
        (c: { source: string }) => c.source === "builtin",
      );
      expect(builtins.length).toBeGreaterThan(0);
    });

    test("cache hit returns cached result", async () => {
      const skillsDir = join(fakeHome, ".claude", "skills");
      mkdirSync(skillsDir, { recursive: true });

      const skillDir = join(skillsDir, "cached-skill");
      mkdirSync(skillDir);
      writeSkillMd(skillDir, "cached-cmd", "Cached");

      const app = await createApp(db);

      // First request populates cache
      const res1 = await app.request("/api/commands");
      const commands1 = await res1.json();

      // Mutate filesystem — add a new skill AFTER the first request
      const newSkillDir = join(skillsDir, "new-skill");
      mkdirSync(newSkillDir);
      writeSkillMd(newSkillDir, "new-cmd", "Should NOT appear due to cache");

      // Second request should return cached result (same reference)
      const res2 = await app.request("/api/commands");
      const commands2 = await res2.json();

      expect(commands1).toEqual(commands2);

      // The new command should NOT be in the cached result
      const newCmd = commands2.find(
        (c: { name: string }) => c.name === "/new-cmd",
      );
      expect(newCmd).toBeUndefined();
    });
  });

  // ── Built-in commands always present ──────────────────

  describe("built-in commands", () => {
    test("always includes /new and /stop", async () => {
      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const names = commands.map((c: { name: string }) => c.name);
      expect(names).toContain("/new");
      expect(names).toContain("/stop");
    });
  });

  // ── User skills directory ─────────────────────────────

  describe("user skills", () => {
    test("skills from ~/.claude/skills/ are sourced as 'skill'", async () => {
      const skillsDir = join(fakeHome, ".claude", "skills");
      mkdirSync(skillsDir, { recursive: true });

      const s1 = join(skillsDir, "skill-one");
      mkdirSync(s1);
      writeSkillMd(s1, "skill-one", "First user skill");

      const s2 = join(skillsDir, "skill-two");
      mkdirSync(s2);
      writeSkillMd(s2, "/skill-two", "Second user skill (with slash)");

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      const skills = commands.filter(
        (c: { source: string }) => c.source === "skill",
      );
      expect(skills.length).toBe(2);

      // Both should have / prefix
      for (const s of skills) {
        expect(s.name.startsWith("/")).toBe(true);
      }
    });
  });

  // ── Sorting ───────────────────────────────────────────

  describe("sorting", () => {
    test("discovered commands are sorted alphabetically by name", async () => {
      const cacheDir = join(fakeHome, ".claude", "plugins", "cache");
      mkdirSync(cacheDir, { recursive: true });

      // Create plugins with names that sort differently
      for (const name of ["zebra", "alpha", "middle"]) {
        const dir = join(cacheDir, name);
        mkdirSync(dir);
        writeSkillMd(dir, name, `The ${name} command`);
      }

      const app = await createApp(db);
      const res = await app.request("/api/commands");
      const commands = await res.json();

      // Builtin commands come first (prepended), then discovered are sorted
      // Filter to only discovered (non-builtin) commands
      const discovered = commands.filter(
        (c: { source: string }) => c.source !== "builtin",
      );
      const discoveredNames = discovered.map((c: { name: string }) => c.name);
      const sorted = [...discoveredNames].sort();
      expect(discoveredNames).toEqual(sorted);
    });
  });
});
