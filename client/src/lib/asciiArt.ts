// Structural box-drawing chars: verticals, corners, tees, crosses.
// Excludes horizontal-only chars (U+2500 dash, U+2550 double, etc.)
// that Claude uses as decorative text separators.
const BOX_STRUCTURAL_RE =
  /[\u2502\u2503\u2506\u2507\u250a-\u254b\u254e\u254f\u2551-\u2570]/g;
const ARROW_SYMBOL_RE =
  /[\u2190-\u21ff\u25c0\u25b6\u25b2\u25bc\u25c1\u25b7\u25b3\u25bd\u27f5-\u27ff]/g;
const FILL_SYMBOL_RE = /[\u2591-\u2593\u2588]/g;

// Lines inside blockquotes must not be wrapped because injecting top-level
// fences would split the container. Lists are handled separately by indenting
// fences so the art stays nested under the list item.
const BLOCKQUOTE_RE = /^\s*>/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+\.)\s+/;

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

function countMatches(line: string, re: RegExp): number {
  const matches = line.match(re);
  return matches ? matches.length : 0;
}

function countArtSignalChars(line: string): number {
  return (
    countStructuralChars(line) +
    countMatches(line, ARROW_SYMBOL_RE) +
    countMatches(line, FILL_SYMBOL_RE)
  );
}

function isInContainer(line: string): boolean {
  return BLOCKQUOTE_RE.test(line);
}

function getLeadingWhitespace(line: string): string {
  return line.match(/^\s*/)?.[0] ?? "";
}

function isAsciiBorder(line: string): boolean {
  return ASCII_BORDER_RE.test(line);
}

function isAsciiPipeRow(line: string): boolean {
  return ASCII_PIPE_ROW_RE.test(line) && !GFM_SEPARATOR_RE.test(line);
}

function isLikelyClosingBoxLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("└") ||
    trimmed.startsWith("╰")
  );
}

function isStandaloneSymbolArt(line: string): boolean {
  return countArtSignalChars(line) >= 4 && !/[A-Za-z0-9]/.test(line);
}

function isLikelyDiagramLeadIn(
  line: string,
  nextLine: string,
  nextNextLine: string,
): boolean {
  const trimmed = line.trim();
  if (!trimmed || /[.:!?]$/.test(trimmed)) return false;

  const nextLooksArtish =
    countArtSignalChars(nextLine) >= 1 ||
    countArtSignalChars(nextNextLine) >= 1 ||
    isAsciiBorder(nextLine) ||
    isAsciiBorder(nextNextLine) ||
    isAsciiPipeRow(nextLine) ||
    isAsciiPipeRow(nextNextLine);

  if (!nextLooksArtish) return false;

  return (
    /\S(?:\s{2,}|\t)\S/.test(line) ||
    /\b\d(?:\s+\d){3,}\b/.test(trimmed) ||
    trimmed.endsWith("/")
  );
}

function countPipeColumns(line: string): number | null {
  if (!ASCII_PIPE_OUTER_RE.test(line) && !GFM_SEPARATOR_RE.test(line)) return null;
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").length;
}

/**
 * Markdown tables are stricter than Claude's ASCII mockups:
 *   - exactly one separator row
 *   - separator row is the second line
 *   - all non-separator rows have the same column count
 *
 * Mockups often contain multiple separator rows or section lines that only look
 * like markdown table separators. Those should stay ASCII art.
 */
function isMarkdownTableBlock(lines: string[]): boolean {
  const block = lines.filter((line) => line.trim() !== "");
  if (block.length < 3) return false;

  const separatorIndexes = block.flatMap((line, index) => (
    GFM_SEPARATOR_RE.test(line) ? [index] : []
  ));
  if (separatorIndexes.length !== 1 || separatorIndexes[0] !== 1) return false;

  const columnCount = countPipeColumns(block[0]);
  if (!columnCount || columnCount < 2) return false;

  return block.every((line, index) => {
    if (index === 1) return true;
    return countPipeColumns(line) === columnCount;
  });
}

/**
 * ASCII art detection and wrapping:
 *
 * Scans lines for art indicators and groups contiguous art lines:
 *   - Unicode box-drawing structural chars (≥2 per line)
 *   - ASCII border patterns (+---+)
 *   - ASCII pipe-column rows (| x | y |)
 *   - Continuation: lines with outer pipes (| text |) or separator rows
 *     (| --- | --- |) extend an existing art block
 *
 * On flush, pipe-only blocks are classified by whole-block structure.
 * Real markdown tables pass through unchanged; mockups get wrapped into text
 * code fences before react-markdown can collapse spacing or build <table>s.
 *
 * Lines inside code fences or blockquotes are never wrapped.
 * Lines inside list items are wrapped with indented fences so markdown keeps
 * the code block inside the list item instead of breaking the list structure.
 */
export function wrapAsciiArt(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let artBlock: string[] = [];
  let inCodeFence = false;
  let activeListFenceIndent: string | null = null;
  let artBlockFenceIndent: string | null = null;

  function flushArt() {
    if (artBlock.length === 0) return;

    const hasStrongArt = artBlock.some(
      (l) => countStructuralChars(l) >= 2 || isAsciiBorder(l),
    );
    const hasStandaloneSymbolBlock = artBlock.some(isStandaloneSymbolArt);
    if (
      (!hasStrongArt && !hasStandaloneSymbolBlock && artBlock.length < 2) ||
      (!hasStrongArt && !hasStandaloneSymbolBlock && isMarkdownTableBlock(artBlock))
    ) {
      result.push(...artBlock);
    } else {
      const fenceIndent = artBlockFenceIndent ?? "";
      result.push(`${fenceIndent}\`\`\`text`, ...artBlock, `${fenceIndent}\`\`\``);
    }
    artBlock = [];
    artBlockFenceIndent = null;
  }

  function pushArtLine(line: string) {
    if (artBlock.length === 0) {
      artBlockFenceIndent = activeListFenceIndent;
    }
    artBlock.push(line);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineIndent = getLeadingWhitespace(line);

    // Track existing code fences (``` and ~~~, including inside blockquotes)
    if (isCodeFenceLine(line)) {
      flushArt();
      inCodeFence = !inCodeFence;
      result.push(line);
      continue;
    }

    // Track list context so fenced art can stay nested under the list item.
    const listItemMatch = line.match(LIST_ITEM_RE);
    if (listItemMatch) {
      activeListFenceIndent = " ".repeat(listItemMatch[0].length);
    } else if (line.trim() === "") {
      activeListFenceIndent = null;
    } else if (
      activeListFenceIndent &&
      lineIndent.length < activeListFenceIndent.length
    ) {
      activeListFenceIndent = null;
    }

    const skip = inCodeFence || isInContainer(line);

    // Detect art: Unicode structural chars, ASCII borders, or ASCII pipe rows.
    // Separator rows can be part of art and are classified at block flush.
    const hasUnicodeArt = countStructuralChars(line) >= 2;
    const hasBorderArt = isAsciiBorder(line);
    const hasPipeArt = isAsciiPipeRow(line);
    const hasWeakArt = countArtSignalChars(line) >= 1;
    const hasStandaloneSymbols = isStandaloneSymbolArt(line);
    const isGfmSeparator = GFM_SEPARATOR_RE.test(line);
    const hasOuterPipes = ASCII_PIPE_OUTER_RE.test(line);
    const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
    const nextNextLine = i + 2 < lines.length ? lines[i + 2] : "";
    const startsPipeBlock =
      hasPipeArt ||
      (hasOuterPipes && (ASCII_PIPE_OUTER_RE.test(nextLine) || GFM_SEPARATOR_RE.test(nextLine)));
    const nextLooksArtish =
      countArtSignalChars(nextLine) >= 1 ||
      isAsciiBorder(nextLine) ||
      isAsciiPipeRow(nextLine) ||
      isStandaloneSymbolArt(nextLine);
    const startsWeakArtBlock =
      hasWeakArt &&
      !hasPipeArt &&
      !hasBorderArt &&
      artBlock.length === 0 &&
      nextLooksArtish;
    const startsLeadInBlock =
      artBlock.length === 0 &&
      isLikelyDiagramLeadIn(line, nextLine, nextNextLine);

    // Continuation: when already inside an art block, a line with just outer pipes
    // (| text |) or a separator row (| --- | --- |) stays in the block until
    // whole-block classification decides whether it is a real markdown table.
    const isContinuation =
      artBlock.length > 0 &&
      (hasOuterPipes || isGfmSeparator || hasWeakArt);

    const startsNewPipeBlockAfterBoundary =
      !skip &&
      artBlock.length > 0 &&
      isLikelyClosingBoxLine(artBlock[artBlock.length - 1]) &&
      startsPipeBlock;

    // A line is art if it has box-drawing chars, border patterns, or pipe-column structure.
    // Pipe-based blocks are classified on flush instead of line-by-line.
    const isArt =
      !skip &&
      (
        hasUnicodeArt ||
        hasBorderArt ||
        startsPipeBlock ||
        startsWeakArtBlock ||
        startsLeadInBlock ||
        hasStandaloneSymbols ||
        isContinuation
      );

    if (startsNewPipeBlockAfterBoundary) {
      flushArt();
      pushArtLine(line);
    } else if (isArt) {
      pushArtLine(line);
    } else {
      flushArt();
      result.push(line);
    }
  }
  flushArt();
  return result.join("\n");
}
