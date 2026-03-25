import { useState } from "react";
import type { ProjectWithStatus, Thread } from "shared";

interface Props {
  projects: ProjectWithStatus[];
  threads: Thread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  onSelectProject: (id: string) => void;
  onSelectThread: (id: string) => void;
  onNewThread: (projectId: string) => void;
  onArchiveThread: (id: string) => void;
  onRemoveProject: (id: string) => void;
  onAddProject: () => void;
  open: boolean;
  onClose: () => void;
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)] animate-pulse",
  pending: "bg-amber-400",
  waiting: "bg-amber-400 animate-pulse",
  paused: "bg-content-3",
  done: "bg-accent/60",
  error: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]",
};

const STATUS_BORDER: Record<string, string> = {
  running: "border-l-emerald-400/50",
  error: "border-l-red-400/40",
  done: "border-l-transparent",
  pending: "border-l-amber-400/30",
  paused: "border-l-transparent",
};

export function ProjectSidebar({
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  onSelectProject,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onRemoveProject,
  onAddProject,
  open,
  onClose,
}: Props) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(projects.length <= 3 ? projects.map((p) => p.id) : []),
  );

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
    onSelectProject(projectId);
  };

  const threadsByProject = (projectId: string) =>
    threads.filter((t) => t.projectId === projectId);

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
          fixed md:static inset-y-0 left-0 z-50
          w-80 bg-surface-1 border-r border-edge-1
          flex flex-col transition-transform duration-200
          shrink-0
        `}
        role="tree"
      >
        <div className="p-3 border-b border-edge-1">
          <h2 className="text-xs font-semibold text-content-3 uppercase tracking-widest">
            Projects
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {projects.length === 0 && (
            <p className="p-4 text-sm text-content-3">No projects yet</p>
          )}

          {projects.map((project) => {
            const isExpanded = expandedProjects.has(project.id);
            const isActive = project.id === activeProjectId;
            const projectThreads = threadsByProject(project.id);

            return (
              <div key={project.id} className="project-group group/project" role="treeitem" aria-expanded={isExpanded}>
                {/* Project header */}
                <div className={`
                  flex items-center border-l-2
                  ${isActive ? "bg-surface-3 border-l-accent" : "border-l-transparent hover:bg-surface-2"}
                `}>
                  <button
                    onClick={() => toggleExpand(project.id)}
                    className="flex-1 text-left flex items-center gap-1.5 px-3 py-2.5 min-w-0"
                  >
                    <span className={`text-[10px] text-content-3 w-3.5 shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}>
                      &#9656;
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">
                        {project.name}
                      </span>
                      <span className="text-[10px] text-content-3 font-mono truncate block">
                        {project.currentBranch}
                      </span>
                    </div>
                    {project.activeThreadCount > 0 && (
                      <span className="text-[10px] text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded font-medium shrink-0">
                        {project.activeThreadCount}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Remove "${project.name}" from the project list? Threads will be archived.`)) {
                        onRemoveProject(project.id);
                      }
                    }}
                    className="opacity-0 group-hover/project:opacity-100 px-2 py-2.5 mr-1 text-content-3 hover:text-red-400 shrink-0"
                    title="Remove project"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>

                {/* Thread list */}
                {isExpanded && (
                  <div>
                    {projectThreads.map((thread) => {
                      const isDone = thread.status === "done";
                      const isError = thread.status === "error";
                      return (
                        <div
                          key={thread.id}
                          className={`
                            group flex items-start
                            border-b border-edge-1/30 border-l-2
                            ${thread.id === activeThreadId ? "bg-surface-3" : isError ? "bg-red-950/10 hover:bg-surface-2" : "hover:bg-surface-2"}
                            ${STATUS_BORDER[thread.status] || "border-l-transparent"}
                          `}
                        >
                          <button
                            onClick={() => {
                              onSelectThread(thread.id);
                              onClose();
                            }}
                            className="flex-1 text-left px-4 py-2.5 md:py-2 pl-8 min-w-0"
                          >
                            {/* Line 1: title */}
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[thread.status] || "bg-content-3"}`}
                              />
                              <span className={`text-sm truncate flex-1 ${isDone ? "text-content-2" : ""}`}>
                                {thread.title}
                              </span>
                            </div>
                            {/* Line 2: metadata */}
                            <div className="flex items-center gap-1.5 mt-1 ml-3.5">
                              <span className="text-[10px] px-1 py-0.5 rounded bg-surface-4 text-content-3 font-mono">
                                {thread.agent}
                              </span>
                              {thread.worktree && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-violet-900/40 text-violet-300">
                                  wt
                                </span>
                              )}
                              {thread.prUrl && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                                  PR
                                </span>
                              )}
                            </div>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onArchiveThread(thread.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 px-2 py-2.5 mr-1 text-content-3 hover:text-red-400 shrink-0"
                            title="Archive thread"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}

                    {/* New thread action */}
                    <button
                      onClick={() => {
                        onNewThread(project.id);
                        onClose();
                      }}
                      className="w-full text-left px-4 py-2 pl-8 text-sm text-content-3 hover:text-content-2 hover:bg-surface-2"
                    >
                      + New thread
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add project button */}
        <button
          onClick={onAddProject}
          className="px-3 py-3 text-sm text-content-3 hover:text-content-2 hover:bg-surface-2 border-t border-edge-1 flex items-center gap-2"
        >
          + Add project
        </button>
      </aside>
    </>
  );
}
