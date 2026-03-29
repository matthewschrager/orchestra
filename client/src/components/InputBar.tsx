import { useState, useRef, useCallback, useEffect } from "react";
import { getEffortOptions, getPermissionModeOptions, getDefaultPermissionMode, type Attachment, type EffortLevel, type ModelOption, type PermissionMode, type Thread, type SlashCommand, type Settings } from "shared";
import { SlashCommandInput } from "./SlashCommandInput";
import { WorktreePathInput } from "./WorktreePathInput";
import { AttachmentPreview } from "./AttachmentPreview";
import { api } from "../hooks/useApi";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete";

interface Props {
  agents: Array<{ name: string; detected: boolean; models?: ModelOption[] }>;
  thread: Thread | null;
  activeProjectId: string | null;
  activeProjectName: string | null;
  commands: SlashCommand[];
  settings?: Settings | null;
  history?: string[];
  pendingQuestion?: boolean | null;
  defaultEffortLevel?: EffortLevel | "";
  defaultAgent?: string;
  onSend: (content: string, attachments?: Attachment[], interrupt?: boolean) => void;
  onNewThread: (agent: string, effortLevel: EffortLevel | null, model: string | null, prompt: string, isolate: boolean, projectId?: string, worktreeName?: string, attachments?: Attachment[], permissionMode?: PermissionMode | null) => void;
  onStop: () => void;
}

const MAX_ATTACHMENTS = 10;

function generateDefaultWorktreeName(projectName: string | null): string {
  const base = projectName || "project";
  const suffix = Math.random().toString(36).slice(2, 13);
  return `orchestra/${base}-${suffix}`;
}

// ── Inline feedback message per config field ──

interface FieldFeedback {
  message: string;
  type: "success" | "error";
}

function usePendingField<T extends string>(
  threadValue: T | null | undefined,
): [T | null, (v: T | null) => void] {
  const [pending, setPending] = useState<T | null>(null);
  // Clear pending when thread prop updates (WS broadcast arrived)
  useEffect(() => { setPending(null); }, [threadValue]);
  return [pending, setPending];
}

export function InputBar({ agents, thread, activeProjectId, activeProjectName, commands, settings, history, pendingQuestion, defaultEffortLevel, defaultAgent, onSend, onNewThread, onStop }: Props) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"reply" | "new">("reply");

  // ── New-thread local state ──
  const resolvedDefaultAgent = (defaultAgent && agents.some((a) => a.detected && a.name === defaultAgent)) ? defaultAgent : (agents.find((a) => a.detected)?.name ?? "claude");
  const [newAgent, setNewAgent] = useState(resolvedDefaultAgent);
  const [newEffortLevel, setNewEffortLevel] = useState<EffortLevel | "">(defaultEffortLevel ?? "");
  const [newPermissionMode, setNewPermissionMode] = useState<PermissionMode | "">(
    () => getDefaultPermissionMode(resolvedDefaultAgent, true),
  );
  const [newModel, setNewModel] = useState<string>("");
  const [isolate, setIsolate] = useState(true);
  const [worktreeName, setWorktreeName] = useState(() => generateDefaultWorktreeName(activeProjectName));
  const userChangedEffortRef = useRef(false);
  const userChangedAgentRef = useRef(false);

  // ── Active-thread pending state (optimistic updates) ──
  const [pendingModel, setPendingModel] = usePendingField(thread?.model);
  const [pendingPermission, setPendingPermission] = usePendingField(thread?.permissionMode);
  const [pendingEffort, setPendingEffort] = usePendingField(thread?.effortLevel);

  // ── Per-field inline feedback ──
  const [modelFeedback, setModelFeedback] = useState<FieldFeedback | null>(null);
  const [permissionFeedback, setPermissionFeedback] = useState<FieldFeedback | null>(null);
  const [effortFeedback, setEffortFeedback] = useState<FieldFeedback | null>(null);

  // ── File attachments ──
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // ── Derived values ──
  const isNewThread = mode === "new" || !thread;
  const isRunning = thread?.status === "running";
  const activeAgent = isNewThread ? newAgent : thread?.agent ?? "claude";
  const effortOptions = getEffortOptions(activeAgent);
  const permissionOptions = getPermissionModeOptions(activeAgent);
  const agentModels = agents.find((a) => a.name === activeAgent)?.models ?? [];

  // Display values for active thread (pending overrides thread prop)
  const displayModel = isNewThread ? newModel : (pendingModel ?? thread?.model ?? "");
  const displayPermission = isNewThread ? newPermissionMode : (pendingPermission ?? thread?.permissionMode ?? "");
  const displayEffort = isNewThread ? newEffortLevel : (pendingEffort ?? thread?.effortLevel ?? "");

  // Settings default for model label
  const settingsDefault = activeAgent === "claude" ? settings?.defaultModelClaude : activeAgent === "codex" ? settings?.defaultModelCodex : "";
  const defaultLabel = settingsDefault
    ? `Default (${agentModels.find((m) => m.value === settingsDefault)?.label ?? settingsDefault})`
    : "Default";

  const { fileSuggestions, fileLoading, handleFileQueryChange } = useFileAutocomplete(activeProjectId);

  // ── New-thread syncs ──
  useEffect(() => {
    if (!userChangedAgentRef.current && defaultAgent) {
      const valid = agents.some((a) => a.detected && a.name === defaultAgent);
      if (valid) setNewAgent(defaultAgent);
    }
  }, [defaultAgent, agents]);

  useEffect(() => {
    if (!userChangedEffortRef.current && defaultEffortLevel !== undefined) {
      setNewEffortLevel(defaultEffortLevel);
    }
  }, [defaultEffortLevel]);

  useEffect(() => {
    if (newEffortLevel && !effortOptions.some((option) => option.value === newEffortLevel)) {
      setNewEffortLevel(defaultEffortLevel && effortOptions.some((o) => o.value === defaultEffortLevel) ? defaultEffortLevel : "");
    }
  }, [newEffortLevel, effortOptions, defaultEffortLevel]);

  useEffect(() => {
    if (isNewThread) setNewPermissionMode(getDefaultPermissionMode(newAgent, isolate));
  }, [newAgent, isNewThread]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (newModel && !agentModels.some((m) => m.value === newModel)) {
      setNewModel("");
    }
  }, [newAgent, newModel, agentModels]);

  // ── Active thread config change handlers ──
  const showFeedback = (setter: typeof setModelFeedback, feedback: FieldFeedback) => {
    setter(feedback);
    setTimeout(() => setter(null), feedback.type === "error" ? 4000 : 3000);
  };

  const handleActiveModelChange = async (value: string) => {
    if (!thread) return;
    setPendingModel(value as typeof pendingModel);
    try {
      await api.updateThread(thread.id, { model: value || null });
      showFeedback(setModelFeedback, { message: "Next turn", type: "success" });
    } catch (err) {
      setPendingModel(null);
      const msg = (err as Error).message;
      showFeedback(setModelFeedback, {
        message: msg.includes("mid-turn") ? "Wait for idle" : "Failed to update",
        type: "error",
      });
    }
  };

  const handleActivePermissionChange = async (value: string) => {
    if (!thread) return;
    setPendingPermission(value as typeof pendingPermission);
    try {
      await api.updateThread(thread.id, { permissionMode: (value || null) as PermissionMode | null });
      const isIdle = thread.status !== "running";
      showFeedback(setPermissionFeedback, {
        message: isIdle ? "Active now" : "Next turn",
        type: "success",
      });
    } catch (err) {
      setPendingPermission(null);
      showFeedback(setPermissionFeedback, { message: "Failed to update", type: "error" });
    }
  };

  const handleActiveEffortChange = async (value: string) => {
    if (!thread) return;
    setPendingEffort(value as typeof pendingEffort);
    try {
      await api.updateThread(thread.id, { effortLevel: (value || null) as EffortLevel | null });
      showFeedback(setEffortFeedback, { message: "Next session", type: "success" });
    } catch (err) {
      setPendingEffort(null);
      showFeedback(setEffortFeedback, { message: "Failed to update", type: "error" });
    }
  };

  // ── File upload handlers ──
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
      e.target.value = "";
    },
    [uploadFiles],
  );

  // ── Submit handler ──
  const handleSubmit = (interrupt?: boolean) => {
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
          onNewThread(newAgent, newEffortLevel || null, newModel || null, prompt, isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined, undefined, newPermissionMode || null);
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

    if (isNewThread) {
      onNewThread(newAgent, newEffortLevel || null, newModel || null, text || "(see attached files)", isolate, activeProjectId ?? undefined, isolate ? worktreeName : undefined, currentAttachments, newPermissionMode || null);
    } else {
      onSend(text || "(see attached files)", currentAttachments, interrupt);
    }
    setInput("");
    setAttachments([]);
    setMode("reply");
    // Reset new-thread state (not active-thread config — that persists via DB)
    userChangedEffortRef.current = false;
    userChangedAgentRef.current = false;
    setNewEffortLevel(defaultEffortLevel ?? "");
    setNewAgent(resolvedDefaultAgent);
    if (isolate) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
  };

  // ── Render ──
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

      {/* ── Config row — always visible ── */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        {/* Back to reply (only in new-thread mode when thread exists) */}
        {isNewThread && thread && (
          <button
            onClick={() => setMode("reply")}
            className="text-[11px] text-content-3 hover:text-content-2 mr-1"
          >
            &larr; Reply
          </button>
        )}

        {/* Agent — dropdown for new thread, badge for active */}
        {isNewThread ? (
          <ConfigChip icon={<IconAgent />} title="Agent">
            <select
              value={newAgent}
              onChange={(e) => { userChangedAgentRef.current = true; setNewAgent(e.target.value); }}
              className="config-select"
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
          </ConfigChip>
        ) : (
          <span className={`text-[11px] font-medium pl-1.5 pr-2 py-0.5 rounded-md inline-flex items-center gap-1 ${
            activeAgent === "codex"
              ? "bg-cyan-400/10 text-cyan-400"
              : "bg-amber-400/10 text-amber-400"
          }`} title="Agent (read-only)">
            <IconAgent />
            {activeAgent}
          </span>
        )}

        <ConfigDivider />

        {/* Model dropdown */}
        {agentModels.length > 0 && (
          <ConfigChip icon={<IconModel />} feedback={modelFeedback} title="Model">
            <select
              value={displayModel}
              onChange={(e) => isNewThread ? setNewModel(e.target.value) : handleActiveModelChange(e.target.value)}
              className="config-select"
              aria-label="Model"
            >
              <option value="">{defaultLabel}</option>
              {agentModels.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </ConfigChip>
        )}

        <ConfigDivider />

        {/* Permissions dropdown */}
        <ConfigChip icon={<IconShield />} feedback={permissionFeedback} title="Permissions">
          <select
            value={displayPermission}
            onChange={(e) => isNewThread
              ? setNewPermissionMode(e.target.value as PermissionMode | "")
              : handleActivePermissionChange(e.target.value)}
            className="config-select"
            aria-label="Permission mode"
          >
            {permissionOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.description}>
                {option.label}
              </option>
            ))}
          </select>
        </ConfigChip>

        <ConfigDivider />

        {/* Effort dropdown */}
        <ConfigChip icon={<IconGauge />} feedback={effortFeedback} title="Effort">
          <select
            value={displayEffort}
            onChange={(e) => isNewThread
              ? (() => { userChangedEffortRef.current = true; setNewEffortLevel(e.target.value as EffortLevel | ""); })()
              : handleActiveEffortChange(e.target.value)}
            className="config-select"
            aria-label="Effort level"
          >
            <option value="">Default</option>
            {effortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </ConfigChip>

        {/* Isolate checkbox — new-thread only */}
        {isNewThread && (
          <>
            <ConfigDivider />
            <label className="flex items-center gap-1.5 text-[11px] text-content-3 hover:text-content-2 cursor-pointer transition-colors px-1">
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => {
                  setIsolate(e.target.checked);
                  if (e.target.checked) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
                  setNewPermissionMode(getDefaultPermissionMode(newAgent, e.target.checked));
                }}
                className="rounded"
              />
              Worktree
            </label>
            {isolate && (
              <WorktreePathInput value={worktreeName} onChange={setWorktreeName} compact />
            )}
          </>
        )}
      </div>

      {/* ── Input area ── */}
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
            isNewThread
              ? "Describe what you want to build..."
              : pendingQuestion
                ? "Type your answer..."
                : "Send a message..."
          }
          fileSuggestions={fileSuggestions}
          fileLoading={fileLoading}
          onFileQueryChange={handleFileQueryChange}
        />

        {/* Send button */}
        <button
          onClick={() => handleSubmit()}
          disabled={uploading || (!input.trim() && attachments.length === 0)}
          className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium shrink-0 border border-transparent"
          title={isRunning
            ? "Enter to queue message · ⌘Enter to interrupt agent"
            : "Enter to send, Shift+Enter for newline"}
        >
          {mode === "new" && thread ? "New" : "Send"}
        </button>

        {/* Stop button */}
        {isRunning && (
          <button
            onClick={onStop}
            className="relative p-2 rounded-lg shrink-0 self-end group"
            aria-label="Stop agent"
            title="Stop running"
          >
            <span className="absolute inset-0 rounded-lg border border-accent/40 animate-[stop-pulse_2s_ease-in-out_infinite]" />
            <svg width="16" height="16" viewBox="0 0 16 16" className="relative text-accent group-hover:text-accent-light transition-colors">
              <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Config chip: icon + select + feedback indicator ──

function ConfigChip({ icon, feedback, title, children }: {
  icon: React.ReactNode;
  feedback?: FieldFeedback | null;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="relative inline-flex items-center gap-0.5 rounded-md hover:bg-surface-2 transition-colors group"
      title={title}
    >
      <span className="text-content-3 group-hover:text-content-2 transition-colors pl-1.5 shrink-0 pointer-events-none">
        {icon}
      </span>
      {children}
      {/* Feedback dot + text */}
      {feedback && (
        <span className={`text-[9px] font-medium pr-1 shrink-0 animate-[fade-in_150ms_ease-out] ${
          feedback.type === "success" ? "text-emerald-400" : "text-red-400"
        }`}>
          {feedback.message}
        </span>
      )}
    </span>
  );
}

function ConfigDivider() {
  return <span className="w-px h-3.5 bg-edge-1 shrink-0 mx-0.5" />;
}

// ── Config icons (12px, stroke-based, matching app icon style) ──

function IconAgent() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="3" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  );
}

function IconModel() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 5h2v2H5zM9 5h2v2H9zM5 9h2v2H5zM9 9h2v2H9z" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z" />
    </svg>
  );
}

function IconGauge() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14A6 6 0 1 1 8 2a6 6 0 0 1 0 12z" />
      <path d="M8 5v3l2 1" />
    </svg>
  );
}
