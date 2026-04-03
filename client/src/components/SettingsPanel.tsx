import { useCallback, useEffect, useState } from "react";
import { ALL_EFFORT_OPTIONS, type EffortLevel, type ModelOption, type Settings } from "shared";
import { api } from "../hooks/useApi";
import { RemoteAccessSettings } from "./RemoteAccessSettings";

interface Props {
  onClose: () => void;
  agents?: Array<{ name: string; detected: boolean; models?: ModelOption[] }>;
  onDefaultEffortChange?: (level: EffortLevel | "") => void;
  onDefaultAgentChange?: (agent: string) => void;
  onSettingsChange?: (settings: Settings) => void;
}

interface SettingsDraft {
  worktreeRoot: string;
  inactivityTimeout: string;
  autoScrollThreads: boolean;
  defaultModelClaude: string;
  defaultModelCodex: string;
  defaultEffortLevel: EffortLevel | "";
  defaultAgent: string;
}

export function buildSettingsPatch(settings: Settings | null, draft: SettingsDraft): Partial<Settings> {
  if (!settings) return {};

  const patch: Partial<Settings> = {};
  const trimmedWorktreeRoot = draft.worktreeRoot.trim();
  if (trimmedWorktreeRoot !== settings.worktreeRoot) {
    patch.worktreeRoot = trimmedWorktreeRoot;
  }

  const timeoutNum = Number(draft.inactivityTimeout);
  if (Number.isFinite(timeoutNum) && timeoutNum >= 1 && timeoutNum !== settings.inactivityTimeoutMinutes) {
    patch.inactivityTimeoutMinutes = timeoutNum;
  }

  if (draft.autoScrollThreads !== settings.autoScrollThreads) {
    patch.autoScrollThreads = draft.autoScrollThreads;
  }
  if (draft.defaultModelClaude !== (settings.defaultModelClaude || "")) {
    patch.defaultModelClaude = draft.defaultModelClaude;
  }
  if (draft.defaultModelCodex !== (settings.defaultModelCodex || "")) {
    patch.defaultModelCodex = draft.defaultModelCodex;
  }
  if (draft.defaultEffortLevel !== settings.defaultEffortLevel) {
    patch.defaultEffortLevel = draft.defaultEffortLevel;
  }
  if (draft.defaultAgent !== settings.defaultAgent) {
    patch.defaultAgent = draft.defaultAgent;
  }

  return patch;
}

export function SettingsPanel({ onClose, agents = [], onDefaultEffortChange, onDefaultAgentChange, onSettingsChange }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [inactivityTimeout, setInactivityTimeout] = useState("30");
  const [autoScrollThreads, setAutoScrollThreads] = useState(true);
  const [defaultModelClaude, setDefaultModelClaude] = useState("");
  const [defaultModelCodex, setDefaultModelCodex] = useState("");
  const [defaultEffortLevel, setDefaultEffortLevel] = useState<EffortLevel | "">("");
  const [defaultAgent, setDefaultAgent] = useState("");
  const [detectedAgents, setDetectedAgents] = useState<Array<{ name: string; detected: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const claudeModels = agents.find((a) => a.name === "claude")?.models ?? [];
  const codexModels = agents.find((a) => a.name === "codex")?.models ?? [];

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setWorktreeRoot(s.worktreeRoot);
      setInactivityTimeout(String(s.inactivityTimeoutMinutes));
      setAutoScrollThreads(s.autoScrollThreads);
      setDefaultModelClaude(s.defaultModelClaude || "");
      setDefaultModelCodex(s.defaultModelCodex || "");
      setDefaultEffortLevel(s.defaultEffortLevel);
      setDefaultAgent(s.defaultAgent);
    }).catch((err) => setError((err as Error).message));
    api.listAgents().then((a) => setDetectedAgents(a.filter((ag) => ag.detected))).catch(console.error);
  }, []);

  const handleSave = useCallback(async () => {
    if (!worktreeRoot.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const patch = buildSettingsPatch(settings, {
        worktreeRoot,
        inactivityTimeout,
        autoScrollThreads,
        defaultModelClaude,
        defaultModelCodex,
        defaultEffortLevel,
        defaultAgent,
      });
      const updated = await api.updateSettings(patch);
      setSettings(updated);
      setWorktreeRoot(updated.worktreeRoot);
      setInactivityTimeout(String(updated.inactivityTimeoutMinutes));
      setAutoScrollThreads(updated.autoScrollThreads);
      setDefaultModelClaude(updated.defaultModelClaude || "");
      setDefaultModelCodex(updated.defaultModelCodex || "");
      setDefaultEffortLevel(updated.defaultEffortLevel);
      setDefaultAgent(updated.defaultAgent);
      onDefaultEffortChange?.(updated.defaultEffortLevel);
      onDefaultAgentChange?.(updated.defaultAgent);
      onSettingsChange?.(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [worktreeRoot, inactivityTimeout, autoScrollThreads, defaultModelClaude, defaultModelCodex, defaultEffortLevel, defaultAgent, settings, onDefaultEffortChange, onDefaultAgentChange, onSettingsChange]);

  const isDirty = settings !== null && (
    worktreeRoot.trim() !== settings.worktreeRoot ||
    (Number.isFinite(Number(inactivityTimeout)) && Number(inactivityTimeout) >= 1 && Number(inactivityTimeout) !== settings.inactivityTimeoutMinutes) ||
    autoScrollThreads !== settings.autoScrollThreads ||
    defaultModelClaude !== (settings.defaultModelClaude || "") ||
    defaultModelCodex !== (settings.defaultModelCodex || "") ||
    defaultEffortLevel !== settings.defaultEffortLevel ||
    defaultAgent !== settings.defaultAgent
  );

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="bg-surface-2 border border-edge-2 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] shadow-2xl shadow-black/50 flex flex-col">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold">Settings</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-3 text-content-3 hover:text-content-1"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {settings === null && error ? (
          <div className="py-8 text-center">
            <p className="text-sm text-red-400 mb-3">{error}</p>
            <button
              onClick={() => {
                setError(null);
                api.getSettings().then((s) => {
                  setSettings(s);
                  setWorktreeRoot(s.worktreeRoot);
                  setInactivityTimeout(String(s.inactivityTimeoutMinutes));
                  setAutoScrollThreads(s.autoScrollThreads);
                  setDefaultModelClaude(s.defaultModelClaude || "");
                  setDefaultModelCodex(s.defaultModelCodex || "");
                  setDefaultEffortLevel(s.defaultEffortLevel);
                  setDefaultAgent(s.defaultAgent);
                }).catch((err) => setError((err as Error).message));
              }}
              className="text-sm text-accent hover:text-accent-light"
            >
              Retry
            </button>
          </div>
        ) : settings === null ? (
          <div className="py-8 text-center text-sm text-content-3">Loading...</div>
        ) : (
          <>
          <div className="overflow-y-auto min-h-0 flex-1 space-y-5 pr-1">
            {/* Remote Access */}
            <RemoteAccessSettings />

            {/* Worktree Root */}
            <div>
              <label className="block text-sm font-medium text-content-2 mb-1.5">
                Default worktree directory
              </label>
              <p className="text-xs text-content-3 mb-2">
                New worktrees will be created inside this directory.
              </p>
              <input
                type="text"
                value={worktreeRoot}
                onChange={(e) => setWorktreeRoot(e.target.value)}
                placeholder="~/projects/worktrees"
                className="w-full bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-content-3"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isDirty) handleSave();
                }}
              />
            </div>

            {/* Inactivity Timeout */}
            <div>
              <label className="block text-sm font-medium text-content-2 mb-1.5">
                Inactivity timeout (minutes)
              </label>
              <p className="text-xs text-content-3 mb-2">
                Sessions are stopped if the agent produces no messages for this long. Increase for long-running sub-agent tasks.
              </p>
              <input
                type="number"
                min={1}
                value={inactivityTimeout}
                onChange={(e) => setInactivityTimeout(e.target.value)}
                placeholder="30"
                className="w-32 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-content-3"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isDirty) handleSave();
                }}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-content-2 mb-1.5">
                Thread auto-scroll
              </label>
              <p className="text-xs text-content-3 mb-2">
                Automatically keep the thread pinned to new messages and streaming output.
              </p>
              <label className="inline-flex items-center gap-3 rounded-lg border border-edge-2 bg-surface-1 px-3 py-2 text-sm text-content-1">
                <input
                  type="checkbox"
                  checked={autoScrollThreads}
                  onChange={(e) => setAutoScrollThreads(e.target.checked)}
                  className="h-4 w-4 rounded border-edge-2 bg-surface-1 text-accent focus:ring-accent"
                />
                <span>Auto-scroll threads</span>
              </label>
            </div>

            {/* Default Models */}
            {(claudeModels.length > 0 || codexModels.length > 0) && (
              <div>
                <label className="block text-sm font-medium text-content-2 mb-1.5">
                  Default model
                </label>
                <p className="text-xs text-content-3 mb-2">
                  New threads will use this model by default. You can override per-thread.
                </p>
                <div className="space-y-2">
                  {claudeModels.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-content-3 w-14">Claude</span>
                      <select
                        value={defaultModelClaude}
                        onChange={(e) => setDefaultModelClaude(e.target.value)}
                        className="flex-1 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                      >
                        <option value="">Default (SDK default)</option>
                        {claudeModels.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {codexModels.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-content-3 w-14">Codex</span>
                      <select
                        value={defaultModelCodex}
                        onChange={(e) => setDefaultModelCodex(e.target.value)}
                        className="flex-1 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                      >
                        <option value="">Default (SDK default)</option>
                        {codexModels.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Default Agent */}
            {detectedAgents.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-content-2 mb-1.5">
                  Default agent
                </label>
                <p className="text-xs text-content-3 mb-2">
                  Pre-selects the agent when creating new threads.
                </p>
                <select
                  value={defaultAgent}
                  onChange={(e) => setDefaultAgent(e.target.value)}
                  className="w-48 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                >
                  <option value="">Auto (first detected)</option>
                  {detectedAgents.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Default Effort Level */}
            <div>
              <label className="block text-sm font-medium text-content-2 mb-1.5">
                Default effort level
              </label>
              <p className="text-xs text-content-3 mb-2">
                Pre-selects the effort level when creating new threads. Ignored if unsupported by the chosen agent.
              </p>
              <select
                value={defaultEffortLevel}
                onChange={(e) => setDefaultEffortLevel(e.target.value as EffortLevel | "")}
                className="w-48 bg-surface-1 border border-edge-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              >
                <option value="">None (agent default)</option>
                {ALL_EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

          </div>

            {error && (
              <p className="text-sm text-red-400 mt-3">{error}</p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-edge-1 shrink-0">
              <div className="text-xs text-content-3">
                {saved && (
                  <span className="text-emerald-400">Saved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-content-2 hover:text-content-1 rounded-lg hover:bg-surface-3"
                >
                  Close
                </button>
                <button
                  onClick={handleSave}
                  disabled={!isDirty || saving}
                  className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
