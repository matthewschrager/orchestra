// ── Permission Mode ────────────────────────────────────

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface PermissionOption {
  value: PermissionMode;
  label: string;
  description: string;
}

/** Claude-supported permission modes (full set). */
export const CLAUDE_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "bypassPermissions", label: "Bypass (auto-approve all)", description: "Skip all permission prompts — fastest, recommended for isolated worktrees" },
  { value: "acceptEdits", label: "Accept Edits", description: "Auto-approve file edits, prompt for shell commands" },
  { value: "default", label: "Default", description: "Prompt for dangerous operations (SDK default)" },
  { value: "plan", label: "Plan Mode", description: "Agent plans first, then asks for approval before executing" },
];

/** Codex-supported permission modes (subset). */
export const CODEX_PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "bypassPermissions", label: "Full Access", description: "No sandbox, auto-approve everything" },
  { value: "acceptEdits", label: "Suggest (network disabled)", description: "Suggest changes, network disabled in sandbox" },
  { value: "default", label: "Auto Edit (network disabled)", description: "Auto-apply file changes, network disabled in sandbox" },
];

/** Get the list of permission options available for a given agent. */
export function getPermissionModeOptions(agent: string): PermissionOption[] {
  if (agent === "codex") return CODEX_PERMISSION_OPTIONS;
  return CLAUDE_PERMISSION_OPTIONS;
}

/** Check whether a given permission mode is supported by the agent. */
export function isPermissionModeSupported(agent: string, mode: string | null | undefined): boolean {
  if (!mode) return true; // null/undefined = use default
  const options = getPermissionModeOptions(agent);
  return options.some((o) => o.value === mode);
}

/** Get human-readable label for a permission mode, optionally scoped to an agent. */
export function getPermissionModeLabel(mode: string | null | undefined, agent?: string): string | null {
  if (!mode) return null;
  const options = agent ? getPermissionModeOptions(agent) : CLAUDE_PERMISSION_OPTIONS;
  return options.find((o) => o.value === mode)?.label ?? mode;
}

/** Get the default permission mode for an agent.
 *  Claude worktree-isolated defaults to bypassPermissions; Codex defaults to bypassPermissions. */
export function getDefaultPermissionMode(agent: string, isolated: boolean): PermissionMode {
  if (agent === "codex") return "bypassPermissions";
  return isolated ? "bypassPermissions" : "acceptEdits";
}

/** Map Orchestra PermissionMode to Codex SDK approvalPolicy + sandboxMode. */
export function toCodexPermissionConfig(mode?: PermissionMode | string | null): {
  approvalPolicy: "never" | "unless-allow-listed" | "on-failure";
  sandboxMode: "danger-full-access" | "container-only";
} {
  switch (mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
    case "acceptEdits":
      return { approvalPolicy: "on-failure", sandboxMode: "container-only" };
    case "default":
    case "plan":
    default:
      return { approvalPolicy: "unless-allow-listed", sandboxMode: "container-only" };
  }
}
