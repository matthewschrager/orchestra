import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude";

describe("ClaudeAdapter.parseOutput", () => {
  const adapter = new ClaudeAdapter();

  test("extracts cost_usd and duration_ms from result event", () => {
    const line = JSON.stringify({
      type: "result",
      cost_usd: 0.12,
      duration_ms: 3400,
      session_id: "sess-123",
    });
    const { messages, deltas } = adapter.parseOutput(line);
    expect(messages).toHaveLength(0);
    // Should have a metrics delta and a turn_end delta
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
    const line = JSON.stringify({
      type: "result",
      session_id: "sess-456",
    });
    const { deltas } = adapter.parseOutput(line);
    // Should only have turn_end, no metrics
    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaType).toBe("turn_end");
  });

  test("parses assistant event text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    });
    const { messages } = adapter.parseOutput(line);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello world");
  });

  test("parses tool_use event", () => {
    const line = JSON.stringify({
      type: "tool_use",
      tool: { name: "Read", input: { file_path: "/test.ts" } },
    });
    const { messages } = adapter.parseOutput(line);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].toolName).toBe("Read");
  });

  test("parses tool_result event", () => {
    const line = JSON.stringify({
      type: "tool_result",
      tool_name: "Read",
      content: "file contents here",
    });
    const { messages } = adapter.parseOutput(line);
    expect(messages).toHaveLength(1);
    expect(messages[0].toolOutput).toBe("file contents here");
  });

  test("handles system event as assistant message", () => {
    const line = JSON.stringify({
      type: "system",
      content: "System initialization complete",
    });
    const { messages } = adapter.parseOutput(line);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("System initialization complete");
  });

  test("handles empty line gracefully", () => {
    const { messages, deltas } = adapter.parseOutput("");
    expect(messages).toHaveLength(0);
    expect(deltas).toHaveLength(0);
  });

  test("handles non-JSON line as raw assistant output", () => {
    const { messages } = adapter.parseOutput("some raw text output");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("some raw text output");
  });
});
