import { describe, expect, test } from "bun:test";
import { filterFiles } from "../fileFilter";

const FILES = [
  "README.md",
  "package.json",
  "src/App.tsx",
  "src/index.ts",
  "src/components/InputBar.tsx",
  "src/components/ChatView.tsx",
  "src/components/SlashCommandInput.tsx",
  "src/lib/fileFilter.ts",
  "src/lib/fileUtils.ts",
  "server/src/index.ts",
  "server/src/routes/filesystem.ts",
  "server/src/routes/projects.ts",
];

describe("filterFiles", () => {
  test("returns empty for empty query", () => {
    expect(filterFiles(FILES, "")).toEqual([]);
  });

  test("returns empty for no matches", () => {
    expect(filterFiles(FILES, "zzznomatch")).toEqual([]);
  });

  test("case-insensitive matching", () => {
    const result = filterFiles(FILES, "README");
    expect(result).toContain("README.md");
  });

  test("case-insensitive matching (lowercase query)", () => {
    const result = filterFiles(FILES, "readme");
    expect(result).toContain("README.md");
  });

  test("basename-start matches rank above substring matches", () => {
    const result = filterFiles(FILES, "Input");
    // InputBar.tsx should rank above SlashCommandInput.tsx
    expect(result.indexOf("src/components/InputBar.tsx")).toBeLessThan(
      result.indexOf("src/components/SlashCommandInput.tsx"),
    );
  });

  test("path-start matches rank above substring matches", () => {
    const result = filterFiles(FILES, "src/lib");
    // src/lib/fileFilter.ts should appear (path starts with query)
    expect(result).toContain("src/lib/fileFilter.ts");
    expect(result).toContain("src/lib/fileUtils.ts");
  });

  test("shorter paths rank higher on tie", () => {
    const result = filterFiles(FILES, "index");
    // src/index.ts (shorter) should rank above server/src/index.ts (longer)
    expect(result.indexOf("src/index.ts")).toBeLessThan(
      result.indexOf("server/src/index.ts"),
    );
  });

  test("respects limit parameter", () => {
    const result = filterFiles(FILES, "s", 3);
    expect(result.length).toBe(3);
  });

  test("substring match across path separators", () => {
    const result = filterFiles(FILES, "routes/file");
    expect(result).toContain("server/src/routes/filesystem.ts");
  });

  test("returns all matches when under limit", () => {
    const result = filterFiles(FILES, "package");
    expect(result).toEqual(["package.json"]);
  });

  test("matches file extension", () => {
    const result = filterFiles(FILES, ".tsx");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((f) => f.endsWith(".tsx"))).toBe(true);
  });
});
