import { describe, expect, test } from "bun:test";
import {
  buildVscodeUrl,
  fileServeUrl,
  isImageFile,
  isLocalhostHostname,
  isServableFilePath,
  parseLocalFileHref,
  shortenPath,
} from "../fileUtils";

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

describe("isServableFilePath", () => {
  test("returns true for safe inline documents", () => {
    expect(isServableFilePath("/tmp/PLAN.md")).toBe(true);
    expect(isServableFilePath("/tmp/notes.txt")).toBe(true);
    expect(isServableFilePath("/tmp/data.json")).toBe(true);
    expect(isServableFilePath("/tmp/report.pdf")).toBe(true);
  });

  test("returns false for unsupported files", () => {
    expect(isServableFilePath("/tmp/archive.zip")).toBe(false);
    expect(isServableFilePath("/tmp/script.ts")).toBe(false);
  });
});

describe("parseLocalFileHref", () => {
  test("parses absolute filesystem paths", () => {
    expect(parseLocalFileHref("/home/user/project/PLAN.md")).toEqual({
      path: "/home/user/project/PLAN.md",
      line: undefined,
      col: undefined,
    });
  });

  test("parses tilde paths with line references", () => {
    expect(parseLocalFileHref("~/project/PLAN.md:12:3")).toEqual({
      path: "~/project/PLAN.md",
      line: 12,
      col: 3,
    });
  });

  test("parses file URLs with line fragments", () => {
    expect(parseLocalFileHref("file:///home/user/PLAN.md#L24C2")).toEqual({
      path: "/home/user/PLAN.md",
      line: 24,
      col: 2,
    });
  });

  test("ignores normal app and web links", () => {
    expect(parseLocalFileHref("/api/files/serve?path=/tmp/test.png")).toBeNull();
    expect(parseLocalFileHref("https://example.com/docs/PLAN.md")).toBeNull();
    expect(parseLocalFileHref("/manifest.json")).toBeNull();
  });
});

describe("buildVscodeUrl", () => {
  test("builds file links with optional line and column", () => {
    expect(buildVscodeUrl("/tmp/test.ts")).toBe("vscode://file/tmp/test.ts");
    expect(buildVscodeUrl("/tmp/test.ts", 12, 4)).toBe("vscode://file/tmp/test.ts:12:4");
  });
});

describe("isLocalhostHostname", () => {
  test("recognizes localhost variants", () => {
    expect(isLocalhostHostname("localhost")).toBe(true);
    expect(isLocalhostHostname("127.0.0.1")).toBe(true);
    expect(isLocalhostHostname("::1")).toBe(true);
    expect(isLocalhostHostname("orchestra.example.com")).toBe(false);
  });
});
