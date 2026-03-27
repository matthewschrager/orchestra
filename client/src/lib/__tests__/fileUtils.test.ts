import { describe, expect, test } from "bun:test";
import { isImageFile, shortenPath, fileServeUrl } from "../fileUtils";

describe("isImageFile", () => {
  test("returns true for common image extensions", () => {
    expect(isImageFile("/tmp/screenshot.png")).toBe(true);
    expect(isImageFile("/tmp/photo.jpg")).toBe(true);
    expect(isImageFile("/tmp/photo.jpeg")).toBe(true);
    expect(isImageFile("/tmp/animation.gif")).toBe(true);
    expect(isImageFile("/tmp/image.webp")).toBe(true);
    expect(isImageFile("/tmp/bitmap.bmp")).toBe(true);
  });

  test("returns true case-insensitively", () => {
    expect(isImageFile("/tmp/SCREENSHOT.PNG")).toBe(true);
    expect(isImageFile("/tmp/Photo.JPG")).toBe(true);
  });

  test("returns false for SVG (XSS risk)", () => {
    expect(isImageFile("/tmp/icon.svg")).toBe(false);
  });

  test("returns false for non-image files", () => {
    expect(isImageFile("/src/index.ts")).toBe(false);
    expect(isImageFile("/README.md")).toBe(false);
    expect(isImageFile("/data.json")).toBe(false);
    expect(isImageFile("/binary.exe")).toBe(false);
  });

  test("returns false for empty or extensionless paths", () => {
    expect(isImageFile("")).toBe(false);
    expect(isImageFile("/tmp/noextension")).toBe(false);
  });
});

describe("shortenPath", () => {
  test("returns short paths unchanged", () => {
    expect(shortenPath("/src/index.ts")).toBe("/src/index.ts");
    expect(shortenPath("file.ts")).toBe("file.ts");
  });

  test("shortens long paths to last 3 segments", () => {
    expect(shortenPath("/home/user/projects/src/index.ts")).toBe("…/projects/src/index.ts");
  });

  test("handles empty/null-ish input", () => {
    expect(shortenPath("")).toBe("");
  });
});

describe("fileServeUrl", () => {
  test("builds URL with encoded path", () => {
    expect(fileServeUrl("/tmp/test.png")).toBe("/api/files/serve?path=%2Ftmp%2Ftest.png");
  });

  test("encodes spaces in path", () => {
    const url = fileServeUrl("/tmp/my screenshot.png");
    expect(url).toContain("my%20screenshot.png");
  });
});
