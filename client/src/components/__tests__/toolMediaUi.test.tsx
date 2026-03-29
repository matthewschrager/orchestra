import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message, Thread } from "shared";
import { pairTools } from "../ChatView";
import { ToolMediaRenderer, getToolImages } from "../renderers/ToolMediaRenderer";

const baseThread: Thread = {
  id: "thread-1",
  title: "Thread",
  agent: "codex",
  effortLevel: null,
  permissionMode: null,
  model: null,
  projectId: "project-1",
  repoPath: "/repo",
  worktree: null,
  branch: null,
  prUrl: null,
  prStatus: null,
  prNumber: null,
  pid: null,
  status: "done",
  errorMessage: null,
  archivedAt: null,
  createdAt: "2026-03-27T00:00:00.000Z",
  updatedAt: "2026-03-27T00:00:00.000Z",
  lastInteractedAt: "2026-03-27T00:00:00.000Z",
};

describe("tool media rendering", () => {
  test("pairs tool-use with metadata-only image result", () => {
    const messages: Message[] = [
      {
        id: "tool-use",
        threadId: baseThread.id,
        seq: 1,
        role: "tool",
        content: "",
        toolName: "js_repl",
        toolInput: '{"code":"emit screenshot"}',
        toolOutput: null,
        metadata: null,
        createdAt: baseThread.createdAt,
      },
      {
        id: "tool-result",
        threadId: baseThread.id,
        seq: 2,
        role: "tool",
        content: "",
        toolName: "js_repl",
        toolInput: null,
        toolOutput: null,
        metadata: {
          images: [{ src: "data:image/png;base64,YWJj", alt: "Screenshot" }],
        },
        createdAt: baseThread.createdAt,
      },
    ];

    const pairs = pairTools(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].name).toBe("js_repl");
    expect(pairs[0].metadata).toEqual(messages[1].metadata);
  });

  test("extracts renderable tool images from metadata", () => {
    expect(getToolImages({
      images: [
        { src: "data:image/png;base64,YWJj", alt: "Preview" },
      ],
    })).toEqual([
      { src: "data:image/png;base64,YWJj", alt: "Preview", mimeType: undefined },
    ]);
  });

  test("rejects unsafe svg data URLs", () => {
    expect(getToolImages({
      images: [
        { src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", alt: "Unsafe" },
      ],
    })).toEqual([]);
  });

  test("pairs concurrent Agent tool_uses with their results", () => {
    // When Claude launches multiple subagents in parallel, the message sequence is:
    // Agent USE, Agent USE, Agent USE, ...subagent tools..., Agent RES, Agent RES, Agent RES
    // pairTools must not break at the second Agent USE — it should pair each USE with its RES.
    const msg = (id: string, seq: number, overrides: Partial<Message>): Message => ({
      id, threadId: baseThread.id, seq, role: "tool", content: "",
      toolName: null, toolInput: null, toolOutput: null, metadata: null,
      createdAt: baseThread.createdAt, ...overrides,
    });
    const messages: Message[] = [
      msg("a1", 1, { toolName: "Agent", toolInput: '{"description":"Explore code"}' }),
      msg("a2", 2, { toolName: "Agent", toolInput: '{"description":"Search docs"}' }),
      msg("a3", 3, { toolName: "Agent", toolInput: '{"description":"Check tests"}' }),
      // Subagent internal tools
      msg("r1", 4, { toolName: "Read", toolInput: '{"file":"a.ts"}' }),
      msg("r2", 5, { toolName: "Read", toolOutput: "file contents" }),
      msg("r3", 6, { toolName: "Grep", toolInput: '{"pattern":"foo"}' }),
      msg("r4", 7, { toolName: "Grep", toolOutput: "matched" }),
      // Agent results (in same order as uses)
      msg("ar1", 8, { toolName: "Agent", toolOutput: "Explore result" }),
      msg("ar2", 9, { toolName: "Agent", toolOutput: "Search result" }),
      msg("ar3", 10, { toolName: "Agent", toolOutput: "Test result" }),
    ];

    const pairs = pairTools(messages);
    // 3 Agent pairs + 2 subagent tool pairs = 5
    const agentPairs = pairs.filter((p) => p.name === "Agent");
    expect(agentPairs).toHaveLength(3);
    // Each Agent USE should be paired with the correct RES (FIFO order)
    expect(agentPairs[0].input).toContain("Explore code");
    expect(agentPairs[0].output).toBe("Explore result");
    expect(agentPairs[1].input).toContain("Search docs");
    expect(agentPairs[1].output).toBe("Search result");
    expect(agentPairs[2].input).toContain("Check tests");
    expect(agentPairs[2].output).toBe("Test result");
  });

  test("Agent tool_use without result stays unpaired (still running)", () => {
    const msg = (id: string, seq: number, overrides: Partial<Message>): Message => ({
      id, threadId: baseThread.id, seq, role: "tool", content: "",
      toolName: null, toolInput: null, toolOutput: null, metadata: null,
      createdAt: baseThread.createdAt, ...overrides,
    });
    const messages: Message[] = [
      msg("a1", 1, { toolName: "Agent", toolInput: '{"description":"Running task"}' }),
      msg("r1", 2, { toolName: "Read", toolInput: '{"file":"a.ts"}' }),
      msg("r2", 3, { toolName: "Read", toolOutput: "file contents" }),
      // No Agent result yet — subagent still running
    ];

    const pairs = pairTools(messages);
    const agentPair = pairs.find((p) => p.name === "Agent");
    expect(agentPair).toBeDefined();
    expect(agentPair!.input).toContain("Running task");
    expect(agentPair!.output).toBeNull(); // No result yet → isActive=true
  });

  test("renders inline tool images", () => {
    const markup = renderToStaticMarkup(
      <ToolMediaRenderer
        output={null}
        metadata={{ images: [{ src: "data:image/png;base64,YWJj", alt: "Preview" }] }}
      />,
    );

    expect(markup).toContain("<img");
    expect(markup).toContain("data:image/png;base64,YWJj");
    expect(markup).toContain("Preview");
  });
});
