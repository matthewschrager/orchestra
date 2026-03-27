import { useState, useEffect, useRef } from "react";
import { computeDiff, type DiffLine } from "../../lib/diffCompute";
import { getHighlighter, detectLanguage } from "../../lib/shiki";
import type { ThemedToken } from "shiki";
import { FilePathLink } from "../FilePathLink";

// ── Parser (pure — no diff computation) ────────────────────

export interface ParsedDiff {
  filePath: string;
  oldString: string;
  newString: string;
  language: string;
  /** @deprecated — kept for backward compat. Use computeDiff() in component. */
  additions: number;
  /** @deprecated — kept for backward compat. Use computeDiff() in component. */
  removals: number;
  /** @deprecated — kept for backward compat. Use computeDiff() in component. */
  lines: DiffLine[];
}

export function parseDiff(input: string | null): ParsedDiff | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const filePath = parsed.file_path || parsed.filePath || "";
    const oldString: string = parsed.old_string || parsed.oldString || "";
    const newString: string = parsed.new_string || parsed.newString || "";
    if (!filePath) return null;

    const language = detectLanguage(filePath);
    // Compute diff eagerly for backward-compat fields
    const diff = computeDiff(oldString, newString);

    return {
      filePath,
      oldString,
      newString,
      language,
      additions: diff.additions,
      removals: diff.removals,
      lines: diff.lines,
    };
  } catch {
    return null;
  }
}

// ── Context collapsing ────────────────────────────────────

type DisplayChunk =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "collapsed"; count: number };

/** Lines of context to show around each change hunk */
const CONTEXT_LINES = 3;

/** After context collapsing, truncate if visible lines exceed this */
const MAX_VISIBLE_LINES = 40;
/** When truncated, show this many visible lines */
const INITIAL_VISIBLE_LINES = 25;

/**
 * Collapse unchanged context lines, keeping only `contextSize` lines
 * around each changed region. Returns chunks of visible lines
 * interspersed with "N hidden lines" separators.
 */
function collapseContextLines(
  allLines: DiffLine[],
  contextSize: number = CONTEXT_LINES,
): DisplayChunk[] {
  if (allLines.length === 0) return [];
  // No context lines to collapse (pure add/remove, e.g. new file)
  if (!allLines.some((l) => l.type === "context")) {
    return [{ type: "lines", lines: allLines }];
  }

  // Mark which lines to show (changed lines + surrounding context)
  const show = new Array<boolean>(allLines.length).fill(false);
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].type !== "context") {
      const start = Math.max(0, i - contextSize);
      const end = Math.min(allLines.length - 1, i + contextSize);
      for (let j = start; j <= end; j++) show[j] = true;
    }
  }

  const chunks: DisplayChunk[] = [];
  let i = 0;
  while (i < allLines.length) {
    if (show[i]) {
      const visible: DiffLine[] = [];
      while (i < allLines.length && show[i]) {
        visible.push(allLines[i]);
        i++;
      }
      chunks.push({ type: "lines", lines: visible });
    } else {
      let count = 0;
      while (i < allLines.length && !show[i]) {
        count++;
        i++;
      }
      chunks.push({ type: "collapsed", count });
    }
  }
  return chunks;
}

function countVisibleLines(chunks: DisplayChunk[]): number {
  return chunks.reduce(
    (sum, c) => sum + (c.type === "lines" ? c.lines.length : 0),
    0,
  );
}

/** Truncate chunks to at most maxLines visible lines.
 *  Strips any trailing collapsed separators — they'd misleadingly imply
 *  only unchanged lines follow when the truncation actually cut off changes. */
function truncateChunks(
  chunks: DisplayChunk[],
  maxLines: number,
): DisplayChunk[] {
  const result: DisplayChunk[] = [];
  let remaining = maxLines;

  for (const chunk of chunks) {
    if (remaining <= 0) break;
    if (chunk.type === "collapsed") {
      result.push(chunk);
      continue;
    }
    if (chunk.lines.length <= remaining) {
      result.push(chunk);
      remaining -= chunk.lines.length;
    } else {
      result.push({ type: "lines", lines: chunk.lines.slice(0, remaining) });
      remaining = 0;
    }
  }
  // Strip trailing collapsed separators
  while (result.length > 0 && result[result.length - 1].type === "collapsed") {
    result.pop();
  }
  return result;
}

// ── Component ──────────────────────────────────────────────

interface Props {
  input: string | null;
  /** When true, skip the renderer-header (ToolLine provides the header) */
  inline?: boolean;
}

export function DiffRenderer({ input, inline }: Props) {
  const [showAll, setShowAll] = useState(false);
  const parsed = parseDiff(input);

  // Async syntax highlighting
  const tokens = useShikiTokens(
    parsed?.oldString ?? "",
    parsed?.newString ?? "",
    parsed?.language ?? "text",
  );

  if (!parsed) {
    if (!input) return null;
    return (
      <pre className="renderer-block renderer-body text-xs overflow-x-auto">
        {formatJson(input)}
      </pre>
    );
  }

  // Empty diff (old === new)
  if (parsed.additions === 0 && parsed.removals === 0 && parsed.lines.length > 0) {
    return (
      <div className="renderer-block">
        <div className="renderer-header">
          <FilePathLink path={parsed.filePath} />
        </div>
        <div className="renderer-body text-xs text-content-3 italic">No changes</div>
      </div>
    );
  }

  // Context-collapse the diff (show only CONTEXT_LINES around each change)
  // When showAll is true, show every line without collapsing
  const chunks = showAll
    ? [{ type: "lines" as const, lines: parsed.lines }]
    : collapseContextLines(parsed.lines);
  const visibleCount = countVisibleLines(chunks);

  // Truncate if still too many visible lines
  const needsTruncation = visibleCount > MAX_VISIBLE_LINES && !showAll;
  const displayChunks = needsTruncation
    ? truncateChunks(chunks, INITIAL_VISIBLE_LINES)
    : chunks;
  const shownCount = countVisibleLines(displayChunks);
  const remainingCount = visibleCount - shownCount;

  return (
    <div className="renderer-block">
      {!inline && (
        <div className="renderer-header">
          <FilePathLink path={parsed.filePath} />
          <span className="flex items-center gap-2 text-[11px] shrink-0">
            {parsed.additions > 0 && <span className="text-diff-add">+{parsed.additions}</span>}
            {parsed.removals > 0 && <span className="text-diff-remove">−{parsed.removals}</span>}
          </span>
        </div>
      )}
      <div className="renderer-body diff-body overflow-x-auto">
        {displayChunks.map((chunk, ci) =>
          chunk.type === "collapsed" ? (
            <CollapsedSeparator key={`sep-${ci}`} count={chunk.count} />
          ) : (
            chunk.lines.map((line, li) => (
              <DiffLineRow key={`${ci}-${li}`} line={line} tokens={tokens} />
            ))
          ),
        )}
      </div>
      {(needsTruncation || (!showAll && parsed.lines.length - visibleCount > CONTEXT_LINES * 2)) && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center text-[11px] text-content-3 hover:text-content-2 py-1.5 border-t border-edge-1"
        >
          {needsTruncation
            ? `Show ${remainingCount} more lines`
            : `Show all ${parsed.lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// ── Line row ───────────────────────────────────────────────

interface TokenMap {
  old: ThemedToken[][] | null;
  new: ThemedToken[][] | null;
}

function DiffLineRow({ line, tokens }: { line: DiffLine; tokens: TokenMap }) {
  const lineNum = line.type === "add" ? line.newLineNum : line.oldLineNum;
  const lineTokens = getTokensForLine(line, tokens);

  const bgClass =
    line.type === "add"
      ? "diff-line-add"
      : line.type === "remove"
        ? "diff-line-remove"
        : "diff-line-context";

  const gutterChar = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
  const gutterLabel = line.type === "add" ? "added line" : line.type === "remove" ? "removed line" : undefined;

  return (
    <div className={`diff-line ${bgClass}`}>
      <span className="diff-line-num">{lineNum ?? ""}</span>
      <span
        className={`diff-gutter ${line.type === "add" ? "diff-gutter-add" : line.type === "remove" ? "diff-gutter-remove" : "diff-gutter-context"}`}
        role={gutterLabel ? "img" : undefined}
        aria-label={gutterLabel}
      >
        {gutterChar}
      </span>
      <span className="diff-content">
        {lineTokens ? (
          lineTokens.map((t, i) => (
            <span key={i} style={{ color: t.color }}>{t.content}</span>
          ))
        ) : (
          line.content || " "
        )}
      </span>
    </div>
  );
}

function CollapsedSeparator({ count }: { count: number }) {
  return (
    <div className="diff-line diff-line-collapsed">
      <span className="diff-line-num" />
      <span className="diff-gutter diff-gutter-context" />
      <span className="diff-content text-content-3 text-[11px] select-none">
        ⋯ {count} unchanged {count === 1 ? "line" : "lines"} ⋯
      </span>
    </div>
  );
}

function getTokensForLine(line: DiffLine, tokens: TokenMap): ThemedToken[] | null {
  if (line.type === "context" || line.type === "remove") {
    if (tokens.old && line.oldLineNum != null) {
      return tokens.old[line.oldLineNum - 1] ?? null;
    }
  }
  if (line.type === "add") {
    if (tokens.new && line.newLineNum != null) {
      return tokens.new[line.newLineNum - 1] ?? null;
    }
  }
  return null;
}

// ── Shiki tokens hook ──────────────────────────────────────

function useShikiTokens(oldStr: string, newStr: string, language: string): TokenMap {
  const [tokenMap, setTokenMap] = useState<TokenMap>({ old: null, new: null });
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current || !language || language === "text") return;
    loadedRef.current = true;

    getHighlighter().then(async (highlighter) => {
      if (!highlighter) return;
      try {
        await highlighter.loadLanguage(language as Parameters<typeof highlighter.loadLanguage>[0]);

        const oldTokens = oldStr
          ? highlighter.codeToTokens(oldStr, { lang: language, theme: "github-dark-default" }).tokens
          : null;
        const newTokens = newStr
          ? highlighter.codeToTokens(newStr, { lang: language, theme: "github-dark-default" }).tokens
          : null;

        setTokenMap({ old: oldTokens, new: newTokens });
      } catch {
        // Language not supported or Shiki failed — fall through to plain text
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps — loadedRef guard prevents re-execution
  }, [language]);

  return tokenMap;
}

// ── Utilities ──────────────────────────────────────────────

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
