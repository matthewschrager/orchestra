import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  threadTitle: string;
  hasWorktree: boolean;
  branchName: string | null;
  onConfirm: (cleanupWorktree: boolean) => void;
  onCancel: () => void;
}

export function ArchiveConfirmationModal({
  threadTitle,
  hasWorktree,
  branchName,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = useCallback(
    (cleanup: boolean) => {
      if (submitting) return;
      setSubmitting(true);
      onConfirm(cleanup);
    },
    [submitting, onConfirm],
  );

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      // Focus trap: keep Tab within the dialog
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const displayBranch = branchName?.replace(/^orchestra\//, "") ?? null;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Archive thread confirmation"
        className="bg-surface-2 border border-edge-2 rounded-2xl p-6 w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-red-500/10 text-red-400 shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-content-1">Archive thread</h3>
            <p className="text-xs text-content-3 mt-0.5 truncate" title={threadTitle}>
              {threadTitle}
            </p>
          </div>
        </div>

        {/* Body */}
        {hasWorktree ? (
          <div className="space-y-3 mb-6">
            <p className="text-sm text-content-2">
              This thread has an associated worktree{displayBranch && (
                <> on branch <code className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-violet-300 font-mono">{displayBranch}</code></>
              )}. How would you like to archive it?
            </p>

            {/* Option: archive + cleanup */}
            <button
              onClick={() => handleConfirm(true)}
              disabled={submitting}
              className="w-full text-left p-3 rounded-lg border border-edge-2 hover:border-red-500/50 hover:bg-red-500/5 transition-colors group disabled:opacity-40"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-content-1 group-hover:text-red-400">
                  Archive &amp; delete worktree
                </span>
              </div>
              <p className="text-xs text-content-3">
                Removes the thread, worktree directory, and local branch.
              </p>
            </button>

            {/* Option: archive only */}
            <button
              onClick={() => handleConfirm(false)}
              disabled={submitting}
              className="w-full text-left p-3 rounded-lg border border-edge-2 hover:border-accent/50 hover:bg-accent/5 transition-colors group disabled:opacity-40"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-content-1 group-hover:text-accent">
                  Archive only
                </span>
              </div>
              <p className="text-xs text-content-3">
                Removes the thread but keeps the worktree and branch on disk.
              </p>
            </button>
          </div>
        ) : (
          <p className="text-sm text-content-2 mb-6">
            Are you sure you want to archive this thread? This can't be undone.
          </p>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm text-content-2 hover:bg-surface-3 rounded-lg transition-colors"
          >
            Cancel
          </button>
          {!hasWorktree && (
            <button
              onClick={() => handleConfirm(false)}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-500/90 hover:bg-red-400 transition-colors disabled:opacity-40"
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
