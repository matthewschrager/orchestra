import { describe, expect, test } from "bun:test";
import { extractQuestionPreview, formatAnswers, isAskUserTool, parseQuestions } from "../askUser";

describe("parseQuestions", () => {
  test("parses the standard questions payload", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Which branch should I use?",
          header: "Branch",
          options: [
            { label: "main", description: "Base branch" },
            { label: "release" },
          ],
        },
      ],
    });

    expect(parseQuestions(input)).toEqual([
      {
        question: "Which branch should I use?",
        header: "Branch",
        options: [
          { label: "main", description: "Base branch" },
          { label: "release", description: undefined },
        ],
        multiSelect: undefined,
      },
    ]);
  });

  test("parses double-encoded JSON strings", () => {
    const input = JSON.stringify(JSON.stringify({ question: "Ship it?" }));

    expect(parseQuestions(input)).toEqual([
      {
        question: "Ship it?",
        header: undefined,
        options: undefined,
        multiSelect: undefined,
      },
    ]);
  });

  test("parses bare arrays of question objects", () => {
    const input = JSON.stringify([
      {
        prompt: "Pick a test runner",
        options: ["bun test", "vitest"],
      },
    ]);

    expect(parseQuestions(input)).toEqual([
      {
        question: "Pick a test runner",
        header: undefined,
        options: [{ label: "bun test" }, { label: "vitest" }],
        multiSelect: undefined,
      },
    ]);
  });

  test("falls back to a useful string when the payload is a malformed fragment", () => {
    expect(parseQuestions(', "description": "Check current branch"}')).toEqual([
      {
        question: "Check current branch",
      },
    ]);
  });
});

describe("ask-user helpers", () => {
  test("extractQuestionPreview returns the first question text", () => {
    const input = JSON.stringify({ questions: [{ question: "Need approval?" }] });
    expect(extractQuestionPreview(input)).toBe("Need approval?");
  });

  test("formatAnswers formats single and multi-question answers", () => {
    const questions = [
      { question: "Branch?", header: "Branch" },
      { question: "Tests?", header: "Tests" },
    ];
    const selections = new Map<number, string[]>([[0, ["main"]]]);
    const customInputs = new Map<number, string>([[1, "Run bun test"]]);

    expect(formatAnswers(questions, selections, customInputs)).toBe("Branch: main\nTests: Run bun test");
    expect(formatAnswers([questions[0]], new Map([[0, ["main"]]]), new Map())).toBe("main");
  });

  test("recognizes both ask-user tool names", () => {
    expect(isAskUserTool("AskUserQuestion")).toBe(true);
    expect(isAskUserTool("AskUserTool")).toBe(true);
    expect(isAskUserTool("request_user_input")).toBe(true);
    expect(isAskUserTool("functions.request_user_input")).toBe(true);
    expect(isAskUserTool("Bash")).toBe(false);
  });
});
