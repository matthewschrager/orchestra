import type { KeyboardEvent } from "react";

interface Props {
  projectName: string;
  prCount: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const STEPS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3l2 1.5" />
      </svg>
    ),
    text: "Inspect each PR for merge conflicts and status",
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3.5h10M3 8h10M3 12.5h6" />
        <path d="M10.5 11.5 12 13l2.5-3" />
      </svg>
    ),
    text: "Resolve conflicts on each branch and push fixes",
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
      </svg>
    ),
    text: "Merge each PR via GitHub once it\u2019s clean",
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    ),
    text: "Close any PR that shouldn\u2019t merge, with an explanation",
  },
];

export function MergeAllPrsConfirmationModal({
  projectName,
  prCount,
  loading,
  onClose,
  onConfirm,
}: Props) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !loading) onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-surface-2 border border-edge-2 rounded-2xl w-full max-w-md shadow-2xl shadow-black/50 overflow-hidden">
        {/* Accent strip */}
        <div className="h-[2px] bg-gradient-to-r from-transparent via-accent/60 to-transparent" />

        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-5">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent/10 text-accent shrink-0">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-semibold">Merge all PRs</h3>
                <p className="text-xs text-content-3 mt-0.5 font-mono">{projectName}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-surface-3 text-content-3 hover:text-content-1 disabled:opacity-40 shrink-0"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          {/* Description */}
          <div className="rounded-xl border border-edge-1 bg-surface-1 p-4 mb-5">
            <p className="text-sm text-content-2 leading-relaxed">
              This launches an agent thread that will autonomously work through{" "}
              <span className="text-content-1 font-semibold tabular-nums">
                {prCount} outstanding PR{prCount === 1 ? "" : "s"}
              </span>{" "}
              and attempt to merge {prCount === 1 ? "it" : "each one"} into main.
            </p>
          </div>

          {/* Steps */}
          <div className="space-y-0 mb-6">
            <div className="text-[11px] uppercase tracking-[0.14em] text-content-3 mb-2.5 px-1">
              The agent will
            </div>
            {STEPS.map((step, i) => (
              <div key={i} className="flex items-start gap-3 py-2 px-1">
                <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-surface-3/60 text-content-3 shrink-0 mt-px">
                  {step.icon}
                </div>
                <span className="text-sm text-content-2 leading-snug pt-0.5">{step.text}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm text-content-2 hover:text-content-1 rounded-lg hover:bg-surface-3 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-wait inline-flex items-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
                  </svg>
                  Starting…
                </>
              ) : (
                <>
                  Launch agent
                  <span className="text-xs opacity-70 tabular-nums">
                    ({prCount} PR{prCount === 1 ? "" : "s"})
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
