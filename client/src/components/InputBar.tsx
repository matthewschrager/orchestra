import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { getEffortOptions, getPermissionModeOptions, getPermissionModeLabel, getDefaultPermissionMode, type Attachment, type EffortLevel, type EffortOption, type ModelOption, type PermissionMode, type PermissionOption, type Thread, type SlashCommand, type Settings } from "shared";
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
  const [mobileConfigExpanded, setMobileConfigExpanded] = useState(false);

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

      {/* ── Mobile config: collapsed summary → expandable panel ── */}
      <MobileConfigPanel
        expanded={mobileConfigExpanded}
        onToggle={() => setMobileConfigExpanded((v) => !v)}
        isNewThread={isNewThread}
        thread={thread}
        activeAgent={activeAgent}
        agents={agents}
        newAgent={newAgent}
        setNewAgent={(v) => { userChangedAgentRef.current = true; setNewAgent(v); }}
        agentModels={agentModels}
        displayModel={displayModel}
        defaultLabel={defaultLabel}
        onModelChange={(v) => isNewThread ? setNewModel(v) : handleActiveModelChange(v)}
        modelFeedback={modelFeedback}
        displayPermission={displayPermission}
        permissionOptions={permissionOptions}
        onPermissionChange={(v) => isNewThread
          ? setNewPermissionMode(v as PermissionMode | "")
          : handleActivePermissionChange(v)}
        permissionFeedback={permissionFeedback}
        displayEffort={displayEffort}
        effortOptions={effortOptions}
        onEffortChange={(v) => isNewThread
          ? (() => { userChangedEffortRef.current = true; setNewEffortLevel(v as EffortLevel | ""); })()
          : handleActiveEffortChange(v)}
        effortFeedback={effortFeedback}
        isolate={isolate}
        onIsolateChange={(checked) => {
          setIsolate(checked);
          if (checked) setWorktreeName(generateDefaultWorktreeName(activeProjectName));
          setNewPermissionMode(getDefaultPermissionMode(newAgent, checked));
        }}
        worktreeName={worktreeName}
        setWorktreeName={setWorktreeName}
        mode={mode}
        setMode={setMode}
      />

      {/* ── Desktop config row — hidden on mobile ── */}
      <div className="hidden md:flex items-center gap-1 mb-2 flex-wrap ml-10">
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
        <ConfigChip icon={<IconBrain />} feedback={effortFeedback} title="Effort">
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
  const chipRef = useRef<HTMLSpanElement>(null);

  // Auto-size contained <select> to fit its currently selected option text
  useLayoutEffect(() => {
    const select = chipRef.current?.querySelector("select");
    if (!select) return;
    const text = select.options[select.selectedIndex]?.text ?? "";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = getComputedStyle(select).font;
    const textWidth = Math.ceil(ctx.measureText(text).width);
    select.style.width = `${textWidth + 18}px`; // 18px = left pad + chevron space
  });

  return (
    <span
      ref={chipRef}
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

function IconBrain() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v13" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
    </svg>
  );
}

function IconChevron({ up }: { up?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${up ? "rotate-180" : ""}`}>
      <path d="M2.5 3.75l2.5 2.5 2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Mobile config: collapsed summary bar → expandable 2×2 grid ──

interface MobileConfigPanelProps {
  expanded: boolean;
  onToggle: () => void;
  isNewThread: boolean;
  thread: Thread | null;
  activeAgent: string;
  agents: Array<{ name: string; detected: boolean; models?: ModelOption[] }>;
  newAgent: string;
  setNewAgent: (v: string) => void;
  agentModels: ModelOption[];
  displayModel: string;
  defaultLabel: string;
  onModelChange: (v: string) => void;
  modelFeedback: FieldFeedback | null;
  displayPermission: string;
  permissionOptions: readonly PermissionOption[];
  onPermissionChange: (v: string) => void;
  permissionFeedback: FieldFeedback | null;
  displayEffort: string;
  effortOptions: readonly EffortOption[];
  onEffortChange: (v: string) => void;
  effortFeedback: FieldFeedback | null;
  isolate: boolean;
  onIsolateChange: (checked: boolean) => void;
  worktreeName: string;
  setWorktreeName: (v: string) => void;
  mode: "reply" | "new";
  setMode: (m: "reply" | "new") => void;
}

function MobileConfigPanel({
  expanded, onToggle, isNewThread, thread, activeAgent, agents,
  newAgent, setNewAgent, agentModels, displayModel, defaultLabel,
  onModelChange, modelFeedback, displayPermission, permissionOptions,
  onPermissionChange, permissionFeedback, displayEffort, effortOptions,
  onEffortChange, effortFeedback, isolate, onIsolateChange,
  worktreeName, setWorktreeName, mode, setMode,
}: MobileConfigPanelProps) {
  // Derive short labels for summary
  const modelLabel = agentModels.find((m) => m.value === displayModel)?.label ?? "Default";
  const permLabel = getPermissionModeLabel(displayPermission || null, activeAgent) ?? "Default";
  // Shorten "Bypass (auto-approve all)" → "Bypass", "Accept Edits" → "Accept Edits"
  const shortPermLabel = permLabel.replace(/\s*\(.*\)/, "");
  const effortLabel = effortOptions.find((o) => o.value === displayEffort)?.label ?? "Default";

  return (
    <div className="md:hidden mb-2">
      {/* Back to reply (only in new-thread mode when thread exists) */}
      {isNewThread && thread && (
        <button
          onClick={() => setMode("reply")}
          className="text-[11px] text-content-3 hover:text-content-2 mb-1.5 px-1"
        >
          &larr; Reply
        </button>
      )}

      {/* Collapsed: full-width summary bar */}
      {!expanded && (
        <button
          onClick={onToggle}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-edge-1 hover:border-edge-2 transition-colors text-left"
          aria-label="Expand thread config"
        >
          <div className="flex items-center gap-1.5 text-[11px] text-content-2 min-w-0 overflow-hidden">
            <span className={`font-medium shrink-0 ${
              activeAgent === "codex" ? "text-cyan-400" : "text-amber-400"
            }`}>{activeAgent}</span>
            <span className="text-content-3">·</span>
            <span className="truncate">{modelLabel}</span>
            <span className="text-content-3">·</span>
            <span className="truncate">{shortPermLabel}</span>
            <span className="text-content-3">·</span>
            <span className="shrink-0">{effortLabel}</span>
          </div>
          <span className="text-content-3 shrink-0">
            <IconChevron />
          </span>
        </button>
      )}

      {/* Expanded: labeled 2×2 grid */}
      {expanded && (
        <div className="rounded-lg bg-surface-2 border border-edge-1 overflow-hidden animate-[slideUp_150ms_ease-out]">
          <div className="grid grid-cols-2 gap-2 p-3">
            {/* Agent */}
            <MobileConfigField label="Agent" icon={<IconAgent />} feedback={null}>
              {isNewThread ? (
                <select
                  value={newAgent}
                  onChange={(e) => setNewAgent(e.target.value)}
                  className="mobile-config-select"
                  aria-label="Agent"
                >
                  {agents.filter((a) => a.detected).map((a) => (
                    <option key={a.name} value={a.name}>{a.name}</option>
                  ))}
                </select>
              ) : (
                <span className={`text-xs font-medium px-2 py-1.5 rounded-md ${
                  activeAgent === "codex"
                    ? "bg-cyan-400/10 text-cyan-400"
                    : "bg-amber-400/10 text-amber-400"
                }`}>{activeAgent}</span>
              )}
            </MobileConfigField>

            {/* Model */}
            {agentModels.length > 0 ? (
              <MobileConfigField label="Model" icon={<IconModel />} feedback={modelFeedback}>
                <select
                  value={displayModel}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="mobile-config-select"
                  aria-label="Model"
                >
                  <option value="">{defaultLabel}</option>
                  {agentModels.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </MobileConfigField>
            ) : <div />}

            {/* Permissions */}
            <MobileConfigField label="Permissions" icon={<IconShield />} feedback={permissionFeedback}>
              <select
                value={displayPermission}
                onChange={(e) => onPermissionChange(e.target.value)}
                className="mobile-config-select"
                aria-label="Permission mode"
              >
                {permissionOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </MobileConfigField>

            {/* Effort */}
            <MobileConfigField label="Effort" icon={<IconBrain />} feedback={effortFeedback}>
              <select
                value={displayEffort}
                onChange={(e) => onEffortChange(e.target.value)}
                className="mobile-config-select"
                aria-label="Effort level"
              >
                <option value="">Default</option>
                {effortOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </MobileConfigField>
          </div>

          {/* Isolate — new thread only */}
          {isNewThread && (
            <div className="px-3 pb-2.5 border-t border-edge-1 pt-2.5">
              <label className="flex items-center gap-2 text-xs text-content-3 hover:text-content-2 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={isolate}
                  onChange={(e) => onIsolateChange(e.target.checked)}
                  className="rounded"
                />
                Worktree isolation
              </label>
              {isolate && (
                <div className="mt-2">
                  <WorktreePathInput value={worktreeName} onChange={setWorktreeName} compact />
                </div>
              )}
            </div>
          )}

          {/* Collapse button */}
          <button
            onClick={onToggle}
            className="w-full flex items-center justify-center gap-1 py-1.5 text-[11px] text-content-3 hover:text-content-2 border-t border-edge-1 transition-colors"
          >
            Collapse
            <IconChevron up />
          </button>
        </div>
      )}
    </div>
  );
}

function MobileConfigField({ label, icon, feedback, children }: {
  label: string;
  icon: React.ReactNode;
  feedback: FieldFeedback | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="text-content-3">{icon}</span>
        <span className="text-[10px] font-medium text-content-3 uppercase tracking-wide">{label}</span>
        {feedback && (
          <span className={`text-[9px] font-medium animate-[fade-in_150ms_ease-out] ${
            feedback.type === "success" ? "text-emerald-400" : "text-red-400"
          }`}>
            {feedback.message}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
