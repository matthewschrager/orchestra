import { useState, useCallback } from "react";
import type { FileDiff } from "shared";
import { api } from "../hooks/useApi";
import { DiffRenderer } from "./renderers/DiffRenderer";
import { resolveChangedFilePath } from "./ContextPanel";

interface Props {
  threadId: string;
  worktreePath: string;
  changedFiles: string[];
}

export function FileDiffAccordion({ threadId, worktreePath, changedFiles }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Map<string, FileDiff>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const allExpanded = expanded.size === changedFiles.length && changedFiles.length > 0;

  const fetchDiff = useCallback(
    async (file: string) => {
      if (diffs.has(file)) return;
      setLoading((prev) => new Set(prev).add(file));
      setErrors((prev) => {
        const next = new Map(prev);
        next.delete(file);
        return next;
      });
      try {
        const diff = await api.getFileDiff(threadId, file);
        setDiffs((prev) => new Map(prev).set(file, diff));
      } catch (err) {
        setErrors((prev) => new Map(prev).set(file, (err as Error).message));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(file);
          return next;
        });
      }
    },
    [threadId, diffs],
  );

  const toggleFile = useCallback(
    (file: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(file)) {
          next.delete(file);
        } else {
          next.add(file);
          fetchDiff(file);
        }
        return next;
      });
    },
    [fetchDiff],
  );

  const toggleAll = useCallback(() => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(changedFiles));
      for (const f of changedFiles) fetchDiff(f);
    }
  }, [allExpanded, changedFiles, fetchDiff]);

  return (
    <div>
      {/* Toggle all */}
      {changedFiles.length > 1 && (
        <button
          onClick={toggleAll}
          className="text-[10px] text-content-3 hover:text-accent mb-1.5 font-mono transition-colors"
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      )}

      {/* File list */}
      <ul className="space-y-px">
        {changedFiles.map((file) => (
          <FileRow
            key={file}
            file={file}
            worktreePath={worktreePath}
            isExpanded={expanded.has(file)}
            diff={diffs.get(file)}
            isLoading={loading.has(file)}
            error={errors.get(file)}
            onToggle={toggleFile}
          />
        ))}
      </ul>
    </div>
  );
}

// ── Single file row with optional expanded diff ─────────

interface FileRowProps {
  file: string;
  worktreePath: string;
  isExpanded: boolean;
  diff: FileDiff | undefined;
  isLoading: boolean;
  error: string | undefined;
  onToggle: (file: string) => void;
}

function FileRow({ file, worktreePath, isExpanded, diff, isLoading, error, onToggle }: FileRowProps) {
  return (
    <li>
      {/* Clickable file header */}
      <button
        onClick={() => onToggle(file)}
        className="w-full flex items-center gap-1.5 py-1 px-1 -mx-1 rounded hover:bg-surface-3/50 text-left group transition-colors"
      >
        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-content-3 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
        >
          <path d="M3.5 2L6.5 5L3.5 8" />
        </svg>

        {/* File name */}
        <span className="font-mono text-xs truncate text-content-2 group-hover:text-content-1 transition-colors flex-1 min-w-0">
          {file}
        </span>

        {/* Status badge */}
        <StatusBadge diff={diff} />

        {/* Inline spinner */}
        {isLoading && (
          <span className="shrink-0 w-2.5 h-2.5 border border-accent/30 border-t-accent rounded-full animate-spin" />
        )}
      </button>

      {/* Expanded diff */}
      {isExpanded && (
        <div className="ml-3 mt-0.5 mb-1.5 file-diff-panel">
          {isLoading && !diff && (
            <div className="py-2 text-[11px] text-content-3 font-mono">Loading...</div>
          )}
          {error && (
            <div className="py-2 text-[11px] text-red-400 font-mono">{error}</div>
          )}
          {diff && diff.binary && (
            <div className="py-2 text-[11px] text-content-3 italic font-mono">Binary file — diff not available</div>
          )}
          {diff && !diff.binary && diff.oldContent === "" && diff.newContent === "" && (
            <div className="py-2 text-[11px] text-content-3 italic font-mono">No changes</div>
          )}
          {diff && !diff.binary && (diff.oldContent || diff.newContent) && (
            <DiffRenderer
              input={JSON.stringify({
                file_path: resolveChangedFilePath(worktreePath, file),
                old_string: diff.oldContent,
                new_string: diff.newContent,
              })}
              inline
            />
          )}
          {diff?.truncated && (
            <div className="px-2 py-1 text-[10px] text-content-3 border-t border-edge-1 font-mono">
              Truncated — file exceeds 200 KB
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Status badge (inferred from diff content) ──────────

function StatusBadge({ diff }: { diff: FileDiff | undefined }) {
  if (!diff || diff.binary) return null;

  if (!diff.oldContent && diff.newContent) {
    return (
      <span className="shrink-0 text-[9px] font-mono font-semibold px-1 py-px rounded bg-emerald-500/15 text-emerald-400 leading-none">
        NEW
      </span>
    );
  }
  if (diff.oldContent && !diff.newContent) {
    return (
      <span className="shrink-0 text-[9px] font-mono font-semibold px-1 py-px rounded bg-red-500/15 text-red-400 leading-none">
        DEL
      </span>
    );
  }

  return null;
}
