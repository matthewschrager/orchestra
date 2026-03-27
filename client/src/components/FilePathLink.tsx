import { useState, useCallback } from "react";
import { shortenPath } from "../lib/fileUtils";

interface FilePathLinkProps {
  path: string;
  line?: number;
  col?: number;
}

/** Whether we're running on localhost (vscode:// links only work locally) */
function isLocalhost(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Build a vscode:// URI for opening a file at an optional line/col */
function buildVscodeUrl(path: string, line?: number, col?: number): string {
  let url = `vscode://file${path}`;
  if (line != null) {
    url += `:${line}`;
    if (col != null) url += `:${col}`;
  }
  return url;
}

/**
 * Clickable file path that opens in VS Code on localhost,
 * or copies path to clipboard on remote connections.
 */
export function FilePathLink({ path, line, col }: FilePathLinkProps) {
  const [copied, setCopied] = useState(false);
  const local = isLocalhost();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may fail in insecure contexts
    }
  }, [path]);

  if (local) {
    return (
      <a
        href={buildVscodeUrl(path, line, col)}
        title="Open in VS Code"
        className="font-mono text-xs truncate text-content-2 hover:text-accent transition-colors"
      >
        {shortenPath(path)}
        <span className="ml-1 text-content-3 text-[10px]">↗</span>
      </a>
    );
  }

  // Remote: show path with copy-on-click
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy path"}
      className="font-mono text-xs truncate text-content-2 hover:text-accent transition-colors text-left"
    >
      {shortenPath(path)}
      <span className="ml-1 text-content-3 text-[10px]">{copied ? "✓" : "⎘"}</span>
    </button>
  );
}
