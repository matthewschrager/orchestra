import { describe, expect, test } from "bun:test";
import { pairHasImages, type ToolPair } from "../ChatView";

function makePair(overrides: Partial<ToolPair> = {}): ToolPair {
  return {
    id: "t1",
    name: "Read",
    input: null,
    output: null,
    context: "",
    metadata: null,
    ...overrides,
  };
}

describe("pairHasImages", () => {
  test("returns true when metadata contains images", () => {
    const pair = makePair({
      name: "js_repl",
      metadata: {
        images: [{ src: "data:image/png;base64,YWJj", alt: "Screenshot" }],
      },
    });
    expect(pairHasImages(pair)).toBe(true);
  });

  test("returns false when metadata has no images", () => {
    const pair = makePair({ name: "Grep", metadata: {} });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns false when metadata is null", () => {
    const pair = makePair({ name: "Grep", metadata: null });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns true for Read tool reading a PNG file", () => {
    const pair = makePair({
      name: "Read",
      input: JSON.stringify({ file_path: "/home/user/screenshot.png" }),
    });
    expect(pairHasImages(pair)).toBe(true);
  });

  test("returns true for Read tool reading a JPG file", () => {
    const pair = makePair({
      name: "Read",
      input: JSON.stringify({ file_path: "/tmp/photo.jpg" }),
    });
    expect(pairHasImages(pair)).toBe(true);
  });

  test("returns false for Read tool reading a text file", () => {
    const pair = makePair({
      name: "Read",
      input: JSON.stringify({ file_path: "/home/user/CLAUDE.md" }),
    });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns false for Read with unparseable input", () => {
    const pair = makePair({
      name: "Read",
      input: "not json",
    });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns false for Read with null input", () => {
    const pair = makePair({
      name: "Read",
      input: null,
    });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns false for non-Read tool without metadata images", () => {
    const pair = makePair({
      name: "Edit",
      input: JSON.stringify({ file_path: "/home/user/logo.png" }),
    });
    expect(pairHasImages(pair)).toBe(false);
  });

  test("returns true for Read with filePath key variant", () => {
    const pair = makePair({
      name: "Read",
      input: JSON.stringify({ filePath: "/tmp/img.webp" }),
    });
    expect(pairHasImages(pair)).toBe(true);
  });
});
