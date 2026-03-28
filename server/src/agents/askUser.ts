import type { AttentionEvent } from "./types";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
}

export interface NormalizedAskUserInput {
  questions: AskUserQuestion[];
}

export interface AskUserExtraction {
  canonicalToolName: "AskUserQuestion";
  toolInput: NormalizedAskUserInput;
  serializedInput: string;
  attention: AttentionEvent;
}

export const ASK_USER_TOOL_NAME_ALIASES = [
  "AskUserQuestion",
  "AskUserTool",
  "request_user_input",
  "requestUserInput",
  "functions.request_user_input",
];

const ASK_USER_TOOL_NAMES = new Set(ASK_USER_TOOL_NAME_ALIASES);

export function isAskUserToolName(name: string | null | undefined): boolean {
  return !!name && ASK_USER_TOOL_NAMES.has(name);
}

export function extractAskUserRequest(
  toolName: string | null | undefined,
  input: unknown,
): AskUserExtraction | null {
  if (!isAskUserToolName(toolName)) return null;

  const normalized = normalizeAskUserInput(input);
  if (!normalized) return null;

  return {
    canonicalToolName: "AskUserQuestion",
    toolInput: normalized,
    serializedInput: JSON.stringify(normalized),
    attention: buildAskUserAttention(normalized),
  };
}

function buildAskUserAttention(toolInput: NormalizedAskUserInput): AttentionEvent {
  const firstQ = toolInput.questions[0];
  const options = firstQ.options?.map((option) => option.label).filter(Boolean);

  return {
    kind: "ask_user",
    prompt: firstQ.question,
    options: options && options.length > 0 ? options : undefined,
    metadata: { toolInput },
  };
}

function normalizeAskUserInput(input: unknown): NormalizedAskUserInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  const questions = Array.isArray(record.questions)
    ? record.questions.map(normalizeQuestion).filter((question): question is AskUserQuestion => question !== null)
    : [];

  if (questions.length > 0) {
    return { questions };
  }

  const single = normalizeQuestion(record);
  return single ? { questions: [single] } : null;
}

function normalizeQuestion(value: unknown): AskUserQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const question = firstString(
    record.question,
    record.prompt,
    record.text,
    record.description,
    record.title,
  );
  if (!question) return null;

  const header = firstString(record.header) || undefined;
  const options = normalizeOptions(record.options);
  const multiSelect = typeof record.multiSelect === "boolean" ? record.multiSelect : undefined;

  return {
    question,
    header,
    options: options.length > 0 ? options : undefined,
    multiSelect,
  };
}

function normalizeOptions(value: unknown): AskUserOption[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((option) => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ label }] : [];
    }

    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return [];
    }

    const record = option as Record<string, unknown>;
    const label = firstString(record.label, record.value, record.text);
    if (!label) return [];

    const description = firstString(record.description, record.details) || undefined;
    return [{ label, description }];
  });
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return "";
}
