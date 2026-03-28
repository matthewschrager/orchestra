import { describe, expect, test } from "bun:test";
import { findSlashToken, findAtToken, buildHighlightSegments, replaceSlashToken, replaceAtToken } from "../SlashCommandInput";
import type { SlashCommand } from "shared";

const COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show help" },
  { name: "/clear", description: "Clear chat" },
  { name: "/config", description: "Show config" },
];

// ── findSlashToken ──────────────────────────────────

describe("findSlashToken", () => {
  test("detects token at start of input", () => {
    const result = findSlashToken("/hel", 4);
    expect(result).toEqual({ token: "/hel", start: 0, end: 4 });
  });

  test("detects token mid-text after space", () => {
    const result = findSlashToken("please run /cl", 14);
    expect(result).toEqual({ token: "/cl", start: 11, end: 14 });
  });

  test("detects token after newline", () => {
    const result = findSlashToken("line one\n/he", 12);
    expect(result).toEqual({ token: "/he", start: 9, end: 12 });
  });

  test("returns null when cursor is not after a slash token", () => {
    expect(findSlashToken("hello world", 5)).toBeNull();
  });

  test("returns null when slash is mid-word (no preceding whitespace)", () => {
    expect(findSlashToken("foo/bar", 7)).toBeNull();
  });

  test("detects just a bare slash", () => {
    const result = findSlashToken("/", 1);
    expect(result).toEqual({ token: "/", start: 0, end: 1 });
  });

  test("extends to full token even when cursor is mid-word", () => {
    // Cursor is at position 4 (after "/hel"), token extends to include trailing "p"
    const result = findSlashToken("/help some other text", 4);
    expect(result).toEqual({ token: "/help", start: 0, end: 5 });
  });

  test("detects token with hyphens", () => {
    const result = findSlashToken("/my-command", 11);
    expect(result).toEqual({ token: "/my-command", start: 0, end: 11 });
  });

  test("extends end to full word when cursor is mid-token", () => {
    // Cursor after "/cle" in "/clear"
    const result = findSlashToken("/clear", 4);
    expect(result).toEqual({ token: "/clear", start: 0, end: 6 });
  });

  test("extends end to full word mid-text when cursor is inside token", () => {
    // Cursor after "/cl" in "run /clear now"
    const result = findSlashToken("run /clear now", 7);
    expect(result).toEqual({ token: "/clear", start: 4, end: 10 });
  });
});

// ── buildHighlightSegments ──────────────────────────

describe("buildHighlightSegments", () => {
  test("highlights recognized command", () => {
    const segs = buildHighlightSegments("/help world", COMMANDS);
    expect(segs).toEqual([
      { text: "/help", highlight: true },
      { text: " world", highlight: false },
    ]);
  });

  test("highlights partial command match", () => {
    const segs = buildHighlightSegments("/hel", COMMANDS);
    expect(segs).toEqual([{ text: "/hel", highlight: true }]);
  });

  test("highlights multiple commands in text", () => {
    const segs = buildHighlightSegments("run /help then /clear", COMMANDS);
    expect(segs).toEqual([
      { text: "run ", highlight: false },
      { text: "/help", highlight: true },
      { text: " then ", highlight: false },
      { text: "/clear", highlight: true },
    ]);
  });

  test("does not highlight unknown tokens", () => {
    const segs = buildHighlightSegments("/unknown command", COMMANDS);
    expect(segs).toEqual([{ text: "/unknown command", highlight: false }]);
  });

  test("returns single segment for plain text", () => {
    const segs = buildHighlightSegments("no commands here", COMMANDS);
    expect(segs).toEqual([{ text: "no commands here", highlight: false }]);
  });

  test("handles empty string", () => {
    const segs = buildHighlightSegments("", COMMANDS);
    expect(segs).toEqual([]);
  });
});

// ── replaceSlashToken ───────────────────────────────

describe("replaceSlashToken", () => {
  test("replaces token at start of input", () => {
    const result = replaceSlashToken("/hel", { start: 0, end: 4 }, "/help");
    expect(result).toEqual({ newValue: "/help ", newCursorPos: 6 });
  });

  test("replaces token mid-text preserving surroundings", () => {
    const result = replaceSlashToken("please run /cl and go", { start: 11, end: 14 }, "/clear");
    expect(result).toEqual({ newValue: "please run /clear  and go", newCursorPos: 18 });
  });

  test("replaces token at end of input", () => {
    const result = replaceSlashToken("do /con", { start: 3, end: 7 }, "/config");
    expect(result).toEqual({ newValue: "do /config ", newCursorPos: 11 });
  });
});

// ── findAtToken ─────────────────────────────────────

describe("findAtToken", () => {
  test("detects token at start of input", () => {
    const result = findAtToken("@src", 4);
    expect(result).toEqual({ token: "@src", query: "src", start: 0, end: 4 });
  });

  test("detects token mid-text after space", () => {
    const result = findAtToken("check @src/comp", 15);
    expect(result).toEqual({ token: "@src/comp", query: "src/comp", start: 6, end: 15 });
  });

  test("detects token after newline", () => {
    const result = findAtToken("line one\n@App", 13);
    expect(result).toEqual({ token: "@App", query: "App", start: 9, end: 13 });
  });

  test("returns null when no @ token at cursor", () => {
    expect(findAtToken("hello world", 5)).toBeNull();
  });

  test("returns null for email-style @ (no preceding whitespace)", () => {
    expect(findAtToken("user@example.com", 16)).toBeNull();
  });

  test("detects bare @", () => {
    const result = findAtToken("@", 1);
    expect(result).toEqual({ token: "@", query: "", start: 0, end: 1 });
  });

  test("allows dots in file paths", () => {
    const result = findAtToken("@src/App.tsx", 12);
    expect(result).toEqual({ token: "@src/App.tsx", query: "src/App.tsx", start: 0, end: 12 });
  });

  test("allows slashes in file paths", () => {
    const result = findAtToken("@server/src/routes/filesystem.ts", 32);
    expect(result).toEqual({
      token: "@server/src/routes/filesystem.ts",
      query: "server/src/routes/filesystem.ts",
      start: 0,
      end: 32,
    });
  });

  test("extends past cursor to full non-whitespace token", () => {
    // Cursor after "@src/" in "@src/App.tsx"
    const result = findAtToken("@src/App.tsx more text", 5);
    expect(result).toEqual({ token: "@src/App.tsx", query: "src/App.tsx", start: 0, end: 12 });
  });

  test("does not trigger for slash that looks like @-token", () => {
    // findAtToken should not match /help — that's a slash token
    expect(findAtToken("/help", 5)).toBeNull();
  });
});

// ── replaceAtToken ──────────────────────────────────

describe("replaceAtToken", () => {
  test("replaces token at start of input", () => {
    // "@src" → "src/components/App.tsx " (22 chars + 1 space, cursor after space)
    const result = replaceAtToken("@src", { start: 0, end: 4 }, "src/components/App.tsx");
    expect(result).toEqual({
      newValue: "src/components/App.tsx ",
      newCursorPos: "src/components/App.tsx ".length,
    });
  });

  test("replaces token mid-text preserving surroundings", () => {
    // findAtToken("check @src/co and fix", 13) gives { start: 6, end: 13 }
    const result = replaceAtToken("check @src/co and fix", { start: 6, end: 13 }, "src/components/App.tsx");
    expect(result).toEqual({
      newValue: "check src/components/App.tsx  and fix",
      newCursorPos: 6 + "src/components/App.tsx".length + 1,
    });
  });

  test("replaces token at end of input", () => {
    // "@App" at pos 4-8, replaced with "src/App.tsx "
    const result = replaceAtToken("fix @App", { start: 4, end: 8 }, "src/App.tsx");
    expect(result).toEqual({
      newValue: "fix src/App.tsx ",
      newCursorPos: 4 + "src/App.tsx".length + 1,
    });
  });

  test("inserts path without @ prefix", () => {
    const result = replaceAtToken("@test", { start: 0, end: 5 }, "test/utils.ts");
    // Should not have @ in the output
    expect(result.newValue.startsWith("test/")).toBe(true);
  });
});

// ── slash vs file token interaction ──────────────────

describe("slash vs file token interaction", () => {
  test("slash token does not match @-prefix", () => {
    expect(findSlashToken("@src/foo", 8)).toBeNull();
  });

  test("file token does not match /-prefix", () => {
    expect(findAtToken("/help", 5)).toBeNull();
  });

  test("both can exist in same text, each matches its own", () => {
    const text = "/help @src/foo";
    // Cursor at end of /help
    const slash = findSlashToken(text, 5);
    expect(slash?.token).toBe("/help");
    // Cursor at end of @src/foo
    const at = findAtToken(text, 14);
    expect(at?.query).toBe("src/foo");
  });

  test("@ after slash command argument works", () => {
    const text = "/review @src/app.tsx";
    const at = findAtToken(text, 19);
    expect(at?.query).toBe("src/app.tsx");
  });
});
