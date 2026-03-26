import type { ProjectWithStatus, Thread } from "shared";

interface MobileSessionsProps {
  projects: ProjectWithStatus[];
  threads: Thread[];
  activeThreadId: string | null;
  unreadThreadIds: Set<string>;
  onSelectThread: (threadId: string) => void;
  onNewThread: (projectId: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-amber-400",
  waiting: "bg-amber-400 animate-pulse",
  error: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]",
};

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  pending: "Pending",
  waiting: "Waiting",
  paused: "Paused",
  done: "Done",
  error: "Error",
};

export function MobileSessions({
  projects,
  threads,
  activeThreadId,
  unreadThreadIds,
  onSelectThread,
  onNewThread,
}: MobileSessionsProps) {
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="text-4xl mb-3 opacity-50">&#9776;</div>
        <div className="text-content-2 font-medium">No projects yet</div>
        <div className="text-content-3 text-sm mt-1">
          Add a project from the sidebar to get started.
        </div>
      </div>
    );
  }

  // Group threads: waiting/running first, then done/error
  const threadsByProject = (projectId: string) => {
    const projectThreads = threads.filter((t) => t.projectId === projectId);
    const active = projectThreads.filter((t) => ["running", "waiting", "pending"].includes(t.status));
    const rest = projectThreads.filter((t) => !["running", "waiting", "pending"].includes(t.status));
    return [...active, ...rest];
  };

  return (
    <div className="overflow-y-auto">
      {projects.map((project) => {
        const projectThreads = threadsByProject(project.id);
        return (
          <div key={project.id}>
            {/* Project header */}
            <div className="sticky top-0 bg-base/90 backdrop-blur-sm border-b border-edge-1 px-4 py-2.5 z-10">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-content-1 truncate">{project.name}</div>
                  <div className="text-[10px] text-content-3 font-mono">{project.currentBranch}</div>
                </div>
                <button
                  onClick={() => onNewThread(project.id)}
                  className="px-3 py-1.5 text-xs text-accent hover:bg-accent/10 rounded-lg font-medium shrink-0"
                >
                  + New
                </button>
              </div>
            </div>

            {/* Thread list */}
            {projectThreads.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <div className="text-sm text-content-3">No threads yet</div>
                <button
                  onClick={() => onNewThread(project.id)}
                  className="mt-2 text-sm text-accent hover:underline"
                >
                  Start a session
                </button>
              </div>
            ) : (
              projectThreads.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => onSelectThread(thread.id)}
                  className={`w-full text-left px-4 py-3 border-b border-edge-1/30 flex items-start gap-3 min-h-[56px] ${
                    thread.id === activeThreadId
                      ? "bg-surface-3"
                      : "hover:bg-surface-2 active:bg-surface-3"
                  }`}
                >
                  {/* Status indicator */}
                  {thread.status === "running" ? (
                    <svg className="w-3.5 h-3.5 mt-1 shrink-0 text-accent animate-spin" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
                    </svg>
                  ) : STATUS_DOT[thread.status] ? (
                    <span
                      className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${STATUS_DOT[thread.status]}`}
                    />
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm text-content-1 truncate">{thread.title}</span>
                      {unreadThreadIds.has(thread.id) && thread.id !== activeThreadId && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-content-3">
                        {STATUS_LABEL[thread.status] || thread.status}
                      </span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-surface-4 text-content-3 font-mono">
                        {thread.agent}
                      </span>
                      {thread.worktree && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-violet-900/40 text-violet-300 max-w-[120px] font-mono"
                          title={thread.branch || thread.worktree}
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
                            <path d="M5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 0 10.5 8.5H12a2.25 2.25 0 1 1 0 1.5h-1.5A4 4 0 0 1 6.5 6V5.372a2.25 2.25 0 0 1-1.5-2.122ZM8 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm5.5 7a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
                          </svg>
                          <span className="truncate">
                            {thread.branch?.replace(/^orchestra\//, "") || "wt"}
                          </span>
                        </span>
                      )}
                      {thread.prUrl && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                          PR
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Chevron */}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-1.5 text-content-3/40">
                    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}
