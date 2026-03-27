import { FilePathLink } from "../FilePathLink";

interface SearchMatch {
  file: string;
  line: number | null;
  content: string;
}

interface ParsedSearch {
  pattern: string;
  matches: SearchMatch[];
  fileCount: number;
}

export function parseSearch(input: string | null, output: string | null): ParsedSearch | null {
  if (!input || !output) return null;
  try {
    const parsed = JSON.parse(input);
    const pattern: string = parsed.pattern || parsed.query || "";

    // Parse output lines — common formats:
    // "file:line:content" (grep style)
    // "file" (glob style, one per line)
    const lines = output.trim().split("\n").filter(Boolean);
    const matches: SearchMatch[] = [];
    const files = new Set<string>();

    for (const line of lines) {
      // Try grep format: file:line:content
      const grepMatch = line.match(/^(.+?):(\d+)[:\s](.*)$/);
      if (grepMatch) {
        const file = grepMatch[1];
        files.add(file);
        matches.push({
          file,
          line: parseInt(grepMatch[2], 10),
          content: grepMatch[3],
        });
        continue;
      }

      // Try glob format: just a file path
      if (line.includes("/") || line.includes(".")) {
        files.add(line.trim());
        matches.push({ file: line.trim(), line: null, content: "" });
        continue;
      }

      // Unknown format — skip
    }

    if (matches.length === 0) return null;

    return { pattern, matches, fileCount: files.size };
  } catch {
    return null;
  }
}

/** Count summary for the tool line badge */
export function searchSummary(input: string | null, output: string | null): string {
  const search = parseSearch(input, output);
  if (!search) return "";
  if (search.matches.length === 0) return "No matches";
  return `${search.matches.length} match${search.matches.length !== 1 ? "es" : ""} in ${search.fileCount} file${search.fileCount !== 1 ? "s" : ""}`;
}

interface Props {
  input: string | null;
  output: string | null;
}

export function SearchRenderer({ input, output }: Props) {
  const search = parseSearch(input, output);

  if (!search) {
    // Zero matches or parse failure
    if (output?.trim() === "") {
      return (
        <div className="renderer-block">
          <div className="renderer-body text-xs text-content-3 italic">No matches found</div>
        </div>
      );
    }
    return null;
  }

  if (search.matches.length === 0) {
    return (
      <div className="renderer-block">
        <div className="renderer-body text-xs text-content-3 italic">No matches found</div>
      </div>
    );
  }

  return (
    <div className="renderer-block">
      <div className="renderer-header">
        <span className="text-xs text-content-3">
          {search.pattern && (
            <>Pattern: <span className="text-amber-400 font-mono">"{search.pattern}"</span> — </>
          )}
          {search.matches.length} match{search.matches.length !== 1 ? "es" : ""} in {search.fileCount} file{search.fileCount !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="renderer-body space-y-0">
        {search.matches.map((m, i) => (
          <div key={i} className="search-result">
            <span className="search-file">
              <FilePathLink path={m.file} line={m.line ?? undefined} />
            </span>
            {m.line !== null && <span className="search-line-num">:{m.line}</span>}
            {m.content && (
              <span className="search-content">
                {highlightMatch(m.content, search.pattern)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function highlightMatch(text: string, pattern: string): React.ReactNode {
  if (!pattern) return text;
  try {
    const regex = new RegExp(`(${escapeRegex(pattern)})`, "gi");
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <span key={i} className="search-highlight">{part}</span>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  } catch {
    return text;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

