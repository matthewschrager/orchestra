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
  onAddProject: () => void;
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

export function ProjectSidebar({
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  onSelectProject,
  onSelectThread,
  onNewThread,
  onArchiveThread,
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
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onClose}
        />
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
        role="tree"
      >
        <div className="p-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Projects
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {projects.length === 0 && (
            <p className="p-4 text-sm text-slate-500">No projects yet</p>
          )}

          {projects.map((project) => {
            const isExpanded = expandedProjects.has(project.id);
            const isActive = project.id === activeProjectId;
            const projectThreads = threadsByProject(project.id);

            return (
              <div key={project.id} className="project-group" role="treeitem" aria-expanded={isExpanded}>
                {/* Project header */}
                <button
                  onClick={() => toggleExpand(project.id)}
                  className={`
                    w-full text-left flex items-center gap-1.5 px-3 py-2.5
                    border-l-2 transition-colors
                    ${isActive ? "bg-slate-800 border-l-indigo-500" : "border-l-transparent hover:bg-slate-800/50"}
                  `}
                >
                  <span className="text-[10px] text-slate-500 w-3.5 shrink-0">
                    {isExpanded ? "▼" : "▶"}
                  </span>
                  <span className="text-sm font-medium truncate flex-1">
                    {project.name}
                  </span>
                  <span className="text-[11px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                    {project.currentBranch}
                  </span>
                  {project.activeThreadCount > 0 && (
                    <span className="text-[10px] text-emerald-400 bg-emerald-900/30 px-1 py-0.5 rounded">
                      {project.activeThreadCount}
                    </span>
                  )}
                </button>

                {/* Thread list */}
                {isExpanded && (
                  <div>
                    {projectThreads.map((thread) => (
                      <div
                        key={thread.id}
                        className={`
                          group flex items-center
                          border-b border-slate-800/30 transition-colors
                          ${thread.id === activeThreadId ? "bg-slate-800" : "hover:bg-slate-800/50"}
                        `}
                      >
                        <button
                          onClick={() => {
                            onSelectThread(thread.id);
                            onClose();
                          }}
                          className="flex-1 text-left flex items-center gap-2 px-4 py-2.5 md:py-2 pl-9 min-w-0"
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[thread.status] || "bg-slate-500"}`}
                          />
                          <span className="text-sm truncate flex-1">
                            {thread.title}
                          </span>
                          <div className="flex gap-1">
                            <span className="text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400">
                              {thread.agent}
                            </span>
                            {thread.worktree && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-violet-900/50 text-violet-300">
                                wt
                              </span>
                            )}
                            {thread.prUrl && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/50 text-emerald-300">
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
                          className="opacity-0 group-hover:opacity-100 px-2 py-1 mr-1 text-slate-500 hover:text-red-400 transition-all shrink-0"
                          title="Archive thread"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    ))}

                    {/* New thread action */}
                    <button
                      onClick={() => {
                        onNewThread(project.id);
                        onClose();
                      }}
                      className="w-full text-left px-4 py-2 pl-9 text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800/30 transition-colors"
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
          className="px-3 py-3 text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800/30 border-t border-slate-800 flex items-center gap-2 transition-colors"
        >
          + Add project
        </button>
      </aside>
    </>
  );
}
