export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface EffortOption {
  value: EffortLevel;
  label: string;
}

const CODEX_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

const CLAUDE_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function getEffortOptions(agent: string): readonly EffortOption[] {
  switch (agent) {
    case "codex":
      return CODEX_EFFORT_OPTIONS;
    case "claude":
      return CLAUDE_EFFORT_OPTIONS;
    default:
      return [];
  }
}

export function isEffortLevelSupported(agent: string, effortLevel: string | null | undefined): effortLevel is EffortLevel {
  if (!effortLevel) return false;
  return getEffortOptions(agent).some((option) => option.value === effortLevel);
}

export function getEffortLabel(agent: string, effortLevel: EffortLevel | null | undefined): string | null {
  if (!effortLevel) return null;
  return getEffortOptions(agent).find((option) => option.value === effortLevel)?.label ?? null;
}
