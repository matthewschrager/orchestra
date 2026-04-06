import { useState } from "react";
import type { QueuedItem, TodoItem, TurnMetrics } from "shared";

interface Props {
  isRunning: boolean;
  turnEnded: boolean;
  currentAction: string | null;
  currentTool: string | null;
  metrics: TurnMetrics;
  elapsedMs: number;
  onInterrupt: () => void;
  onScrollToBottom?: () => void;
  todos: TodoItem[] | null;
  /** Number of user messages queued during current agent turn */
  queuedCount?: number;
  /** Full queue items for drawer display */
  queueItems?: QueuedItem[] | null;
  /** Cancel a specific queued message */
  onCancelQueued?: (queueId: string) => void;
  /** Cancel all pending queued messages */
  onClearQueue?: () => void;
}

export function StickyRunBar({ isRunning, turnEnded, currentAction, currentTool, metrics, elapsedMs, onInterrupt, onScrollToBottom, todos, queuedCount = 0, queueItems, onCancelQueued, onClearQueue }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Treat "process still running but turn ended" as idle — agent is just cleaning up
  const activelyWorking = isRunning && !turnEnded;
  if (!activelyWorking && metrics.turnCount === 0) return null;

  const formatDuration = (ms: number) => {
    if (ms === 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  };

  const modelLabel = metrics.modelName ? formatModelName(metrics.modelName) : null;

  const items = queueItems ?? [];
  const hasPending = items.some((i) => i.state === "pending");
  const displayCount = getPendingQueueDisplayCount(items, queuedCount);

  // Auto-close drawer when queue empties
  if (drawerOpen && displayCount === 0) {
    setDrawerOpen(false);
  }

  if (!activelyWorking) {
    // Idle state — session summary (tap to scroll to bottom)
    return (
      <div
        className="sticky-run-bar cursor-pointer hover:bg-surface-2 transition-colors"
        role="status"
        aria-live="polite"
        onClick={onScrollToBottom}
        title="Jump to bottom"
      >
        <div className="flex items-center gap-3 text-content-3">
          {modelLabel && (
            <span className="text-[10px] text-content-3/70 font-medium" title={metrics.modelName ?? undefined}>
              {modelLabel}
            </span>
          )}
          <span className="text-[11px]">
            Session: {metrics.turnCount} turn{metrics.turnCount !== 1 ? "s" : ""}
            {" · "}{formatDuration(metrics.durationMs)}
          </span>
          <ContextWindowIndicator metrics={metrics} />
        </div>
      </div>
    );
  }

  // Compute active task label for todos
  const todoLabel = todos && todos.length > 0
    ? (() => {
        const active = todos.find((t) => t.status === "in_progress");
        const completed = todos.filter((t) => t.status === "completed").length;
        return active
          ? `▸ ${active.activeForm} (${completed}/${todos.length})`
          : `${completed}/${todos.length} tasks`;
      })()
    : null;

  // Active state — full metrics strip (tap bar body to scroll to bottom)
  return (
    <div role="status" aria-live="polite">
      <div className="sticky-run-bar sticky-run-bar-active">
        <div
          className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
          onClick={onScrollToBottom}
          title="Jump to bottom"
        >
          {/* Spinner */}
          <svg className="w-3 h-3 shrink-0 text-accent animate-spin" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
          </svg>

          {modelLabel && (
            <span className="text-[10px] text-accent/70 font-medium shrink-0" title={metrics.modelName ?? undefined}>
              {modelLabel}
            </span>
          )}

          {/* Current action */}
          <span className="text-[11px] text-content-2 font-mono truncate">
            {currentTool
              ? formatToolAction(currentTool, currentAction)
              : "Thinking…"}
          </span>
          {todoLabel && (
            <span
              className="text-[10px] text-accent/70 shrink-0 truncate max-w-[200px]"
              title={todoLabel}
            >
              {todoLabel}
            </span>
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 shrink-0 text-[11px] text-content-3">
          <ContextWindowIndicator metrics={metrics} />
          <span>{formatDuration(elapsedMs)}</span>
          {displayCount > 0 && (
            <button
              onClick={() => items.length > 0 ? setDrawerOpen(!drawerOpen) : undefined}
              className={`font-medium transition-colors ${items.length > 0 ? "cursor-pointer hover:text-accent" : ""} ${drawerOpen ? "text-accent" : "text-accent/80"}`}
              title={items.length > 0 ? (drawerOpen ? "Collapse queue" : "Expand queue") : `${displayCount} message${displayCount !== 1 ? "s" : ""} queued`}
            >
              {items.length > 0 && <span className="mr-0.5">{drawerOpen ? "▾" : "▸"}</span>}
              {displayCount} queued
            </button>
          )}
          <button
            onClick={onInterrupt}
            className="px-2 py-0.5 text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded text-[11px] font-medium border border-red-900/20"
            aria-label="Stop agent"
          >
            Stop
          </button>
        </div>
      </div>

      {/* Queue Drawer */}
      <div
        className="overflow-hidden transition-all duration-200 ease-out"
        style={{ maxHeight: drawerOpen ? `${items.length * 40 + 36}px` : "0px" }}
      >
        <div className="bg-surface-2 border-t border-edge px-4 py-2 space-y-1.5">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 bg-surface-3 rounded-md px-3 py-1.5 text-[12px]">
              <span className="flex-1 text-content-2 truncate" title={item.content}>
                "{item.content}"
              </span>
              {item.state === "pending" ? (
                <>
                  <span className="text-[10px] text-accent/60 font-mono shrink-0">queued</span>
                  <button
                    onClick={() => onCancelQueued?.(item.id)}
                    className="w-5 h-5 flex items-center justify-center rounded text-content-3 hover:text-red-400 hover:bg-red-950/30 transition-colors shrink-0"
                    title="Cancel"
                    aria-label={`Cancel queued message: ${item.content.slice(0, 40)}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </>
              ) : (
                <span className="text-[10px] text-content-3 font-mono shrink-0">sent to agent</span>
              )}
            </div>
          ))}
          {hasPending && (
            <div className="flex justify-end pt-0.5">
              <button
                onClick={onClearQueue}
                className="text-[10px] text-content-3 hover:text-red-400 border border-edge hover:border-red-900/30 rounded px-2 py-0.5 transition-colors"
              >
                Clear pending
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function getPendingQueueDisplayCount(queueItems: QueuedItem[] | null | undefined, queuedCount = 0): number {
  const pendingCount = (queueItems ?? []).filter((item) => item.state === "pending").length;
  return pendingCount > 0 ? pendingCount : queuedCount;
}

// ── Model Name Formatting ──────────────────────────────

/** Convert raw SDK model ID to a shorter display label.
 *  Strips the date suffix and vendor prefix — no hard-coded model list.
 *  e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"
 *       "gpt-4o-2024-11-20"        → "gpt-4o"
 */
function formatModelName(raw: string): string {
  // Strip trailing date suffix: -YYYYMMDD or -YYYY-MM-DD
  return raw.replace(/-\d{4}-?\d{2}-?\d{2}$/, "");
}

// ── Context Window Indicator ──────────────────────────────

function ContextWindowIndicator({ metrics }: { metrics: TurnMetrics }) {
  const summary = getTokenUsageSummary(metrics);
  if (!summary) return null;

  const { totalTokens, contextWindow, pct } = summary;

  if (!contextWindow || contextWindow <= 0) {
    return (
      <span
        className="text-[10px] tabular-nums text-content-3"
        title={`${formatTokenCount(totalTokens)} tokens this turn`}
      >
        {formatTokenCount(totalTokens)}
      </span>
    );
  }

  // Color thresholds: green → yellow → orange → red
  const barColor =
    pct >= 90 ? "bg-red-500" :
    pct >= 75 ? "bg-orange-400" :
    pct >= 50 ? "bg-yellow-400" :
    "bg-accent";

  const textColor =
    pct >= 90 ? "text-red-400" :
    pct >= 75 ? "text-orange-400" :
    "text-content-3";

  return (
    <div className="flex items-center gap-1.5" title={`${formatTokenCount(totalTokens)} / ${formatTokenCount(contextWindow)} tokens (${Math.round(pct)}%)`}>
      {/* Mini progress bar */}
      <div className="w-12 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[10px] tabular-nums ${textColor}`}>
        {formatTokenCount(totalTokens)}
      </span>
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function getTokenUsageSummary(metrics: TurnMetrics): { totalTokens: number; contextWindow: number; pct: number } | null {
  const totalTokens = metrics.inputTokens + metrics.outputTokens;
  if (totalTokens <= 0) return null;

  const contextWindow = metrics.contextWindow;
  const pct = contextWindow > 0
    ? Math.min((totalTokens / contextWindow) * 100, 100)
    : 0;

  return { totalTokens, contextWindow, pct };
}

// ── Tool Action Formatting ──────────────────────────────

const TOOL_ACTION_MAP: Record<string, string> = {
  Read: "Reading",
  Edit: "Editing",
  Write: "Writing",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Finding files",
  Agent: "Sub-agent",
  WebSearch: "Searching web",
  WebFetch: "Fetching",
  AskUserQuestion: "Asking…",
  AskUserTool: "Asking…",
};

function formatToolAction(tool: string, context: string | null): string {
  const verb = TOOL_ACTION_MAP[tool] ?? tool;
  if (!context) return verb;
  // Shorten file paths in context
  if (context.includes("/")) {
    const parts = context.split("/").filter(Boolean);
    if (parts.length > 3) {
      return `${verb} …/${parts.slice(-2).join("/")}`;
    }
  }
  return `${verb} ${context.length > 60 ? context.slice(0, 60) + "…" : context}`;
}

// Export for testing
export { formatModelName, formatTokenCount, getTokenUsageSummary };
