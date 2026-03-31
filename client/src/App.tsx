import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  Attachment,
  AttentionResolution,
  CleanupPushedResponse,
  EffortLevel,
  Message,
  PermissionMode,
  ProjectWithStatus,
  SlashCommand,
  StreamDelta,
  Thread,
  TodoItem,
  TurnMetrics,
  WSServerMessage,
} from "shared";
import { useWebSocket } from "./hooks/useWebSocket";
import { api } from "./hooks/useApi";
import { useAttention } from "./hooks/useAttention";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ChatView, type ChatViewHandle } from "./components/ChatView";
import { ContextPanel } from "./components/ContextPanel";
import { InputBar } from "./components/InputBar";
import { AuthGate } from "./components/AuthGate";
import { extractTokenFromUrl, getStoredToken } from "./lib/auth";
import { StickyRunBar } from "./components/StickyRunBar";
import { MobileNav } from "./components/MobileNav";
import { AttentionInbox } from "./components/AttentionInbox";
import { MobileSessions } from "./components/MobileSessions";
import { MobileNewSession } from "./components/MobileNewSession";
import { usePushNotifications } from "./hooks/usePushNotifications";
import { isAskUserTool } from "./lib/askUser";
import { WorktreePathInput } from "./components/WorktreePathInput";
import { useTerminal } from "./hooks/useTerminal";
import { TerminalPanel } from "./components/TerminalPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { MobileThreadHeader } from "./components/MobileThreadHeader";
import { parseTodos } from "./components/renderers/TodoRenderer";
import { OrchestraLogo } from "./components/OrchestraLogo";
import { MergeAllPrsButton } from "./components/MergeAllPrsButton";
import { PinnedTodoPanel } from "./components/PinnedTodoPanel";
import { CleanupConfirmationModal } from "./components/CleanupConfirmationModal";
import { MergeAllPrsConfirmationModal } from "./components/MergeAllPrsConfirmationModal";
import { buildInputHistory } from "./lib/inputHistory";
import { getEffectiveOutstandingPrCount } from "./lib/prCounts";
import { usePrAutoRefresh } from "./hooks/usePrAutoRefresh";

export function App() {
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);

  // Check URL for token param (from QR code), then check if auth is required
  useEffect(() => {
    extractTokenFromUrl();
    const token = getStoredToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    fetch("/api/agents", { headers }).then((res) => {
      if (res.status === 401) setNeedsAuth(true);
      else setNeedsAuth(false);
    }).catch(() => setNeedsAuth(false));
  }, []);

  if (needsAuth === null) {
    return <div className="h-dvh flex items-center justify-center bg-base text-content-2">Loading...</div>;
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
  /** Number of messages queued during current agent turn (per thread) */
  queuedCount: Map<string, number>;
  /** Seq numbers of user messages that were queued, keyed by threadId */
  queuedSeqs: Map<string, Set<number>>;
}

const initialStreamingState: StreamingState = {
  text: new Map(),
  tool: new Map(),
  toolInput: new Map(),
  metrics: new Map(),
  turnEnded: new Set(),
  queuedCount: new Map(),
  queuedSeqs: new Map(),
};

const EMPTY_METRICS: TurnMetrics = { costUsd: 0, durationMs: 0, turnCount: 0, inputTokens: 0, outputTokens: 0, contextWindow: 0, modelName: null };

type StreamingAction =
  | { type: "delta"; delta: StreamDelta }
  | { type: "clear_text"; threadId: string }
  | { type: "clear_tool"; threadId: string }
  | { type: "clear_all"; threadId: string }
  | { type: "mark_queued"; threadId: string; seq: number };

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
          // Only count completed-turn metrics, not intermediate context updates.
          const hasTurnData =
            delta.finalMetrics === true ||
            delta.costUsd !== undefined ||
            delta.durationMs !== undefined;
          metrics.set(delta.threadId, {
            costUsd: prev.costUsd + (delta.costUsd ?? 0),
            durationMs: prev.durationMs + (delta.durationMs ?? 0),
            turnCount: prev.turnCount + (hasTurnData ? 1 : 0),
            inputTokens: delta.inputTokens ?? prev.inputTokens,
            outputTokens: delta.outputTokens ?? prev.outputTokens,
            contextWindow: Math.max(delta.contextWindow ?? 0, prev.contextWindow),
            modelName: delta.modelName ?? prev.modelName,
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
          // Reset queued count and queued message indicators on turn end
          const queuedCountTe = new Map(state.queuedCount);
          queuedCountTe.delete(delta.threadId);
          // Clear one queued seq for this thread (the oldest) — agent is processing it
          const queuedSeqs = new Map(state.queuedSeqs);
          const threadSeqs = queuedSeqs.get(delta.threadId);
          if (threadSeqs && threadSeqs.size > 0) {
            const nextSeqs = new Set(threadSeqs);
            const oldest = [...nextSeqs].sort((a, b) => a - b)[0]!;
            nextSeqs.delete(oldest);
            if (nextSeqs.size > 0) queuedSeqs.set(delta.threadId, nextSeqs);
            else queuedSeqs.delete(delta.threadId);
          }
          return { ...state, text, tool, toolInput, turnEnded, queuedCount: queuedCountTe, queuedSeqs };
        }
        case "queued_message": {
          const queuedCountQm = new Map(state.queuedCount);
          queuedCountQm.set(delta.threadId, delta.queuedCount ?? 0);
          return { ...state, queuedCount: queuedCountQm };
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
    case "mark_queued": {
      const queuedSeqs = new Map(state.queuedSeqs);
      const existing = queuedSeqs.get(action.threadId) ?? new Set<number>();
      const next = new Set(existing);
      next.add(action.seq);
      queuedSeqs.set(action.threadId, next);
      return { ...state, queuedSeqs };
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
  type CleanupPhase = "loading" | "preview" | "executing" | "complete";

  interface CleanupModalState {
    projectId: string;
    phase: CleanupPhase;
    preview: {
      willClean: CleanupPushedResponse["cleaned"];
      needsReview: CleanupPushedResponse["needsConfirmation"];
      skipped: CleanupPushedResponse["skipped"];
    } | null;
    result: {
      cleanedCount: number;
      skippedCount: number;
      leftUntouched: CleanupPushedResponse["skipped"];
    } | null;
  }

  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [agents, setAgents] = useState<Array<{ name: string; detected: boolean; version: string | null; models?: import("shared").ModelOption[] }>>([]);
  const [appSettings, setAppSettings] = useState<import("shared").Settings | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cleanupModal, setCleanupModal] = useState<CleanupModalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergingProjectId, setMergingProjectId] = useState<string | null>(null);
  const [mergeConfirmProjectId, setMergeConfirmProjectId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"inbox" | "sessions" | "new">("sessions");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [lastTerminalMsg, setLastTerminalMsg] = useState<WSServerMessage | null>(null);
  const [latestTodos, setLatestTodos] = useState<Map<string, TodoItem[]>>(new Map());
  const [defaultEffortLevel, setDefaultEffortLevel] = useState<EffortLevel | "">("");
  const [defaultAgent, setDefaultAgent] = useState("");
  const [pushBannerDismissed, setPushBannerDismissed] = useState(
    () => localStorage.getItem("orchestra_push_dismissed") === "1",
  );
  const [streaming, dispatchStreaming] = useReducer(streamingReducer, initialStreamingState);
  const [unreadThreadIds, setUnreadThreadIds] = useState<Set<string>>(new Set());
  const subscribedRef = useRef<string | null>(null);
  const turnStartRef = useRef<number>(0);
  const wasConnectedRef = useRef<boolean | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  activeThreadRef.current = activeThreadId;
  const chatViewRef = useRef<ChatViewHandle>(null);

  // Attention system — cross-thread pending questions/permissions
  const attention = useAttention();

  // Push notifications
  const push = usePushNotifications();
  const showPushBanner = push.supported && push.permission === "default" && !push.subscribed && !pushBannerDismissed;

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const defaultDetectedAgent = useMemo(
    () => agents.find((agent) => agent.detected)?.name ?? "claude",
    [agents],
  );
  const activeMessages = (activeThreadId ? messages.get(activeThreadId) : null) ?? [];
  const activeInputHistory = useMemo(() => buildInputHistory(activeMessages), [activeMessages]);
  const activeStreamingText = activeThreadId ? streaming.text.get(activeThreadId) : undefined;
  const activeStreamingTool = activeThreadId ? streaming.tool.get(activeThreadId) : undefined;
  const activeStreamingToolInput = activeThreadId ? streaming.toolInput.get(activeThreadId) : undefined;
  const activeMetrics = activeThreadId ? streaming.metrics.get(activeThreadId) ?? EMPTY_METRICS : EMPTY_METRICS;
  const activeTurnEnded = activeThreadId ? streaming.turnEnded.has(activeThreadId) : false;
  const activeTodos = activeThreadId ? latestTodos.get(activeThreadId) ?? null : null;

  const activeProjectThreads = useMemo(() =>
    threads
      .filter((t) => t.projectId === activeProjectId && !t.archivedAt)
      .sort((a, b) => new Date(b.lastInteractedAt).getTime() - new Date(a.lastInteractedAt).getTime()),
    [threads, activeProjectId],
  );

  // Recent non-archived threads for the active project (empty-state display)
  const recentProjectThreads = useMemo(() =>
    activeProjectThreads
      .slice(0, 5),
    [activeProjectThreads],
  );
  const activeProjectOutstandingPrCount = useMemo(() => {
    if (!activeProject) return 0;
    return getEffectiveOutstandingPrCount(activeProject, activeProjectThreads);
  }, [activeProject, activeProjectThreads]);

  // Detect unanswered ask-user tool calls — check if there's one after the last user message
  const pendingQuestion = useMemo(() => {
    if (!activeMessages.length) return null;
    let foundAsk = false;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const msg = activeMessages[i];
      if (msg.role === "user") return foundAsk ? true : null;
      if (isAskUserTool(msg.toolName) && msg.toolInput && !msg.toolOutput) {
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
      // Tag user messages as queued if they were sent while agent was running
      if (msg.role === "user" && pendingQueuedCountRef.current > 0) {
        pendingQueuedCountRef.current--;
        dispatchStreaming({ type: "mark_queued", threadId: msg.threadId, seq: msg.seq });
      }
      // Clear streaming state when a persisted message arrives
      if (msg.role === "assistant") {
        dispatchStreaming({ type: "clear_text", threadId: msg.threadId });
      }
      if (msg.role === "tool") {
        dispatchStreaming({ type: "clear_tool", threadId: msg.threadId });
        // Track latest TodoWrite state per thread
        if (msg.toolName === "TodoWrite" && msg.toolInput) {
          const todosParsed = parseTodos(msg.toolInput);
          if (todosParsed) {
            setLatestTodos((prev) => {
              const next = new Map(prev);
              next.set(msg.threadId, todosParsed.items);
              return next;
            });
          }
        }
      }
    }, []),
    onThreadUpdate: useCallback((thread: Thread) => {
      setThreads((prev) => {
        // Archived thread — remove from list
        if (thread.archivedAt) {
          return prev.filter((t) => t.id !== thread.id);
        }
        const exists = prev.some((t) => t.id === thread.id);
        if (exists) {
          return prev.map((t) => (t.id === thread.id ? thread : t));
        }
        // New thread from another client — add to the top
        return [thread, ...prev];
      });
      if (thread.status === "done" || thread.status === "error") {
        dispatchStreaming({ type: "clear_all", threadId: thread.id });
      }
      // Mark as unread if this thread isn't currently being viewed
      if (!thread.archivedAt && thread.id !== activeThreadRef.current) {
        setUnreadThreadIds((prev) => {
          if (prev.has(thread.id)) return prev;
          const next = new Set(prev);
          next.add(thread.id);
          return next;
        });
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
      // Route terminal messages
      if (msg.type === "terminal_output" || msg.type === "terminal_exit" ||
          msg.type === "terminal_created" || msg.type === "terminal_error") {
        setLastTerminalMsg(msg);
      }
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
  });

  // Terminal hook
  const terminal = useTerminal({
    threadId: activeThreadId,
    visible: terminalOpen,
    send,
  });

  // Route terminal WS messages to the hook
  useEffect(() => {
    if (lastTerminalMsg) {
      terminal.handleMessage(lastTerminalMsg);
    }
  }, [lastTerminalMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcut: Ctrl+` / Cmd+` to toggle terminal
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        if (!activeThreadIdRef.current) return;
        setTerminalOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
    api.getSettings().then((s) => { setAppSettings(s); setDefaultEffortLevel(s.defaultEffortLevel); setDefaultAgent(s.defaultAgent); }).catch(console.error);
  }, []);

  // Fetch commands scoped to active project; refetch when project changes.
  // Stale-response guard prevents a slow earlier response from overwriting a fast later one.
  useEffect(() => {
    let stale = false;
    api.listCommands(activeProjectId ?? undefined).then((cmds) => {
      if (!stale) setCommands(cmds);
    }).catch(console.error);
    return () => { stale = true; };
  }, [activeProjectId]);

  // Re-fetch thread list on WS reconnection so sidebar statuses are fresh.
  // Without this, threads that changed status while disconnected appear "stuck".
  useEffect(() => {
    // null = never connected yet (initial load handles it)
    // false = was connected, then disconnected → next true is a reconnect
    if (connected && wasConnectedRef.current === false) {
      api.listProjects().then(setProjects).catch(console.error);
      api.listThreads().then(setThreads).catch(console.error);
    }
    wasConnectedRef.current = connected;
  }, [connected]);

  usePrAutoRefresh({
    connected,
    onThreads: setThreads,
    threads,
  });

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
      // Hydrate latestTodos from loaded history (scan backwards for last TodoWrite).
      // Guard: skip if streaming already provided newer state for this thread.
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].toolName === "TodoWrite" && msgs[i].toolInput) {
          const todosParsed = parseTodos(msgs[i].toolInput);
          if (todosParsed) {
            setLatestTodos((prev) => {
              if (prev.has(activeThreadId)) return prev; // streaming set newer data
              const next = new Map(prev);
              next.set(activeThreadId, todosParsed.items);
              return next;
            });
            break;
          }
        }
      }
    });
  }, [activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update browser tab title when there are unseen completed threads
  useEffect(() => {
    const unseenDoneCount = threads.filter(
      (t) => unreadThreadIds.has(t.id) && (t.status === "done" || t.status === "error"),
    ).length;
    document.title = unseenDoneCount > 0 ? `(${unseenDoneCount}) Orchestra` : "Orchestra";
  }, [unreadThreadIds, threads]);

  // ── Actions ───────────────────────────────────────────

  const handleNewThread = async (agent: string, effortLevel: EffortLevel | null, model: string | null, prompt: string, isolate: boolean, projectId?: string, worktreeName?: string, attachments?: Attachment[], permissionMode?: PermissionMode | null, baseBranch?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) {
      setError("Select a project first");
      return;
    }
    try {
      setError(null);
      const thread = await api.createThread({ agent, effortLevel: effortLevel ?? undefined, permissionMode: permissionMode ?? undefined, model: model ?? undefined, prompt, projectId: pid, isolate, worktreeName, baseBranch, attachments });
      // Guard against duplicate: WS broadcast from server may arrive before this HTTP response
      setThreads((prev) => prev.some((t) => t.id === thread.id) ? prev : [thread, ...prev]);
      setActiveThreadId(thread.id);
      clearUnread(thread.id); // WS race: thread_updated may arrive before setActiveThreadId takes effect
      setActiveProjectId(pid);
      setSidebarOpen(false);
      turnStartRef.current = Date.now();
      // Refresh projects to update counts
      api.listProjects().then(setProjects).catch(console.error);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Track how many of the next incoming user messages should be marked as "queued"
  const pendingQueuedCountRef = useRef(0);

  const handleSendMessage = async (content: string, attachments?: Attachment[], interrupt?: boolean) => {
    if (!activeThreadId) return;
    try {
      setError(null);
      // Only reset turn timer when starting a new turn, not when queuing mid-turn
      const thread = threads.find((t) => t.id === activeThreadId);
      if (!thread || thread.status !== "running") {
        turnStartRef.current = Date.now();
      } else {
        // Sending while running — flag next incoming user message as queued
        pendingQueuedCountRef.current++;
      }
      send({ type: "send_message", threadId: activeThreadId, content, attachments, interrupt: interrupt ?? false });
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

  const clearUnread = useCallback((threadId: string) => {
    setUnreadThreadIds((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  const handleNavigateToThread = (threadId: string) => {
    setActiveThreadId(threadId);
    clearUnread(threadId);
    setMobileTab("sessions");
  };

  const handleSaveTitle = useCallback(async (newTitle: string) => {
    if (!activeThreadId) return;
    // Optimistic update
    setThreads((prev) => prev.map((t) => (t.id === activeThreadId ? { ...t, title: newTitle } : t)));
    try {
      await api.updateThread(activeThreadId, { title: newTitle });
    } catch {
      // Revert on failure — WS broadcast will correct if server succeeded
    }
  }, [activeThreadId]);

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
    clearUnread(threadId);
    // Also set the project to the thread's project
    const thread = threads.find((t) => t.id === threadId);
    if (thread?.projectId) {
      setActiveProjectId(thread.projectId);
    }
  };

  const handleArchiveThread = async (threadId: string, opts?: { cleanupWorktree?: boolean }) => {
    try {
      setError(null);
      const result = await api.archiveThread(threadId, opts);
      if (result.cleanupFailed) {
        setError("Thread archived, but worktree cleanup failed — the worktree may still exist on disk.");
      }
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      clearUnread(threadId);
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

  /** Remove cleaned thread IDs from local state */
  const applyCleanedIds = (cleanedIds: Set<string>) => {
    if (cleanedIds.size === 0) return;
    setThreads((prev) => prev.filter((t) => !cleanedIds.has(t.id)));
    if (activeThreadId && cleanedIds.has(activeThreadId)) {
      setActiveThreadId(null);
    }
    setMessages((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of cleanedIds) {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    api.listProjects().then(setProjects).catch(console.error);
  };

  const handleCleanupPushed = async (projectId: string) => {
    // Open modal immediately with loading spinner
    setCleanupModal({ projectId, phase: "loading", preview: null, result: null });

    try {
      setError(null);
      const dryResult = await api.cleanupPushedThreads(projectId, { dryRun: true });

      // Guard: if user dismissed the modal while the dry-run was in flight, don't reopen
      setCleanupModal((prev) => {
        if (!prev || prev.phase !== "loading") return prev;

        // Nothing to do at all
        if (dryResult.cleaned.length === 0 && dryResult.needsConfirmation.length === 0 && dryResult.skipped.length === 0) {
          setError("No threads to clean up.");
          return null;
        }

        return {
          projectId,
          phase: "preview",
          preview: {
            willClean: dryResult.cleaned,
            needsReview: dryResult.needsConfirmation,
            skipped: dryResult.skipped,
          },
          result: null,
        };
      });
    } catch (err) {
      setCleanupModal((prev) => prev?.phase === "loading" ? null : prev);
      setError((err as Error).message);
    }
  };

  const handleCleanupConfirm = async (confirmedThreadIds: string[]) => {
    if (!cleanupModal?.preview) return;

    // Capture the preview's thread IDs so the server only processes what the user saw
    const scopeToThreadIds = [
      ...cleanupModal.preview.willClean.map((t) => t.id),
      ...cleanupModal.preview.needsReview.map((t) => t.id),
      ...cleanupModal.preview.skipped.map((t) => t.id),
    ];

    setCleanupModal((prev) => prev ? { ...prev, phase: "executing" } : null);

    try {
      setError(null);
      const result = await api.cleanupPushedThreads(cleanupModal.projectId, {
        confirmedThreadIds,
        scopeToThreadIds,
      });

      const cleanedIds = new Set(result.cleaned.map((c) => c.id));
      applyCleanedIds(cleanedIds);

      // Combine skipped + unconfirmed review items for "left untouched"
      const leftUntouched = [...result.skipped, ...result.needsConfirmation];

      setCleanupModal((prev) => prev ? {
        ...prev,
        phase: "complete",
        result: {
          cleanedCount: result.cleaned.length,
          skippedCount: leftUntouched.length,
          leftUntouched,
        },
      } : null);
    } catch (err) {
      // Revert to preview so user can retry or cancel
      setCleanupModal((prev) => prev ? { ...prev, phase: "preview" } : null);
      setError((err as Error).message);
    }
  };

  const handleCleanupClose = () => {
    setCleanupModal(null);
  };

  const handleNewThreadFromSidebar = (projectId: string) => {
    setActiveProjectId(projectId);
    setActiveThreadId(null); // Show empty state for this project
  };

  const handleMergeAllPrsClick = (projectId: string) => {
    setMergeConfirmProjectId(projectId);
  };

  const handleMergeAllPrsConfirm = async () => {
    const projectId = mergeConfirmProjectId;
    if (!projectId) return;
    try {
      setError(null);
      setMergingProjectId(projectId);
      const thread = await api.mergeAllPrs(projectId, defaultDetectedAgent);
      setMergeConfirmProjectId(null);
      setThreads((prev) => prev.some((t) => t.id === thread.id) ? prev : [thread, ...prev]);
      setActiveThreadId(thread.id);
      clearUnread(thread.id);
      setActiveProjectId(projectId);
      setSidebarOpen(false);
      turnStartRef.current = Date.now();
      api.listProjects().then(setProjects).catch(console.error);
    } catch (err) {
      setMergeConfirmProjectId(null);
      setError((err as Error).message);
    } finally {
      setMergingProjectId((current) => (current === projectId ? null : current));
    }
  };

  // ── Render ────────────────────────────────────────────

  const isRunning = activeThread?.status === "running";
  const activelyWorking = isRunning && !activeTurnEnded;

  return (
    <div className="h-dvh flex flex-col bg-base text-content-1 overflow-hidden">
      {/* Top bar — frosted glass */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-base/80 backdrop-blur-xl border-b border-edge-1 shrink-0 z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <OrchestraLogo size={20} color="var(--color-accent)" />
            <h1 className="text-sm font-semibold tracking-tight text-content-2">Orchestra</h1>
          </div>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="md:hidden p-2 hover:bg-surface-3 rounded-lg shrink-0"
          >
            <MenuIcon />
          </button>
          {activeProject && (
            <span className="text-xs text-content-3 font-light shrink-0">
              / {activeProject.name}
            </span>
          )}
        </div>
        {activeThread && (
          <div className="hidden md:flex items-center gap-2 mx-4 min-w-0 justify-center flex-1">
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
          <button
            onClick={() => setTerminalOpen(!terminalOpen)}
            disabled={!activeThread}
            className="hidden md:block px-3 py-1.5 hover:bg-surface-3 rounded-lg text-sm text-content-2 hover:text-content-1 disabled:opacity-30 disabled:cursor-not-allowed font-mono"
            title={
              !activeThread
                ? "Select a thread to open terminal"
                : terminalOpen
                  ? "Close terminal (Ctrl+`)"
                  : "Open terminal (Ctrl+`)"
            }
          >
            &gt;_
          </button>
          {activeThread?.worktree && (
            <button
              onClick={() => setContextOpen(!contextOpen)}
              className="p-1.5 hover:bg-surface-3 rounded-lg text-content-2 hover:text-content-1"
              title="Diff / context"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" strokeOpacity="0.35" />
                <line x1="6" y1="8" x2="10" y2="8" />
                <line x1="6" y1="12" x2="9" y2="12" />
                <line x1="6" y1="16" x2="10" y2="16" />
                <line x1="14" y1="8" x2="18" y2="8" />
                <line x1="14" y1="12" x2="17" y2="12" />
                <line x1="14" y1="16" x2="18" y2="16" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="hidden md:flex p-1.5 hover:bg-surface-3 rounded-lg text-content-3 hover:text-content-1"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
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

      <div className="flex flex-1 min-h-0 relative">
        {/* Sidebar */}
        <ProjectSidebar
          projects={projects}
          threads={threads}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          unreadThreadIds={unreadThreadIds}
          onSelectProject={setActiveProjectId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThreadFromSidebar}
          onMergeAllPrs={handleMergeAllPrsClick}
          onArchiveThread={handleArchiveThread}
          onRemoveProject={handleRemoveProject}
          onCleanupPushed={handleCleanupPushed}
          onAddProject={() => setShowAddProject(true)}
          onOpenSettings={() => setShowSettings(true)}
          mergingProjectId={mergingProjectId}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main area — pb-14 on mobile for bottom nav */}
        <div className="flex-1 flex flex-col min-w-0 pb-14 md:pb-0">
          {activeThread ? (
            <>
              <MobileThreadHeader
                thread={activeThread}
                onBack={() => {
                  setActiveThreadId(null);
                  setMobileTab("sessions");
                }}
                onSaveTitle={handleSaveTitle}
              />
              <ChatView
                ref={chatViewRef}
                messages={activeMessages}
                thread={activeThread}
                streamingText={activeStreamingText}
                streamingTool={activeStreamingTool}
                streamingToolInput={activeStreamingToolInput}
                turnEnded={activeTurnEnded}
                queuedSeqs={activeThreadId ? streaming.queuedSeqs.get(activeThreadId) : undefined}
                onSubmitAnswers={handleSendMessage}
                onSaveTitle={handleSaveTitle}
              />
              <StickyRunBar
                isRunning={isRunning}
                turnEnded={activeTurnEnded}
                currentAction={activeStreamingToolInput ? extractToolContextForBar(activeStreamingTool ?? null, activeStreamingToolInput) : null}
                currentTool={activeStreamingTool ?? null}
                metrics={activeMetrics}
                elapsedMs={activelyWorking ? Date.now() - (turnStartRef.current || Date.now()) : activeMetrics.durationMs}
                onInterrupt={handleStopThread}
                onScrollToBottom={() => chatViewRef.current?.scrollToBottom()}
                todos={activeTodos}
                queuedCount={activeThreadId ? (streaming.queuedCount.get(activeThreadId) ?? 0) : 0}
              />
              <PinnedTodoPanel
                todos={activeTodos}
                isRunning={isRunning}
                turnEnded={activeTurnEnded}
              />
              <InputBar
                agents={agents}
                thread={activeThread}
                activeProjectId={activeProjectId}
                activeProjectName={activeProject?.name ?? null}
                activeProjectBranch={activeProject?.currentBranch ?? null}
                commands={commands}
                settings={appSettings}
                history={activeInputHistory}
                pendingQuestion={pendingQuestion}
                defaultEffortLevel={defaultEffortLevel}
                defaultAgent={defaultAgent}
                onSend={handleSendMessage}
                onNewThread={handleNewThread}
                onStop={handleStopThread}
              />
              {activeThread && (
                <TerminalPanel
                  threadId={activeThread.id}
                  visible={terminalOpen}
                  connected={terminal.connected}
                  exited={terminal.exited}
                  exitCode={terminal.exitCode}
                  error={terminal.error}
                  replay={terminal.replay}
                  onInput={terminal.sendInput}
                  onResize={terminal.resize}
                  onRestart={terminal.restart}
                  onClose={() => setTerminalOpen(false)}
                  lastMessage={lastTerminalMsg}
                />
              )}
            </>
          ) : activeProject ? (
            <>
              <ProjectEmptyState
                project={activeProject}
                outstandingPrCount={activeProjectOutstandingPrCount}
                recentThreads={recentProjectThreads}
                onSelectThread={handleSelectThread}
                onMergeAllPrs={handleMergeAllPrsClick}
                mergeAllLoading={mergingProjectId === activeProject.id}
              />
              <InputBar
                agents={agents}
                thread={null}
                activeProjectId={activeProjectId}
                activeProjectName={activeProject.name}
                activeProjectBranch={activeProject.currentBranch}
                commands={commands}
                settings={appSettings}
                defaultEffortLevel={defaultEffortLevel}
                defaultAgent={defaultAgent}
                onSend={handleSendMessage}
                onNewThread={handleNewThread}
                onStop={handleStopThread}
              />
            </>
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

        {/* Mobile tab overlays — absolute within main content area, below header */}
        {mobileTab === "inbox" && (
          <div className="md:hidden absolute inset-0 z-20 bg-base overflow-y-auto"
            style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}>
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
          <div className="md:hidden absolute inset-0 z-20 bg-base overflow-y-auto"
            style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}>
            <MobileSessions
              projects={projects}
              threads={threads}
              activeThreadId={activeThreadId}
              unreadThreadIds={unreadThreadIds}
              onSelectThread={(threadId) => {
                handleSelectThread(threadId);
                setMobileTab("sessions");
              }}
              onNewThread={(projectId) => {
                setActiveProjectId(projectId);
                setActiveThreadId(null);
                setMobileTab("new");
              }}
              onArchiveThread={handleArchiveThread}
              onMergeAllPrs={handleMergeAllPrsClick}
              mergingProjectId={mergingProjectId}
            />
          </div>
        )}

        {mobileTab === "new" && (
          <div className="md:hidden absolute inset-0 z-20 bg-base overflow-y-auto"
            style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}>
            <MobileNewSession
              projects={projects}
              agents={agents}
              commands={commands}
              activeProjectId={activeProjectId}
              settings={appSettings}
              defaultEffortLevel={defaultEffortLevel}
              defaultAgent={defaultAgent}
              onNewThread={(agent, effortLevel, model, prompt, isolate, projectId, worktreeName, attachments, permissionMode, baseBranch) => {
                handleNewThread(agent, effortLevel, model, prompt, isolate, projectId, worktreeName, attachments, permissionMode, baseBranch);
                setMobileTab("sessions");
              }}
            />
          </div>
        )}
      </div>

      {/* Mobile Bottom Navigation */}
      <MobileNav
        activeTab={mobileTab}
        onTabChange={(tab) => {
          if (tab === "sessions") setActiveThreadId(null);
          setMobileTab(tab);
        }}
        attentionCount={attention.pendingCount}
      />


      {/* Add Project Dialog */}
      {showAddProject && (
        <AddProjectDialog
          onAdd={handleAddProject}
          onClose={() => setShowAddProject(false)}
        />
      )}

      {cleanupModal && (
        <CleanupConfirmationModal
          phase={cleanupModal.phase}
          preview={cleanupModal.preview}
          result={cleanupModal.result}
          onClose={handleCleanupClose}
          onConfirm={handleCleanupConfirm}
        />
      )}

      {mergeConfirmProjectId && (() => {
        const proj = projects.find((p) => p.id === mergeConfirmProjectId);
        if (!proj) return null;
        const projThreads = threads.filter((t) => t.projectId === proj.id && !t.archivedAt);
        const prCount = getEffectiveOutstandingPrCount(proj, projThreads);
        return (
          <MergeAllPrsConfirmationModal
            projectName={proj.name}
            prCount={prCount}
            loading={mergingProjectId === mergeConfirmProjectId}
            onClose={() => setMergeConfirmProjectId(null)}
            onConfirm={handleMergeAllPrsConfirm}
          />
        );
      })()}

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} agents={agents} onDefaultEffortChange={setDefaultEffortLevel} onDefaultAgentChange={setDefaultAgent} />
      )}
    </div>
  );
}

// ── Project-aware empty state with recent threads ───

const EMPTY_STATUS_DOT: Record<string, string> = {
  // "running" handled separately with a spinner element
  pending: "bg-amber-400",
  waiting: "bg-amber-400 animate-pulse",
  paused: "bg-content-3",
  done: "bg-accent/60",
  error: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]",
};

function shortenPath(path: string): string {
  const home = path.match(/^\/(?:Users|home)\/([^/]+)/);
  if (home) return path.replace(home[0], "~");
  return path;
}

function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function ProjectEmptyState({
  project,
  outstandingPrCount,
  recentThreads,
  onSelectThread,
  onMergeAllPrs,
  mergeAllLoading,
}: {
  project: ProjectWithStatus;
  outstandingPrCount: number;
  recentThreads: Thread[];
  onSelectThread: (id: string) => void;
  onMergeAllPrs: (projectId: string) => void;
  mergeAllLoading: boolean;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-8 relative overflow-y-auto">
      {/* Subtle radial glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(34,211,238,0.03)_0%,_transparent_60%)] pointer-events-none" />

      <div className="relative w-full max-w-lg space-y-6">
        {/* Project header */}
        <div className="text-center">
          <h2 className="text-2xl font-semibold tracking-tight mb-2">{project.name}</h2>
          <div className="flex items-center justify-center gap-2 text-xs text-content-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 font-mono bg-surface-3 px-2 py-0.5 rounded">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-content-3">
                <path d="M6 3L3 8l3 5M10 3l3 5-3 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {project.currentBranch}
            </span>
            <span>&middot;</span>
            <span className="font-mono truncate max-w-[240px]" title={project.path}>
              {shortenPath(project.path)}
            </span>
          </div>
          <div className="mt-2.5 text-xs text-content-3">
            {project.threadCount} thread{project.threadCount !== 1 ? "s" : ""}
            {project.activeThreadCount > 0 && (
              <span className="text-emerald-400 ml-1">&middot; {project.activeThreadCount} running</span>
            )}
            {outstandingPrCount > 0 && (
              <span className="text-amber-300 ml-1">
                &middot; {outstandingPrCount} PR{outstandingPrCount === 1 ? "" : "s"} open
              </span>
            )}
          </div>
        </div>

        {outstandingPrCount > 0 && (
          <div className="flex justify-center">
            <MergeAllPrsButton
              count={outstandingPrCount}
              busy={mergeAllLoading}
              onClick={() => onMergeAllPrs(project.id)}
            />
          </div>
        )}

        {/* Recent threads */}
        {recentThreads.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-content-3 mb-2 px-1">Recent threads</div>
            <div className="bg-surface-2/50 border border-edge-1 rounded-xl overflow-hidden divide-y divide-edge-1/50">
              {recentThreads.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSelectThread(t.id)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-3/50 text-left group transition-colors"
                >
                  {t.status === "running" ? (
                    <span className="w-2 h-2 shrink-0 rounded-full border border-emerald-400/40 border-t-emerald-400 animate-spin" />
                  ) : (
                    <span className={`w-2 h-2 shrink-0 rounded-full ${EMPTY_STATUS_DOT[t.status] ?? "bg-content-3"}`} />
                  )}
                  <span className="text-sm text-content-2 group-hover:text-content-1 truncate flex-1 transition-colors">
                    {t.title}
                  </span>
                  {t.worktree && (
                    <span className="text-[10px] font-mono bg-surface-4 px-1.5 py-0.5 rounded text-content-3 shrink-0">wt</span>
                  )}
                  <span className="text-[11px] text-content-3 shrink-0 tabular-nums">
                    {formatRelativeTime(t.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Prompt hint */}
        <p className="text-center text-[11px] text-content-3">
          Enter a prompt below to start a new thread
        </p>
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
          <OrchestraLogo size={36} color="var(--color-accent)" />
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
