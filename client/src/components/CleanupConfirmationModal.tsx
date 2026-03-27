import { useEffect, useMemo, useState } from "react";
import type { CleanupConfirmationCandidate } from "shared";
import { formatCleanupReason, isCleanupReasonDangerous } from "../lib/cleanup";

interface Props {
  candidates: CleanupConfirmationCandidate[];
  autoCleanedCount: number;
  skippedCount: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: (threadIds: string[]) => Promise<void>;
}

export function CleanupConfirmationModal({
  candidates,
  autoCleanedCount,
  skippedCount,
  loading,
  onClose,
  onConfirm,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedIds(new Set(
      candidates
        .filter((candidate) => candidate.defaultSelected)
        .map((candidate) => candidate.id),
    ));
  }, [candidates]);

  const selectedCount = selectedIds.size;
  const hasDangerousCandidate = useMemo(
    () => candidates.some((candidate) => isCleanupReasonDangerous(candidate.reason)),
    [candidates],
  );

  const toggle = (threadId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === "Escape" && !loading) onClose(); }}
    >
      <div className="bg-surface-2 border border-edge-2 rounded-2xl p-6 w-full max-w-2xl shadow-2xl shadow-black/50 flex flex-col max-h-[80vh]">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold mb-1">Confirm Merged Thread Cleanup</h3>
            <p className="text-sm text-content-2">
              These threads are merged, but they were not clean by the old remote-backed rule.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-lg hover:bg-surface-3 text-content-3 hover:text-content-1 disabled:opacity-40"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-xl border border-edge-2 bg-surface-1 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.14em] text-content-3">Auto-cleaned</div>
            <div className="text-xl font-semibold">{autoCleanedCount}</div>
          </div>
          <div className="rounded-xl border border-edge-2 bg-surface-1 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.14em] text-content-3">Needs review</div>
            <div className="text-xl font-semibold">{candidates.length}</div>
          </div>
          <div className="rounded-xl border border-edge-2 bg-surface-1 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.14em] text-content-3">Skipped</div>
            <div className="text-xl font-semibold">{skippedCount}</div>
          </div>
        </div>

        {hasDangerousCandidate && (
          <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Threads marked “new local commits after merge” have commits that exist only in the local worktree.
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-edge-2 bg-surface-1">
          <div className="divide-y divide-edge-1">
            {candidates.map((candidate) => {
              const checked = selectedIds.has(candidate.id);
              const dangerous = isCleanupReasonDangerous(candidate.reason);
              return (
                <label
                  key={candidate.id}
                  className={`flex items-start gap-3 px-4 py-3 cursor-pointer ${checked ? "bg-surface-1" : "bg-surface-1/60"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(candidate.id)}
                    disabled={loading}
                    className="mt-1 h-4 w-4 rounded border-edge-2 bg-surface-2 text-accent focus:ring-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-content-1 truncate">{candidate.title}</div>
                    <div className={`text-sm mt-1 ${dangerous ? "text-amber-200" : "text-content-2"}`}>
                      {formatCleanupReason(candidate.reason)}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-edge-1">
          <div className="text-sm text-content-2">
            {selectedCount} selected
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm text-content-2 hover:text-content-1 rounded-lg hover:bg-surface-3 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(Array.from(selectedIds))}
              disabled={loading || selectedCount === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium text-base bg-red-500/90 hover:bg-red-400 disabled:opacity-40"
            >
              {loading ? "Deleting..." : `Delete Selected (${selectedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
