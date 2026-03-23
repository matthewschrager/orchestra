import { useState } from "react";
import type { Thread, SlashCommand } from "shared";
import { SlashCommandInput } from "./SlashCommandInput";

interface Props {
  agents: Array<{ name: string; detected: boolean }>;
  thread: Thread | null;
  activeProjectId: string | null;
  commands: SlashCommand[];
  pendingQuestion?: boolean | null;
  onSend: (content: string) => void;
  onNewThread: (agent: string, prompt: string, isolate: boolean, projectId?: string) => void;
  onStop: () => void;
}

export function InputBar({ agents, thread, activeProjectId, commands, pendingQuestion, onSend, onNewThread, onStop }: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"reply" | "new">("reply");
  const [showOptions, setShowOptions] = useState(false);
  const [agent, setAgent] = useState(agents.find((a) => a.detected)?.name ?? "claude");
  const [isolate, setIsolate] = useState(false);

  const isRunning = thread?.status === "running";

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;

    // Handle slash commands
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmd = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";

      if (cmd === "/new") {
        const prompt = args || "";
        if (prompt) {
          onNewThread(agent, prompt, isolate, activeProjectId ?? undefined);
        } else {
          setMode("new");
        }
        setInput("");
        return;
      }
      if (cmd === "/stop") {
        onStop();
        setInput("");
        return;
      }
    }

    if (mode === "new" || !thread) {
      onNewThread(agent, text, isolate, activeProjectId ?? undefined);
    } else {
      onSend(text);
    }
    setInput("");
    setMode("reply");
  };

  return (
    <div className="border-t border-edge-1 bg-surface-1 p-3 shrink-0 relative z-10">
      {/* Stop banner when running */}
      {isRunning && (
        <button
          onClick={onStop}
          className="w-full mb-2 py-1.5 bg-red-950/40 text-red-300 hover:bg-red-900/40 rounded-lg border border-red-900/20 text-xs font-medium text-center"
        >
          Stop running
        </button>
      )}

      {/* Input area */}
      <div className="flex gap-2 items-end">
        {/* New thread button */}
        {thread && mode === "reply" && (
          <button
            onClick={() => setMode("new")}
            className="p-2 hover:bg-surface-3 rounded-lg text-content-3 hover:text-accent shrink-0 self-end"
            title="New thread"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}

        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          commands={commands}
          placeholder={
            mode === "new" || !thread
              ? "Describe what you want to build..."
              : pendingQuestion
                ? "Type your answer..."
                : "Send a message..."
          }
        />

        <button
          onClick={handleSubmit}
          disabled={!input.trim()}
          className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base shrink-0"
          title={`${navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send`}
        >
          {mode === "new" && thread ? "New" : "Send"}
        </button>
      </div>

      {/* Collapsed options row — only in new-thread mode */}
      {(mode === "new" || !thread) && (
        <div className="flex items-center gap-2 mt-2">
          {thread && (
            <button
              onClick={() => setMode("reply")}
              className="text-xs text-content-3 hover:text-content-2"
            >
              &larr; Back to reply
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setShowOptions(!showOptions)}
            className="text-xs text-content-3 hover:text-content-2 flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.5 2a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM2 3.5h2a2.5 2.5 0 005 0h5v-1H9a2.5 2.5 0 00-5 0H2v1zM9.5 11a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM2 12.5h5a2.5 2.5 0 005 0h2v-1h-2a2.5 2.5 0 00-5 0H2v1z"/>
            </svg>
            Options
          </button>
        </div>
      )}

      {showOptions && (mode === "new" || !thread) && (
        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-edge-1/50">
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="text-xs bg-surface-2 border border-edge-2 rounded-lg px-2 py-1.5 text-content-2"
          >
            {agents
              .filter((a) => a.detected)
              .map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-content-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isolate}
              onChange={(e) => setIsolate(e.target.checked)}
              className="rounded"
            />
            Isolate to worktree
          </label>
        </div>
      )}
    </div>
  );
}
