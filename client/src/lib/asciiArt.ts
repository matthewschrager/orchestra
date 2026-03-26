// Structural box-drawing chars: verticals, corners, tees, crosses.
// Excludes horizontal-only chars (U+2500 dash, U+2550 double, etc.)
// that Claude uses as decorative text separators.
const BOX_STRUCTURAL_RE =
  /[\u2502\u2503\u2506\u2507\u250a-\u254b\u254e\u254f\u2551-\u2570]/g;

// Lines inside markdown containers (blockquotes, lists) must not be wrapped —
// injecting top-level fences would split the container.
const BLOCKQUOTE_RE = /^\s*>/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s/;

function isCodeFenceLine(line: string): boolean {
  const trimmed = line.replace(/^\s*>\s?/, "").trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function countStructuralChars(line: string): number {
  const matches = line.match(BOX_STRUCTURAL_RE);
  return matches ? matches.length : 0;
}

function isInContainer(line: string): boolean {
  return BLOCKQUOTE_RE.test(line);
}

export function wrapAsciiArt(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let artBlock: string[] = [];
  let inCodeFence = false;
  let inListContext = false;

  function flushArt() {
    if (artBlock.length === 0) return;
    result.push("```text", ...artBlock, "```");
    artBlock = [];
  }

  for (const line of lines) {
    // Track existing code fences (``` and ~~~, including inside blockquotes)
    if (isCodeFenceLine(line)) {
      flushArt();
      inCodeFence = !inCodeFence;
      result.push(line);
      continue;
    }

    // Track list context — art on indented lines after a list item breaks the list
    if (LIST_ITEM_RE.test(line)) {
      inListContext = true;
    } else if (line.trim() === "") {
      // Blank line ends list context (markdown paragraph break)
      inListContext = false;
    }

    const hasArt =
      !inCodeFence &&
      countStructuralChars(line) >= 2 &&
      !isInContainer(line) &&
      !inListContext;

    if (hasArt) {
      artBlock.push(line);
    } else {
      flushArt();
      result.push(line);
    }
  }
  flushArt();
  return result.join("\n");
}
