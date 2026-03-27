import { describe, expect, test } from "bun:test";
import type { Message } from "shared";
import {
  ATTACHMENT_ONLY_PLACEHOLDER,
  buildInputHistory,
  canNavigateInputHistory,
  getNextInputHistoryState,
} from "../inputHistory";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    threadId: overrides.threadId ?? "thread-1",
    seq: overrides.seq ?? 1,
    role: overrides.role ?? "user",
    content: overrides.content ?? "",
    toolName: overrides.toolName ?? null,
    toolInput: overrides.toolInput ?? null,
    toolOutput: overrides.toolOutput ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? "2026-03-27T00:00:00.000Z",
  };
}

describe("buildInputHistory", () => {
  test("returns prior user inputs newest-first", () => {
    const messages: Message[] = [
      makeMessage({ seq: 1, content: "first prompt" }),
      makeMessage({ seq: 2, role: "assistant", content: "reply" }),
      makeMessage({ seq: 3, content: "second prompt" }),
      makeMessage({ seq: 4, content: "/stop" }),
    ];

    expect(buildInputHistory(messages)).toEqual(["/stop", "second prompt", "first prompt"]);
  });

  test("skips attachment-only placeholder messages", () => {
    const messages: Message[] = [
      makeMessage({ seq: 1, content: "keep me" }),
      makeMessage({
        seq: 2,
        content: ATTACHMENT_ONLY_PLACEHOLDER,
        metadata: { attachments: [{ id: "att-1" }] },
      }),
      makeMessage({ seq: 3, content: "keep me too" }),
    ];

    expect(buildInputHistory(messages)).toEqual(["keep me too", "keep me"]);
  });
});

describe("canNavigateInputHistory", () => {
  test("allows recall from a blank composer when the caret is at the end", () => {
    expect(canNavigateInputHistory("", 0, 0, null)).toBe(true);
  });

  test("blocks recall while editing a non-empty draft", () => {
    expect(canNavigateInputHistory("draft", 5, 5, null)).toBe(false);
  });

  test("blocks recall when the caret is not at the end of the current value", () => {
    expect(canNavigateInputHistory("recalled command", 3, 3, 0)).toBe(false);
  });
});

describe("getNextInputHistoryState", () => {
  const history = ["latest", "older", "oldest"];

  test("moves to the most recent entry on first ArrowUp", () => {
    expect(getNextInputHistoryState(history, null, "older")).toEqual({ index: 0, value: "latest" });
  });

  test("moves farther back through history on repeated ArrowUp", () => {
    expect(getNextInputHistoryState(history, 0, "older")).toEqual({ index: 1, value: "older" });
  });

  test("moves forward through recalled history on ArrowDown", () => {
    expect(getNextInputHistoryState(history, 2, "newer")).toEqual({ index: 1, value: "older" });
  });

  test("restores a blank draft when leaving the newest recalled entry", () => {
    expect(getNextInputHistoryState(history, 0, "newer")).toEqual({ index: null, value: "" });
  });

  test("returns null when no history navigation is available", () => {
    expect(getNextInputHistoryState([], null, "older")).toBeNull();
    expect(getNextInputHistoryState(history, null, "newer")).toBeNull();
  });
});
