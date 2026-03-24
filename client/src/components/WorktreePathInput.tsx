import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi";

interface Props {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}

interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export function WorktreePathInput({ value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    try {
      const data = await api.browsePath(path);
      setCurrent(data.current);
      setParent(data.parent);
      setDirs(data.directories);
    } catch {
      // browsing failed — keep current state
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // If value looks like an absolute path, start there; otherwise start at home
    const startPath = value.startsWith("/") ? value.replace(/\/[^/]*$/, "") : undefined;
    navigate(startPath);
  };

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = () => {
    if (!current) return;
    // Preserve the last path segment (worktree name) from the current value
    const lastSlash = value.lastIndexOf("/");
    const suffix = lastSlash >= 0 ? value.slice(lastSlash + 1) : value;
    onChange(`${current}/${suffix}`);
    setOpen(false);
  };

  const inputClass = compact
    ? "text-xs bg-surface-2 border border-edge-2 rounded-lg px-2 py-1.5 text-content-2 font-mono flex-1 min-w-0"
    : "text-sm bg-surface-2 border border-edge-2 rounded-lg px-3 py-1.5 text-content-2 font-mono w-full";

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          placeholder="worktree path"
        />
        <button
          type="button"
          onClick={handleOpen}
          className={`shrink-0 bg-surface-2 border border-edge-2 rounded-lg text-content-3 hover:text-content-1 hover:border-edge-3 ${
            compact ? "px-1.5 py-1" : "px-2 py-1.5"
          } ${open ? "border-accent text-accent" : ""}`}
          title="Browse directories"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-surface-2 border border-edge-2 rounded-lg shadow-xl shadow-black/40 z-30 overflow-hidden min-w-[280px]">
          {/* Current path + up button */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-edge-2 bg-surface-1/50">
            <button
              type="button"
              onClick={() => parent && navigate(parent)}
              disabled={!parent || loading}
              className="p-0.5 rounded hover:bg-surface-3 disabled:opacity-30 text-content-2 hover:text-content-1 shrink-0"
              title="Go up"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 12V4M4 8l4-4 4 4" />
              </svg>
            </button>
            <span className="text-[11px] font-mono text-content-2 truncate" title={current ?? ""}>
              {current ?? "Loading..."}
            </span>
          </div>

          {/* Directory list */}
          <div className="max-h-48 overflow-y-auto">
            {loading && dirs.length === 0 ? (
              <div className="p-3 text-center text-xs text-content-3">Loading...</div>
            ) : dirs.length === 0 ? (
              <div className="p-3 text-center text-xs text-content-3">No subdirectories</div>
            ) : (
              dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3/60"
                  onClick={() => navigate(dir.path)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-content-3">
                    <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                  <span className="text-sm text-content-2 truncate">{dir.name}</span>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="ml-auto shrink-0 text-content-3/50">
                    <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center px-3 py-2 border-t border-edge-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-content-3 hover:text-content-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSelect}
              disabled={!current}
              className="text-xs px-3 py-1 bg-accent hover:bg-accent/80 rounded-lg text-white font-medium disabled:opacity-40"
            >
              Use this folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
