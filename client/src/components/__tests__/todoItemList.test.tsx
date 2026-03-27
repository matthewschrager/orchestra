import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TodoItem } from "shared";
import { TodoItemList } from "../TodoItemList";

describe("TodoItemList", () => {
  test("renders the in-progress marker and shows the active form", () => {
    const items: TodoItem[] = [
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
    ];

    const markup = renderToStaticMarkup(<TodoItemList items={items} />);

    expect(markup).toContain('aria-label="in progress"');
    expect(markup).toContain("▸");
    expect(markup).toContain("Writing tests");
    expect(markup).not.toContain(">Write tests<");
  });

  test("renders the compact spacing variant for pinned panels", () => {
    const items: TodoItem[] = [
      { content: "Run checks", status: "pending", activeForm: "Running checks" },
    ];

    const markup = renderToStaticMarkup(<TodoItemList items={items} compact />);

    expect(markup).toContain("py-[3px]");
    expect(markup).toContain('aria-label="pending"');
  });
});
