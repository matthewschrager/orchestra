import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, ProjectWithStatus, StreamDelta, Thread } from "shared";
import { useWebSocket } from "./hooks/useWebSocket";
import { api } from "./hooks/useApi";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ChatView } from "./components/ChatView";
import { ContextPanel } from "./components/ContextPanel";
import { InputBar } from "./components/InputBar";
import { AuthGate } from "./components/AuthGate";

export function App() {
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);

  // Check if auth is required on mount
  useEffect(() => {
    fetch("/api/agents").then((res) => {
      if (res.status === 401) setNeedsAuth(true);
      else setNeedsAuth(false);
    }).catch(() => setNeedsAuth(false));
  }, []);

  if (needsAuth === null) {
    return <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-400">Loading...</div>;
  }
  if (needsAuth) {
    return <AuthGate onAuthenticated={() => setNeedsAuth(false)} />;
  }

  return <AppInner />;
}

function AppInner() {
  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [agents, setAgents] = useState<Array<{ name: string; detected: boolean; version: string | null }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<Map<string, string>>(new Map());
  const [streamingTool, setStreamingTool] = useState<Map<string, string>>(new Map());
  const [streamingToolInput, setStreamingToolInput] = useState<Map<string, string>>(new Map());
  const subscribedRef = useRef<string | null>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeMessages = (activeThreadId ? messages.get(activeThreadId) : null) ?? [];
  const activeStreamingText = activeThreadId ? streamingText.get(activeThreadId) : undefined;
  const activeStreamingTool = activeThreadId ? streamingTool.get(activeThreadId) : undefined;
  const activeStreamingToolInput = activeThreadId ? streamingToolInput.get(activeThreadId) : undefined;

  // ── WebSocket ───────────────────────────────────────

  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: Message) => {
      setMessages((prev) => {
        const existing = prev.get(msg.threadId) ?? [];
        if (existing.some((m) => m.seq === msg.seq)) return prev;
        const next = new Map(prev);
        next.set(msg.threadId, [...existing, msg]);
        return next;
      });
      // Clear streaming state when a persisted message arrives
      if (msg.role === "assistant") {
        setStreamingText((prev) => {
          if (!prev.has(msg.threadId)) return prev;
          const next = new Map(prev);
          next.delete(msg.threadId);
          return next;
        });
      }
      if (msg.role === "tool") {
        setStreamingTool((prev) => {
          if (!prev.has(msg.threadId)) return prev;
          const next = new Map(prev);
          next.delete(msg.threadId);
          return next;
        });
      }
    }, []),
    onThreadUpdate: useCallback((thread: Thread) => {
      setThreads((prev) =>
        prev.map((t) => (t.id === thread.id ? thread : t)),
      );
      // Clear streaming state when thread finishes
      if (thread.status === "done" || thread.status === "error") {
        setStreamingText((prev) => {
          if (!prev.has(thread.id)) return prev;
          const next = new Map(prev);
          next.delete(thread.id);
          return next;
        });
        setStreamingTool((prev) => {
          if (!prev.has(thread.id)) return prev;
          const next = new Map(prev);
          next.delete(thread.id);
          return next;
        });
      }
    }, []),
    onStreamDelta: useCallback((delta: StreamDelta) => {
      switch (delta.deltaType) {
        case "text":
          if (delta.text) {
            setStreamingText((prev) => {
              const next = new Map(prev);
              next.set(delta.threadId, (prev.get(delta.threadId) ?? "") + delta.text);
              return next;
            });
          }
          break;
        case "tool_start":
          if (delta.toolName) {
            setStreamingTool((prev) => {
              const next = new Map(prev);
              next.set(delta.threadId, delta.toolName!);
              return next;
            });
            setStreamingToolInput((prev) => {
              const next = new Map(prev);
              next.delete(delta.threadId);
              return next;
            });
          }
          break;
        case "tool_input":
          if (delta.toolInput) {
            setStreamingToolInput((prev) => {
              const next = new Map(prev);
              next.set(delta.threadId, (prev.get(delta.threadId) ?? "") + delta.toolInput);
              return next;
            });
          }
          break;
        case "tool_end":
          setStreamingTool((prev) => {
            if (!prev.has(delta.threadId)) return prev;
            const next = new Map(prev);
            next.delete(delta.threadId);
            return next;
          });
          setStreamingToolInput((prev) => {
            if (!prev.has(delta.threadId)) return prev;
            const next = new Map(prev);
            next.delete(delta.threadId);
            return next;
          });
          break;
        case "turn_end":
          setStreamingText((prev) => {
            if (!prev.has(delta.threadId)) return prev;
            const next = new Map(prev);
            next.delete(delta.threadId);
            return next;
          });
          setStreamingTool((prev) => {
            if (!prev.has(delta.threadId)) return prev;
            const next = new Map(prev);
            next.delete(delta.threadId);
            return next;
          });
          setStreamingToolInput((prev) => {
            if (!prev.has(delta.threadId)) return prev;
            const next = new Map(prev);
            next.delete(delta.threadId);
            return next;
          });
          break;
      }
    }, []),
  });

  // Subscribe to active thread
  useEffect(() => {
    if (!connected) return;
    if (subscribedRef.current) {
      send({ type: "unsubscribe", threadId: subscribedRef.current });
    }
    if (activeThreadId) {
      const lastSeq = Math.max(0, ...(messages.get(activeThreadId) ?? []).map((m) => m.seq));
      send({ type: "subscribe", threadId: activeThreadId, lastSeq });
      subscribedRef.current = activeThreadId;
    }
  }, [activeThreadId, connected, send]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data loading ──────────────────────────────────────

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error);
    api.listThreads().then(setThreads).catch(console.error);
    api.listAgents().then(setAgents).catch(console.error);
  }, []);

  // Load messages for active thread
  useEffect(() => {
    if (!activeThreadId) return;
    if (messages.has(activeThreadId)) return;
    api.getMessages(activeThreadId).then((msgs) => {
      setMessages((prev) => {
        const next = new Map(prev);
        next.set(activeThreadId, msgs);
        return next;
      });
    });
  }, [activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────

  const handleNewThread = async (agent: string, prompt: string, isolate: boolean, projectId?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) {
      setError("Select a project first");
      return;
    }
    try {
      setError(null);
      const thread = await api.createThread({ agent, prompt, projectId: pid, isolate });
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setActiveProjectId(pid);
      setSidebarOpen(false);
      // Refresh projects to update counts
      api.listProjects().then(setProjects).catch(console.error);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!activeThreadId) return;
    try {
      setError(null);
      send({ type: "send_message", threadId: activeThreadId, content });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStopThread = async () => {
    if (!activeThreadId) return;
    send({ type: "stop_thread", threadId: activeThreadId });
  };

  const handleAddProject = async (path: string) => {
    try {
      setError(null);
      await api.addProject({ path });
      const updated = await api.listProjects();
      setProjects(updated);
      setShowAddProject(false);
      // Auto-select the newly added project
      if (updated.length > 0) {
        setActiveProjectId(updated[0].id);
      }
    } catch (err) {
      throw err; // Let the dialog handle the error display
    }
  };

  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    // Also set the project to the thread's project
    const thread = threads.find((t) => t.id === threadId);
    if (thread?.projectId) {
      setActiveProjectId(thread.projectId);
    }
  };

  const handleArchiveThread = async (threadId: string) => {
    try {
      setError(null);
      await api.archiveThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
      }
      // Clean up cached messages
      setMessages((prev) => {
        if (!prev.has(threadId)) return prev;
        const next = new Map(prev);
        next.delete(threadId);
        return next;
      });
      // Refresh projects to update counts
      api.listProjects().then(setProjects).catch(console.error);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleNewThreadFromSidebar = (projectId: string) => {
    setActiveProjectId(projectId);
    setActiveThreadId(null); // Show empty state for this project
  };

  // ── Render ────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="md:hidden p-2 hover:bg-slate-800 rounded"
        >
          <MenuIcon />
        </button>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Orchestra</h1>
          {activeProject && (
            <span className="text-sm text-slate-500">
              / {activeProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          {activeThread?.worktree && (
            <button
              onClick={() => setContextOpen(!contextOpen)}
              className="p-2 hover:bg-slate-800 rounded text-sm"
            >
              Context
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="bg-red-900/50 text-red-200 px-4 py-2 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {!connected && (
        <div className="bg-amber-900/50 text-amber-200 px-4 py-1 text-sm text-center">
          Reconnecting...
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <ProjectSidebar
          projects={projects}
          threads={threads}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          onSelectProject={setActiveProjectId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThreadFromSidebar}
          onArchiveThread={handleArchiveThread}
          onAddProject={() => setShowAddProject(true)}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeThread ? (
            <>
              <ChatView
                messages={activeMessages}
                thread={activeThread}
                streamingText={activeStreamingText}
                streamingTool={activeStreamingTool}
                streamingToolInput={activeStreamingToolInput}
              />
              <InputBar
                agents={agents}
                thread={activeThread}
                activeProjectId={activeProjectId}
                onSend={handleSendMessage}
                onNewThread={handleNewThread}
                onStop={handleStopThread}
              />
            </>
          ) : activeProject ? (
            <ProjectEmptyState
              project={activeProject}
              agents={agents}
              onNewThread={handleNewThread}
            />
          ) : (
            <WelcomeState onAddProject={() => setShowAddProject(true)} />
          )}
        </div>

        {/* Context panel */}
        {contextOpen && activeThread && (
          <ContextPanel
            thread={activeThread}
            onClose={() => setContextOpen(false)}
          />
        )}
      </div>

      {/* Add Project Dialog */}
      {showAddProject && (
        <AddProjectDialog
          onAdd={handleAddProject}
          onClose={() => setShowAddProject(false)}
        />
      )}
    </div>
  );
}

// ── Project-aware empty state ──────────────────────────

function ProjectEmptyState({
  project,
  agents,
  onNewThread,
}: {
  project: ProjectWithStatus;
  agents: Array<{ name: string; detected: boolean }>;
  onNewThread: (agent: string, prompt: string, isolate: boolean, projectId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(false);
  const defaultAgent = agents.find((a) => a.detected)?.name ?? "claude";

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-4 text-sm text-slate-500">
          <span className="text-indigo-400 font-medium">{project.name}</span>
          <span>&middot;</span>
          <span>{project.currentBranch}</span>
          <span>&middot;</span>
          <span className="truncate max-w-[200px]">{project.path}</span>
        </div>
        <h2 className="text-2xl font-bold mb-2">New thread</h2>
        <p className="text-slate-400 text-sm">Start a thread in this project</p>
      </div>
      <div className="w-full max-w-xl">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What would you like to build?"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm resize-none h-32 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-slate-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
              onNewThread(defaultAgent, prompt.trim(), isolate, project.id);
              setPrompt("");
            }
          }}
        />
        <div className="flex items-center justify-between mt-3">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={isolate}
              onChange={(e) => setIsolate(e.target.checked)}
              className="rounded"
            />
            Isolate to worktree
          </label>
          <button
            onClick={() => {
              if (prompt.trim()) {
                onNewThread(defaultAgent, prompt.trim(), isolate, project.id);
                setPrompt("");
              }
            }}
            disabled={!prompt.trim()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Welcome state (no projects) ────────────────────────

function WelcomeState({ onAddProject }: { onAddProject: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-2">Welcome to Orchestra</h2>
        <p className="text-slate-400">
          Add a project to get started. Point Orchestra at any git repository on your machine.
        </p>
      </div>
      <button
        onClick={onAddProject}
        className="flex items-center gap-3 px-6 py-4 bg-slate-900 border border-slate-700 rounded-xl hover:border-indigo-500 hover:bg-slate-900/80 transition-colors max-w-md w-full text-left"
      >
        <span className="text-2xl text-slate-500">+</span>
        <div>
          <div className="text-sm font-medium">Add a project</div>
          <div className="text-xs text-slate-500">Browse to a git repository folder</div>
        </div>
      </button>
      <p className="text-xs text-slate-600">
        or run{" "}
        <code className="bg-slate-900 px-1.5 py-0.5 rounded text-slate-400">
          orchestra add ~/projects/my-repo
        </code>{" "}
        from the terminal
      </p>
    </div>
  );
}

// ── Add Project Dialog ──────────────────────────────────

function AddProjectDialog({
  onAdd,
  onClose,
}: {
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onAdd(path.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-4">Add Project</h3>
        <p className="text-sm text-slate-400 mb-4">
          Enter the absolute path to a git repository on your machine.
        </p>
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/home/user/projects/my-repo"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-2"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onClose();
          }}
          autoFocus
        />
        {error && (
          <p className="text-sm text-red-400 mb-3">{error}</p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!path.trim() || loading}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium"
          >
            {loading ? "Adding..." : "Add Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
