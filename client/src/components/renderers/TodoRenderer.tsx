import type { TodoItem, TodoStatus } from "shared";

interface ParsedTodos {
  items: TodoItem[];
  completed: number;
  total: number;
}

export function parseTodos(input: string | null): ParsedTodos | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    // Normalize: Claude SDK uses { todos: [...] }, Codex uses { items: [...] }.
    // Claude sometimes nests the array as a JSON string and may use `title`.
    const raw = normalizeTodoArray(parsed);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const items: TodoItem[] = raw.map((t: Record<string, unknown>) => {
      const content = String(t.content ?? t.text ?? t.title ?? "");
      const statusStr = String(t.status ?? "");
      const status: TodoStatus = (["pending", "in_progress", "completed"].includes(statusStr)
        ? statusStr
        : t.completed === true ? "completed" : "pending") as TodoStatus;
      const activeForm = String(t.activeForm ?? t.content ?? t.text ?? t.title ?? "");
      return { content, status, activeForm };
    });
    return {
      items,
      completed: items.filter((t) => t.status === "completed").length,
      total: items.length,
    };
  } catch {
    return null;
  }
}

function normalizeTodoArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;

  const candidate = (parsed as Record<string, unknown>).todos ?? (parsed as Record<string, unknown>).items;
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate !== "string") return null;

  try {
    const nested = JSON.parse(candidate);
    return Array.isArray(nested) ? nested : null;
  } catch {
    return null;
  }
}

interface Props {
  input: string | null;
}

export function TodoRenderer({ input }: Props) {
  const todos = parseTodos(input);
  if (!todos) return null;

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <span className="text-xs font-medium">Tasks</span>
        <span className="text-[11px] text-content-3">
          {todos.completed}/{todos.total} done
        </span>
      </div>
      <div className="renderer-body" role="list">
        {todos.items.map((item, i) => (
          <div
            key={i}
            role="listitem"
            className={`flex items-start gap-2 py-0.5 text-xs ${
              item.status === "completed"
                ? "text-content-3"
                : item.status === "in_progress"
                  ? "text-accent"
                  : "text-content-2"
            }`}
          >
            <span className="shrink-0 w-4 text-center" aria-label={item.status.replace("_", " ")}>
              {item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}
            </span>
            <span className={item.status === "completed" ? "line-through" : ""}>
              {item.status === "in_progress" ? item.activeForm : item.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
