export interface ParsedQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

const ASK_USER_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "AskUserTool",
  "request_user_input",
  "requestUserInput",
  "functions.request_user_input",
]);

export function isAskUserTool(name: string | null | undefined): boolean {
  return !!name && ASK_USER_TOOL_NAMES.has(name);
}

export function parseQuestions(input: string | null): ParsedQuestion[] {
  if (!input) return [];

  const parsed = parseJsonRecursively(input, 2);
  const normalized = collectQuestions(parsed);
  if (normalized.length > 0) return normalized;

  const fragmentQuestion = extractQuestionFromFragment(input);
  return fragmentQuestion ? [{ question: fragmentQuestion }] : [];
}

export function formatAnswers(
  questions: ParsedQuestion[],
  selections: Map<number, string[]>,
  customInputs: Map<number, string>,
): string {
  const parts: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections.get(i) ?? [];
    const custom = customInputs.get(i)?.trim() ?? "";
    const answer = selected.length > 0 ? selected.join(", ") : custom;
    if (!answer) continue;
    if (questions.length === 1) return answer;
    const prefix = q.header || `Q${i + 1}`;
    parts.push(`${prefix}: ${answer}`);
  }

  return parts.join("\n");
}

export function extractQuestionPreview(input: string | null): string {
  const questions = parseQuestions(input);
  if (questions.length === 0) return "";
  return questions[0].question;
}

function parseJsonRecursively(value: unknown, depth: number): unknown {
  if (depth <= 0 || typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return parseJsonRecursively(JSON.parse(trimmed), depth - 1);
  } catch {
    return value;
  }
}

function collectQuestions(value: unknown): ParsedQuestion[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map(normalizeQuestion)
      .filter((question): question is ParsedQuestion => question !== null);
  }

  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.questions)) {
    return record.questions
      .map(normalizeQuestion)
      .filter((question): question is ParsedQuestion => question !== null);
  }

  if ("toolInput" in record) {
    const nested = collectQuestions(record.toolInput);
    if (nested.length > 0) return nested;
  }

  if ("input" in record) {
    const nested = collectQuestions(record.input);
    if (nested.length > 0) return nested;
  }

  const single = normalizeQuestion(record);
  return single ? [single] : [];
}

function normalizeQuestion(value: unknown): ParsedQuestion | null {
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

  const header = firstString(record.header);
  const options = normalizeOptions(record.options);
  const multiSelect = typeof record.multiSelect === "boolean" ? record.multiSelect : undefined;

  return {
    question,
    header: header || undefined,
    options: options.length > 0 ? options : undefined,
    multiSelect,
  };
}

function normalizeOptions(value: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((option) => {
    if (typeof option === "string") {
      return option.trim() ? [{ label: option.trim() }] : [];
    }

    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return [];
    }

    const record = option as Record<string, unknown>;
    const label = firstString(record.label, record.value, record.text);
    if (!label) return [];

    const description = firstString(record.description, record.details);
    return [{ label, description: description || undefined }];
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

function extractQuestionFromFragment(input: string): string {
  for (const field of ["question", "prompt", "text", "description"]) {
    const value = extractStringField(input, field);
    if (value) return value;
  }

  return "";
}

function extractStringField(input: string, field: string): string {
  const match = input.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"));
  if (!match) return "";

  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .trim();
}
