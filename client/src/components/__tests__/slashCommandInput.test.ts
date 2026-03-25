import { describe, expect, test } from "bun:test";
import { findSlashToken, buildHighlightSegments, replaceSlashToken } from "../SlashCommandInput";
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
