import { useState, useRef, useCallback, useEffect } from "react";
import { getEffortOptions, type Attachment, type EffortLevel, type Thread, type SlashCommand } from "shared";
import { SlashCommandInput } from "./SlashCommandInput";
import { WorktreePathInput } from "./WorktreePathInput";
import { AttachmentPreview } from "./AttachmentPreview";
import { api } from "../hooks/useApi";

interface Props {
  agents: Array<{ name: string; detected: boolean }>;
  thread: Thread | null;
  activeProjectId: string | null;
  activeProjectName: string | null;
  commands: SlashCommand[];
  history?: string[];
  pendingQuestion?: boolean | null;
  onSend: (content: string, attachments?: Attachment[], interrupt?: boolean) => void;
  onNewThread: (agent: string, effortLevel: EffortLevel | null, prompt: string, isolate: boolean, projectId?: string, worktreeName?: string, attachments?: Attachment[]) => void;
  onStop: () => void;
}

const MAX_ATTACHMENTS = 10;

function generateDefaultWorktreeName(projectName: string | null): string {
  const base = projectName || "project";
  const suffix = Math.random().toString(36).slice(2, 13);
  return `orchestra/${base}-${suffix}`;
}

export function InputBar({ agents, thread, activeProjectId, activeProjectName, commands, history, pendingQuestion, onSend, onNewThread, onStop }: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"reply" | "new">("reply");
  const [agent, setAgent] = useState(agents.find((a) => a.detected)?.name ?? "claude");
  const [effortLevel, setEffortLevel] = useState<EffortLevel | "">("");
  const [isolate, setIsolate] = useState(true);
  const [worktreeName, setWorktreeName] = useState(() => generateDefaultWorktreeName(activeProjectName));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const isRunning = thread?.status === "running";
  const effortOptions = getEffortOptions(agent);

  useEffect(() => {
    if (effortLevel && !effortOptions.some((option) => option.value === effortLevel)) {
      setEffortLevel("");
    }
  }, [effortLevel, effortOptions]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(
        files.map((f) => api.uploadFile(f)),
      );
      setAttachments((prev) => {
        const combined = [...prev, ...uploaded];
        if (combined.length > MAX_ATTACHMENTS) {
          setUploadError(`Max ${MAX_ATTACHMENTS} attachments per message`);
          setTimeout(() => setUploadError(null), 4000);
          return combined.slice(0, MAX_ATTACHMENTS);
        }
        return combined;
      });
    } catch (err) {
      setUploadError((err as Error).message);
      setTimeout(() => setUploadError(null), 4000);
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        uploadFiles(files);
      }
    },
    [uploadFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragOver(false);
      const files: File[] = [];
      for (const item of e.dataTransfer.items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      uploadFiles(files);
    },
    [uploadFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      uploadFiles(files);
      // Reset so same file can be selected again
      e.target.value = "";
    },
    [uploadFiles],
  );

  const handleSubmit = () => {
    if (uploading) return;
    const text = input.trim();
    const hasAttachments = attachments.length > 0;
    if (!text && !hasAttachments) return;

    // Handle slash commands (only if no attachments)
    if (text.startsWith("/") && !hasAttachments) {
      const spaceIdx = text.indexOf(" ");
      const cmd = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";

      if (cmd === "/new") {
        const prompt = args || "";
        if (prompt) {
          onNewThread(agent, effortLevel || null, prompt, isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined);
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

    const currentAttachments = hasAttachments ? attachments : undefined;

    if (mode === "new" || !thread) {
      onNewThread(agent, effortLevel || null, text || "(see attached files)", isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined, currentAttachments);
    } else {
      onSend(text || "(see attached files)", currentAttachments);
    }
    setInput("");
    setAttachments([]);
    setMode("reply");
    if (isolate) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
  };

  return (
    <div
      className={`border-t bg-surface-1 p-3 shrink-0 relative z-10 transition-colors ${
        dragOver ? "border-accent bg-accent/5" : "border-edge-1"
      }`}
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent rounded-lg z-20 pointer-events-none">
          <span className="text-accent font-medium text-sm">Drop files here</span>
        </div>
      )}

      {/* Upload error toast */}
      {uploadError && (
        <div className="mb-2 text-xs text-red-400 bg-red-950/30 border border-red-500/20 rounded-lg px-3 py-1.5">
          {uploadError}
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <AttachmentPreview
          attachments={attachments}
          onRemove={removeAttachment}
          uploading={uploading}
        />
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

        {/* Attach file button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 hover:bg-surface-3 rounded-lg text-content-3 hover:text-accent shrink-0 self-end"
          title="Attach file (or paste/drag-drop)"
          disabled={uploading}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5L9 3.5a2 2 0 013 3L6.5 12a.5.5 0 01-1-1L11 5.5" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept="image/*,.pdf,.txt,.csv,.md,.json,.xml,.html,.css,.js,.ts"
        />

        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          commands={commands}
          history={history}
          placeholder={
            mode === "new" || !thread
              ? "Describe what you want to build..."
              : pendingQuestion
                ? "Type your answer..."
                : "Send a message..."
          }
        />

        {/* Send button — always visible */}
        <button
          onClick={handleSubmit}
          disabled={uploading || (!input.trim() && attachments.length === 0)}
          className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base shrink-0 border border-transparent"
          title="Enter to send, Shift+Enter for newline"
        >
          {mode === "new" && thread ? "New" : "Send"}
        </button>

        {/* Stop button — shown alongside Send when agent is running */}
        {isRunning && (
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
        )}
      </div>

      {/* Thread options — always visible in new-thread mode */}
      {(mode === "new" || !thread) && (
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          {thread && (
            <button
              onClick={() => setMode("reply")}
              className="text-xs text-content-3 hover:text-content-2"
            >
              &larr; Back to reply
            </button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-content-2">
            <span className="text-content-3">Agent</span>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="text-xs bg-surface-2 border border-edge-2 rounded-lg px-2 py-1.5 text-content-2"
              aria-label="Agent"
            >
              {agents
                .filter((a) => a.detected)
                .map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-content-2">
            <span className="text-content-3">Effort</span>
            <select
              value={effortLevel}
              onChange={(e) => setEffortLevel(e.target.value as EffortLevel | "")}
              className="text-xs bg-surface-2 border border-edge-2 rounded-lg px-2 py-1.5 text-content-2"
              aria-label="Effort level"
            >
              <option value="">Default</option>
              {effortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
            <WorktreePathInput value={worktreeName} onChange={setWorktreeName} compact />
          )}
        </div>
      )}
    </div>
  );
}
