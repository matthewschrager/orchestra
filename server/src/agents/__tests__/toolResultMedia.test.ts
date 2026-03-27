import { describe, expect, test } from "bun:test";
import { normalizeToolResultContent } from "../toolResultMedia";

describe("normalizeToolResultContent", () => {
  test("preserves safe raster image blocks", () => {
    const result = normalizeToolResultContent([
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/png",
          data: "YWJj",
        },
      },
    ]);

    expect(result.images).toEqual([
      {
        src: "data:image/png;base64,YWJj",
        mimeType: "image/png",
        alt: "Tool image 1",
      },
    ]);
  });

  test("rejects svg image blocks", () => {
    const result = normalizeToolResultContent([
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: "image/svg+xml",
          data: "PHN2Zz48L3N2Zz4=",
        },
      },
    ]);

    expect(result.images).toEqual([]);
  });
});
