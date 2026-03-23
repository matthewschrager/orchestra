import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Thread } from "shared";
import { useWebSocket } from "./hooks/useWebSocket";
import { api } from "./hooks/useApi";
import { ThreadSidebar } from "./components/ThreadSidebar";
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
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [agents, setAgents] = useState<Array<{ name: string; detected: boolean; version: string | null }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscribedRef = useRef<string | null>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeMessages = (activeThreadId ? messages.get(activeThreadId) : null) ?? [];

  // ── WebSocket ───────────────────────────────────────

  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: Message) => {
      setMessages((prev) => {
        const existing = prev.get(msg.threadId) ?? [];
        // Dedupe by seq
        if (existing.some((m) => m.seq === msg.seq)) return prev;
        const next = new Map(prev);
        next.set(msg.threadId, [...existing, msg]);
        return next;
      });
    }, []),
    onThreadUpdate: useCallback((thread: Thread) => {
      setThreads((prev) =>
        prev.map((t) => (t.id === thread.id ? thread : t)),
      );
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

  const handleNewThread = async (agent: string, prompt: string, isolate: boolean) => {
    try {
      setError(null);
      const thread = await api.createThread({ agent, prompt, isolate });
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setSidebarOpen(false);
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
        <h1 className="text-lg font-semibold tracking-tight">Orchestra</h1>
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
        <ThreadSidebar
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={(id) => {
            setActiveThreadId(id);
            setSidebarOpen(false);
          }}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeThread ? (
            <>
              <ChatView messages={activeMessages} thread={activeThread} />
              <InputBar
                agents={agents}
                thread={activeThread}
                onSend={handleSendMessage}
                onNewThread={handleNewThread}
                onStop={handleStopThread}
              />
            </>
          ) : (
            <EmptyState
              agents={agents}
              onNewThread={handleNewThread}
            />
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
    </div>
  );
}

function EmptyState({
  agents,
  onNewThread,
}: {
  agents: Array<{ name: string; detected: boolean }>;
  onNewThread: (agent: string, prompt: string, isolate: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(false);
  const defaultAgent = agents.find((a) => a.detected)?.name ?? "claude";

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-2">Orchestra</h2>
        <p className="text-slate-400">Start a new thread to begin</p>
      </div>
      <div className="w-full max-w-xl">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What would you like to build?"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm resize-none h-32 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-slate-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
              onNewThread(defaultAgent, prompt.trim(), isolate);
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
                onNewThread(defaultAgent, prompt.trim(), isolate);
                setPrompt("");
              }
            }}
            disabled={!prompt.trim()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium"
          >
            Start with {defaultAgent}
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
