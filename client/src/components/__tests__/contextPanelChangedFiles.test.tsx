import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangedFilesList, resolveChangedFilePath } from "../ContextPanel";

const originalWindow = globalThis.window;

describe("ContextPanel changed files", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { hostname: "localhost" } },
    });
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
      return;
    }

    delete (globalThis as { window?: Window }).window;
  });

  test("resolves relative changed files against the worktree root", () => {
    expect(
      resolveChangedFilePath("/tmp/wt-pr-discovery", "client/src/components/ContextPanel.tsx"),
    ).toBe("/tmp/wt-pr-discovery/client/src/components/ContextPanel.tsx");

    expect(
      resolveChangedFilePath("/tmp/wt-pr-discovery/", "README.md"),
    ).toBe("/tmp/wt-pr-discovery/README.md");
  });

  test("renders changed files as clickable file links", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesList
        worktreePath="/tmp/wt-pr-discovery"
        changedFiles={["client/src/components/ContextPanel.tsx"]}
      />,
    );

    expect(markup).toContain(
      'href="vscode://file/tmp/wt-pr-discovery/client/src/components/ContextPanel.tsx"',
    );
    expect(markup).toContain("ContextPanel.tsx");
  });
});
