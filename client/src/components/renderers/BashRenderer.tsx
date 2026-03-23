import { useState } from "react";

interface ParsedBash {
  command: string;
  output: string;
  exitCode: number | null;
}

export function parseBash(input: string | null, output: string | null): ParsedBash | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const command: string = parsed.command || "";
    if (!command) return null;

    // Exit code: try to parse from output or metadata
    let exitCode: number | null = null;
    const exitMatch = output?.match(/Exit code[:\s]+(\d+)/i);
    if (exitMatch) exitCode = parseInt(exitMatch[1], 10);

    return { command, output: output || "", exitCode };
  } catch {
    return null;
  }
}

interface Props {
  input: string | null;
  output: string | null;
}

export function BashRenderer({ input, output }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bash = parseBash(input, output);

  if (!bash) return null;

  const hasOutput = bash.output.trim().length > 0;
  const lines = bash.output.split("\n");
  const needsTruncation = lines.length > 15 && !expanded;
  const displayOutput = needsTruncation ? lines.slice(0, 15).join("\n") : bash.output;

  // Truncate long commands for the header
  const displayCmd = bash.command.length > 100
    ? bash.command.slice(0, 100) + "…"
    : bash.command;

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <span className="font-mono text-xs truncate">
          <span className="text-diff-add">$</span> {displayCmd}
        </span>
        {bash.exitCode !== null && (
          <span className={`text-[10px] font-medium shrink-0 ${
            bash.exitCode === 0 ? "text-emerald-400" : "text-red-400"
          }`}>
            {bash.exitCode === 0 ? "✓" : "✗"} exit {bash.exitCode}
          </span>
        )}
      </div>
      {hasOutput ? (
        <pre className="renderer-body text-xs overflow-x-auto whitespace-pre-wrap break-words">
          {highlightBashOutput(displayOutput)}
        </pre>
      ) : (
        <div className="renderer-body text-xs text-content-3 italic">No output</div>
      )}
      {needsTruncation && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-center text-[11px] text-content-3 hover:text-content-2 py-1.5 border-t border-edge-1"
        >
          Show all {lines.length} lines
        </button>
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
