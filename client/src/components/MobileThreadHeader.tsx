import { getEffortLabel, type Thread } from "shared";
import { EditableTitle } from "./EditableTitle";

interface MobileThreadHeaderProps {
  thread: Thread;
  onBack: () => void;
  onSaveTitle: (newTitle: string) => void;
}

function StatusDot({ status }: { status: Thread["status"] }) {
  if (status === "running") {
    return (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
      </span>
    );
  }
  if (status === "waiting") {
    return <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />;
  }
  if (status === "error") {
    return <span className="h-2 w-2 rounded-full bg-red-400 shrink-0" />;
  }
  return <span className="h-2 w-2 rounded-full bg-content-3 shrink-0" />;
}

export function MobileThreadHeader({ thread, onBack, onSaveTitle }: MobileThreadHeaderProps) {
  const effortLabel = getEffortLabel(thread.agent, thread.effortLevel);

  return (
    <div className="md:hidden flex items-center gap-2 px-2 py-2 bg-base/80 backdrop-blur-xl border-b border-edge-1 shrink-0 z-20">
      <button
        onClick={onBack}
        className="p-2 hover:bg-surface-3 rounded-lg shrink-0"
        aria-label="Back to sessions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <EditableTitle
          title={thread.title}
          onSave={onSaveTitle}
          className="text-sm font-medium min-w-0"
        />
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-content-3">
          <span className={thread.agent === "codex" ? "text-cyan-400" : "text-amber-400"}>{thread.agent}</span>
          {effortLabel && (
            <span className="font-mono text-content-2">effort {effortLabel.toLowerCase()}</span>
          )}
          {thread.branch && (
            <span className="inline-flex items-center gap-0.5 font-mono text-content-2 truncate max-w-[120px]">
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-50">
                <path d="M5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 0 10.5 8.5H12a2.25 2.25 0 1 1 0 1.5h-1.5A4 4 0 0 1 6.5 6V5.372a2.25 2.25 0 0 1-1.5-2.122ZM8 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm5.5 7a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
              </svg>
              <span className="truncate">{thread.baseBranch ?? thread.branch.replace(/^orchestra\//, "")}</span>
            </span>
          )}
        </div>
      </div>

      <StatusDot status={thread.status} />
    </div>
  );
}
