import { describe, expect, test } from "bun:test";
import { wrapAsciiArt } from "../../lib/asciiArt";

describe("wrapAsciiArt", () => {
  test("wraps lines with box-drawing characters in code fences", () => {
    const input = [
      "Here is a diagram:",
      "┌──────────┐",
      "│  Hello   │",
      "└──────────┘",
      "End of diagram.",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "Here is a diagram:",
        "```text",
        "┌──────────┐",
        "│  Hello   │",
        "└──────────┘",
        "```",
        "End of diagram.",
      ].join("\n"),
    );
  });

  test("leaves text without box-drawing characters unchanged", () => {
    const input = "No special characters here.\nJust plain text.";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("does not double-wrap lines already inside code fences", () => {
    const input = [
      "```",
      "┌──┐",
      "└──┘",
      "```",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("handles multiple separate ASCII art blocks", () => {
    const input = [
      "First:",
      "┌─┐",
      "└─┘",
      "Middle text",
      "Second:",
      "├──┤",
      "├──┤",
      "End",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "First:",
        "```text",
        "┌─┐",
        "└─┘",
        "```",
        "Middle text",
        "Second:",
        "```text",
        "├──┤",
        "├──┤",
        "```",
        "End",
      ].join("\n"),
    );
  });

  test("handles ASCII art at the end of content", () => {
    const input = "Before\n┌─────┐\n│ end │\n└─────┘";
    const result = wrapAsciiArt(input);
    expect(result).toBe("Before\n```text\n┌─────┐\n│ end │\n└─────┘\n```");
  });

  test("handles ASCII art at the start of content", () => {
    const input = "┌─┐\n│x│\n└─┘\nAfter";
    const result = wrapAsciiArt(input);
    expect(result).toBe("```text\n┌─┐\n│x│\n└─┘\n```\nAfter");
  });

  test("handles content that is only ASCII art", () => {
    const input = "┌─┐\n└─┘";
    const result = wrapAsciiArt(input);
    expect(result).toBe("```text\n┌─┐\n└─┘\n```");
  });

  test("handles empty string", () => {
    expect(wrapAsciiArt("")).toBe("");
  });

  test("does not wrap horizontal-only separator lines", () => {
    const input = [
      "Here is a summary:",
      "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
      "\u2500\u2500 Section Title \u2500\u2500",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "Some content after.",
    ].join("\n");
    // Horizontal-only lines should pass through unchanged
    expect(wrapAsciiArt(input)).toBe(input);
  });

  // --- Codex adversarial findings ---

  test("does not wrap box-drawing inside blockquotes", () => {
    const input = [
      "> Here is a quote:",
      "> ┌──┐",
      "> │hi│",
      "> └──┘",
      "> done",
    ].join("\n");
    // Lines inside blockquotes must not be wrapped
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("does not wrap box-drawing inside list items", () => {
    const input = [
      "- item",
      "  ┌─┐",
      "  └─┘",
      "- next",
    ].join("\n");
    // Lines after a list item (before a blank line) must not be wrapped
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("wraps art after blank line ends list context", () => {
    const input = [
      "- item one",
      "- item two",
      "",
      "┌──────┐",
      "│ free │",
      "└──────┘",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "- item one",
        "- item two",
        "",
        "```text",
        "┌──────┐",
        "│ free │",
        "└──────┘",
        "```",
      ].join("\n"),
    );
  });

  test("handles ~~~ tilde code fences", () => {
    const input = [
      "~~~",
      "┌──┐",
      "└──┘",
      "~~~",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("handles quoted code fences (> ```)", () => {
    const input = [
      "> ```text",
      "> ┌──┐",
      "> └──┘",
      "> ```",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("does not wrap single structural char in prose", () => {
    const input = "Use │ to separate columns.";
    // Single structural char should not trigger wrapping
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("preserves indented code fences", () => {
    const input = [
      "  ```python",
      "  ─── header ───",
      "  ```",
    ].join("\n");
    // Inside a code fence (even indented), don't wrap
    expect(wrapAsciiArt(input)).toBe(input);
  });
});
