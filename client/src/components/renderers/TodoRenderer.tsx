import type { TodoItem, TodoStatus } from "shared";
import { TodoItemList } from "../TodoItemList";

interface ParsedTodos {
  items: TodoItem[];
  completed: number;
  total: number;
}

export function parseTodos(input: string | null): ParsedTodos | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    // Normalize: Claude SDK uses { todos: [...] }, Codex uses { items: [...] }
    const raw = parsed.todos ?? parsed.items;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const items: TodoItem[] = raw.map((t: Record<string, unknown>) => {
      const content = String(t.content ?? t.text ?? "");
      const statusStr = String(t.status ?? "");
      const status: TodoStatus = (["pending", "in_progress", "completed"].includes(statusStr)
        ? statusStr
        : t.completed === true ? "completed" : "pending") as TodoStatus;
      const activeForm = String(t.activeForm ?? t.content ?? t.text ?? "");
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
      <div className="renderer-body">
        <TodoItemList items={todos.items} />
      </div>
    </div>
  );
}
