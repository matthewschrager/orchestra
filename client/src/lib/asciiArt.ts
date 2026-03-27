// Structural box-drawing chars: verticals, corners, tees, crosses.
// Excludes horizontal-only chars (U+2500 dash, U+2550 double, etc.)
// that Claude uses as decorative text separators.
const BOX_STRUCTURAL_RE =
  /[\u2502\u2503\u2506\u2507\u250a-\u254b\u254e\u254f\u2551-\u2570]/g;

// Lines inside markdown containers (blockquotes, lists) must not be wrapped —
// injecting top-level fences would split the container.
const BLOCKQUOTE_RE = /^\s*>/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s/;

// ASCII border row: +---+---+ or +===+===+ patterns.
// Requires at least one - or = between the + chars to avoid matching bare +++ or ++++.
const ASCII_BORDER_RE = /^\s*\+[-=][-=+]*\+\s*$/;

// ASCII pipe-column line: starts with | and ends with |, has at least one interior |
// e.g. "| Left sidebar | Right pane |"
const ASCII_PIPE_ROW_RE = /^\s*\|.*\|.*\|\s*$/;

// Weaker pipe check for continuation: just outer pipes (| text |).
// Only used when already inside an art block to prevent breaks mid-diagram.
const ASCII_PIPE_OUTER_RE = /^\s*\|.+\|\s*$/;

// GFM separator row: | --- | --- | or | :---: | :--- | (with optional leading/trailing pipes)
// This separates table headers from body — lines matching this are NOT art.
const GFM_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

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

function isAsciiBorder(line: string): boolean {
  return ASCII_BORDER_RE.test(line);
}

function isAsciiPipeRow(line: string): boolean {
  return ASCII_PIPE_ROW_RE.test(line) && !GFM_SEPARATOR_RE.test(line);
}

/**
 * Detect whether a contiguous block of pipe-rows is actually a GFM table.
 * A GFM table has: header row, separator row (| --- | --- |), then body rows.
 * If a separator row exists in the block, it's a table, not art.
 */
function isGfmTableBlock(lines: string[]): boolean {
  return lines.some((l) => GFM_SEPARATOR_RE.test(l));
}

/**
 * ASCII art detection and wrapping:
 *
 * Scans lines for art indicators and groups contiguous art lines:
 *   - Unicode box-drawing structural chars (≥2 per line)
 *   - ASCII border patterns (+---+)
 *   - ASCII pipe-column rows (| x | y |) that are NOT GFM table separators
 *   - Continuation: lines with outer pipes (| text |) extend an existing art block
 *
 * On flush, pipe-only blocks that look like GFM tables (contain a separator
 * row) are passed through unwrapped so react-markdown renders them as tables.
 *
 * Lines inside code fences, blockquotes, or list context are never wrapped.
 */
export function wrapAsciiArt(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let artBlock: string[] = [];
  let inCodeFence = false;
  let inListContext = false;
  let inGfmTable = false;

  function flushArt() {
    if (artBlock.length === 0) return;

    // If the block is entirely pipe-rows (no Unicode box-drawing or ASCII borders),
    // check if it's actually a GFM table — if so, don't wrap it.
    const hasUnicodeOrBorder = artBlock.some(
      (l) => countStructuralChars(l) >= 2 || isAsciiBorder(l),
    );
    if (!hasUnicodeOrBorder && isGfmTableBlock(artBlock)) {
      // This is a GFM table, not ASCII art — pass through unwrapped
      result.push(...artBlock);
    } else {
      result.push("```text", ...artBlock, "```");
    }
    artBlock = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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

    const skip = inCodeFence || isInContainer(line) || inListContext;

    // Detect art: Unicode structural chars, ASCII borders, or ASCII pipe rows
    const hasUnicodeArt = countStructuralChars(line) >= 2;
    const hasBorderArt = isAsciiBorder(line);
    const hasPipeArt = isAsciiPipeRow(line);

    // GFM table tracking: a separator row (| --- | --- |) starts table context.
    // Pipe rows after a separator are table body, not art. Non-pipe/blank lines end it.
    const isGfmSeparator = GFM_SEPARATOR_RE.test(line);
    if (isGfmSeparator) {
      inGfmTable = true;
    } else if (inGfmTable && !ASCII_PIPE_OUTER_RE.test(line)) {
      inGfmTable = false;
    }

    // Lookahead: if the NEXT line is a GFM separator, this pipe row is a table
    // header — flush the art block and don't treat this line as art.
    const nextIsGfmSep =
      i + 1 < lines.length && GFM_SEPARATOR_RE.test(lines[i + 1]);

    // Continuation: when already inside an art block, a line with just outer pipes
    // (| text |) is still part of the diagram even without interior pipes.
    // GFM separators, table body rows, and lines preceding separators break continuation.
    const isContinuation =
      artBlock.length > 0 &&
      ASCII_PIPE_OUTER_RE.test(line) &&
      !isGfmSeparator &&
      !inGfmTable &&
      !nextIsGfmSep;

    // A line is art if it has box-drawing chars, border patterns, or pipe-column structure.
    // Lines in GFM table context (separator, header before separator, body after) are not art.
    const isArt =
      !skip &&
      !isGfmSeparator &&
      !inGfmTable &&
      !nextIsGfmSep &&
      (hasUnicodeArt || hasBorderArt || hasPipeArt || isContinuation);

    if (isArt) {
      artBlock.push(line);
    } else {
      flushArt();
      result.push(line);
    }
  }
  flushArt();
  return result.join("\n");
}
