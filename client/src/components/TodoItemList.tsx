import type { TodoItem } from "shared";

interface TodoItemListProps {
  items: TodoItem[];
  compact?: boolean;
}

export function TodoItemList({ items, compact = false }: TodoItemListProps) {
  return (
    <div role="list">
      {items.map((item, index) => (
        <TodoRow key={`${item.content}-${item.status}-${index}`} item={item} compact={compact} />
      ))}
    </div>
  );
}

function TodoRow({ item, compact }: { item: TodoItem; compact: boolean }) {
  const isCompleted = item.status === "completed";
  const isInProgress = item.status === "in_progress";

  return (
    <div
      role="listitem"
      className={`flex items-start gap-2 ${compact ? "py-[3px]" : "py-0.5"} text-xs ${
        isCompleted ? "text-content-3" : isInProgress ? "text-accent" : "text-content-2"
      }`}
    >
      <TodoStatusIcon status={item.status} />
      <span className={isCompleted ? "line-through" : ""}>
        {isInProgress ? item.activeForm : item.content}
      </span>
    </div>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <span className="shrink-0 w-4 text-center text-emerald-400" aria-label="completed">
        ✓
      </span>
    );
  }

  if (status === "in_progress") {
    return (
      <span className="shrink-0 w-4 text-center" aria-label="in progress">
        ▸
      </span>
    );
  }

  return (
    <span className="shrink-0 w-4 text-center" aria-label="pending">
      ○
    </span>
  );
}
