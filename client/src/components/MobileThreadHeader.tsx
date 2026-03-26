import type { Thread } from "shared";
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

      <EditableTitle
        title={thread.title}
        onSave={onSaveTitle}
        className="text-sm font-medium min-w-0 flex-1"
      />

      <StatusDot status={thread.status} />
    </div>
  );
}
