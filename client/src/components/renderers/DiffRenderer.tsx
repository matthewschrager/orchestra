import { useState, useEffect, useRef } from "react";
import { computeDiff, type DiffLine } from "../../lib/diffCompute";
import { getHighlighter, detectLanguage } from "../../lib/shiki";
import type { ThemedToken } from "shiki";

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

// ── Outer truncation threshold ─────────────────────────────

const OUTER_TRUNCATION = 100;
const OUTER_INITIAL_SHOW = 50;

// ── Component ──────────────────────────────────────────────

interface Props {
  input: string | null;
}

export function DiffRenderer({ input }: Props) {
  const [expanded, setExpanded] = useState(false);
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
          <span className="font-mono text-xs truncate">{shortenPath(parsed.filePath)}</span>
        </div>
        <div className="renderer-body text-xs text-content-3 italic">No changes</div>
      </div>
    );
  }

  // Outer truncation for very large diffs
  const needsTruncation = parsed.lines.length > OUTER_TRUNCATION && !expanded;
  const displayLines = needsTruncation ? parsed.lines.slice(0, OUTER_INITIAL_SHOW) : parsed.lines;

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <span className="font-mono text-xs truncate">{shortenPath(parsed.filePath)}</span>
        <span className="flex items-center gap-2 text-[11px] shrink-0">
          {parsed.additions > 0 && <span className="text-diff-add">+{parsed.additions}</span>}
          {parsed.removals > 0 && <span className="text-diff-remove">−{parsed.removals}</span>}
        </span>
      </div>
      <div className="renderer-body diff-body overflow-x-auto">
        {displayLines.map((line, i) => (
          <DiffLineRow key={i} line={line} tokens={tokens} />
        ))}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-center text-[11px] text-content-3 hover:text-content-2 py-1.5 border-t border-edge-1"
        >
          Show all {parsed.lines.length} lines
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
