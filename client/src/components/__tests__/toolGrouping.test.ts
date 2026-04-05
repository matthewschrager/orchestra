import { describe, expect, test } from "bun:test";
import { groupConsecutiveTools, type ToolPair } from "../ChatView";

function makePair(id: string, name: string): ToolPair {
  return {
    id,
    name,
    input: null,
    output: null,
    context: "",
    metadata: null,
  };
}

describe("groupConsecutiveTools", () => {
  test("keeps consecutive file edits as separate rows", () => {
    const groups = groupConsecutiveTools([
      makePair("edit-1", "Edit"),
      makePair("edit-2", "Edit"),
      makePair("write-1", "Write"),
      makePair("nb-1", "NotebookEdit"),
      makePair("multi-1", "MultiEdit"),
      makePair("multi-2", "MultiEdit"),
    ]);

    expect(groups).toHaveLength(6);
    expect(groups.map((group) => group.map((pair) => pair.id))).toEqual([
      ["edit-1"],
      ["edit-2"],
      ["write-1"],
      ["nb-1"],
      ["multi-1"],
      ["multi-2"],
    ]);
  });

  test("still groups consecutive non-edit tools", () => {
    const groups = groupConsecutiveTools([
      makePair("read-1", "Read"),
      makePair("read-2", "Read"),
      makePair("grep-1", "Grep"),
      makePair("grep-2", "Grep"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].map((pair) => pair.id)).toEqual(["read-1", "read-2"]);
    expect(groups[1].map((pair) => pair.id)).toEqual(["grep-1", "grep-2"]);
  });
});
