import { useEffect, useState } from "react";
import type { Thread, WorktreeInfo } from "shared";
import { api } from "../hooks/useApi";
import { FilePathLink } from "./FilePathLink";
import { PrBadge } from "./PrBadge";

interface Props {
  thread: Thread;
  onClose: () => void;
}

/** "https://github.com/owner/repo/pull/123" → "owner/repo#123" */
function formatPrUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

export function resolveChangedFilePath(worktreePath: string, changedFile: string): string {
  if (changedFile.startsWith("/")) return changedFile;

  const normalizedRoot = worktreePath.replace(/\/+$/, "") || "/";
  const normalizedFile = changedFile.replace(/^\/+/, "");
  return normalizedRoot === "/" ? `/${normalizedFile}` : `${normalizedRoot}/${normalizedFile}`;
}

interface ChangedFilesListProps {
  worktreePath: string;
  changedFiles: string[];
}

export function ChangedFilesList({ worktreePath, changedFiles }: ChangedFilesListProps) {
  return (
    <ul className="space-y-0.5 text-xs max-h-48 overflow-y-auto">
      {changedFiles.map((file) => (
        <li key={file} className="truncate">
          <FilePathLink path={resolveChangedFilePath(worktreePath, file)} />
        </li>
      ))}
    </ul>
  );
}

export function ContextPanel({ thread, onClose }: Props) {
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
  const [prRefreshing, setPrRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!thread.worktree) return;
    setLoading(true);
    api
      .getWorktreeStatus(thread.id)
      .then(setWorktreeInfo)
      .catch(() => setWorktreeInfo(null))
      .finally(() => setLoading(false));
  }, [thread.id, thread.worktree]);

  const handleCreatePR = async () => {
    setPrLoading(true);
    setError(null);
    try {
      const updatedThread = await api.createPR(thread.id);
      if (updatedThread.prUrl) {
        window.open(updatedThread.prUrl, "_blank");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrLoading(false);
    }
  };

  const handleRefreshPr = async () => {
    setPrRefreshing(true);
    setError(null);
    try {
      await api.refreshPrStatus(thread.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrRefreshing(false);
    }
  };

  // Auto-refresh PR status on mount if stale (covers SPA users)
  useEffect(() => {
    const shouldRefreshKnownPr =
      !!thread.prUrl && (!thread.prStatus || thread.prStatus === "open" || thread.prStatus === "draft");
    const shouldDiscoverBranchPr = !!thread.worktree && !thread.prUrl;
    if (shouldRefreshKnownPr || shouldDiscoverBranchPr) {
      api.refreshPrStatus(thread.id).catch(() => {});
    }
  }, [thread.id, thread.prUrl, thread.prStatus, thread.worktree]);

  const handleCleanup = async () => {
    if (!confirm("Remove worktree and archive thread?")) return;
    try {
      await api.cleanupWorktree(thread.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      {/* Mobile overlay */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
        onClick={onClose}
      />
      <aside className={`
        fixed inset-x-0 bottom-0 z-50 max-h-[70vh] rounded-t-2xl
        md:static md:inset-auto md:max-h-none md:rounded-none
        w-full md:w-80 border-l-0 md:border-l border-t md:border-t-0 border-edge-1
        bg-surface-1 flex flex-col shrink-0 overflow-y-auto
      `}>
      <div className="flex items-center justify-between p-3 border-b border-edge-1">
        {/* Drag handle (mobile) */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-surface-4 md:hidden" />
        <div className="flex items-center gap-1.5 text-content-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" strokeOpacity="0.35" />
            <line x1="6" y1="8" x2="10" y2="8" />
            <line x1="6" y1="12" x2="9" y2="12" />
            <line x1="6" y1="16" x2="10" y2="16" />
            <line x1="14" y1="8" x2="18" y2="8" />
            <line x1="14" y1="12" x2="17" y2="12" />
            <line x1="14" y1="16" x2="18" y2="16" />
          </svg>
          <h3 className="text-xs font-semibold uppercase tracking-widest">
            Diff
          </h3>
        </div>
        <button onClick={onClose} className="text-content-3 hover:text-content-1 text-sm">
          Close
        </button>
      </div>

      <div className="p-3 space-y-4">
        {/* Branch info */}
        {thread.branch && (
          <Section title="Branch">
            <code className="text-sm text-accent font-mono">{thread.branch}</code>
          </Section>
        )}

        {/* Worktree path */}
        {thread.worktree && (
          <Section title="Worktree">
            <code className="text-xs text-content-2 break-all font-mono">{thread.worktree}</code>
          </Section>
        )}

        {/* Ahead/Behind + Diff Stats */}
        {worktreeInfo && (
          <Section title="Status">
            <div className="space-y-1.5">
              <div className="flex gap-3 text-sm font-mono">
                <span className="text-emerald-400">
                  +{worktreeInfo.aheadBehind.ahead} ahead
                </span>
                <span className="text-red-400">
                  -{worktreeInfo.aheadBehind.behind} behind
                </span>
              </div>
              {worktreeInfo.diffStats && (
                <div className="flex gap-3 text-sm font-mono">
                  <span className="text-emerald-400">
                    +{worktreeInfo.diffStats.insertions.toLocaleString()}
                  </span>
                  <span className="text-red-400">
                    -{worktreeInfo.diffStats.deletions.toLocaleString()}
                  </span>
                  <span className="text-content-3">lines</span>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Changed files */}
        {thread.worktree && worktreeInfo && worktreeInfo.changedFiles.length > 0 && (
          <Section title={`Changed files (${worktreeInfo.changedFiles.length})`}>
            <ChangedFilesList
              worktreePath={thread.worktree}
              changedFiles={worktreeInfo.changedFiles}
            />
          </Section>
        )}

        {loading && <p className="text-sm text-content-3">Loading worktree info...</p>}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* PR */}
        {thread.prUrl ? (
          <Section title="Pull Request">
            <div className="flex items-center gap-2">
              <PrBadge
                prUrl={thread.prUrl}
                prStatus={thread.prStatus}
                prNumber={thread.prNumber}
              />
              <a
                href={thread.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:text-accent-light font-mono truncate"
                title={thread.prUrl}
              >
                {formatPrUrl(thread.prUrl)}
              </a>
              {/* Refresh: only for open/draft/null states */}
              {(!thread.prStatus || thread.prStatus === "open" || thread.prStatus === "draft") && (
                <button
                  onClick={handleRefreshPr}
                  disabled={prRefreshing}
                  className="ml-auto shrink-0 text-content-3 hover:text-content-2 disabled:opacity-40"
                  title="Refresh PR status"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={prRefreshing ? "animate-spin" : ""}
                  >
                    <path d="M1 4v5h5" />
                    <path d="M3.51 10a6 6 0 1 0 .49-5.5L1 7.5" />
                  </svg>
                </button>
              )}
            </div>
          </Section>
        ) : (
          thread.worktree && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCreatePR}
                disabled={prLoading}
                className="flex-1 py-2 bg-surface-3 hover:bg-surface-4 border border-edge-2 disabled:opacity-40 rounded-lg text-sm font-medium text-content-1"
              >
                {prLoading ? "Creating PR..." : "Create PR"}
              </button>
              <button
                onClick={handleRefreshPr}
                disabled={prRefreshing}
                className="shrink-0 px-3 py-2 bg-surface-2 hover:bg-surface-3 border border-edge-1 disabled:opacity-40 rounded-lg text-sm text-content-2"
                title="Check for existing PR"
              >
                {prRefreshing ? "Checking..." : "Check existing PR"}
              </button>
            </div>
          )
        )}

        {/* Cleanup */}
        {thread.worktree && thread.prUrl && (
          <button
            onClick={handleCleanup}
            className="w-full py-2 bg-surface-3 hover:bg-surface-4 rounded-lg text-sm text-content-2"
          >
            Cleanup worktree
          </button>
        )}
      </div>
    </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-medium text-content-3 uppercase tracking-widest mb-1.5">
        {title}
      </h4>
      {children}
    </div>
  );
}
