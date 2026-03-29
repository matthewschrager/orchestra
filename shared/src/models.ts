export interface ModelOption {
  value: string;
  label: string;
}

const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: "claude-sonnet-4-6", label: "Sonnet" },
  { value: "claude-opus-4-6", label: "Opus" },
  { value: "claude-haiku-3-5", label: "Haiku" },
];

const CODEX_MODEL_OPTIONS: readonly ModelOption[] = [
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "o3", label: "o3" },
  { value: "o4-mini", label: "o4 Mini" },
];

export function getModelOptions(agent: string): readonly ModelOption[] {
  switch (agent) {
    case "claude":
      return CLAUDE_MODEL_OPTIONS;
    case "codex":
      return CODEX_MODEL_OPTIONS;
    default:
      return [];
  }
}

export function isModelSupported(agent: string, model: string | null | undefined): boolean {
  if (!model) return false;
  return getModelOptions(agent).some((option) => option.value === model);
}

export function getModelLabel(agent: string, model: string | null | undefined): string | null {
  if (!model) return null;
  return getModelOptions(agent).find((option) => option.value === model)?.label ?? null;
}
