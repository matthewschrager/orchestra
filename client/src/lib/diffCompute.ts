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

/** Large diff threshold — fall back to block diff to avoid O(N²) */
const MYERS_LINE_LIMIT = 500;

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

  // Large diff bail-out
  if (oldLines.length + newLines.length > MYERS_LINE_LIMIT) {
    return blockDiff(oldLines, newLines);
  }

  const editScript = myersDiff(oldLines, newLines);
  return buildResult(editScript, oldLines, newLines);
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

type EditOp = "keep" | "insert" | "delete";

/**
 * Myers diff algorithm — finds shortest edit script (SES).
 * Returns an array of edit operations.
 */
function myersDiff(a: string[], b: string[]): EditOp[] {
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

  outer:
  for (let d = 0; d <= max; d++) {
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
        break outer;
      }
    }
  }

  // Backtrack to recover the edit script
  return backtrack(trace, a, b, offset);
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
