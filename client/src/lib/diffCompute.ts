/** Pure diff computation — Myers algorithm for line-level diffing */

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  additions: number;
  removals: number;
}

/** Avoid pathological browser work on genuinely large rewrites */
const MYERS_MAX_TOTAL_LINES = 4000;
/** Stop Myers once the edit distance is clearly no longer "small" */
const MYERS_MAX_EDIT_DISTANCE = 200;

/**
 * Compute a line-level diff between two strings using Myers algorithm.
 * Returns context, add, and remove lines with line numbers for both sides.
 */
export function computeDiff(oldStr: string, newStr: string): DiffResult {
  // Empty-string guards: "".split("\n") → [""] which produces phantom diffs
  if (oldStr === "" && newStr === "") {
    return { lines: [], additions: 0, removals: 0 };
  }
  if (oldStr === "") {
    const newLines = splitLines(newStr);
    return {
      lines: newLines.map((content, i) => ({
        type: "add" as const,
        content,
        newLineNum: i + 1,
      })),
      additions: newLines.length,
      removals: 0,
    };
  }
  if (newStr === "") {
    const oldLines = splitLines(oldStr);
    return {
      lines: oldLines.map((content, i) => ({
        type: "remove" as const,
        content,
        oldLineNum: i + 1,
      })),
      additions: 0,
      removals: oldLines.length,
    };
  }

  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);
  const prefixCount = countCommonPrefix(oldLines, newLines);
  const suffixCount = countCommonSuffix(oldLines, newLines, prefixCount);

  const oldCore = oldLines.slice(prefixCount, oldLines.length - suffixCount);
  const newCore = newLines.slice(prefixCount, newLines.length - suffixCount);

  const prefixLines = buildContextLines(
    oldLines.slice(0, prefixCount),
    1,
    1,
  );
  const suffixLines = buildContextLines(
    oldLines.slice(oldLines.length - suffixCount),
    oldLines.length - suffixCount + 1,
    newLines.length - suffixCount + 1,
  );

  if (oldCore.length === 0 && newCore.length === 0) {
    return {
      lines: [...prefixLines, ...suffixLines],
      additions: 0,
      removals: 0,
    };
  }

  let coreDiff: DiffResult;
  if (oldCore.length === 0 || newCore.length === 0) {
    coreDiff = blockDiff(oldCore, newCore);
  } else if (oldCore.length + newCore.length > MYERS_MAX_TOTAL_LINES) {
    coreDiff = blockDiff(oldCore, newCore);
  } else {
    const editScript = myersDiff(oldCore, newCore, MYERS_MAX_EDIT_DISTANCE);
    coreDiff = editScript ? buildResult(editScript, oldCore, newCore) : blockDiff(oldCore, newCore);
  }

  return {
    lines: [
      ...prefixLines,
      ...shiftLineNumbers(coreDiff.lines, prefixCount, prefixCount),
      ...suffixLines,
    ],
    additions: coreDiff.additions,
    removals: coreDiff.removals,
  };
}

/** Strip trailing newline, then split by \n */
function splitLines(s: string): string[] {
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.split("\n");
}

/** Simple block diff: all removes then all adds */
function blockDiff(oldLines: string[], newLines: string[]): DiffResult {
  const lines: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    lines.push({ type: "remove", content: oldLines[i], oldLineNum: i + 1 });
  }
  for (let i = 0; i < newLines.length; i++) {
    lines.push({ type: "add", content: newLines[i], newLineNum: i + 1 });
  }
  return { lines, additions: newLines.length, removals: oldLines.length };
}

function countCommonPrefix(oldLines: string[], newLines: string[]): number {
  const limit = Math.min(oldLines.length, newLines.length);
  let count = 0;
  while (count < limit && oldLines[count] === newLines[count]) count++;
  return count;
}

function countCommonSuffix(oldLines: string[], newLines: string[], prefixCount: number): number {
  const oldLimit = oldLines.length - prefixCount;
  const newLimit = newLines.length - prefixCount;
  const limit = Math.min(oldLimit, newLimit);
  let count = 0;
  while (
    count < limit &&
    oldLines[oldLines.length - 1 - count] === newLines[newLines.length - 1 - count]
  ) {
    count++;
  }
  return count;
}

function buildContextLines(
  lines: string[],
  oldStart: number,
  newStart: number,
): DiffLine[] {
  return lines.map((content, index) => ({
    type: "context" as const,
    content,
    oldLineNum: oldStart + index,
    newLineNum: newStart + index,
  }));
}

function shiftLineNumbers(lines: DiffLine[], oldOffset: number, newOffset: number): DiffLine[] {
  return lines.map((line) => ({
    ...line,
    oldLineNum: line.oldLineNum === undefined ? undefined : line.oldLineNum + oldOffset,
    newLineNum: line.newLineNum === undefined ? undefined : line.newLineNum + newOffset,
  }));
}

type EditOp = "keep" | "insert" | "delete";

/**
 * Myers diff algorithm — finds shortest edit script (SES).
 * Returns an array of edit operations.
 */
function myersDiff(a: string[], b: string[], maxEditDistance: number): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  // V stores the furthest-reaching endpoint for each diagonal k
  // Using offset to handle negative indices: V[k + offset]
  const offset = max;
  const size = 2 * max + 1;
  const v = new Int32Array(size);
  v.fill(-1);
  v[1 + offset] = 0;

  // Trace stores V snapshots for backtracking
  const trace: Int32Array[] = [];

  const maxD = Math.min(max, maxEditDistance);
  for (let d = 0; d <= maxD; d++) {
    const snapshot = new Int32Array(v);
    trace.push(snapshot);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // move down (insert)
      } else {
        x = v[k - 1 + offset] + 1; // move right (delete)
      }
      let y = x - k;

      // Follow diagonal (matches)
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v[k + offset] = x;

      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }

  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): EditOp[] {
  const ops: EditOp[] = [];
  let x = a.length;
  let y = b.length;

  // trace[d] = V snapshot taken BEFORE depth d was processed (= state after d-1).
  // At backtrack step d, we use trace[d] to find the previous position.
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
      prevK = k + 1; // came from above (insert)
    } else {
      prevK = k - 1; // came from left (delete)
    }

    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    // Diagonal moves (matches) — walk backward
    while (x > prevX && y > prevY) {
      ops.push("keep");
      x--;
      y--;
    }

    if (x === prevX) {
      ops.push("insert");
      y--;
    } else {
      ops.push("delete");
      x--;
    }
  }

  // Remaining diagonal at d=0
  while (x > 0 && y > 0) {
    ops.push("keep");
    x--;
    y--;
  }

  ops.reverse();
  return ops;
}

function buildResult(ops: EditOp[], oldLines: string[], newLines: string[]): DiffResult {
  const lines: DiffLine[] = [];
  let additions = 0;
  let removals = 0;
  let oldIdx = 0;
  let newIdx = 0;

  for (const op of ops) {
    switch (op) {
      case "keep":
        lines.push({
          type: "context",
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1,
          newLineNum: newIdx + 1,
        });
        oldIdx++;
        newIdx++;
        break;
      case "delete":
        lines.push({
          type: "remove",
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1,
        });
        removals++;
        oldIdx++;
        break;
      case "insert":
        lines.push({
          type: "add",
          content: newLines[newIdx],
          newLineNum: newIdx + 1,
        });
        additions++;
        newIdx++;
        break;
    }
  }

  return { lines, additions, removals };
}
