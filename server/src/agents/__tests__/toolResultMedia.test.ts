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

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: "image/png",
      alt: "Tool image 1",
    });
    expect(result.images[0].src).toMatch(/^\/api\/files\/serve\?path=/);
    const persistedPath = new URL(`http://localhost${result.images[0].src}`).searchParams.get("path");
    expect(persistedPath).toContain("/tmp/orchestra-tool-result-images/");
    expect(persistedPath?.endsWith(".png")).toBe(true);
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

  test("extracts image file paths from nested structured content", () => {
    const result = normalizeToolResultContent({
      artifact: {
        screenshot: {
          path: "/tmp/mobile-shot.png",
          title: "Mobile screenshot",
        },
      },
    });

    expect(result.images).toEqual([
      {
        src: "/api/files/serve?path=%2Ftmp%2Fmobile-shot.png",
        mimeType: "image/png",
        alt: "Mobile screenshot",
      },
    ]);
  });
});
