import { useState } from "react";
import type { Thread } from "shared";

interface Props {
  agents: Array<{ name: string; detected: boolean }>;
  thread: Thread | null;
  onSend: (content: string) => void;
  onNewThread: (agent: string, prompt: string, isolate: boolean) => void;
  onStop: () => void;
}

export function InputBar({ agents, thread, onSend, onNewThread, onStop }: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"reply" | "new">("reply");
  const [agent, setAgent] = useState(agents.find((a) => a.detected)?.name ?? "claude");
  const [isolate, setIsolate] = useState(false);

  const isRunning = thread?.status === "running";

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;

    if (mode === "new" || !thread) {
      onNewThread(agent, text, isolate);
    } else {
      onSend(text);
    }
    setInput("");
    setMode("reply");
  };

  return (
    <div className="border-t border-slate-800 p-3 shrink-0">
      {/* Mode toggle / agent selector */}
      <div className="flex items-center gap-2 mb-2">
        {thread && (
          <div className="flex text-xs">
            <button
              onClick={() => setMode("reply")}
              className={`px-2 py-1 rounded-l border border-slate-700 ${
                mode === "reply" ? "bg-slate-700 text-white" : "text-slate-400"
              }`}
            >
              Reply
            </button>
            <button
              onClick={() => setMode("new")}
              className={`px-2 py-1 rounded-r border border-l-0 border-slate-700 ${
                mode === "new" ? "bg-slate-700 text-white" : "text-slate-400"
              }`}
            >
              + New
            </button>
          </div>
        )}

        {(mode === "new" || !thread) && (
          <>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300"
            >
              {agents
                .filter((a) => a.detected)
                .map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                className="rounded"
              />
              Worktree
            </label>
          </>
        )}

        <div className="flex-1" />

        {isRunning && (
          <button
            onClick={onStop}
            className="text-xs px-2 py-1 bg-red-900/50 text-red-300 hover:bg-red-900 rounded"
          >
            Stop
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            mode === "new" || !thread
              ? "Describe what you want to build..."
              : "Send a message..."
          }
          rows={2}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-slate-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim()}
          className="self-end px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium shrink-0"
        >
          Send
        </button>
      </div>
      <p className="text-xs text-slate-600 mt-1">
        {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send
      </p>
    </div>
  );
}
