import { useEffect, useMemo, useState } from "react";
import type {
  CleanupConfirmationCandidate,
  CleanupPushedResponse,
  CleanupThreadSummary,
} from "shared";
import { formatCleanupReason, isCleanupReasonDangerous } from "../lib/cleanup";

// ── Types ──────────────────────────────────────────────

type ModalPhase = "loading" | "preview" | "executing" | "complete";

interface CleanupPreview {
  willClean: CleanupThreadSummary[];
  needsReview: CleanupConfirmationCandidate[];
  skipped: CleanupPushedResponse["skipped"];
}

interface CleanupResult {
  cleanedCount: number;
  skippedCount: number;
  leftUntouched: CleanupPushedResponse["skipped"];
}

interface Props {
  phase: ModalPhase;
  preview: CleanupPreview | null;
  result: CleanupResult | null;
  onClose: () => void;
  onConfirm: (confirmedThreadIds: string[]) => void;
}

// ── Spinner ────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin h-8 w-8 text-content-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Collapsible section ────────────────────────────────

function CollapsibleSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (count === 0) return null;

  return (
    <div className="mb-3 last:mb-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-content-3 hover:text-content-2 mb-1.5 w-full"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4z" />
        </svg>
        {title} ({count})
      </button>
      {open && children}
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────

export function CleanupConfirmationModal({
  phase,
  preview,
  result,
  onClose,
  onConfirm,
}: Props) {
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(new Set());

  // Initialize review selections from preview defaults
  useEffect(() => {
    if (!preview) return;
    setSelectedReviewIds(new Set(
      preview.needsReview
        .filter((c) => c.defaultSelected)
        .map((c) => c.id),
    ));
  }, [preview]);

  const hasDangerousCandidate = useMemo(
    () => preview?.needsReview.some((c) => isCleanupReasonDangerous(c.reason)) ?? false,
    [preview],
  );

  const totalToDelete = (preview?.willClean.length ?? 0) + selectedReviewIds.size;
  const busy = phase === "loading" || phase === "executing";

  const toggleReview = (threadId: string) => {
    setSelectedReviewIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}
    >
      <div className="bg-surface-2 border border-edge-2 rounded-2xl p-6 w-full max-w-2xl shadow-2xl shadow-black/50 flex flex-col max-h-[80vh]">
        {/* ── Loading state ── */}
        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <Spinner />
            <p className="text-sm text-content-3">Scanning threads…</p>
          </div>
        )}

        {/* ── Preview state ── */}
        {phase === "preview" && preview && (
          <PreviewContent
            preview={preview}
            selectedReviewIds={selectedReviewIds}
            hasDangerousCandidate={hasDangerousCandidate}
            totalToDelete={totalToDelete}
            onToggleReview={toggleReview}
            onClose={onClose}
            onConfirm={() => onConfirm(Array.from(selectedReviewIds))}
          />
        )}

        {/* ── Executing state ── */}
        {phase === "executing" && preview && (
          <PreviewContent
            preview={preview}
            selectedReviewIds={selectedReviewIds}
            hasDangerousCandidate={hasDangerousCandidate}
            totalToDelete={totalToDelete}
            onToggleReview={toggleReview}
            onClose={onClose}
            onConfirm={() => {}}
            executing
          />
        )}

        {/* ── Complete state ── */}
        {phase === "complete" && result && (
          <CompleteContent result={result} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

// ── Preview / Executing content ────────────────────────

function PreviewContent({
  preview,
  selectedReviewIds,
  hasDangerousCandidate,
  totalToDelete,
  onToggleReview,
  onClose,
  onConfirm,
  executing = false,
}: {
  preview: CleanupPreview;
  selectedReviewIds: Set<string>;
  hasDangerousCandidate: boolean;
  totalToDelete: number;
  onToggleReview: (id: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  executing?: boolean;
}) {
  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <h3 className="text-lg font-semibold">Clean Up Merged Threads</h3>
        <button
          onClick={onClose}
          disabled={executing}
          className="p-1.5 rounded-lg hover:bg-surface-3 text-content-3 hover:text-content-1 disabled:opacity-40"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Will delete" value={preview.willClean.length} />
        <StatCard label="Needs review" value={preview.needsReview.length} />
        <StatCard label="Won't touch" value={preview.skipped.length} />
      </div>

      {hasDangerousCandidate && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          ⚠ Threads with "new local commits after merge" have commits that exist only in the local worktree.
        </div>
      )}

      {/* Scrollable thread lists */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {/* Will delete — informational, always deleted */}
        <CollapsibleSection
          title="Will delete"
          count={preview.willClean.length}
          defaultOpen={preview.willClean.length <= 8}
        >
          <div className="rounded-xl border border-edge-2 bg-surface-1 divide-y divide-edge-1">
            {preview.willClean.map((t) => (
              <div key={t.id} className="px-4 py-2.5 flex items-center gap-3">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400 shrink-0">
                  <path d="M3 8l4 4 6-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-sm text-content-1 truncate">{t.title}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Needs review — checkboxes */}
        <CollapsibleSection
          title="Needs review"
          count={preview.needsReview.length}
          defaultOpen={true}
        >
          <div className="rounded-xl border border-edge-2 bg-surface-1 divide-y divide-edge-1">
            {preview.needsReview.map((c) => {
              const checked = selectedReviewIds.has(c.id);
              const dangerous = isCleanupReasonDangerous(c.reason);
              return (
                <label
                  key={c.id}
                  className={`flex items-start gap-3 px-4 py-2.5 cursor-pointer ${checked ? "" : "opacity-60"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleReview(c.id)}
                    disabled={executing}
                    className="mt-0.5 h-4 w-4 rounded border-edge-2 bg-surface-2 text-accent focus:ring-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-content-1 truncate">{c.title}</div>
                    <div className={`text-xs mt-0.5 ${dangerous ? "text-amber-200" : "text-content-3"}`}>
                      {formatCleanupReason(c.reason)}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </CollapsibleSection>

        {/* Won't touch — info only */}
        <CollapsibleSection
          title="Won't touch"
          count={preview.skipped.length}
          defaultOpen={false}
        >
          <div className="rounded-xl border border-edge-2 bg-surface-1 divide-y divide-edge-1">
            {preview.skipped.map((s) => (
              <div key={s.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-sm text-content-2 truncate flex-1">{s.title}</span>
                <span className="text-xs text-content-3 shrink-0">{formatCleanupReason(s.reason)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-edge-1">
        <div className="text-sm text-content-2">
          {totalToDelete} thread{totalToDelete !== 1 ? "s" : ""} will be deleted
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            disabled={executing}
            className="px-4 py-2 text-sm text-content-2 hover:text-content-1 rounded-lg hover:bg-surface-3 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={executing || totalToDelete === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-500/90 hover:bg-red-400 disabled:opacity-40 min-w-[120px] flex items-center justify-center gap-2"
          >
            {executing ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Cleaning…
              </>
            ) : (
              `Delete (${totalToDelete})`
            )}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Complete content ───────────────────────────────────

function CompleteContent({
  result,
  onClose,
}: {
  result: CleanupResult;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-4">
        <h3 className="text-lg font-semibold">Cleanup Complete</h3>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-surface-3 text-content-3 hover:text-content-1"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div className="space-y-3 mb-6">
        {result.cleanedCount > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/10 px-4 py-3">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400 shrink-0">
              <path d="M3 8l4 4 6-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-sm text-green-100">
              {result.cleanedCount} thread{result.cleanedCount !== 1 ? "s" : ""} cleaned up
            </span>
          </div>
        )}
        {result.skippedCount > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-edge-2 bg-surface-1 px-4 py-3">
            <span className="text-sm text-content-2">
              {result.skippedCount} thread{result.skippedCount !== 1 ? "s" : ""} left untouched
            </span>
          </div>
        )}
      </div>

      {result.leftUntouched.length > 0 && (
        <CollapsibleSection
          title="Left untouched"
          count={result.leftUntouched.length}
          defaultOpen={result.leftUntouched.length <= 5}
        >
          <div className="rounded-xl border border-edge-2 bg-surface-1 divide-y divide-edge-1 mb-4">
            {result.leftUntouched.map((s) => (
              <div key={s.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-sm text-content-2 truncate flex-1">{s.title}</span>
                <span className="text-xs text-content-3 shrink-0">{formatCleanupReason(s.reason)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      <div className="flex justify-end pt-4 border-t border-edge-1">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-medium text-content-1 bg-surface-3 hover:bg-surface-3/80"
        >
          Done
        </button>
      </div>
    </>
  );
}

// ── Stat card ──────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-edge-2 bg-surface-1 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.14em] text-content-3">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
