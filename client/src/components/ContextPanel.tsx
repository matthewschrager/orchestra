import { useEffect, useState } from "react";
import type { Thread, WorktreeInfo } from "shared";
import { api } from "../hooks/useApi";

interface Props {
  thread: Thread;
  onClose: () => void;
}

export function ContextPanel({ thread, onClose }: Props) {
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
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
      const { prUrl } = await api.createPR(thread.id);
      window.open(prUrl, "_blank");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrLoading(false);
    }
  };

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
        className="fixed inset-0 bg-black/50 z-40 md:hidden"
        onClick={onClose}
      />
      <aside className={`
        fixed inset-x-0 bottom-0 z-50 max-h-[70vh] rounded-t-2xl
        md:static md:inset-auto md:max-h-none md:rounded-none
        w-full md:w-80 border-l-0 md:border-l border-t md:border-t-0 border-slate-800
        bg-slate-900 flex flex-col shrink-0 overflow-y-auto
      `}>
      <div className="flex items-center justify-between p-3 border-b border-slate-800">
        {/* Drag handle (mobile) */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-slate-700 md:hidden" />
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
          Context
        </h3>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-sm">
          Close
        </button>
      </div>

      <div className="p-3 space-y-4">
        {/* Branch info */}
        {thread.branch && (
          <Section title="Branch">
            <code className="text-sm text-indigo-400">{thread.branch}</code>
          </Section>
        )}

        {/* Worktree path */}
        {thread.worktree && (
          <Section title="Worktree">
            <code className="text-xs text-slate-400 break-all">{thread.worktree}</code>
          </Section>
        )}

        {/* Ahead/Behind */}
        {worktreeInfo && (
          <Section title="Status">
            <div className="flex gap-3 text-sm">
              <span className="text-emerald-400">
                +{worktreeInfo.aheadBehind.ahead} ahead
              </span>
              <span className="text-red-400">
                -{worktreeInfo.aheadBehind.behind} behind
              </span>
            </div>
          </Section>
        )}

        {/* Changed files */}
        {worktreeInfo && worktreeInfo.changedFiles.length > 0 && (
          <Section title={`Changed files (${worktreeInfo.changedFiles.length})`}>
            <ul className="space-y-0.5 text-xs font-mono text-slate-300 max-h-48 overflow-y-auto">
              {worktreeInfo.changedFiles.map((f) => (
                <li key={f} className="truncate">
                  {f}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {loading && <p className="text-sm text-slate-500">Loading worktree info...</p>}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* PR */}
        {thread.prUrl ? (
          <Section title="Pull Request">
            <a
              href={thread.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-400 hover:underline break-all"
            >
              {thread.prUrl}
            </a>
          </Section>
        ) : (
          thread.worktree && (
            <button
              onClick={handleCreatePR}
              disabled={prLoading}
              className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium"
            >
              {prLoading ? "Creating PR..." : "Create PR"}
            </button>
          )
        )}

        {/* Cleanup */}
        {thread.worktree && thread.prUrl && (
          <button
            onClick={handleCleanup}
            className="w-full py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
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
      <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">
        {title}
      </h4>
      {children}
    </div>
  );
}
