import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, ClaudeParser } from "../claude";

function createParser() {
  // ClaudeParser is per-session — create a fresh one for each test
  return new ClaudeParser();
}

describe("ClaudeAdapter", () => {
  test("adapter has correct name and supports resume", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.name).toBe("claude");
    expect(adapter.supportsResume()).toBe(true);
  });
});

describe("ClaudeParser", () => {
  test("extracts cost_usd and duration_ms from result event", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.12,
      duration_ms: 3400,
      session_id: "sess-123",
      permission_denials: [],
    });

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

  test("handles result event without cost fields", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-456",
      permission_denials: [],
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaType).toBe("turn_end");
  });

  test("captures session_id from system init event", () => {
    const parser = createParser();
    const { messages, deltas, sessionId } = parser.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-init",
      tools: [],
      cwd: "/tmp",
    });

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
    expect(sessionId).toBe("sess-init");
  });

  test("assistant event with only text produces no messages (text persisted via stream_events)", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
      session_id: "sess-1",
    });

    // Text-only assistant events are redundant — text is persisted via content_block_stop
    expect(messages).toHaveLength(0);
  });

  test("extracts tool_use blocks from assistant event", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/foo/bar.ts" } },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("Read");
    expect(JSON.parse(messages[0].toolInput!)).toEqual({ file_path: "/foo/bar.ts" });
  });

  test("detects AskUserQuestion in assistant tool_use blocks", () => {
    const parser = createParser();
    const { messages, attention } = parser.handleMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {
              questions: [{ question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(attention).toBeDefined();
    expect(attention!.prompt).toBe("Which option?");
    expect(attention!.options).toEqual(["A", "B"]);
  });

  test("system init event produces no messages", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      tools: ["Read", "Bash"],
      cwd: "/tmp",
    });
    expect(messages).toHaveLength(0);
  });

  test("system compact_boundary produces no messages", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-1",
    });
    expect(messages).toHaveLength(0);
  });

  test("message_stop stream event does not emit turn_end (only result does)", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "stream_event",
      event: { type: "message_stop" },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("silently ignores thinking deltas", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
      session_id: "sess-think",
    });

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("emits turn_end on result event even without session_id", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.05,
      duration_ms: 1000,
      permission_denials: [],
    });

    const turnEnd = deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.text).toBeUndefined();

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.costUsd).toBe(0.05);
  });

  test("keeps parser state isolated across concurrent session parsers", () => {
    const parserA = createParser();
    const parserB = createParser();

    parserA.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "AskUserQuestion" } },
      session_id: "sess-a",
    });
    parserB.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b", name: "Bash" } },
      session_id: "sess-b",
    });
    parserA.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"questions\":[{\"question\":\"Pick A?\"}]}" } },
      session_id: "sess-a",
    });
    parserB.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" } },
      session_id: "sess-b",
    });

    const resultB = parserB.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-b",
    });
    const resultA = parserA.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-a",
    });

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

    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } },
      session_id: "sess-1",
    });
    const { messages } = parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello world!");
  });

  test("pairs user-event tool_result with tool_use via tool_use_id", () => {
    const parser = createParser();

    // First, emit a tool_use via stream_event so the ID is tracked
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abc", name: "Bash" } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-1",
    });

    // Now a user event with tool_result referencing that ID
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_abc", content: "file1.ts\nfile2.ts" },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("Bash");
    expect(messages[0].toolOutput).toBe("file1.ts\nfile2.ts");
  });

  test("tracks tool blocks by content block index so interleaved blocks do not corrupt ask-user input", () => {
    const parser = createParser();

    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion" } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"questions\":[{\"question\":\"Which branch should we use?\"" },
      },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Thinking..." } },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ",\"header\":\"Branch\"}]}" },
      },
      session_id: "sess-1",
    });

    const { messages, deltas, attention } = parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(messages[0].toolInput).toBe("{\"questions\":[{\"question\":\"Which branch should we use?\",\"header\":\"Branch\"}]}");
    expect(deltas).toEqual([{ deltaType: "tool_end" }]);
    expect(attention?.prompt).toBe("Which branch should we use?");
  });

  test("merges initial tool input with a trailing streamed fragment when SDK starts with parsed JSON", () => {
    const parser = createParser();

    parser.handleMessage({
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
      session_id: "sess-1",
    });
    parser.handleMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ",\"description\":\"Check current branch\"}" },
      },
      session_id: "sess-1",
    });

    const { messages, attention } = parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolName).toBe("AskUserQuestion");
    expect(JSON.parse(messages[0].toolInput!)).toEqual({
      questions: [{ question: "Which branch should we use?" }],
      description: "Check current branch",
    });
    expect(attention?.prompt).toBe("Which branch should we use?");
  });

  test("extracts tool_result from user event", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read", content: "file contents here" },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolOutput).toBe("file contents here");
  });

  test("extracts tool_result with array content from user event", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result", tool_use_id: "toolu_agent", content: [
              { type: "text", text: "Subagent completed successfully." },
            ],
          },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolOutput).toBe("Subagent completed successfully.");
  });

  test("propagates is_error from tool_result to metadata", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_err", is_error: true, content: "Agent crashed" },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolOutput).toBe("Agent crashed");
    expect(messages[0].metadata).toEqual({ isError: true });
  });

  test("does not set isError metadata when tool_result succeeds", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ok", content: "Report mentions error handling patterns" },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].toolOutput).toBe("Report mentions error handling patterns");
    expect(messages[0].metadata).toBeUndefined();
  });

  // ── Deduplication across event types ──────────────────

  // Note: top-level "tool_use" events don't exist in the SDK — only in CLI stream-json.
  // Dedup between stream_event and assistant is the relevant SDK scenario.

  test("stream_event + assistant event for same tool_use_id does not produce duplicate messages", () => {
    const parser = createParser();

    // Stream the tool via stream_event flow
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_dup2", name: "Bash" } },
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });

    // Same tool in assistant summary — should be deduped
    const assistantResult = parser.handleMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_dup2", name: "Bash", input: { command: "ls" } }] },
    });
    expect(assistantResult.messages).toHaveLength(0);
  });

  test("multiple assistant events for same tool_use_id does not produce duplicate messages", () => {
    const parser = createParser();

    // First assistant event processes the tool_use
    const first = parser.handleMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_dup4", name: "Read", input: { file_path: "/foo.ts" } }] },
    });
    expect(first.messages).toHaveLength(1);

    // Second assistant event (e.g. from --include-partial-messages) — should be deduped
    const second = parser.handleMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_dup4", name: "Read", input: { file_path: "/foo.ts" } }] },
    });
    expect(second.messages).toHaveLength(0);
  });

  // ── Reverse-order deduplication (tool_use/assistant BEFORE stream_event stop) ──

  test("assistant event before stream_event stop does not produce duplicate (reverse order)", () => {
    const parser = createParser();

    // Assistant summary arrives first
    const assistantResult = parser.handleMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_rev2", name: "Bash", input: { command: "ls" } }] },
    });
    expect(assistantResult.messages).toHaveLength(1);

    // Then the same tool streams via stream_event flow
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_rev2", name: "Bash" } },
    });
    parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" } },
    });
    const stopResult = parser.handleMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });

    // content_block_stop should be deduped
    expect(stopResult.messages).toHaveLength(0);
    expect(stopResult.deltas).toEqual([{ deltaType: "tool_end" }]);
  });

  test("handles user event with no tool_result blocks (echo of user prompt)", () => {
    const parser = createParser();
    const { messages } = parser.handleMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Hello, please help me." },
        ],
      },
      session_id: "sess-1",
    });

    expect(messages).toHaveLength(0);
  });

  // ── SDK-specific message types ──────────────────────────

  test("rate_limit_event is silently skipped", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "rate_limit_event",
      session_id: "sess-1",
    });
    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("unknown message type logs warning but doesn't crash", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "some_future_type",
      session_id: "sess-1",
    });
    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  // ── Token usage extraction from modelUsage ──────────────

  test("extracts token usage and contextWindow from modelUsage in result event", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.10,
      duration_ms: 2000,
      session_id: "sess-tok",
      permission_denials: [],
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 5000,
          outputTokens: 1200,
          cacheReadInputTokens: 3000,
          cacheCreationInputTokens: 800,
          contextWindow: 200000,
        },
      },
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    // inputTokens = 5000 + 3000 + 800 = 8800
    expect(metrics!.inputTokens).toBe(8800);
    expect(metrics!.outputTokens).toBe(1200);
    expect(metrics!.contextWindow).toBe(200000);
  });

  test("uses primary model tokens only (not sub-agent aggregate) and picks largest contextWindow", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.20,
      duration_ms: 3000,
      session_id: "sess-multi",
      permission_denials: [],
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10000,
          outputTokens: 2000,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
        },
        "claude-haiku-3-5": {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 8192,
        },
      },
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    // Only primary model (opus, largest contextWindow) tokens
    // input: 10000 + 5000 + 0 = 15000
    expect(metrics!.inputTokens).toBe(15000);
    // output: 2000 (opus only)
    expect(metrics!.outputTokens).toBe(2000);
    // largest context window wins
    expect(metrics!.contextWindow).toBe(200000);
  });

  test("handles result with empty modelUsage object", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      duration_ms: 500,
      session_id: "sess-empty",
      permission_denials: [],
      modelUsage: {},
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.inputTokens).toBe(0);
    expect(metrics!.outputTokens).toBe(0);
    expect(metrics!.contextWindow).toBeUndefined();
  });

  test("handles modelUsage with missing optional fields", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-partial",
      permission_denials: [],
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 4000,
          outputTokens: 800,
          // no cache fields, no contextWindow
        },
      },
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.inputTokens).toBe(4000);
    expect(metrics!.outputTokens).toBe(800);
    expect(metrics!.contextWindow).toBeUndefined();
  });

  test("extracts modelName from modelUsage in result event", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.10,
      duration_ms: 2000,
      session_id: "sess-model",
      permission_denials: [],
      modelUsage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 5000,
          outputTokens: 1200,
          contextWindow: 200000,
        },
      },
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.modelName).toBe("claude-sonnet-4-20250514");
  });

  test("picks modelName of model with largest contextWindow", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.20,
      duration_ms: 3000,
      session_id: "sess-multi-model",
      permission_denials: [],
      modelUsage: {
        "claude-haiku-4-20250514": {
          inputTokens: 1000,
          outputTokens: 500,
          contextWindow: 8192,
        },
        "claude-opus-4-20250514": {
          inputTokens: 10000,
          outputTokens: 2000,
          contextWindow: 200000,
        },
      },
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics!.modelName).toBe("claude-opus-4-20250514");
  });

  test("extracts model from system init event as metrics delta", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-20250514",
      session_id: "sess-init-model",
      tools: [],
      cwd: "/tmp",
    });

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaType).toBe("metrics");
    expect(deltas[0].modelName).toBe("claude-sonnet-4-20250514");
  });

  test("system init without model field emits no deltas", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-no-model",
      tools: [],
      cwd: "/tmp",
    });

    expect(deltas).toHaveLength(0);
  });

  test("message_start does not extract model (avoids sub-agent flicker)", () => {
    const parser = createParser();
    const { messages, deltas } = parser.handleMessage({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg_123",
          model: "claude-sonnet-4-20250514",
          type: "message",
          role: "assistant",
          content: [],
        },
      },
    });

    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("result error event still emits metrics and turn_end", () => {
    const parser = createParser();
    const { deltas } = parser.handleMessage({
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0.15,
      duration_ms: 5000,
      session_id: "sess-err",
      permission_denials: [],
      errors: ["Something went wrong"],
      is_error: true,
    });

    const metrics = deltas.find((d) => d.deltaType === "metrics");
    expect(metrics).toBeDefined();
    expect(metrics!.costUsd).toBe(0.15);

    const turnEnd = deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
  });
});
