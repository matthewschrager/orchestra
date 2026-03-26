import { useEffect, useRef, useState } from "react";
import type { ProjectWithStatus, Thread } from "shared";

interface Props {
  projects: ProjectWithStatus[];
  threads: Thread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  unreadThreadIds: Set<string>;
  onSelectProject: (id: string) => void;
  onSelectThread: (id: string) => void;
  onNewThread: (projectId: string) => void;
  onArchiveThread: (id: string, opts?: { cleanupWorktree?: boolean }) => void;
  onRemoveProject: (id: string) => void;
  onCleanupPushed: (projectId: string) => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  open: boolean;
  onClose: () => void;
}

const STATUS_DOT: Record<string, string> = {
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
  unreadThreadIds,
  onSelectProject,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onRemoveProject,
  onCleanupPushed,
  onAddProject,
  onOpenSettings,
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

  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenFor) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenFor(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpenFor]);

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
                  <div className="relative shrink-0" ref={menuOpenFor === project.id ? menuRef : undefined}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenFor(menuOpenFor === project.id ? null : project.id);
                      }}
                      className="opacity-0 group-hover/project:opacity-100 px-2 py-2.5 mr-1 text-content-3 hover:text-content-2 shrink-0"
                      title="Project actions"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="8" cy="13" r="1.5" />
                      </svg>
                    </button>
                    {menuOpenFor === project.id && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-edge-1 bg-surface-2 shadow-xl py-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenFor(null);
                            onCleanupPushed(project.id);
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-content-2 hover:bg-surface-3 flex items-center gap-2"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          Clean up pushed
                        </button>
                        <div className="border-t border-edge-1 my-1" />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenFor(null);
                            if (confirm(`Remove "${project.name}" from the project list? Threads will be archived.`)) {
                              onRemoveProject(project.id);
                            }
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-surface-3 flex items-center gap-2"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                          Remove project
                        </button>
                      </div>
                    )}
                  </div>
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
                              {thread.status === "running" ? (
                                <svg className="w-3 h-3 shrink-0 text-accent animate-spin" viewBox="0 0 16 16" fill="none">
                                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
                                </svg>
                              ) : STATUS_DOT[thread.status] ? (
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[thread.status]}`}
                                />
                              ) : null}
                              <span className={`text-sm truncate flex-1 ${isDone ? "text-content-2" : ""}`}>
                                {thread.title}
                              </span>
                              {unreadThreadIds.has(thread.id) && thread.id !== activeThreadId && (
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                              )}
                            </div>
                            {/* Line 2: metadata */}
                            <div className="flex items-center gap-1.5 mt-1 ml-3.5">
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
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (thread.worktree) {
                                const cleanup = confirm(
                                  `This thread has a worktree. Also delete the worktree and branch?\n\n` +
                                  `OK = archive thread + delete worktree\n` +
                                  `Cancel = archive thread only (worktree kept)`,
                                );
                                onArchiveThread(thread.id, { cleanupWorktree: cleanup });
                              } else {
                                onArchiveThread(thread.id);
                              }
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

        {/* Bottom actions */}
        <div className="border-t border-edge-1 flex items-center">
          <button
            onClick={onAddProject}
            className="flex-1 px-3 py-3 text-sm text-content-3 hover:text-content-2 hover:bg-surface-2 flex items-center gap-2"
          >
            + Add project
          </button>
          <button
            onClick={onOpenSettings}
            className="px-3 py-3 text-content-3 hover:text-content-2 hover:bg-surface-2 shrink-0"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </aside>
    </>
  );
}
