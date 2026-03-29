import { useCallback, useEffect, useRef, useState } from "react";
import { getEffortOptions, type Attachment, type EffortLevel, type ModelOption, type ProjectWithStatus, type Settings, type SlashCommand } from "shared";
import { api } from "../hooks/useApi";
import { AttachmentPreview } from "./AttachmentPreview";
import { SlashCommandInput } from "./SlashCommandInput";
import { WorktreePathInput } from "./WorktreePathInput";

const MAX_ATTACHMENTS = 10;

interface MobileNewSessionProps {
  projects: ProjectWithStatus[];
  agents: Array<{ name: string; detected: boolean; models?: ModelOption[] }>;
  commands: SlashCommand[];
  activeProjectId: string | null;
  settings?: Settings | null;
  onNewThread: (
    agent: string,
    effortLevel: EffortLevel | null,
    model: string | null,
    prompt: string,
    isolate: boolean,
    projectId: string,
    worktreeName?: string,
    attachments?: Attachment[],
  ) => void;
}

export function MobileNewSession({
  projects,
  agents,
  commands,
  activeProjectId,
  settings,
  onNewThread,
}: MobileNewSessionProps) {
  const detectedAgents = agents.filter((agent) => agent.detected);
  const defaultAgent = detectedAgents[0]?.name ?? "claude";
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId);
  const [selectedAgent, setSelectedAgent] = useState(defaultAgent);
  const [effortLevel, setEffortLevel] = useState<EffortLevel | "">("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [isolate, setIsolate] = useState(true);
  const [worktreeName, setWorktreeName] = useState(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    const suffix = Math.random().toString(36).slice(2, 13);
    return `orchestra/${project?.name ?? "project"}-${suffix}`;
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const effortOptions = getEffortOptions(selectedAgent);
  const agentModels = agents.find((a) => a.name === selectedAgent)?.models ?? [];
  const settingsDefault = selectedAgent === "claude" ? settings?.defaultModelClaude : selectedAgent === "codex" ? settings?.defaultModelCodex : "";
  const defaultModelLabel = settingsDefault
    ? `Default (${agentModels.find((m) => m.value === settingsDefault)?.label ?? settingsDefault})`
    : "Default";

  useEffect(() => {
    if (effortLevel && !effortOptions.some((option) => option.value === effortLevel)) {
      setEffortLevel("");
    }
  }, [effortLevel, effortOptions]);

  useEffect(() => {
    if (selectedModel && !agentModels.some((m) => m.value === selectedModel)) {
      setSelectedModel("");
    }
  }, [selectedAgent, selectedModel, agentModels]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadFile(file)));
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
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }

      if (files.length > 0) {
        e.preventDefault();
        uploadFiles(files);
      }
    },
    [uploadFiles],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      uploadFiles(files);
      e.target.value = "";
    },
    [uploadFiles],
  );

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="text-4xl mb-3 opacity-50">+</div>
        <div className="text-content-2 font-medium">No projects</div>
        <div className="text-content-3 text-sm mt-1">
          Add a project from the sidebar first.
        </div>
      </div>
    );
  }

  const hasContent = prompt.trim() || attachments.length > 0;

  const handleSubmit = () => {
    if (uploading || !hasContent || !selectedProjectId) return;
    const currentAttachments = attachments.length > 0 ? attachments : undefined;
    onNewThread(
      selectedAgent,
      effortLevel || null,
      selectedModel || null,
      prompt.trim() || "(see attached files)",
      isolate,
      selectedProjectId,
      isolate ? worktreeName : undefined,
      currentAttachments,
    );
    setPrompt("");
    setAttachments([]);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-lg font-semibold text-content-1 mb-3">New Session</h2>

        {/* Project selector */}
        <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
          Project
        </label>
        <div className="space-y-1.5 mb-4">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => {
                setSelectedProjectId(project.id);
                if (isolate) {
                  const suffix = Math.random().toString(36).slice(2, 13);
                  setWorktreeName(`orchestra/${project.name}-${suffix}`);
                }
              }}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                selectedProjectId === project.id
                  ? "border-accent bg-accent/10 text-content-1"
                  : "border-edge-1 bg-surface-1 text-content-2 hover:border-edge-2"
              }`}
            >
              <div className="text-sm font-medium">{project.name}</div>
              <div className="text-[10px] text-content-3 font-mono mt-0.5">
                {project.currentBranch}
                {project.activeThreadCount > 0 && (
                  <span className="text-emerald-400 ml-2">{project.activeThreadCount} running</span>
                )}
              </div>
            </button>
          ))}
        </div>

      </div>

      {/* Prompt area */}
      {selectedProject && (
        <div className="flex flex-col px-4 pb-4">
          <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
            Prompt
          </label>

          {uploadError && (
            <div className="mb-2 rounded-lg border border-red-500/20 bg-red-950/30 px-3 py-1.5 text-xs text-red-400">
              {uploadError}
            </div>
          )}

          {attachments.length > 0 && (
            <AttachmentPreview
              attachments={attachments}
              onRemove={removeAttachment}
              uploading={uploading}
            />
          )}

          <div className="flex items-end gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center self-end rounded-lg p-2 text-content-3 hover:bg-surface-3 hover:text-accent"
              title="Attach file (or paste)"
              disabled={uploading}
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
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

            <div className="flex-1">
              <SlashCommandInput
                value={prompt}
                onChange={setPrompt}
                onSubmit={handleSubmit}
                onPaste={handlePaste}
                commands={commands}
                placeholder={`What should the agent do in ${selectedProject.name}?`}
                rows={4}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-3">
            <div>
              <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
                Agent
              </label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="w-full min-h-[44px] bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm text-content-2 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                aria-label="Agent"
              >
                {detectedAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            {agentModels.length > 0 && (
              <div>
                <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
                  Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full min-h-[44px] bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm text-content-2 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                  aria-label="Model"
                >
                  <option value="">{defaultModelLabel}</option>
                  {agentModels.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-content-3 uppercase tracking-wider mb-1.5 block">
                Effort
              </label>
              <select
                value={effortLevel}
                onChange={(e) => setEffortLevel(e.target.value as EffortLevel | "")}
                className="w-full min-h-[44px] bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm text-content-2 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                aria-label="Effort level"
              >
                <option value="">Default</option>
                {effortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-content-2">
                <input
                  type="checkbox"
                  checked={isolate}
                  onChange={(e) => {
                    setIsolate(e.target.checked);
                    if (e.target.checked) {
                      const suffix = Math.random().toString(36).slice(2, 13);
                      setWorktreeName(`orchestra/${selectedProject?.name ?? "project"}-${suffix}`);
                    }
                  }}
                  className="rounded"
                />
                Isolate to worktree
              </label>
              <button
                onClick={handleSubmit}
                disabled={uploading || !hasContent || !selectedProjectId}
                className="min-h-[44px] rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-40"
              >
                Start Session
              </button>
            </div>
            {isolate && (
              <WorktreePathInput value={worktreeName} onChange={setWorktreeName} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
