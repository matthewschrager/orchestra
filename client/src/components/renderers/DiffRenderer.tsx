import { useState } from "react";

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
}

interface ParsedDiff {
  filePath: string;
  additions: number;
  removals: number;
  lines: DiffLine[];
}

export function parseDiff(input: string | null): ParsedDiff | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const filePath = parsed.file_path || parsed.filePath || "";
    const oldStr: string = parsed.old_string || parsed.oldString || "";
    const newStr: string = parsed.new_string || parsed.newString || "";
    if (!filePath) return null;

    const oldLines = oldStr.split("\n");
    const newLines = newStr.split("\n");
    const lines: DiffLine[] = [];
    let additions = 0;
    let removals = 0;

    // Simple line-by-line diff: show removed lines then added lines
    // For single-line changes, interleave; for multi-line, show blocks
    if (oldLines.length === 1 && newLines.length === 1) {
      if (oldStr) {
        lines.push({ type: "remove", content: oldLines[0] });
        removals++;
      }
      if (newStr) {
        lines.push({ type: "add", content: newLines[0] });
        additions++;
      }
    } else {
      for (const line of oldLines) {
        lines.push({ type: "remove", content: line });
        removals++;
      }
      for (const line of newLines) {
        lines.push({ type: "add", content: line });
        additions++;
      }
    }

    return { filePath, additions, removals, lines };
  } catch {
    return null;
  }
}

interface Props {
  input: string | null;
}

export function DiffRenderer({ input }: Props) {
  const [expanded, setExpanded] = useState(false);
  const diff = parseDiff(input);

  if (!diff) {
    // Fallback: raw JSON
    if (!input) return null;
    return (
      <pre className="renderer-block renderer-body text-xs overflow-x-auto">
        {formatJson(input)}
      </pre>
    );
  }

  const needsTruncation = diff.lines.length > 12 && !expanded;
  const displayLines = needsTruncation ? diff.lines.slice(0, 12) : diff.lines;

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <span className="font-mono text-xs truncate">{shortenPath(diff.filePath)}</span>
        <span className="flex items-center gap-2 text-[11px] shrink-0">
          {diff.additions > 0 && <span className="text-diff-add">+{diff.additions}</span>}
          {diff.removals > 0 && <span className="text-diff-remove">−{diff.removals}</span>}
        </span>
      </div>
      <div className="renderer-body overflow-x-auto">
        {displayLines.map((line, i) => (
          <div
            key={i}
            className={`diff-line ${
              line.type === "add"
                ? "diff-line-add"
                : line.type === "remove"
                  ? "diff-line-remove"
                  : "diff-line-context"
            }`}
          >
            <span className="diff-gutter" aria-hidden="true">
              {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
            </span>
            <span className="diff-content">{line.content || " "}</span>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-center text-[11px] text-content-3 hover:text-content-2 py-1.5 border-t border-edge-1"
        >
          Show all {diff.lines.length} lines
        </button>
      )}
    </div>
  );
}

function shortenPath(p: string): string {
  if (!p || !p.includes("/")) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-3).join("/");
}

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
