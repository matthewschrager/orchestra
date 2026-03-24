import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude";

function createParser() {
  return new ClaudeAdapter().createParser();
}

describe("ClaudeAdapter parser", () => {
  test("extracts cost_usd and duration_ms from result event", () => {
    const parser = createParser();
    const { messages, deltas } = parser.parseOutput(JSON.stringify({
      type: "result",
      cost_usd: 0.12,
      duration_ms: 3400,
      session_id: "sess-123",
    }));

    expect(messages).toHaveLength(0);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const metricsDelta = deltas.find((d) => d.deltaType === "metrics");
    expect(metricsDelta).toBeDefined();
    expect(metricsDelta!.costUsd).toBe(0.12);
    expect(metricsDelta!.durationMs).toBe(3400);
    const turnEnd = deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.text).toBe("sess-123");
  });

  test("accepts total_cost_usd from current Claude result events", () => {
    const parser = createParser();
    const { deltas } = parser.parseOutput(JSON.stringify({
      type: "result",
      total_cost_usd: 0.34,
      duration_ms: 1200,
      session_id: "sess-total",
    }));

    const metricsDelta = deltas.find((d) => d.deltaType === "metrics");
    expect(metricsDelta).toBeDefined();
    expect(metricsDelta!.costUsd).toBe(0.34);
    expect(metricsDelta!.durationMs).toBe(1200);
  });

  test("handles result event without cost fields", () => {
    const parser = createParser();
    const { deltas } = parser.parseOutput(JSON.stringify({
      type: "result",
      session_id: "sess-456",
    }));

    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaType).toBe("turn_end");
  });

  test("captures session_id from early init envelopes without creating a phantom message", () => {
    const parser = createParser();
    const { messages, deltas, sessionId } = parser.parseOutput(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-init",
    }));

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
    expect(sessionId).toBe("sess-init");
  });

  test("assistant event with only text produces no messages (text persisted via stream_events)", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    }));

    // Text-only assistant events are redundant — text is persisted via content_block_stop
    expect(messages).toHaveLength(0);
  });

  test("parses top-level tool_use event and emits attention for AskUserQuestion", () => {
    const parser = createParser();
    const { messages, attention } = parser.parseOutput(JSON.stringify({
      type: "tool_use",
      tool: {
        id: "toolu_123",
        name: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which branch should we use?",
            options: [{ label: "main" }, { label: "feature" }],
          }],
        },
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(attention).toBeDefined();
    expect(attention!.prompt).toBe("Which branch should we use?");
    expect(attention!.options).toEqual(["main", "feature"]);
  });

  test("handles system event as assistant message", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "system",
      content: "System initialization complete",
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("System initialization complete");
  });

  test("handles system event with null content (no phantom message)", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({ type: "system", content: null }));
    expect(messages).toHaveLength(0);
  });

  test("handles system event with empty string content (no phantom message)", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({ type: "system", content: "" }));
    expect(messages).toHaveLength(0);
  });

  test("message_stop stream event does not emit turn_end (only result does)", () => {
    const parser = createParser();
    const { messages, deltas } = parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "message_stop" },
    }));

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("silently ignores thinking deltas from slash-command runs", () => {
    const parser = createParser();
    const { messages, deltas } = parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
      session_id: "sess-think",
    }));

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("handles empty line gracefully", () => {
    const parser = createParser();
    const { messages, deltas } = parser.parseOutput("");
    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("message_stop does not emit turn_end (result event handles it)", () => {
    const parser = createParser();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "message_stop" },
    });
    const { messages, deltas } = parser.parseOutput(line);
    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("handles non-JSON line as raw assistant output", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput("some raw text output");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("some raw text output");
  });

  test("tracks tool blocks by content block index so interleaved blocks do not corrupt ask-user input", () => {
    const parser = createParser();

    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion" } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"questions\":[{\"question\":\"Which branch should we use?\"" },
      },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Thinking..." } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ",\"header\":\"Branch\"}]}" },
      },
    }));

    const { messages, deltas, attention } = parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(messages[0].toolInput).toBe("{\"questions\":[{\"question\":\"Which branch should we use?\",\"header\":\"Branch\"}]}");
    expect(deltas).toEqual([{ deltaType: "tool_end" }]);
    expect(attention?.prompt).toBe("Which branch should we use?");
  });

  test("merges initial tool input with a trailing streamed fragment when Claude starts with parsed JSON", () => {
    const parser = createParser();

    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_ask",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which branch should we use?" }] },
        },
      },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ",\"description\":\"Check current branch\"}" },
      },
    }));

    const { messages, attention } = parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(JSON.parse(messages[0].toolInput!)).toEqual({
      questions: [{ question: "Which branch should we use?" }],
      description: "Check current branch",
    });
    expect(attention?.prompt).toBe("Which branch should we use?");
  });

  test("emits turn_end on result event even without session_id", () => {
    const parser = createParser();
    const { deltas } = parser.parseOutput(JSON.stringify({
      type: "result",
      cost_usd: 0.05,
      duration_ms: 1000,
    }));

    const turnEnd = deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.text).toBeUndefined();

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.costUsd).toBe(0.05);
  });

  test("keeps parser state isolated across concurrent session parsers", () => {
    const adapter = new ClaudeAdapter();
    const parserA = adapter.createParser();
    const parserB = adapter.createParser();

    parserA.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "AskUserQuestion" } },
    }));
    parserB.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b", name: "Bash" } },
    }));
    parserA.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"questions\":[{\"question\":\"Pick A?\"}]}" } },
    }));
    parserB.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" } },
    }));

    const resultB = parserB.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));
    const resultA = parserA.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(resultB.messages[0].toolName).toBe("Bash");
    expect(resultB.messages[0].toolInput).toBe("{\"command\":\"pwd\"}");
    expect(resultB.attention).toBeUndefined();

    expect(resultA.messages[0].toolName).toBe("AskUserQuestion");
    expect(resultA.messages[0].toolInput).toBe("{\"questions\":[{\"question\":\"Pick A?\"}]}");
    expect(resultA.attention?.prompt).toBe("Pick A?");
  });

  // ── Stream event text persistence ──────────────────────

  test("persists text from stream_event content blocks on stop", () => {
    const parser = createParser();

    // Start a text content block
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    }));
    // Stream text deltas
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } },
    }));
    // Stop the block — should persist the accumulated text
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello world!");
  });

  test("pairs user-event tool_result with tool_use via tool_use_id", () => {
    const parser = createParser();

    // First, emit a tool_use via stream_event so the ID is tracked
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abc", name: "Bash" } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
    }));
    parser.parseOutput(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    }));

    // Now a user event with tool_result referencing that ID
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_abc", content: "file1.ts\nfile2.ts" },
        ],
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("Bash");
    expect(messages[0].toolOutput).toBe("file1.ts\nfile2.ts");
  });

  // ── Top-level assistant/user envelope parsing ─────────

  test("extracts tool_use blocks from top-level assistant event (text handled by stream_events)", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/foo/bar.ts" } },
        ],
      },
    }));

    // Only tool_use extracted — text is persisted via stream_event content_block_stop
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("Read");
    expect(JSON.parse(messages[0].toolInput!)).toEqual({ file_path: "/foo/bar.ts" });
  });

  test("extracts tool_use blocks from assistant event with no text", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } },
        ],
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("Bash");
  });

  test("detects AskUserQuestion in top-level assistant tool_use blocks", () => {
    const parser = createParser();
    const { messages, attention } = parser.parseOutput(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {
            questions: [{ question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
          }},
        ],
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(attention).toBeDefined();
    expect(attention!.prompt).toBe("Which option?");
    expect(attention!.options).toEqual(["A", "B"]);
  });

  test("extracts tool_result from top-level user event", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read", content: "file contents here" },
        ],
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolOutput).toBe("file contents here");
  });

  test("extracts tool_result with array content from user event", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_agent", content: [
            { type: "text", text: "Subagent completed successfully." },
          ]},
        ],
      },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].toolOutput).toBe("Subagent completed successfully.");
  });

  test("handles user event with no tool_result blocks (echo of user prompt)", () => {
    const parser = createParser();
    const { messages } = parser.parseOutput(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Hello, please help me." },
        ],
      },
    }));

    // Text-only user events produce no messages (still echo of user input)
    expect(messages).toHaveLength(0);
  });
});
