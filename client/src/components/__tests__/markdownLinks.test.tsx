import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../MarkdownContent";

describe("MarkdownContent local file links", () => {
  test("rewrites absolute document links to the file proxy", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content="[plan](/home/user/project/PLAN.md)" />,
    );

    expect(html).toContain('href="/api/files/serve?path=%2Fhome%2Fuser%2Fproject%2FPLAN.md"');
    expect(html).toContain(">plan<");
  });

  test("rewrites tilde document links to the file proxy", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content="[notes](~/project/notes.md)" />,
    );

    expect(html).toContain('href="/api/files/serve?path=~%2Fproject%2Fnotes.md"');
  });

  test("leaves normal web links alone", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content="[docs](https://example.com/docs)" />,
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain("/api/files/serve");
  });
});
