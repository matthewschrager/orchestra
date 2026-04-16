import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parsePluginId,
  collectLspChecks,
  installHintFor,
  runLspDoctor,
  loadMarketplaces,
  type ParsedClaudeSettings,
  type MarketplaceManifest,
} from "../doctor";

// ── parsePluginId ──────────────────────────────────────────

describe("parsePluginId", () => {
  test("splits `name@marketplace` into parts", () => {
    expect(parsePluginId("pyright-lsp@claude-plugins-official")).toEqual({
      name: "pyright-lsp",
      marketplace: "claude-plugins-official",
    });
  });

  test("uses the LAST `@` so names containing @ still parse", () => {
    // In practice this is rare but marketplace IDs are unambiguous suffixes.
    expect(parsePluginId("scope@thing@official")).toEqual({
      name: "scope@thing",
      marketplace: "official",
    });
  });

  test("returns null for malformed IDs", () => {
    expect(parsePluginId("no-at-sign")).toBeNull();
    expect(parsePluginId("@leading")).toBeNull();
    expect(parsePluginId("trailing@")).toBeNull();
    expect(parsePluginId("")).toBeNull();
  });
});

// ── installHintFor ─────────────────────────────────────────

describe("installHintFor", () => {
  test("returns curated hints for known binaries", () => {
    expect(installHintFor("pyright-langserver")).toBe("npm install -g pyright");
    expect(installHintFor("typescript-language-server")).toContain("typescript-language-server");
    expect(installHintFor("rust-analyzer")).toContain("rustup");
  });

  test("returns null for unknown binaries", () => {
    expect(installHintFor("some-random-lsp")).toBeNull();
  });
});

// ── collectLspChecks ───────────────────────────────────────

function fakeMarketplaces(): Map<string, MarketplaceManifest> {
  const mp: MarketplaceManifest = {
    name: "claude-plugins-official",
    plugins: [
      {
        name: "pyright-lsp",
        lspServers: {
          pyright: { command: "pyright-langserver", args: ["--stdio"] },
        },
      },
      {
        name: "typescript-lsp",
        lspServers: {
          typescript: { command: "typescript-language-server", args: ["--stdio"] },
        },
      },
      {
        // Non-LSP plugin — should be ignored.
        name: "frontend-design",
      },
      {
        // LSP plugin with multiple servers — should yield one check per server.
        name: "multi-lsp",
        lspServers: {
          a: { command: "a-langserver" },
          b: { command: "b-langserver" },
        },
      },
    ],
  };
  return new Map([["claude-plugins-official", mp]]);
}

describe("collectLspChecks", () => {
  test("emits a probe for enabled LSP plugins and a manifest-missing for plugins not in the manifest", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: {
        "pyright-lsp@claude-plugins-official": true,
        "typescript-lsp@claude-plugins-official": false, // disabled — ignored
        "frontend-design@claude-plugins-official": true, // not an LSP — silently skipped
        "nonexistent@claude-plugins-official": true, // not in manifest — surfaced as manifest-missing
      },
    };
    const checks = collectLspChecks(settings, fakeMarketplaces());
    const probes = checks.filter((c) => c.kind === "probe");
    const missing = checks.filter((c) => c.kind === "manifest-missing");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      pluginName: "pyright-lsp",
      command: "pyright-langserver",
      serverName: "pyright",
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ pluginName: "nonexistent" });
  });

  test("treats non-empty version constraint arrays/strings as enabled", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: {
        "pyright-lsp@claude-plugins-official": ["^1.0.0"],
      },
    };
    const checks = collectLspChecks(settings, fakeMarketplaces());
    expect(checks.filter((c) => c.kind === "probe")).toHaveLength(1);
  });

  test("treats empty array and false as disabled", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: {
        "pyright-lsp@claude-plugins-official": [],
        "typescript-lsp@claude-plugins-official": false,
      },
    };
    expect(collectLspChecks(settings, fakeMarketplaces())).toHaveLength(0);
  });

  test("expands plugins that declare multiple LSP servers", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: { "multi-lsp@claude-plugins-official": true },
    };
    const checks = collectLspChecks(settings, fakeMarketplaces());
    const probes = checks.filter((c) => c.kind === "probe");
    expect(probes.map((c) => c.command).sort()).toEqual(["a-langserver", "b-langserver"]);
  });

  test("surfaces manifest-missing when the marketplace itself isn't loaded", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: { "pyright-lsp@unknown-marketplace": true },
    };
    const checks = collectLspChecks(settings, fakeMarketplaces());
    expect(checks).toHaveLength(1);
    expect(checks[0].kind).toBe("manifest-missing");
    if (checks[0].kind === "manifest-missing") {
      expect(checks[0].marketplace).toBe("unknown-marketplace");
      expect(checks[0].reason).toMatch(/Marketplace/);
    }
  });

  test("returns empty when settings has no enabledPlugins", () => {
    expect(collectLspChecks({}, fakeMarketplaces())).toHaveLength(0);
  });

  test("ignores malformed plugin IDs", () => {
    const settings: ParsedClaudeSettings = {
      enabledPlugins: { "no-at-sign": true, "@leading": true },
    };
    expect(collectLspChecks(settings, fakeMarketplaces())).toHaveLength(0);
  });

  test("skips LSP server entries with missing or empty `command`", () => {
    // Guards against a marketplace entry shaped like
    // `lspServers: { foo: { command: "" } }` — the doctor should silently
    // skip rather than emit a diagnostic that spawns an empty string.
    const mp: MarketplaceManifest = {
      plugins: [
        {
          name: "bad-lsp",
          lspServers: {
            // Empty-string command matches the type but is semantically
            // invalid — the doctor's runtime guard should drop it.
            empty: { command: "" },
            // @ts-expect-error — missing `command` entirely
            missing: {},
            valid: { command: "valid-langserver" },
          },
        },
      ],
    };
    const marketplaces = new Map([["mp", mp]]);
    const settings: ParsedClaudeSettings = {
      enabledPlugins: { "bad-lsp@mp": true },
    };
    const checks = collectLspChecks(settings, marketplaces);
    const probes = checks.filter((c) => c.kind === "probe");
    expect(probes).toHaveLength(1);
    expect(probes[0].command).toBe("valid-langserver");
  });
});

// ── loadMarketplaces (IO against a temp dir) ───────────────

describe("loadMarketplaces", () => {
  function setupTmp() {
    const dir = mkdtempSync(join(tmpdir(), "doctor-marketplaces-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("returns empty map when dir does not exist", () => {
    const result = loadMarketplaces("/nonexistent/path/that/shouldnt/exist");
    expect(result.size).toBe(0);
  });

  test("loads a valid marketplace manifest keyed by directory name", () => {
    const { dir, cleanup } = setupTmp();
    try {
      const mpDir = join(dir, "my-mp", ".claude-plugin");
      mkdirSync(mpDir, { recursive: true });
      writeFileSync(
        join(mpDir, "marketplace.json"),
        JSON.stringify({
          name: "my-mp",
          plugins: [{ name: "foo-lsp", lspServers: { foo: { command: "foo-ls" } } }],
        }),
      );

      const result = loadMarketplaces(dir);
      expect(result.size).toBe(1);
      const mp = result.get("my-mp");
      expect(mp?.plugins?.[0]?.name).toBe("foo-lsp");
    } finally {
      cleanup();
    }
  });

  test("skips marketplace dirs with malformed JSON rather than throwing", () => {
    const { dir, cleanup } = setupTmp();
    try {
      const goodDir = join(dir, "good", ".claude-plugin");
      const badDir = join(dir, "bad", ".claude-plugin");
      mkdirSync(goodDir, { recursive: true });
      mkdirSync(badDir, { recursive: true });
      writeFileSync(
        join(goodDir, "marketplace.json"),
        JSON.stringify({ name: "good", plugins: [] }),
      );
      writeFileSync(join(badDir, "marketplace.json"), "{ this is not json");

      const result = loadMarketplaces(dir);
      expect(result.has("good")).toBe(true);
      expect(result.has("bad")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("skips dirs missing .claude-plugin/marketplace.json", () => {
    const { dir, cleanup } = setupTmp();
    try {
      mkdirSync(join(dir, "no-manifest"), { recursive: true });
      const result = loadMarketplaces(dir);
      expect(result.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ── runLspDoctor (integration with injected overrides) ─────

describe("runLspDoctor", () => {
  test("marks binaries found on PATH as ok — reports resolved=true without leaking the absolute path", () => {
    const diagnostics = runLspDoctor({
      settings: { enabledPlugins: { "pyright-lsp@claude-plugins-official": true } },
      marketplaces: fakeMarketplaces(),
      which: (cmd) => (cmd === "pyright-langserver" ? "/fake/bin/pyright-langserver" : null),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      status: "ok",
      resolved: true,
      command: "pyright-langserver",
      installHint: "npm install -g pyright",
      reason: null,
    });
    // We deliberately do NOT surface the absolute path — see adversarial review #19.
    expect(diagnostics[0]).not.toHaveProperty("resolvedPath");
  });

  test("marks missing binaries with install hint when available", () => {
    const diagnostics = runLspDoctor({
      settings: { enabledPlugins: { "pyright-lsp@claude-plugins-official": true } },
      marketplaces: fakeMarketplaces(),
      which: () => null,
    });
    expect(diagnostics[0]).toMatchObject({
      status: "missing",
      resolved: false,
      installHint: "npm install -g pyright",
      reason: null,
    });
  });

  test("returns empty array when settings file is missing", () => {
    const diagnostics = runLspDoctor({
      settings: null,
      marketplaces: fakeMarketplaces(),
      which: () => null,
    });
    expect(diagnostics).toEqual([]);
  });

  test("emits manifest-missing diagnostic when marketplace can't be found (doesn't silently drop)", () => {
    // Regression test for adversarial review #12: silently dropping enabled
    // plugins whose manifest is missing defeats the doctor's whole purpose.
    const diagnostics = runLspDoctor({
      settings: {
        enabledPlugins: {
          "ghost-lsp@missing-marketplace": true,
          "pyright-lsp@claude-plugins-official": true,
        },
      },
      marketplaces: fakeMarketplaces(),
      which: () => "/fake/bin/pyright-langserver",
    });
    expect(diagnostics).toHaveLength(2);
    const ghost = diagnostics.find((d) => d.pluginName === "ghost-lsp");
    expect(ghost).toMatchObject({
      status: "manifest-missing",
      resolved: false,
      installHint: null,
    });
    expect(ghost?.reason).toMatch(/missing-marketplace/);
  });

  test("returns null installHint for unknown binary (so the UI can omit the hint line)", () => {
    const marketplaces: Map<string, MarketplaceManifest> = new Map([
      [
        "mp",
        {
          plugins: [
            {
              name: "weird-lsp",
              lspServers: { w: { command: "weird-langserver" } },
            },
          ],
        },
      ],
    ]);
    const diagnostics = runLspDoctor({
      settings: { enabledPlugins: { "weird-lsp@mp": true } },
      marketplaces,
      which: () => null,
    });
    expect(diagnostics[0]).toMatchObject({
      status: "missing",
      command: "weird-langserver",
      installHint: null,
    });
  });
});
