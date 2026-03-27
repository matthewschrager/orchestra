import { describe, expect, test } from "bun:test";
import { parseDiff } from "../DiffRenderer";
import { computeDiff } from "../../../lib/diffCompute";
import { getBashPreview, parseBash } from "../BashRenderer";
import { parseRead } from "../ReadRenderer";
import { parseSearch, searchSummary } from "../SearchRenderer";
import { parseAgentPrompt } from "../SubAgentCard";
import { parseTodos } from "../TodoRenderer";

// ── DiffRenderer ─────────────────────────────────────

describe("parseDiff", () => {
  test("parses valid Edit input with old_string and new_string", () => {
    const input = JSON.stringify({
      file_path: "/src/utils/pagination.ts",
      old_string: "const offset = page * pageSize;",
      new_string: "const offset = (page - 1) * pageSize;",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("/src/utils/pagination.ts");
    expect(result!.additions).toBe(1);
    expect(result!.removals).toBe(1);
    expect(result!.lines).toHaveLength(2);
    expect(result!.lines[0].type).toBe("remove");
    expect(result!.lines[1].type).toBe("add");
  });

  test("handles malformed JSON input", () => {
    expect(parseDiff("not json")).toBeNull();
  });

  test("handles null input", () => {
    expect(parseDiff(null)).toBeNull();
  });

  test("handles empty old_string (new file creation)", () => {
    const input = JSON.stringify({
      file_path: "/src/new-file.ts",
      old_string: "",
      new_string: "export const x = 1;",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.additions).toBe(1);
    expect(result!.removals).toBe(0);
  });

  test("handles empty new_string (deletion)", () => {
    const input = JSON.stringify({
      file_path: "/src/old-file.ts",
      old_string: "export const x = 1;",
      new_string: "",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.removals).toBe(1);
    expect(result!.additions).toBe(0);
  });

  test("handles multi-line diffs", () => {
    const input = JSON.stringify({
      file_path: "/src/test.ts",
      old_string: "line1\nline2\nline3",
      new_string: "newline1\nnewline2",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.removals).toBe(3);
    expect(result!.additions).toBe(2);
    expect(result!.lines).toHaveLength(5);
  });

  test("returns null for missing file_path", () => {
    const input = JSON.stringify({
      old_string: "foo",
      new_string: "bar",
    });
    expect(parseDiff(input)).toBeNull();
  });

  test("returns language field from file extension", () => {
    const input = JSON.stringify({
      file_path: "/src/app.py",
      old_string: "x = 1",
      new_string: "x = 2",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("python");
  });

  test("returns oldString and newString raw fields", () => {
    const input = JSON.stringify({
      file_path: "/src/test.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.oldString).toBe("const a = 1;");
    expect(result!.newString).toBe("const a = 2;");
  });

  test("identical old and new produces zero additions/removals", () => {
    const input = JSON.stringify({
      file_path: "/src/test.ts",
      old_string: "const x = 1;",
      new_string: "const x = 1;",
    });
    const result = parseDiff(input);
    expect(result).not.toBeNull();
    expect(result!.additions).toBe(0);
    expect(result!.removals).toBe(0);
  });
});

// ── computeDiff ──────────────────────────────────────

describe("computeDiff", () => {
  test("identical strings produce all context lines", () => {
    const result = computeDiff("a\nb\nc", "a\nb\nc");
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => l.type === "context")).toBe(true);
  });

  test("completely different strings produce all remove then all add", () => {
    const result = computeDiff("a\nb", "x\ny");
    expect(result.removals).toBe(2);
    expect(result.additions).toBe(2);
    expect(result.lines).toHaveLength(4);
  });

  test("partial overlap: single line changed in middle", () => {
    const result = computeDiff("a\nb\nc\nd", "a\nX\nc\nd");
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(1);
    // Should be: context(a), remove(b), add(X), context(c), context(d)
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toMatchObject({ type: "context", content: "a" });
    expect(result.lines[1]).toMatchObject({ type: "remove", content: "b" });
    expect(result.lines[2]).toMatchObject({ type: "add", content: "X" });
    expect(result.lines[3]).toMatchObject({ type: "context", content: "c" });
    expect(result.lines[4]).toMatchObject({ type: "context", content: "d" });
  });

  test("empty old string produces all adds (no phantom blank)", () => {
    const result = computeDiff("", "foo\nbar");
    expect(result.additions).toBe(2);
    expect(result.removals).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].content).toBe("foo");
    expect(result.lines[1].content).toBe("bar");
  });

  test("empty new string produces all removes (no phantom blank)", () => {
    const result = computeDiff("foo\nbar", "");
    expect(result.removals).toBe(2);
    expect(result.additions).toBe(0);
    expect(result.lines).toHaveLength(2);
  });

  test("both empty strings produce empty result", () => {
    const result = computeDiff("", "");
    expect(result.lines).toHaveLength(0);
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
  });

  test("trailing newline normalization: no phantom diff", () => {
    const result = computeDiff("foo\n", "foo");
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].type).toBe("context");
  });

  test("line numbers increment correctly through mixed types", () => {
    const result = computeDiff("a\nb\nc", "a\nX\nc");
    // context(a) old=1,new=1 | remove(b) old=2 | add(X) new=2 | context(c) old=3,new=3
    expect(result.lines[0]).toMatchObject({ oldLineNum: 1, newLineNum: 1 });
    expect(result.lines[1]).toMatchObject({ type: "remove", oldLineNum: 2 });
    expect(result.lines[2]).toMatchObject({ type: "add", newLineNum: 2 });
    expect(result.lines[3]).toMatchObject({ oldLineNum: 3, newLineNum: 3 });
  });

  test("large input falls back to block diff", () => {
    const oldLines = Array.from({ length: 300 }, (_, i) => `old-line-${i}`).join("\n");
    const newLines = Array.from({ length: 300 }, (_, i) => `new-line-${i}`).join("\n");
    const result = computeDiff(oldLines, newLines);
    // Should bail out: 300 + 300 > 500
    expect(result.removals).toBe(300);
    expect(result.additions).toBe(300);
    expect(result.lines).toHaveLength(600);
    // All removes come first in block diff
    expect(result.lines[0].type).toBe("remove");
    expect(result.lines[299].type).toBe("remove");
    expect(result.lines[300].type).toBe("add");
  });
});

// ── BashRenderer ─────────────────────────────────────

describe("parseBash", () => {
  test("parses valid bash command", () => {
    const input = JSON.stringify({ command: "bun test" });
    const result = parseBash(input, "3 pass 0 fail");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("bun test");
    expect(result!.output).toBe("3 pass 0 fail");
  });

  test("handles empty output", () => {
    const input = JSON.stringify({ command: "mkdir -p /tmp/test" });
    const result = parseBash(input, "");
    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
  });

  test("handles null output", () => {
    const input = JSON.stringify({ command: "ls" });
    const result = parseBash(input, null);
    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
  });

  test("returns null for missing command", () => {
    const input = JSON.stringify({ description: "some task" });
    expect(parseBash(input, "output")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseBash(null, "output")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseBash("not json", "output")).toBeNull();
  });

  test("extracts exit code metadata and removes fallback marker from output", () => {
    const input = JSON.stringify({ command: "false" });
    const result = parseBash(input, "stderr line\n[exit code: 1]", { exitCode: 1 });
    expect(result).not.toBeNull();
    expect(result!.output).toBe("stderr line");
    expect(result!.exitCode).toBe(1);
  });

  test("tracks successful exit codes from metadata", () => {
    const input = JSON.stringify({ command: "echo ok" });
    const result = parseBash(input, "ok\n", { exitCode: 0 });
    expect(result).not.toBeNull();
    expect(result!.output).toBe("ok");
    expect(result!.exitCode).toBe(0);
    expect(result!.lineCount).toBe(1);
  });
});

describe("getBashPreview", () => {
  test("returns full output when line count is within limit", () => {
    const preview = getBashPreview("one\ntwo", 4);
    expect(preview.text).toBe("one\ntwo");
    expect(preview.totalLines).toBe(2);
    expect(preview.hiddenLineCount).toBe(0);
  });

  test("truncates output to the requested number of lines", () => {
    const preview = getBashPreview("1\n2\n3\n4\n5", 3);
    expect(preview.text).toBe("1\n2\n3");
    expect(preview.totalLines).toBe(5);
    expect(preview.hiddenLineCount).toBe(2);
  });
});

// ── ReadRenderer ─────────────────────────────────────

describe("parseRead", () => {
  test("parses valid file read", () => {
    const input = JSON.stringify({ file_path: "/src/index.ts" });
    const output = "     1\texport const x = 1;\n     2\texport const y = 2;";
    const result = parseRead(input, output);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe("/src/index.ts");
    expect(result!.language).toBe("typescript");
    expect(result!.content).toBe(output);
  });

  test("detects language from extension", () => {
    expect(parseRead(JSON.stringify({ file_path: "test.py" }), "x = 1")!.language).toBe("python");
    expect(parseRead(JSON.stringify({ file_path: "test.rs" }), "fn main()")!.language).toBe("rust");
    expect(parseRead(JSON.stringify({ file_path: "test.go" }), "func main()")!.language).toBe("go");
    expect(parseRead(JSON.stringify({ file_path: "test.xyz" }), "content")!.language).toBe("text");
  });

  test("handles empty file", () => {
    const input = JSON.stringify({ file_path: "/src/empty.ts" });
    const result = parseRead(input, "");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("");
  });

  test("returns null for missing file_path", () => {
    expect(parseRead(JSON.stringify({}), "content")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseRead(null, "content")).toBeNull();
  });

  test("uses offset from input params", () => {
    const input = JSON.stringify({ file_path: "/src/test.ts", offset: 42 });
    const result = parseRead(input, "line content");
    expect(result).not.toBeNull();
    expect(result!.lineStart).toBe(42);
  });

  test("detects image file by extension", () => {
    const input = JSON.stringify({ file_path: "/tmp/screenshot.png" });
    const result = parseRead(input, "");
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(true);
    expect(result!.content).toBe("");
  });

  test("detects JPEG as image", () => {
    const input = JSON.stringify({ file_path: "/tmp/photo.jpg" });
    const result = parseRead(input, "binary content here");
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(true);
  });

  test("does not treat SVG as image (XSS risk)", () => {
    const input = JSON.stringify({ file_path: "/tmp/icon.svg" });
    const result = parseRead(input, "<svg>...</svg>");
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(false);
  });

  test("does not treat TypeScript as image", () => {
    const input = JSON.stringify({ file_path: "/src/index.ts" });
    const result = parseRead(input, "export const x = 1;");
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(false);
    expect(result!.content).toBe("export const x = 1;");
  });

  test("non-image binary file has isImage false", () => {
    const input = JSON.stringify({ file_path: "/tmp/data.bin" });
    // Simulate binary content with null bytes
    const result = parseRead(input, "\0\0\0binary");
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(false);
    expect(result!.content).toBe("");
  });
});

// ── SearchRenderer ───────────────────────────────────

describe("parseSearch", () => {
  test("parses grep-style output", () => {
    const input = JSON.stringify({ pattern: "pageSize" });
    const output = "src/utils/pagination.ts:14:  const totalPages = Math.ceil(total / pageSize);\nsrc/routes/threads.ts:42:  const pageSize = parseInt(query.limit) || 20;";
    const result = parseSearch(input, output);
    expect(result).not.toBeNull();
    expect(result!.matches).toHaveLength(2);
    expect(result!.fileCount).toBe(2);
    expect(result!.matches[0].file).toBe("src/utils/pagination.ts");
    expect(result!.matches[0].line).toBe(14);
  });

  test("parses glob-style output (file paths only)", () => {
    const input = JSON.stringify({ pattern: "*.ts" });
    const output = "src/index.ts\nsrc/app.ts\nsrc/utils/helpers.ts";
    const result = parseSearch(input, output);
    expect(result).not.toBeNull();
    expect(result!.matches).toHaveLength(3);
    expect(result!.fileCount).toBe(3);
    expect(result!.matches[0].line).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(parseSearch(JSON.stringify({ pattern: "notfound" }), "")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseSearch(null, "output")).toBeNull();
  });
});

describe("searchSummary", () => {
  test("returns match summary", () => {
    const input = JSON.stringify({ pattern: "test" });
    const output = "src/a.ts:1:test\nsrc/b.ts:2:test";
    expect(searchSummary(input, output)).toBe("2 matches in 2 files");
  });

  test("returns empty for unparseable", () => {
    expect(searchSummary(null, null)).toBe("");
  });
});

// ── SubAgentCard ─────────────────────────────────────

describe("parseAgentPrompt", () => {
  test("extracts description from Agent tool_use", () => {
    const input = JSON.stringify({
      description: "Research pagination patterns",
      prompt: "Find all pagination implementations in the codebase",
    });
    const result = parseAgentPrompt(input);
    expect(result).not.toBeNull();
    expect(result!.description).toBe("Research pagination patterns");
  });

  test("falls back to prompt when no description", () => {
    const input = JSON.stringify({
      prompt: "Find all pagination implementations in the codebase and report back",
    });
    const result = parseAgentPrompt(input);
    expect(result).not.toBeNull();
    expect(result!.description).toContain("Find all pagination");
  });

  test("extracts subagent_type", () => {
    const input = JSON.stringify({
      description: "Search code",
      subagent_type: "Explore",
    });
    const result = parseAgentPrompt(input);
    expect(result!.subagentType).toBe("Explore");
  });

  test("handles malformed JSON gracefully", () => {
    const result = parseAgentPrompt("not json");
    expect(result).not.toBeNull();
    expect(result!.description).toBe("Sub-agent task");
  });

  test("handles null input", () => {
    expect(parseAgentPrompt(null)).toBeNull();
  });
});

// ── TodoRenderer ─────────────────────────────────────

describe("parseTodos", () => {
  test("parses valid todo list", () => {
    const input = JSON.stringify({
      todos: [
        { content: "Set up schema", status: "completed", activeForm: "Setting up schema" },
        { content: "Write API endpoints", status: "in_progress", activeForm: "Writing API endpoints" },
        { content: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(3);
    expect(result!.completed).toBe(1);
    expect(result!.total).toBe(3);
    expect(result!.items[0].status).toBe("completed");
    expect(result!.items[1].status).toBe("in_progress");
    expect(result!.items[2].status).toBe("pending");
  });

  test("returns null for null input", () => {
    expect(parseTodos(null)).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseTodos("not json")).toBeNull();
  });

  test("returns null for empty todos array", () => {
    const input = JSON.stringify({ todos: [] });
    expect(parseTodos(input)).toBeNull();
  });

  test("parses Codex-shaped items field", () => {
    const input = JSON.stringify({
      items: [{ text: "Set up schema", completed: true }, { text: "Write tests", completed: false }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(2);
    expect(result!.items[0].content).toBe("Set up schema");
    expect(result!.items[0].status).toBe("completed");
    expect(result!.items[0].activeForm).toBe("Set up schema");
    expect(result!.items[1].content).toBe("Write tests");
    expect(result!.items[1].status).toBe("pending");
    expect(result!.completed).toBe(1);
    expect(result!.total).toBe(2);
  });

  test("returns null for missing todos and items fields", () => {
    const input = JSON.stringify({ other: [{ content: "test" }] });
    expect(parseTodos(input)).toBeNull();
  });

  test("Codex completed: true maps to completed status", () => {
    const input = JSON.stringify({
      items: [{ text: "Done task", completed: true }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items[0].status).toBe("completed");
  });

  test("Codex completed: false maps to pending status", () => {
    const input = JSON.stringify({
      items: [{ text: "Pending task", completed: false }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items[0].status).toBe("pending");
  });

  test("prefers todos field over items when both present", () => {
    const input = JSON.stringify({
      todos: [{ content: "From todos", status: "in_progress", activeForm: "Working" }],
      items: [{ text: "From items", completed: false }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items[0].content).toBe("From todos");
  });

  test("returns null for empty items array", () => {
    const input = JSON.stringify({ items: [] });
    expect(parseTodos(input)).toBeNull();
  });

  test("defaults missing fields gracefully", () => {
    const input = JSON.stringify({
      todos: [{ content: "Do something" }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items[0].status).toBe("pending");
    expect(result!.items[0].activeForm).toBe("Do something");
  });

  test("handles all-completed state", () => {
    const input = JSON.stringify({
      todos: [
        { content: "Task 1", status: "completed", activeForm: "Doing task 1" },
        { content: "Task 2", status: "completed", activeForm: "Doing task 2" },
      ],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.completed).toBe(2);
    expect(result!.total).toBe(2);
  });

  test("handles unknown status as pending", () => {
    const input = JSON.stringify({
      todos: [{ content: "Task", status: "unknown_status", activeForm: "Doing task" }],
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.items[0].status).toBe("pending");
  });

  test("parses Claude stringified todos payload with title fields", () => {
    const input = JSON.stringify({
      todos: JSON.stringify([
        { id: "1", title: "First task", status: "in_progress" },
        { id: "2", title: "Second task", status: "pending" },
      ]),
    });
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    expect(result!.items[0]).toMatchObject({
      content: "First task",
      activeForm: "First task",
      status: "in_progress",
    });
    expect(result!.items[1].content).toBe("Second task");
  });

  test("parses bare array todo payloads", () => {
    const input = JSON.stringify([
      { title: "Standalone task", status: "completed" },
    ]);
    const result = parseTodos(input);
    expect(result).not.toBeNull();
    expect(result!.completed).toBe(1);
    expect(result!.items[0]).toMatchObject({
      content: "Standalone task",
      activeForm: "Standalone task",
      status: "completed",
    });
  });
});
