import { useState } from "react";
import type { Thread, SlashCommand } from "shared";
import { SlashCommandInput } from "./SlashCommandInput";

interface Props {
  agents: Array<{ name: string; detected: boolean }>;
  thread: Thread | null;
  activeProjectId: string | null;
  activeProjectName: string | null;
  commands: SlashCommand[];
  pendingQuestion?: boolean | null;
  onSend: (content: string) => void;
  onNewThread: (agent: string, prompt: string, isolate: boolean, projectId?: string, worktreeName?: string) => void;
  onStop: () => void;
}

function generateDefaultWorktreeName(projectName: string | null): string {
  const base = projectName || "project";
  const suffix = Math.random().toString(36).slice(2, 13);
  return `${base}-${suffix}`;
}

export function InputBar({ agents, thread, activeProjectId, activeProjectName, commands, pendingQuestion, onSend, onNewThread, onStop }: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"reply" | "new">("reply");
  const [showOptions, setShowOptions] = useState(false);
  const [agent, setAgent] = useState(agents.find((a) => a.detected)?.name ?? "claude");
  const [isolate, setIsolate] = useState(false);
  const [worktreeName, setWorktreeName] = useState(() => generateDefaultWorktreeName(activeProjectName));

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
          onNewThread(agent, prompt, isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined);
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
      onNewThread(agent, text, isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined);
    } else {
      onSend(text);
    }
    setInput("");
    setMode("reply");
    if (isolate) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
  };

  return (
    <div className="border-t border-edge-1 bg-surface-1 p-3 shrink-0 relative z-10">
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
                : isRunning
                  ? "Agent is working..."
                  : "Send a message..."
          }
        />

        {isRunning ? (
          <button
            onClick={onStop}
            className="relative p-2 rounded-lg shrink-0 self-end group"
            aria-label="Stop agent"
            title="Stop running"
          >
            {/* Pulse ring */}
            <span className="absolute inset-0 rounded-lg border border-accent/40 animate-[stop-pulse_2s_ease-in-out_infinite]" />
            {/* Stop icon — rounded square */}
            <svg width="16" height="16" viewBox="0 0 16 16" className="relative text-accent group-hover:text-accent-light transition-colors">
              <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base shrink-0"
            title={`${navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send`}
          >
            {mode === "new" && thread ? "New" : "Send"}
          </button>
        )}
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
              onChange={(e) => {
                setIsolate(e.target.checked);
                if (e.target.checked) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
              }}
              className="rounded"
            />
            Isolate to worktree
          </label>
          {isolate && (
            <input
              type="text"
              value={worktreeName}
              onChange={(e) => setWorktreeName(e.target.value)}
              className="text-xs bg-surface-2 border border-edge-2 rounded-lg px-2 py-1.5 text-content-2 font-mono flex-1 min-w-0"
              placeholder="worktree name"
            />
          )}
        </div>
      )}
    </div>
  );
}
