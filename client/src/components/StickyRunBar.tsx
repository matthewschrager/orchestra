import type { TodoItem, TurnMetrics } from "shared";

interface Props {
  isRunning: boolean;
  turnEnded: boolean;
  currentAction: string | null;
  currentTool: string | null;
  metrics: TurnMetrics;
  elapsedMs: number;
  onInterrupt: () => void;
  todos: TodoItem[] | null;
}

export function StickyRunBar({ isRunning, turnEnded, currentAction, currentTool, metrics, elapsedMs, onInterrupt, todos }: Props) {
  // Treat "process still running but turn ended" as idle — agent is just cleaning up
  const activelyWorking = isRunning && !turnEnded;
  if (!activelyWorking && metrics.turnCount === 0) return null;

  const formatCost = (usd: number) => {
    if (usd === 0) return "—";
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  };

  const formatDuration = (ms: number) => {
    if (ms === 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  };

  if (!activelyWorking) {
    // Idle state — session summary
    return (
      <div className="sticky-run-bar" role="status" aria-live="polite">
        <div className="flex items-center gap-3 text-content-3">
          <span className="text-[11px]">
            Session: {metrics.turnCount} turn{metrics.turnCount !== 1 ? "s" : ""}
            {" · "}{formatCost(metrics.costUsd)}
            {" · "}{formatDuration(metrics.durationMs)}
          </span>
        </div>
      </div>
    );
  }

  // Active state — full metrics strip
  return (
    <div className="sticky-run-bar sticky-run-bar-active" role="status" aria-live="polite">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Equalizer animation */}
        <span className="inline-flex items-end gap-[2px] h-3 shrink-0">
          <span className="w-[2px] h-full bg-accent rounded-full origin-bottom animate-eq" />
          <span className="w-[2px] h-full bg-accent rounded-full origin-bottom animate-eq" style={{ animationDelay: "150ms" }} />
          <span className="w-[2px] h-full bg-accent rounded-full origin-bottom animate-eq" style={{ animationDelay: "300ms" }} />
        </span>

        {/* Current action */}
        <span className="text-[11px] text-content-2 font-mono truncate">
          {currentTool
            ? formatToolAction(currentTool, currentAction)
            : "Thinking…"}
        </span>
        {todos && todos.length > 0 && (
          <span className="text-[10px] text-accent/70 shrink-0">
            {todos.filter((t) => t.status === "completed").length}/{todos.length} tasks
          </span>
        )}
      </div>

      {/* Metrics */}
      <div className="flex items-center gap-3 shrink-0 text-[11px] text-content-3">
        <span>{formatDuration(elapsedMs)}</span>
        <span className="hidden md:inline">{formatCost(metrics.costUsd)}</span>
        <button
          onClick={onInterrupt}
          className="px-2 py-0.5 text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded text-[11px] font-medium border border-red-900/20"
          aria-label="Stop agent"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

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
  TodoWrite: "Updating tasks",
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
