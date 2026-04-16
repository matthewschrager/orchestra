import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDefaultPermissionMode, getPermissionModeLabel, type AgentStatus, type Thread } from "shared";

interface Props {
  thread: Thread;
  agents: AgentStatus[];
  queuedCount: number;
  pendingAttentionCount: number;
  onConfirm: (nextAgent: string) => Promise<void>;
  onCancel: () => void;
}

export function SwitchAgentModal({
  thread,
  agents,
  queuedCount,
  pendingAttentionCount,
  onConfirm,
  onCancel,
}: Props) {
  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.detected && agent.name !== thread.agent),
    [agents, thread.agent],
  );
  const [selectedAgent, setSelectedAgent] = useState(availableAgents[0]?.name ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const nextPermissionModeLabel = selectedAgent
    ? getPermissionModeLabel(getDefaultPermissionMode(selectedAgent, Boolean(thread.worktree)), selectedAgent)
    : null;

  const handleConfirm = useCallback(async () => {
    if (!selectedAgent || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(selectedAgent);
    } catch (err) {
      setSubmitting(false);
      setError((err as Error).message);
    }
  }, [onConfirm, selectedAgent, submitting]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!submitting) onCancel();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel, submitting]);

  if (availableAgents.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => !submitting && onCancel()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch agent"
        className="w-full max-w-lg rounded-2xl border border-edge-2 bg-surface-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-edge-1 px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-accent/10 p-2 text-accent shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 3h5v5" />
                <path d="M8 21H3v-5" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-content-1">Switch agent in this thread</h3>
              <p className="mt-1 text-sm text-content-3">
                The worktree and transcript stay here. The next agent turn starts fresh.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-content-3">Choose agent</div>
            <div className="space-y-2">
              {availableAgents.map((agent) => {
                const selected = selectedAgent === agent.name;
                return (
                  <button
                    key={agent.name}
                    type="button"
                    disabled={submitting}
                    onClick={() => setSelectedAgent(agent.name)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      selected
                        ? "border-accent/50 bg-accent/10"
                        : "border-edge-2 bg-surface-3 hover:border-accent/30"
                    } ${submitting ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-content-1">{agent.name}</span>
                      {selected && <span className="text-xs font-medium text-accent">Selected</span>}
                    </div>
                    {agent.version && (
                      <div className="mt-1 text-xs text-content-3">{agent.version}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <InfoCard title="Preserved" body="Worktree, branch, PR metadata, terminal, and visible history stay on this thread." />
            <InfoCard title="Discarded" body={`${queuedCount} queued message${queuedCount === 1 ? "" : "s"} and ${pendingAttentionCount} pending approval${pendingAttentionCount === 1 ? "" : "s"} are cleared.`} />
            <InfoCard title="Reset" body={`Model clears, permission mode resets to ${nextPermissionModeLabel ?? "the new default"}, and unsupported effort falls back.`} />
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
            The new agent will not automatically know earlier context from this thread. Previous messages stay visible for you, but the new session starts without that conversation history.
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-950/30 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge-1 px-6 py-4">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-sm text-content-2 hover:bg-surface-3 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedAgent || submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-light disabled:opacity-40"
          >
            {submitting ? "Switching..." : `Switch to ${selectedAgent}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-edge-1 bg-surface-3/70 px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-content-3">{title}</div>
      <div className="mt-1 text-sm text-content-2">{body}</div>
    </div>
  );
}
