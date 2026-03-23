import type { Thread } from "shared";

interface Props {
  threads: Thread[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-emerald-400",
  pending: "bg-amber-400",
  paused: "bg-slate-400",
  done: "bg-blue-400",
  error: "bg-red-400",
};

export function ThreadSidebar({ threads, activeThreadId, onSelect, open, onClose }: Props) {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
          fixed md:static inset-y-0 left-0 z-50
          w-72 bg-slate-900 border-r border-slate-800
          flex flex-col transition-transform duration-200
          shrink-0
        `}
      >
        <div className="p-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Threads
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <p className="p-4 text-sm text-slate-500">No threads yet</p>
          )}
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => onSelect(thread.id)}
              className={`
                w-full text-left px-4 py-4 md:px-3 md:py-3 border-b border-slate-800/50
                hover:bg-slate-800/50 active:bg-slate-800 transition-colors
                ${thread.id === activeThreadId ? "bg-slate-800" : ""}
              `}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[thread.status] || "bg-slate-500"}`}
                />
                <span className="text-sm font-medium truncate">{thread.title}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <AgentBadge agent={thread.agent} />
                {thread.worktree && <WorktreeBadge />}
                {thread.prUrl && <PRBadge />}
              </div>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

function AgentBadge({ agent }: { agent: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
      {agent}
    </span>
  );
}

function WorktreeBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded bg-violet-900/50 text-violet-300">
      worktree
    </span>
  );
}

function PRBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
      PR
    </span>
  );
}
