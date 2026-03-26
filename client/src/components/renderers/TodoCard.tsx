import { useMemo, useState } from "react";
import type { TodoItem } from "shared";
import { parseTodos } from "./TodoRenderer";

interface Props {
  input: string | null;
  isLatest: boolean;
}

export function TodoCard({ input, isLatest }: Props) {
  const todos = useMemo(() => parseTodos(input), [input]);
  const [expanded, setExpanded] = useState(false);

  if (!todos) return null;

  const { items, completed, total } = todos;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total;

  // Collapsed mode for prior (non-latest) TodoWrites — click to expand snapshot
  if (!isLatest) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs py-0.5 text-content-3 hover:text-content-2 cursor-pointer"
        >
          <span className="text-emerald-400">✓</span>
          <span>
            Updated tasks ({completed}/{total})
          </span>
          <span className={`text-[10px] text-content-3 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}>
            &#9656;
          </span>
        </button>
        {expanded && (
          <div className="todo-card todo-card-collapsed ml-5 mt-0.5 mb-1">
            <TodoItemList items={items} />
          </div>
        )}
      </div>
    );
  }

  // Prominent card for the latest TodoWrite
  return (
    <div className={`todo-card ${allDone ? "todo-card-done" : "todo-card-latest"}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-content-2">
          <svg className="w-3.5 h-3.5 text-accent/70" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2h4v4H2zm0 6h4v4H2zm6-6h4v2H8zm0 4h4v2H8zm0 4h4v2H8z" />
          </svg>
          <span>Tasks</span>
        </div>
        <span className={`text-[11px] ${allDone ? "text-emerald-400" : "text-content-3"}`}>
          {completed}/{total} done
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-[3px] rounded-full bg-surface-2 overflow-hidden mb-2.5"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemax={total}
        aria-label={`${completed} of ${total} tasks completed`}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${allDone ? "bg-emerald-400" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Task list */}
      <TodoItemList items={items} />
    </div>
  );
}

// ── Shared item list ─────────────────────────────────────

function TodoItemList({ items }: { items: TodoItem[] }) {
  return (
    <div role="list">
      {items.map((item, i) => (
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
          <span
            className={`shrink-0 w-4 text-center ${
              item.status === "completed" ? "text-emerald-400" : ""
            }`}
            aria-label={item.status.replace("_", " ")}
          >
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}
          </span>
          <span className={item.status === "completed" ? "line-through" : ""}>
            {item.status === "in_progress" ? item.activeForm : item.content}
          </span>
        </div>
      ))}
    </div>
  );
}
