import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AttentionResolution, Message, ProjectWithStatus, SlashCommand, StreamDelta, Thread, TurnMetrics, WSServerMessage } from "shared";
import { useWebSocket } from "./hooks/useWebSocket";
import { api } from "./hooks/useApi";
import { useAttention } from "./hooks/useAttention";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ChatView } from "./components/ChatView";
import { ContextPanel } from "./components/ContextPanel";
import { InputBar } from "./components/InputBar";
import { SlashCommandInput } from "./components/SlashCommandInput";
import { AuthGate } from "./components/AuthGate";
import { StickyRunBar } from "./components/StickyRunBar";
import { MobileNav } from "./components/MobileNav";
import { AttentionInbox } from "./components/AttentionInbox";
import { MobileSessions } from "./components/MobileSessions";
import { MobileNewSession } from "./components/MobileNewSession";
import { usePushNotifications } from "./hooks/usePushNotifications";

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
    return <div className="h-screen flex items-center justify-center bg-base text-content-2">Loading...</div>;
  }
  if (needsAuth) {
    return <AuthGate onAuthenticated={() => setNeedsAuth(false)} />;
  }

  return <AppInner />;
}

// ── Streaming State Reducer ────────────────────────────

interface StreamingState {
  text: Map<string, string>;
  tool: Map<string, string>;
  toolInput: Map<string, string>;
  metrics: Map<string, TurnMetrics>;
  /** Threads that received turn_end but thread status hasn't updated to done yet */
  turnEnded: Set<string>;
}

const initialStreamingState: StreamingState = {
  text: new Map(),
  tool: new Map(),
  toolInput: new Map(),
  metrics: new Map(),
  turnEnded: new Set(),
};

const EMPTY_METRICS: TurnMetrics = { costUsd: 0, durationMs: 0, turnCount: 0 };

type StreamingAction =
  | { type: "delta"; delta: StreamDelta }
  | { type: "clear_text"; threadId: string }
  | { type: "clear_tool"; threadId: string }
  | { type: "clear_all"; threadId: string };

function streamingReducer(state: StreamingState, action: StreamingAction): StreamingState {
  switch (action.type) {
    case "delta": {
      const { delta } = action;
      switch (delta.deltaType) {
        case "text":
          if (delta.text) {
            const text = new Map(state.text);
            text.set(delta.threadId, (state.text.get(delta.threadId) ?? "") + delta.text);
            const turnEnded = state.turnEnded.has(delta.threadId)
              ? new Set([...state.turnEnded].filter((id) => id !== delta.threadId))
              : state.turnEnded;
            return { ...state, text, turnEnded };
          }
          return state;
        case "tool_start":
          if (delta.toolName) {
            const tool = new Map(state.tool);
            tool.set(delta.threadId, delta.toolName);
            const toolInput = new Map(state.toolInput);
            toolInput.delete(delta.threadId);
            const turnEnded = state.turnEnded.has(delta.threadId)
              ? new Set([...state.turnEnded].filter((id) => id !== delta.threadId))
              : state.turnEnded;
            return { ...state, tool, toolInput, turnEnded };
          }
          return state;
        case "tool_input":
          if (delta.toolInput) {
            const toolInput = new Map(state.toolInput);
            toolInput.set(delta.threadId, (state.toolInput.get(delta.threadId) ?? "") + delta.toolInput);
            return { ...state, toolInput };
          }
          return state;
        case "tool_end": {
          const tool = new Map(state.tool);
          tool.delete(delta.threadId);
          const toolInput = new Map(state.toolInput);
          toolInput.delete(delta.threadId);
          return { ...state, tool, toolInput };
        }
        case "metrics": {
          const metrics = new Map(state.metrics);
          const prev = state.metrics.get(delta.threadId) ?? { ...EMPTY_METRICS };
          metrics.set(delta.threadId, {
            costUsd: prev.costUsd + (delta.costUsd ?? 0),
            durationMs: prev.durationMs + (delta.durationMs ?? 0),
            turnCount: prev.turnCount + 1,
          });
          return { ...state, metrics };
        }
        case "turn_end": {
          const text = new Map(state.text);
          text.delete(delta.threadId);
          const tool = new Map(state.tool);
          tool.delete(delta.threadId);
          const toolInput = new Map(state.toolInput);
          toolInput.delete(delta.threadId);
          const turnEnded = new Set(state.turnEnded);
          turnEnded.add(delta.threadId);
          return { ...state, text, tool, toolInput, turnEnded };
        }
        default:
          return state;
      }
    }
    case "clear_text": {
      if (!state.text.has(action.threadId)) return state;
      const text = new Map(state.text);
      text.delete(action.threadId);
      return { ...state, text };
    }
    case "clear_tool": {
      if (!state.tool.has(action.threadId)) return state;
      const tool = new Map(state.tool);
      tool.delete(action.threadId);
      return { ...state, tool };
    }
    case "clear_all": {
      const text = new Map(state.text);
      text.delete(action.threadId);
      const tool = new Map(state.tool);
      tool.delete(action.threadId);
      const toolInput = new Map(state.toolInput);
      toolInput.delete(action.threadId);
      return { ...state, text, tool, toolInput };
    }
  }
}

function extractToolContextForBar(tool: string | null, input: string): string | null {
  if (!tool || !input) return null;
  try {
    const parsed = JSON.parse(input);
    if (parsed.file_path || parsed.filePath) return parsed.file_path || parsed.filePath;
    if (parsed.command) return parsed.command.slice(0, 80);
    if (parsed.pattern) return parsed.pattern;
    return null;
  } catch {
    // Partial JSON — try regex extraction
    const pathMatch = input.match(/"(?:file_path|filePath|path)"\s*:\s*"([^"]+)"/);
    if (pathMatch) return pathMatch[1];
    const cmdMatch = input.match(/"command"\s*:\s*"([^"]{1,80})/);
    if (cmdMatch) return cmdMatch[1];
    return null;
  }
}

function AppInner() {
  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [agents, setAgents] = useState<Array<{ name: string; detected: boolean; version: string | null }>>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"inbox" | "sessions" | "new">("sessions");
  const [desktopDrawerOpen, setDesktopDrawerOpen] = useState(false);
  const [pushBannerDismissed, setPushBannerDismissed] = useState(
    () => localStorage.getItem("orchestra_push_dismissed") === "1",
  );
  const drawerRef = useRef<HTMLDivElement>(null);
  const [streaming, dispatchStreaming] = useReducer(streamingReducer, initialStreamingState);
  const subscribedRef = useRef<string | null>(null);
  const turnStartRef = useRef<number>(0);

  // Attention system — cross-thread pending questions/permissions
  const attention = useAttention();

  // Push notifications
  const push = usePushNotifications();
  const showPushBanner = push.supported && push.permission === "default" && !push.subscribed && !pushBannerDismissed;

  // Close desktop drawer on click outside
  useEffect(() => {
    if (!desktopDrawerOpen) return;
    function handleClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setDesktopDrawerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [desktopDrawerOpen]);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeMessages = (activeThreadId ? messages.get(activeThreadId) : null) ?? [];
  const activeStreamingText = activeThreadId ? streaming.text.get(activeThreadId) : undefined;
  const activeStreamingTool = activeThreadId ? streaming.tool.get(activeThreadId) : undefined;
  const activeStreamingToolInput = activeThreadId ? streaming.toolInput.get(activeThreadId) : undefined;
  const activeMetrics = activeThreadId ? streaming.metrics.get(activeThreadId) ?? EMPTY_METRICS : EMPTY_METRICS;
  const activeTurnEnded = activeThreadId ? streaming.turnEnded.has(activeThreadId) : false;

  // Detect unanswered AskUserQuestion — check if there's one after the last user message
  const pendingQuestion = useMemo(() => {
    if (!activeMessages.length) return null;
    let foundAsk = false;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const msg = activeMessages[i];
      if (msg.role === "user") return foundAsk ? true : null;
      if (msg.toolName === "AskUserQuestion" && msg.toolInput && !msg.toolOutput) {
        foundAsk = true;
      }
    }
    return foundAsk ? true : null;
  }, [activeMessages]);

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
        dispatchStreaming({ type: "clear_text", threadId: msg.threadId });
      }
      if (msg.role === "tool") {
        dispatchStreaming({ type: "clear_tool", threadId: msg.threadId });
      }
    }, []),
    onThreadUpdate: useCallback((thread: Thread) => {
      setThreads((prev) =>
        prev.map((t) => (t.id === thread.id ? thread : t)),
      );
      if (thread.status === "done" || thread.status === "error") {
        dispatchStreaming({ type: "clear_all", threadId: thread.id });
      }
    }, []),
    onStreamDelta: useCallback((delta: StreamDelta) => {
      dispatchStreaming({ type: "delta", delta });
    }, []),
    onError: useCallback((error: string) => {
      setError(error);
    }, []),
    onRawMessage: useCallback((msg: WSServerMessage) => {
      attention.handleWSMessage(msg);
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
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

  // ── Service worker notification-click handler ─────────
  useEffect(() => {
    // Handle deep-link from push notification click
    const params = new URLSearchParams(window.location.search);
    const threadParam = params.get("thread");
    if (threadParam) {
      setActiveThreadId(threadParam);
      // Clean URL without reload
      window.history.replaceState({}, "", "/");
    }

    // Handle messages from service worker
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "notification-click") {
        if (event.data.threadId) {
          setActiveThreadId(event.data.threadId);
        }
      }
    };
    navigator.serviceWorker?.addEventListener("message", handler);
    return () => navigator.serviceWorker?.removeEventListener("message", handler);
  }, []);

  // ── Data loading ──────────────────────────────────────

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error);
    api.listThreads().then(setThreads).catch(console.error);
    api.listAgents().then(setAgents).catch(console.error);
    api.listCommands().then(setCommands).catch(console.error);
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
      turnStartRef.current = Date.now();
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
      turnStartRef.current = Date.now();
      send({ type: "send_message", threadId: activeThreadId, content });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStopThread = async () => {
    if (!activeThreadId) return;
    send({ type: "stop_thread", threadId: activeThreadId });
  };

  const handleResolveAttention = (attentionId: string, resolution: AttentionResolution) => {
    send({ type: "resolve_attention", attentionId, resolution });
  };

  const handleNavigateToThread = (threadId: string) => {
    setActiveThreadId(threadId);
    setMobileTab("sessions");
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

  const handleRemoveProject = async (projectId: string) => {
    try {
      setError(null);
      await api.deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      // Remove threads for this project from local state
      setThreads((prev) => prev.filter((t) => t.projectId !== projectId));
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
        setActiveThreadId(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleNewThreadFromSidebar = (projectId: string) => {
    setActiveProjectId(projectId);
    setActiveThreadId(null); // Show empty state for this project
  };

  // ── Render ────────────────────────────────────────────

  const isRunning = activeThread?.status === "running";
  const activelyWorking = isRunning && !activeTurnEnded;

  return (
    <div className="h-screen flex flex-col bg-base text-content-1 overflow-hidden">
      {/* Top bar — frosted glass */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-base/80 backdrop-blur-xl border-b border-edge-1 shrink-0 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="md:hidden p-2 hover:bg-surface-3 rounded-lg shrink-0"
          >
            <MenuIcon />
          </button>
          <div className={`w-2 h-2 rounded-full bg-accent shrink-0 ${activelyWorking ? "animate-pulse" : ""}`} />
          <h1 className="text-sm font-semibold tracking-tight text-content-2 shrink-0">Orchestra</h1>
          {activeProject && (
            <span className="text-xs text-content-3 font-light shrink-0">
              / {activeProject.name}
            </span>
          )}
        </div>
        {activeThread && (
          <div className="flex items-center gap-2 mx-4 min-w-0 justify-center flex-1">
            <span className="text-sm font-medium truncate">{activeThread.title}</span>
            <HeaderStatusBadge status={activeThread.status} errorMessage={activeThread.errorMessage} />
          </div>
        )}
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connected
                ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                : "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]"
            }`}
            title={connected ? "Connected" : "Disconnected"}
          />
          {activeThread?.worktree && (
            <button
              onClick={() => setContextOpen(!contextOpen)}
              className="px-3 py-1.5 hover:bg-surface-3 rounded-lg text-sm text-content-2 hover:text-content-1"
            >
              Context
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="bg-red-950/60 border-b border-red-900/30 text-red-300 px-4 py-2 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline text-red-400 hover:text-red-300">
            dismiss
          </button>
        </div>
      )}

      {!connected && (
        <div className="bg-amber-950/60 border-b border-amber-900/30 text-amber-300 px-4 py-1.5 text-sm text-center">
          Reconnecting...
        </div>
      )}

      {showPushBanner && (
        <div className="bg-accent/10 border-b border-accent/20 px-4 py-2 text-sm flex items-center justify-between gap-3">
          <span className="text-content-2">Get notified when agents need your input.</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => push.subscribe()}
              disabled={push.loading}
              className="px-3 py-1 rounded-lg bg-accent hover:bg-accent/80 text-white text-xs font-medium disabled:opacity-50"
            >
              {push.loading ? "..." : "Enable"}
            </button>
            <button
              onClick={() => {
                setPushBannerDismissed(true);
                localStorage.setItem("orchestra_push_dismissed", "1");
              }}
              className="text-content-3 hover:text-content-2 text-xs"
            >
              Later
            </button>
          </div>
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
          onRemoveProject={handleRemoveProject}
          onAddProject={() => setShowAddProject(true)}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main area — pb-14 on mobile for bottom nav */}
        <div className="flex-1 flex flex-col min-w-0 pb-14 md:pb-0">
          {activeThread ? (
            <>
              <ChatView
                messages={activeMessages}
                thread={activeThread}
                streamingText={activeStreamingText}
                streamingTool={activeStreamingTool}
                streamingToolInput={activeStreamingToolInput}
                turnEnded={activeTurnEnded}
                onSubmitAnswers={handleSendMessage}
              />
              <StickyRunBar
                isRunning={isRunning}
                turnEnded={activeTurnEnded}
                currentAction={activeStreamingToolInput ? extractToolContextForBar(activeStreamingTool ?? null, activeStreamingToolInput) : null}
                currentTool={activeStreamingTool ?? null}
                metrics={activeMetrics}
                elapsedMs={activelyWorking ? Date.now() - (turnStartRef.current || Date.now()) : activeMetrics.durationMs}
                onInterrupt={handleStopThread}
              />
              <InputBar
                agents={agents}
                thread={activeThread}
                activeProjectId={activeProjectId}
                commands={commands}
                pendingQuestion={pendingQuestion}
                onSend={handleSendMessage}
                onNewThread={handleNewThread}
                onStop={handleStopThread}
              />
            </>
          ) : activeProject ? (
            <ProjectEmptyState
              project={activeProject}
              agents={agents}
              commands={commands}
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

      {/* Mobile tab overlays — only show when NOT viewing a specific thread */}
      {mobileTab === "inbox" && (
        <div className="md:hidden fixed inset-0 top-0 bottom-14 z-20 bg-base overflow-y-auto"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div className="sticky top-0 bg-base border-b border-edge-1 px-4 py-3 z-10">
            <h2 className="text-lg font-semibold text-content-1">
              Inbox {attention.pendingCount > 0 && (
                <span className="ml-2 text-sm font-normal text-content-3">
                  {attention.pendingCount} pending
                </span>
              )}
            </h2>
          </div>
          <AttentionInbox
            items={attention.items}
            onResolve={handleResolveAttention}
            onNavigateToThread={handleNavigateToThread}
          />
        </div>
      )}

      {mobileTab === "sessions" && !activeThread && (
        <div className="md:hidden fixed inset-0 top-0 bottom-14 z-20 bg-base overflow-y-auto"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <MobileSessions
            projects={projects}
            threads={threads}
            activeThreadId={activeThreadId}
            onSelectThread={(threadId) => {
              handleSelectThread(threadId);
              setMobileTab("sessions");
            }}
            onNewThread={(projectId) => {
              setActiveProjectId(projectId);
              setActiveThreadId(null);
              setMobileTab("new");
            }}
          />
        </div>
      )}

      {mobileTab === "new" && (
        <div className="md:hidden fixed inset-0 top-0 bottom-14 z-20 bg-base overflow-y-auto"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <MobileNewSession
            projects={projects}
            agents={agents}
            commands={commands}
            activeProjectId={activeProjectId}
            onNewThread={(agent, prompt, isolate, projectId) => {
              handleNewThread(agent, prompt, isolate, projectId);
              setMobileTab("sessions");
            }}
          />
        </div>
      )}

      {/* Mobile Bottom Navigation */}
      <MobileNav
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        attentionCount={attention.pendingCount}
      />

      {/* Desktop attention drawer (top-right) */}
      {attention.pendingCount > 0 && (
        <div ref={drawerRef} className="hidden md:block fixed top-3 right-4 z-30">
          <button
            onClick={() => setDesktopDrawerOpen((o) => !o)}
            className="relative px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium hover:bg-amber-500/20"
          >
            {attention.pendingCount} pending
          </button>
          {desktopDrawerOpen && (
            <div className="absolute top-full right-0 mt-2 w-96 max-h-[70vh] overflow-y-auto rounded-xl bg-surface-1 border border-edge-1 shadow-2xl shadow-black/40">
              <div className="sticky top-0 bg-surface-1 border-b border-edge-1 px-4 py-2.5 z-10">
                <h3 className="text-sm font-semibold text-content-1">Attention Queue</h3>
              </div>
              <AttentionInbox
                items={attention.items}
                onResolve={(id, res) => {
                  handleResolveAttention(id, res);
                  if (attention.pendingCount <= 1) setDesktopDrawerOpen(false);
                }}
                onNavigateToThread={(threadId) => {
                  handleNavigateToThread(threadId);
                  setDesktopDrawerOpen(false);
                }}
              />
            </div>
          )}
        </div>
      )}

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
  commands,
  onNewThread,
}: {
  project: ProjectWithStatus;
  agents: Array<{ name: string; detected: boolean }>;
  commands: SlashCommand[];
  onNewThread: (agent: string, prompt: string, isolate: boolean, projectId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(false);
  const defaultAgent = agents.find((a) => a.detected)?.name ?? "claude";

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-2">{project.name}</h2>
        <div className="flex items-center justify-center gap-2 text-xs text-content-3">
          <span className="font-mono bg-surface-3 px-2 py-0.5 rounded">{project.currentBranch}</span>
          <span>&middot;</span>
          <span>
            {project.threadCount} thread{project.threadCount !== 1 ? "s" : ""}
            {project.activeThreadCount > 0 && (
              <span className="text-emerald-400 ml-1">{project.activeThreadCount} running</span>
            )}
          </span>
        </div>
      </div>
      <div className="w-full max-w-xl">
        <SlashCommandInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => {
            if (prompt.trim()) {
              onNewThread(defaultAgent, prompt.trim(), isolate, project.id);
              setPrompt("");
            }
          }}
          commands={commands}
          placeholder="What would you like to build?"
          rows={5}
        />
        <div className="flex items-center justify-between mt-3">
          <label className="flex items-center gap-2 text-sm text-content-2 cursor-pointer">
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
            className="px-5 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base"
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
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-8 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(34,211,238,0.04)_0%,_transparent_70%)] pointer-events-none" />
      <div className="text-center relative">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="w-3 h-3 rounded-full bg-accent shadow-[0_0_8px_rgba(34,211,238,0.4)]" />
          <h2 className="text-4xl font-light tracking-tight">Orchestra</h2>
        </div>
        <p className="text-content-2 text-sm max-w-sm mx-auto">
          Agent-first development interface. Point it at a repo and let agents build.
        </p>
      </div>

      {/* 3-step guide */}
      <div className="flex items-start gap-6 text-sm text-content-2 relative max-w-lg">
        {[
          { step: "1", label: "Add project", desc: "Point to any git repo" },
          { step: "2", label: "Start thread", desc: "Describe what to build" },
          { step: "3", label: "Watch it work", desc: "Stream tools + output live" },
        ].map((s, i) => (
          <div key={i} className="flex-1 text-center">
            <div className="w-7 h-7 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-medium flex items-center justify-center mx-auto mb-2">
              {s.step}
            </div>
            <div className="font-medium text-content-1 text-xs">{s.label}</div>
            <div className="text-[11px] text-content-3 mt-0.5">{s.desc}</div>
          </div>
        ))}
      </div>

      <button
        onClick={onAddProject}
        className="flex items-center gap-4 px-6 py-4 bg-surface-2 border border-edge-2 rounded-xl hover:border-accent/40 hover:bg-surface-3 max-w-md w-full text-left group"
      >
        <span className="text-2xl text-content-3 group-hover:text-accent">+</span>
        <div>
          <div className="text-sm font-medium">Add a project</div>
          <div className="text-xs text-content-3">Browse to a git repository folder</div>
        </div>
      </button>
      <p className="text-xs text-content-3 relative">
        or run{" "}
        <code className="bg-surface-2 px-1.5 py-0.5 rounded text-content-2 font-mono text-xs">
          orchestra add ~/projects/my-repo
        </code>{" "}
        from the terminal
      </p>
    </div>
  );
}

// ── Add Project Dialog ──────────────────────────────────

interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

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

  // Browser state
  const [browseCurrent, setBrowseCurrent] = useState<string | null>(null);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<BrowseEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback(async (targetPath?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const data = await api.browsePath(targetPath);
      setBrowseCurrent(data.current);
      setBrowseParent(data.parent);
      setBrowseDirs(data.directories);
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (err) {
      setBrowseError((err as Error).message);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // Load home directory on mount
  useEffect(() => {
    navigate();
  }, [navigate]);

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
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="bg-surface-2 border border-edge-2 rounded-2xl p-6 w-full max-w-lg shadow-2xl shadow-black/50 flex flex-col max-h-[80vh]">
        <h3 className="text-lg font-semibold mb-1">Add Project</h3>
        <p className="text-sm text-content-2 mb-4">
          Browse to a git repository or type its path directly.
        </p>

        {/* Path input */}
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/projects/my-repo"
            className="flex-1 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-content-3"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoFocus
          />
          <button
            onClick={handleSubmit}
            disabled={!path.trim() || loading}
            className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base whitespace-nowrap"
          >
            {loading ? "Adding..." : "Add"}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-400 mb-2">{error}</p>
        )}

        {/* Directory browser */}
        <div className="flex-1 min-h-0 flex flex-col border border-edge-2 rounded-lg bg-surface-1 overflow-hidden">
          {/* Current path breadcrumb + up button */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-edge-2 bg-surface-1/50 shrink-0">
            <button
              onClick={() => browseParent && navigate(browseParent)}
              disabled={!browseParent || browseLoading}
              className="p-1 rounded hover:bg-surface-3 disabled:opacity-30 text-content-2 hover:text-content-1 shrink-0"
              title="Go up"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 12V4M4 8l4-4 4 4" />
              </svg>
            </button>
            <span className="text-xs font-mono text-content-2 truncate" title={browseCurrent ?? ""}>
              {browseCurrent ?? "Loading..."}
            </span>
          </div>

          {/* Directory list */}
          <div ref={listRef} className="flex-1 overflow-y-auto min-h-[200px] max-h-[320px]">
            {browseLoading && browseDirs.length === 0 ? (
              <div className="p-4 text-center text-sm text-content-3">Loading...</div>
            ) : browseError ? (
              <div className="p-4 text-center text-sm text-red-400">{browseError}</div>
            ) : browseDirs.length === 0 ? (
              <div className="p-4 text-center text-sm text-content-3">No subdirectories</div>
            ) : (
              browseDirs.map((dir) => (
                <button
                  key={dir.path}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-3/60 transition-colors ${
                    dir.path === path ? "bg-accent/10 border-l-2 border-accent" : "border-l-2 border-transparent"
                  }`}
                  onClick={() => {
                    if (dir.isGitRepo) {
                      setPath(dir.path);
                      setError(null);
                    } else {
                      navigate(dir.path);
                    }
                  }}
                  onDoubleClick={() => navigate(dir.path)}
                  title={dir.isGitRepo ? `${dir.path} (git repo — click to select)` : dir.path}
                >
                  {/* Icon */}
                  {dir.isGitRepo ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-accent">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                      <circle cx="8" cy="5" r="1.5" fill="currentColor" />
                      <circle cx="8" cy="11" r="1.5" fill="currentColor" />
                      <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-content-3">
                      <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  )}
                  {/* Name + label */}
                  <span className={`text-sm truncate ${dir.isGitRepo ? "text-content-1 font-medium" : "text-content-2"}`}>
                    {dir.name}
                  </span>
                  {dir.isGitRepo && (
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-accent/70 font-medium shrink-0">
                      git
                    </span>
                  )}
                  {/* Chevron for non-git dirs */}
                  {!dir.isGitRepo && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="ml-auto shrink-0 text-content-3/50">
                      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-4 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-content-2 hover:text-content-1 rounded-lg hover:bg-surface-3"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!path.trim() || loading}
            className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base"
          >
            {loading ? "Adding..." : "Add Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function HeaderStatusBadge({ status, errorMessage }: { status: string; errorMessage?: string | null }) {
  const styles: Record<string, string> = {
    running: "bg-emerald-900/40 text-emerald-400 border-emerald-500/20",
    pending: "bg-amber-900/40 text-amber-400 border-amber-500/20",
    waiting: "bg-amber-900/40 text-amber-400 border-amber-500/20",
    paused: "bg-surface-3 text-content-3 border-edge-2",
    done: "bg-accent/10 text-accent border-accent/20",
    error: "bg-red-900/40 text-red-400 border-red-500/20",
  };
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${styles[status] ?? ""}`}
      title={status === "error" && errorMessage ? errorMessage : undefined}
    >
      {status}
    </span>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
