import { useState } from "react";

interface ParsedBash {
  command: string;
  output: string;
  exitCode: number | null;
  lineCount: number;
}

const BASH_PREVIEW_LINES = 4;
const BASH_PREVIEW_LINE_CHARS = 200;

interface BashPreview {
  text: string;
  totalLines: number;
  hiddenLineCount: number;
  truncatedLineCount: number;
}

// Strip ANSI escape sequences and non-printable control bytes before showing
// tool output in plain HTML. Otherwise the raw ESC byte renders as a tofu box.
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const NON_RENDERABLE_CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function parseBash(
  input: string | null,
  output: string | null,
  metadata?: Record<string, unknown> | null,
): ParsedBash | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const command: string = typeof parsed.command === "string" ? parsed.command : "";
    if (!command) return null;

    const { cleanOutput, exitCode } = parseBashOutput(output, metadata);

    return {
      command,
      output: cleanOutput,
      exitCode,
      lineCount: countOutputLines(cleanOutput),
    };
  } catch {
    return null;
  }
}

interface Props {
  input: string | null;
  output: string | null;
  metadata?: Record<string, unknown> | null;
  forceExpand?: boolean;
}

export function getBashPreview(
  output: string,
  maxLines = BASH_PREVIEW_LINES,
  maxCharsPerLine = BASH_PREVIEW_LINE_CHARS,
) {
  const lines = output ? output.split("\n") : [];
  let truncatedLineCount = 0;
  const previewLines = lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxCharsPerLine) return line;
    truncatedLineCount++;
    return truncatePreviewLine(line, maxCharsPerLine);
  });

  return {
    text: previewLines.join("\n"),
    totalLines: lines.length,
    hiddenLineCount: Math.max(0, lines.length - maxLines),
    truncatedLineCount,
  };
}

export function BashRenderer({ input, output, metadata, forceExpand = false }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bash = parseBash(input, output, metadata);

  if (!bash) return null;

  const hasOutput = bash.output.length > 0;
  const preview = getBashPreview(bash.output);
  const isOpen = expanded || forceExpand;
  const canExpand = preview.hiddenLineCount > 0 || preview.truncatedLineCount > 0;
  const displayOutput = isOpen ? bash.output : preview.text;
  const displayCmd = formatBashLabel(bash.command);
  const statusClasses = bash.exitCode === null
    ? { dot: "bg-accent/70", badge: "text-content-3" }
    : bash.exitCode === 0
      ? { dot: "bg-emerald-400", badge: "text-emerald-400" }
      : { dot: "bg-red-400", badge: "text-red-400" };
  const toggle = () => {
    if (!canExpand) return;
    setExpanded((open) => !open);
  };

  return (
    <div className="ml-5 my-1 rounded-lg border border-edge-1 bg-surface-2/70 font-mono overflow-hidden">
      {canExpand ? (
        <button
          type="button"
          onClick={toggle}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-3/40"
          aria-expanded={isOpen}
        >
          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${statusClasses.dot}`} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-content-1">{displayCmd}</span>
          {bash.exitCode !== null && (
            <span className={`shrink-0 text-[10px] font-medium ${statusClasses.badge}`}>
              {bash.exitCode === 0 ? "ok" : `exit ${bash.exitCode}`}
            </span>
          )}
          <span className={`shrink-0 text-[10px] text-content-3 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}>
            &#9656;
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${statusClasses.dot}`} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-content-1">{displayCmd}</span>
          {bash.exitCode !== null && (
            <span className={`shrink-0 text-[10px] font-medium ${statusClasses.badge}`}>
              {bash.exitCode === 0 ? "ok" : `exit ${bash.exitCode}`}
            </span>
          )}
        </div>
      )}
      {hasOutput ? (
        <div className="px-3 pb-3">
          <div className="flex gap-2">
            <span className="pt-0.5 text-[11px] leading-5 text-content-3">└</span>
            <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-[11px] leading-5 text-content-2">
              {highlightBashOutput(displayOutput)}
            </pre>
          </div>
          {canExpand && (
            <button
              type="button"
              onClick={toggle}
              className="ml-5 mt-1 text-[10px] text-content-3 hover:text-content-2"
            >
              {isOpen ? "Show less" : getBashExpandLabel(preview)}
            </button>
          )}
        </div>
      ) : (
        <div className="px-3 pb-3">
          <div className="flex gap-2 text-[11px] italic text-content-3">
            <span>└</span>
            <span>No output</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Basic output highlighting for common patterns */
function highlightBashOutput(output: string): React.ReactNode {
  const lines = output.split("\n");
  return lines.map((line, i) => {
    let className = "";
    if (/^\s*(✓|✅|PASS|pass|ok)\s/i.test(line) || /\b\d+ pass/i.test(line)) {
      className = "text-emerald-400";
    } else if (/^\s*(✗|✘|❌|FAIL|fail|error|Error)\s/i.test(line) || /\b\d+ fail/i.test(line)) {
      className = "text-red-400";
    } else if (/^\s*(⚠|warn|Warning)/i.test(line)) {
      className = "text-amber-400";
    }

    return (
      <span key={i}>
        {className ? <span className={className}>{line}</span> : line}
        {i < lines.length - 1 ? "\n" : ""}
      </span>
    );
  });
}

function parseBashOutput(
  output: string | null,
  metadata?: Record<string, unknown> | null,
): { cleanOutput: string; exitCode: number | null } {
  const metaExitCode = typeof metadata?.exitCode === "number" ? metadata.exitCode : null;
  let cleanOutput = sanitizeBashOutput(output ?? "");
  let exitCode = metaExitCode;

  const bracketMatch = cleanOutput.match(/\n?\[exit code:\s*(\d+)\]\s*$/i);
  if (bracketMatch) {
    if (exitCode === null) exitCode = Number.parseInt(bracketMatch[1], 10);
    cleanOutput = cleanOutput.slice(0, bracketMatch.index).replace(/\s+$/, "");
  } else {
    const textMatch = cleanOutput.match(/(?:^|\n)Exit code[:\s]+(\d+)\s*$/i);
    if (textMatch) {
      if (exitCode === null) exitCode = Number.parseInt(textMatch[1], 10);
      cleanOutput = cleanOutput.slice(0, textMatch.index).replace(/\s+$/, "");
    } else {
      cleanOutput = cleanOutput.replace(/\s+$/, "");
    }
  }

  return { cleanOutput, exitCode };
}

function sanitizeBashOutput(output: string): string {
  return output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(NON_RENDERABLE_CONTROL_CHARS_PATTERN, "");
}

function countOutputLines(output: string): number {
  if (!output) return 0;
  return output.split("\n").length;
}

function truncatePreviewLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, Math.max(1, maxChars - 1)) + "…";
}

function getBashExpandLabel(preview: BashPreview): string {
  const parts: string[] = [];
  if (preview.hiddenLineCount > 0) {
    parts.push(`${preview.hiddenLineCount} more line${preview.hiddenLineCount === 1 ? "" : "s"}`);
  }
  if (preview.truncatedLineCount > 0) {
    parts.push(`${preview.truncatedLineCount} long line${preview.truncatedLineCount === 1 ? "" : "s"} truncated`);
  }
  return `… ${parts.join(", ")}`;
}

function formatBashLabel(command: string): string {
  return `Bash(${command.replace(/\s+/g, " ").trim()})`;
}
