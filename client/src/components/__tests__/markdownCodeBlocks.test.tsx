import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../MarkdownContent";

describe("MarkdownContent code blocks", () => {
  test("renders unlabeled fenced code blocks as block code", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={[
          "```",
          "┌───────┐",
          "│ Agent │",
          "└───────┘",
          "```",
        ].join("\n")}
      />,
    );

    expect(html).toContain('<pre class="md-code-block"><code>');
    expect(html).toContain("┌───────┐");
    expect(html).not.toContain("md-inline-code");
  });

  test("keeps inline code inline", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content={"Use `agent run` to continue."} />,
    );

    expect(html).toContain('class="md-inline-code"');
    expect(html).not.toContain('<pre class="md-code-block"><code>');
  });
});
