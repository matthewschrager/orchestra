/**
 * LSP-plugin PATH doctor
 * ----------------------
 *
 * Orchestra passes `settingSources: ["user", "project", "local"]` to the Claude
 * Agent SDK so CLI skills and plugins are inherited by SDK sessions. The side
 * effect: any `*-lsp@*` plugin the user enabled in `~/.claude/settings.json`
 * (for example `pyright-lsp@claude-plugins-official`) will cause the SDK to try
 * spawning the plugin's language server on first Python/TS/Rust file access.
 * The plugin bundles no binary — it only *declares* the command
 * (e.g. `pyright-langserver`) and expects the user to have installed it.
 *
 * When the binary is missing from PATH, the SDK surfaces the spawn failure as a
 * tool_use error that ends the turn with `Agent error: ... Executable not found
 * in $PATH: "pyright-langserver"`. In the CLI this appears as an inline warning;
 * in headless SDK mode (Orchestra's use case) it's a hard failure.
 *
 * This doctor runs once at server startup:
 *   1. Read `~/.claude/settings.json` → `enabledPlugins`
 *   2. Look up each enabled plugin in its marketplace manifest
 *      (`~/.claude/plugins/marketplaces/<mp>/.claude-plugin/marketplace.json`)
 *   3. For plugins that declare `lspServers`, check whether the `command`
 *      resolves on PATH via `Bun.which()`
 *   4. Cache diagnostics in memory; expose them via `GET /api/diagnostics/lsp`
 *      so the client can surface a warning banner in the Settings panel with
 *      a one-shot install hint.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { LspPluginDiagnostic } from "shared";

// ── Pure helpers (testable without filesystem) ───────────

/**
 * Settings-file shape we care about. Other keys are ignored.
 * Values in `enabledPlugins` can be boolean or string[] (version constraints);
 * only truthy values count as "enabled".
 */
export interface ParsedClaudeSettings {
  enabledPlugins?: Record<string, unknown>;
}

/**
 * Marketplace entry shape we care about.
 */
export interface MarketplacePluginEntry {
  name: string;
  lspServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      extensionToLanguage?: Record<string, string>;
    }
  >;
}

export interface MarketplaceManifest {
  name?: string;
  plugins?: MarketplacePluginEntry[];
}

/**
 * Parse a plugin ID of the form `name@marketplace` into its parts.
 * Returns null if the ID isn't well-formed.
 */
export function parsePluginId(pluginId: string): { name: string; marketplace: string } | null {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) return null;
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

/**
 * A single check to run: either a binary to resolve on PATH, or a marker that
 * we couldn't inspect the plugin at all (manifest missing / malformed).
 *
 * We deliberately surface the "manifest missing" case rather than silently
 * dropping it — the whole point of the doctor is to catch pre-flight issues,
 * and a plugin enabled in settings whose manifest we can't find will still
 * fail at SDK time, just with a different error message.
 */
export type LspCheck =
  | {
      kind: "probe";
      pluginId: string;
      pluginName: string;
      marketplace: string;
      serverName: string;
      command: string;
    }
  | {
      kind: "manifest-missing";
      pluginId: string;
      pluginName: string;
      marketplace: string;
      reason: string;
    };

/**
 * Given the parsed settings + map of marketplace name → manifest, compute the
 * set of enabled LSP plugin checks to run. Pure function — no IO.
 */
export function collectLspChecks(
  settings: ParsedClaudeSettings,
  marketplaces: Map<string, MarketplaceManifest>,
): LspCheck[] {
  const checks: LspCheck[] = [];
  const enabled = settings.enabledPlugins ?? {};

  for (const [pluginId, value] of Object.entries(enabled)) {
    // Plugin is "enabled" when value is truthy (boolean true or non-empty array).
    // `false` / `undefined` / empty array all mean disabled.
    const isEnabled =
      value === true ||
      (Array.isArray(value) && value.length > 0) ||
      (typeof value === "string" && value.length > 0);
    if (!isEnabled) continue;

    const parsed = parsePluginId(pluginId);
    if (!parsed) continue;

    const manifest = marketplaces.get(parsed.marketplace);
    if (!manifest?.plugins) {
      checks.push({
        kind: "manifest-missing",
        pluginId,
        pluginName: parsed.name,
        marketplace: parsed.marketplace,
        reason: `Marketplace "${parsed.marketplace}" has no manifest at ~/.claude/plugins/marketplaces/${parsed.marketplace}/.claude-plugin/marketplace.json — SDK will fail on first matching file.`,
      });
      continue;
    }

    const entry = manifest.plugins.find((p) => p.name === parsed.name);
    if (!entry) {
      checks.push({
        kind: "manifest-missing",
        pluginId,
        pluginName: parsed.name,
        marketplace: parsed.marketplace,
        reason: `Plugin "${parsed.name}" is enabled in settings but missing from the "${parsed.marketplace}" manifest.`,
      });
      continue;
    }

    // Plugin found but declares no LSP servers → not an LSP plugin, skip
    // silently (it's something else like a skill / slash command / MCP).
    if (!entry.lspServers) continue;

    for (const [serverName, cfg] of Object.entries(entry.lspServers)) {
      if (!cfg?.command) continue;
      checks.push({
        kind: "probe",
        pluginId,
        pluginName: parsed.name,
        marketplace: parsed.marketplace,
        serverName,
        command: cfg.command,
      });
    }
  }
  return checks;
}

/**
 * Curated install hints keyed by binary name. Falls back to null when the
 * binary isn't in this table; the client can still surface the plugin README
 * path in that case.
 *
 * Keep this list short and only include binaries we've verified — wrong hints
 * are worse than no hint.
 */
const INSTALL_HINTS: Record<string, string> = {
  "pyright-langserver": "npm install -g pyright",
  "basedpyright-langserver": "npm install -g basedpyright",
  "typescript-language-server": "npm install -g typescript-language-server typescript",
  "rust-analyzer": "rustup component add rust-analyzer",
  "ruby-lsp": "gem install ruby-lsp",
  gopls: "go install golang.org/x/tools/gopls@latest",
};

export function installHintFor(command: string): string | null {
  return INSTALL_HINTS[command] ?? null;
}

// ── IO layer ──────────────────────────────────────────────

/**
 * Resolve CLAUDE_HOME. Respects `$CLAUDE_CONFIG_DIR` (Claude Code's override)
 * so the doctor still works when users point Claude at a non-default config
 * location (e.g. XDG-style setups). Fall back to `~/.claude` otherwise.
 */
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_HOME, "settings.json");
const MARKETPLACES_DIR = join(CLAUDE_HOME, "plugins", "marketplaces");

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.error(`[lsp-doctor] Failed to read ${path}:`, (err as Error).message);
    return null;
  }
}

/**
 * Read all marketplace manifests from `~/.claude/plugins/marketplaces/<mp>/.claude-plugin/marketplace.json`.
 * Missing or malformed files are skipped silently — this is a best-effort diagnostic.
 */
export function loadMarketplaces(dir: string = MARKETPLACES_DIR): Map<string, MarketplaceManifest> {
  const out = new Map<string, MarketplaceManifest>();
  if (!existsSync(dir)) return out;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of entries) {
    const manifestPath = join(dir, name, ".claude-plugin", "marketplace.json");
    const manifest = readJson<MarketplaceManifest>(manifestPath);
    if (manifest) out.set(name, manifest);
  }
  return out;
}

/**
 * Run the doctor. Reads settings + marketplaces from disk, checks each enabled
 * LSP plugin's command against PATH, and returns the diagnostics.
 *
 * Exported for testing — pass `overrides` to inject fake settings / marketplaces
 * / PATH resolver without touching the real filesystem.
 */
export function runLspDoctor(overrides?: {
  settings?: ParsedClaudeSettings | null;
  marketplaces?: Map<string, MarketplaceManifest>;
  which?: (command: string) => string | null;
}): LspPluginDiagnostic[] {
  const settings =
    overrides?.settings !== undefined
      ? overrides.settings
      : readJson<ParsedClaudeSettings>(SETTINGS_PATH);
  if (!settings) return [];

  const marketplaces = overrides?.marketplaces ?? loadMarketplaces();
  const which = overrides?.which ?? defaultWhich;

  const checks = collectLspChecks(settings, marketplaces);

  return checks.map((check): LspPluginDiagnostic => {
    if (check.kind === "manifest-missing") {
      return {
        pluginId: check.pluginId,
        pluginName: check.pluginName,
        marketplace: check.marketplace,
        // These three fields don't apply for manifest-missing entries; use
        // sentinels the client can display without conditional handling.
        serverName: "(unknown)",
        command: "(unknown)",
        status: "manifest-missing",
        resolved: false,
        installHint: null,
        reason: check.reason,
      };
    }

    const resolved = which(check.command);
    return {
      pluginId: check.pluginId,
      pluginName: check.pluginName,
      marketplace: check.marketplace,
      serverName: check.serverName,
      command: check.command,
      status: resolved ? "ok" : "missing",
      // Don't leak the absolute path — just record whether we resolved it.
      resolved: resolved !== null,
      installHint: installHintFor(check.command),
      reason: null,
    };
  });
}

/**
 * Default PATH resolver. Bun.which respects $PATH and returns null when not
 * found — exactly what we need. Guarded with a try/catch since in tests we may
 * not have a Bun global.
 */
function defaultWhich(command: string): string | null {
  try {
    return Bun.which(command);
  } catch {
    return null;
  }
}

// ── In-process cache ──────────────────────────────────────

let cachedDiagnostics: LspPluginDiagnostic[] = [];
let cachedCheckedAt: string | null = null;

/**
 * Run the doctor and store the result in memory for `/api/diagnostics/lsp`.
 * Logs a concise warning per missing binary so the failure is visible in the
 * server logs even before anyone opens the UI.
 */
export function runAndCacheLspDoctor(): { diagnostics: LspPluginDiagnostic[]; checkedAt: string } {
  const diagnostics = runLspDoctor();
  cachedDiagnostics = diagnostics;
  cachedCheckedAt = new Date().toISOString();

  const unhealthy = diagnostics.filter((d) => d.status !== "ok");
  if (unhealthy.length > 0) {
    console.log(
      `\n[lsp-doctor] ${unhealthy.length} enabled LSP plugin(s) will break SDK sessions on first matching file:`,
    );
    for (const d of unhealthy) {
      if (d.status === "manifest-missing") {
        console.log(`  • ${d.pluginId}: ${d.reason}`);
      } else {
        const hint = d.installHint ? ` → install with: ${d.installHint}` : "";
        console.log(`  • ${d.pluginId} expects \`${d.command}\` on PATH${hint}`);
      }
    }
    console.log(
      `[lsp-doctor] Disable a plugin by setting it to false in ~/.claude/settings.json > enabledPlugins, or install the binary.\n`,
    );
  }

  return { diagnostics, checkedAt: cachedCheckedAt };
}

export function getCachedLspDiagnostics(): {
  diagnostics: LspPluginDiagnostic[];
  checkedAt: string | null;
} {
  return { diagnostics: cachedDiagnostics, checkedAt: cachedCheckedAt };
}
