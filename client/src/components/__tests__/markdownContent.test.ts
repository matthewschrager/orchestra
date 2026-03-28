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

  test("wraps box-drawing inside list items with indented fences", () => {
    const input = [
      "- item",
      "  ┌─┐",
      "  └─┘",
      "- next",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(
      [
        "- item",
        "  ```text",
        "  ┌─┐",
        "  └─┘",
        "  ```",
        "- next",
      ].join("\n"),
    );
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

  // --- ASCII pipe and mixed diagram support ---

  test("wraps mixed Unicode box-drawing + ASCII pipe diagrams as single block", () => {
    const input = [
      "Looking at this:",
      "┌──────────────────────────────┐",
      "| Left sidebar | Right pane |",
      "| Feature 1 | Review |",
      "| Feature 2 | Review |",
      "└──────────────────────────────┘",
      "Done.",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "Looking at this:",
        "```text",
        "┌──────────────────────────────┐",
        "| Left sidebar | Right pane |",
        "| Feature 1 | Review |",
        "| Feature 2 | Review |",
        "└──────────────────────────────┘",
        "```",
        "Done.",
      ].join("\n"),
    );
  });

  test("wraps pure ASCII pipe-column diagrams", () => {
    const input = [
      "Table:",
      "| Name | Value | Status |",
      "| Alice | 42 | OK |",
      "| Bob | 99 | ERR |",
      "After.",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "Table:",
        "```text",
        "| Name | Value | Status |",
        "| Alice | 42 | OK |",
        "| Bob | 99 | ERR |",
        "```",
        "After.",
      ].join("\n"),
    );
  });

  test("wraps ASCII border (+---+) diagrams", () => {
    const input = [
      "Grid:",
      "+--------+--------+",
      "| Cell 1 | Cell 2 |",
      "+--------+--------+",
      "| Cell 3 | Cell 4 |",
      "+--------+--------+",
      "End.",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "Grid:",
        "```text",
        "+--------+--------+",
        "| Cell 1 | Cell 2 |",
        "+--------+--------+",
        "| Cell 3 | Cell 4 |",
        "+--------+--------+",
        "```",
        "End.",
      ].join("\n"),
    );
  });

  test("continues art block through single-pipe-pair lines (| text |)", () => {
    // A line with just outer pipes should not break a diagram mid-block
    const input = [
      "┌──────────────────┐",
      "| [Yellow Q&A card] |",
      "| Review | Status |",
      "└──────────────────┘",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "```text",
        "┌──────────────────┐",
        "| [Yellow Q&A card] |",
        "| Review | Status |",
        "└──────────────────┘",
        "```",
      ].join("\n"),
    );
  });

  test("does not wrap GFM tables (with separator row)", () => {
    const input = [
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
      "| Bob | 25 |",
    ].join("\n");
    // GFM tables should pass through unchanged for react-markdown to render
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("does not wrap GFM table with alignment markers", () => {
    const input = [
      "| Left | Center | Right |",
      "| :--- | :---: | ---: |",
      "| a | b | c |",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("wraps pipe-column block that has no GFM separator", () => {
    // This is art, not a table — no separator row
    const input = [
      "| Header A | Header B |",
      "| value 1 | value 2 |",
      "| value 3 | value 4 |",
    ].join("\n");
    const result = wrapAsciiArt(input);
    expect(result).toBe(
      [
        "```text",
        "| Header A | Header B |",
        "| value 1 | value 2 |",
        "| value 3 | value 4 |",
        "```",
      ].join("\n"),
    );
  });

  test("wraps Claude-style ASCII mockups that contain separator rows", () => {
    const input = [
      "Modal Layout:",
      "| Cleanup Merged Threads |",
      "| ---------------------- |",
      "| Safe to delete (11) | Needs review (1) |",
      "| ------------------- | ---------------- |",
      "| Delete selected | Cancel |",
      "After.",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(
      [
        "Modal Layout:",
        "```text",
        "| Cleanup Merged Threads |",
        "| ---------------------- |",
        "| Safe to delete (11) | Needs review (1) |",
        "| ------------------- | ---------------- |",
        "| Delete selected | Cancel |",
        "```",
        "After.",
      ].join("\n"),
    );
  });

  test("wraps mixed mockups with multiple markdown-like separator rows", () => {
    const input = [
      "| Section | Count |",
      "| --- | --- |",
      "| Safe to delete | 11 |",
      "| --- | --- |",
      "| Needs review | 1 |",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(
      [
        "```text",
        "| Section | Count |",
        "| --- | --- |",
        "| Safe to delete | 11 |",
        "| --- | --- |",
        "| Needs review | 1 |",
        "```",
      ].join("\n"),
    );
  });

  test("does not wrap ASCII pipe rows inside blockquotes", () => {
    const input = [
      "> | col1 | col2 |",
      "> | a | b |",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  test("wraps ASCII pipe rows inside list context with indented fences", () => {
    const input = [
      "- item",
      "  | col1 | col2 |",
      "  | a | b |",
      "- next",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(
      [
        "- item",
        "  ```text",
        "  | col1 | col2 |",
        "  | a | b |",
        "  ```",
        "- next",
      ].join("\n"),
    );
  });

  test("wraps Claude-style diagrams inside numbered list items", () => {
    const input = [
      "1. Simple flowchart:",
      "   ┌───────┐   ┌───────┐",
      "   │ Input │──▶│ Agent │",
      "   └───────┘   └───────┘",
      "2. Next section:",
      "   Done.",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(
      [
        "1. Simple flowchart:",
        "   ```text",
        "   ┌───────┐   ┌───────┐",
        "   │ Input │──▶│ Agent │",
        "   └───────┘   └───────┘",
        "   ```",
        "2. Next section:",
        "   Done.",
      ].join("\n"),
    );
  });

  // --- Adversarial review findings ---

  test("does not swallow GFM table that immediately follows a box diagram", () => {
    const input = [
      "┌────┐",
      "| box |",
      "└────┘",
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
    ].join("\n");
    const result = wrapAsciiArt(input);
    // Box should be wrapped, but the GFM table should pass through for markdown rendering
    expect(result).toBe(
      [
        "```text",
        "┌────┐",
        "| box |",
        "└────┘",
        "```",
        "| Name | Age |",
        "| --- | --- |",
        "| Alice | 30 |",
      ].join("\n"),
    );
  });

  test("does not wrap bare +++ or ++++ as border art", () => {
    expect(wrapAsciiArt("Before\n+++\nAfter")).toBe("Before\n+++\nAfter");
    expect(wrapAsciiArt("Before\n++++\nAfter")).toBe("Before\n++++\nAfter");
  });

  test("still wraps real +---+ borders", () => {
    const input = "+---+---+\n| a | b |\n+---+---+";
    const result = wrapAsciiArt(input);
    expect(result).toBe("```text\n+---+---+\n| a | b |\n+---+---+\n```");
  });
});
