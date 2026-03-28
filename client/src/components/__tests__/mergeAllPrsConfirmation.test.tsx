import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MergeAllPrsConfirmationModal } from "../MergeAllPrsConfirmationModal";

describe("MergeAllPrsConfirmationModal", () => {
  const baseProps = {
    projectName: "orchestra",
    prCount: 3,
    loading: false,
    onClose: () => {},
    onConfirm: () => {},
  };

  test("renders project name and PR count", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} />,
    );

    expect(markup).toContain("orchestra");
    expect(markup).toContain("3 outstanding PRs");
    expect(markup).toContain("Launch agent");
    expect(markup).toContain("(3 PRs)");
  });

  test("uses singular text for 1 PR", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} prCount={1} />,
    );

    expect(markup).toContain("1 outstanding PR<");
    // "it" not "each one"
    expect(markup).toContain("merge it into main");
    expect(markup).not.toContain("each one");
    expect(markup).toContain("(1 PR)");
  });

  test("uses plural text for multiple PRs", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} prCount={5} />,
    );

    expect(markup).toContain("5 outstanding PRs");
    expect(markup).toContain("each one");
    expect(markup).toContain("(5 PRs)");
  });

  test("renders all four agent steps", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} />,
    );

    expect(markup).toContain("Inspect each PR for merge conflicts and status");
    expect(markup).toContain("Resolve conflicts on each branch and push fixes");
    expect(markup).toContain("Merge each PR via GitHub");
    expect(markup).toContain("Close any PR that shouldn\u2019t merge");
  });

  test("renders Cancel and Close buttons", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} />,
    );

    expect(markup).toContain("Cancel");
    expect(markup).toContain('aria-label="Close"');
  });

  test("shows loading state with spinner text", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} loading />,
    );

    expect(markup).toContain("Starting");
    // Loading state should not show the "Launch agent" label
    expect(markup).not.toContain("Launch agent");
  });

  test("disables buttons when loading", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} loading />,
    );

    // Close and Cancel buttons should be disabled
    const disabledCount = (markup.match(/disabled=""/g) || []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(2);
  });

  test("renders the accent strip decoration", () => {
    const markup = renderToStaticMarkup(
      <MergeAllPrsConfirmationModal {...baseProps} />,
    );

    // The accent gradient strip at the top of the modal
    expect(markup).toContain("via-accent/60");
  });
});
