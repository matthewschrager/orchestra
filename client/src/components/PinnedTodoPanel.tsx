import { useState } from "react";
import type { TodoItem } from "shared";

interface Props {
  todos: TodoItem[] | null;
  isRunning: boolean;
  turnEnded: boolean;
}

/**
 * Pinned TODO panel that sits above the InputBar, always visible while
 * the agent is working with an active task list — similar to Claude CLI.
 */
export function PinnedTodoPanel({ todos, isRunning, turnEnded }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const activelyWorking = isRunning && !turnEnded;
  const hasTodos = todos !== null && todos.length > 0;

  // Only show while actively working and todos exist
  if (!activelyWorking || !hasTodos) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const allDone = completed === total;

  return (
    <div className="pinned-todo-panel shrink-0">
      {/* Header — always visible, click to collapse/expand */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-content-2">
          <svg className="w-3.5 h-3.5 text-accent/70" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2h4v4H2zm0 6h4v4H2zm6-6h4v2H8zm0 4h4v2H8zm0 4h4v2H8z" />
          </svg>
          <span>Tasks</span>
          <span className={`text-[11px] font-normal ${allDone ? "text-emerald-400" : "text-content-3"}`}>
            {completed}/{total}
          </span>
          {/* Progress bar inline in header */}
          <div className="w-16 h-1 rounded-full bg-surface-2 overflow-hidden ml-1">
            <div
              className={`h-full rounded-full transition-all duration-300 ${allDone ? "bg-emerald-400" : "bg-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <span
          className={`text-[10px] text-content-3 transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`}
        >
          &#9656;
        </span>
      </button>

      {/* Task list — collapsible */}
      {!collapsed && (
        <div className="px-3 pb-2" role="list">
          {todos.map((item, i) => (
            <div
              key={i}
              role="listitem"
              className={`flex items-start gap-2 py-[3px] text-xs ${
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
              >
                {item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}
              </span>
              <span className={item.status === "completed" ? "line-through" : ""}>
                {item.status === "in_progress" ? item.activeForm : item.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
