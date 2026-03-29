import { describe, expect, test } from "bun:test";
import {
  getPermissionModeOptions,
  getPermissionModeLabel,
  getDefaultPermissionMode,
  isPermissionModeSupported,
  toCodexPermissionConfig,
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_PERMISSION_OPTIONS,
} from "../permissions";

describe("permission mode helpers", () => {
  // ── getPermissionModeOptions ──────────────────────────
  test("returns claude-specific permission options", () => {
    const opts = getPermissionModeOptions("claude");
    expect(opts).toBe(CLAUDE_PERMISSION_OPTIONS);
    expect(opts.map((o) => o.value)).toEqual([
      "bypassPermissions",
      "acceptEdits",
      "default",
      "plan",
    ]);
  });

  test("returns codex-specific permission options", () => {
    const opts = getPermissionModeOptions("codex");
    expect(opts).toBe(CODEX_PERMISSION_OPTIONS);
    expect(opts.map((o) => o.value)).toEqual([
      "bypassPermissions",
      "acceptEdits",
      "default",
    ]);
  });

  test("returns claude options for unknown agents", () => {
    expect(getPermissionModeOptions("unknown")).toBe(CLAUDE_PERMISSION_OPTIONS);
  });

  // ── isPermissionModeSupported ─────────────────────────
  test("validates permission mode support by agent", () => {
    expect(isPermissionModeSupported("claude", "bypassPermissions")).toBe(true);
    expect(isPermissionModeSupported("claude", "plan")).toBe(true);
    expect(isPermissionModeSupported("codex", "plan")).toBe(false);
    expect(isPermissionModeSupported("codex", "bypassPermissions")).toBe(true);
    expect(isPermissionModeSupported("codex", "acceptEdits")).toBe(true);
    expect(isPermissionModeSupported("codex", "default")).toBe(true);
  });

  test("treats null/undefined as supported (default)", () => {
    expect(isPermissionModeSupported("claude", null)).toBe(true);
    expect(isPermissionModeSupported("claude", undefined)).toBe(true);
    expect(isPermissionModeSupported("codex", null)).toBe(true);
  });

  test("rejects unknown modes", () => {
    expect(isPermissionModeSupported("claude", "nonsense")).toBe(false);
    expect(isPermissionModeSupported("codex", "nonsense")).toBe(false);
  });

  // ── getPermissionModeLabel ────────────────────────────
  test("returns correct label for known modes", () => {
    expect(getPermissionModeLabel("bypassPermissions", "claude")).toBe("Bypass (auto-approve all)");
    expect(getPermissionModeLabel("acceptEdits", "claude")).toBe("Accept Edits");
    expect(getPermissionModeLabel("plan", "claude")).toBe("Plan Mode");
    expect(getPermissionModeLabel("bypassPermissions", "codex")).toBe("Full Access");
  });

  test("returns the mode string for unknown modes", () => {
    expect(getPermissionModeLabel("nonsense", "claude")).toBe("nonsense");
  });

  test("returns null for null/undefined", () => {
    expect(getPermissionModeLabel(null)).toBe(null);
    expect(getPermissionModeLabel(undefined)).toBe(null);
  });

  // ── getDefaultPermissionMode ──────────────────────────
  test("defaults to bypassPermissions for isolated worktrees", () => {
    expect(getDefaultPermissionMode("claude", true)).toBe("bypassPermissions");
    expect(getDefaultPermissionMode("codex", true)).toBe("bypassPermissions");
  });

  test("defaults to acceptEdits for non-isolated claude", () => {
    expect(getDefaultPermissionMode("claude", false)).toBe("acceptEdits");
  });

  test("defaults to bypassPermissions for codex regardless of isolation", () => {
    expect(getDefaultPermissionMode("codex", false)).toBe("bypassPermissions");
  });

  // ── toCodexPermissionConfig ───────────────────────────
  test("maps bypassPermissions to full access", () => {
    const config = toCodexPermissionConfig("bypassPermissions");
    expect(config.approvalPolicy).toBe("never");
    expect(config.sandboxMode).toBe("danger-full-access");
  });

  test("maps acceptEdits to container sandbox", () => {
    const config = toCodexPermissionConfig("acceptEdits");
    expect(config.approvalPolicy).toBe("on-failure");
    expect(config.sandboxMode).toBe("container-only");
  });

  test("maps default/plan to allow-listed container sandbox", () => {
    const defaultConfig = toCodexPermissionConfig("default");
    expect(defaultConfig.approvalPolicy).toBe("unless-allow-listed");
    expect(defaultConfig.sandboxMode).toBe("container-only");

    const planConfig = toCodexPermissionConfig("plan");
    expect(planConfig.approvalPolicy).toBe("unless-allow-listed");
    expect(planConfig.sandboxMode).toBe("container-only");
  });

  test("maps null/undefined to default config", () => {
    const nullConfig = toCodexPermissionConfig(null);
    expect(nullConfig.approvalPolicy).toBe("unless-allow-listed");

    const undefinedConfig = toCodexPermissionConfig(undefined);
    expect(undefinedConfig.approvalPolicy).toBe("unless-allow-listed");
  });
});
