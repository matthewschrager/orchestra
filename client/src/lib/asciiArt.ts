// Structural box-drawing chars: verticals, corners, tees, crosses.
// Excludes horizontal-only chars (U+2500 dash, U+2550 double, etc.)
// that Claude uses as decorative text separators.
const BOX_STRUCTURAL_RE =
  /[\u2502\u2503\u2506\u2507\u250a-\u254b\u254e\u254f\u2551-\u2570]/;

export function wrapAsciiArt(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let artBlock: string[] = [];
  let inCodeFence = false;

  function flushArt() {
    if (artBlock.length === 0) return;
    result.push("```text", ...artBlock, "```");
    artBlock = [];
  }

  for (const line of lines) {
    // Track existing code fences so we don't double-wrap
    if (line.trimStart().startsWith("```")) {
      flushArt();
      inCodeFence = !inCodeFence;
      result.push(line);
      continue;
    }

    if (!inCodeFence && BOX_STRUCTURAL_RE.test(line)) {
      artBlock.push(line);
    } else {
      flushArt();
      result.push(line);
    }
  }
  flushArt();
  return result.join("\n");
}
