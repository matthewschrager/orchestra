import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexParser } from "../codex";

function createParser() {
  return new CodexParser();
}

describe("CodexAdapter", () => {
  test("adapter has correct name and supports resume", () => {
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe("codex");
    expect(adapter.supportsResume()).toBe(true);
  });
});

describe("CodexParser", () => {
  // ── Session lifecycle ────────────────────────────────────

  test("thread.started extracts sessionId (thread_id)", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "thread.started",
      thread_id: "thread-abc-123",
    });

    expect(result.sessionId).toBe("thread-abc-123");
    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });

  test("turn.started returns empty result", () => {
    const parser = createParser();
    const result = parser.handleEvent({ type: "turn.started" });

    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });

  test("turn.completed produces metrics and turn_end deltas", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
    });

    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(2);

    const metricsDelta = result.deltas.find((d) => d.deltaType === "metrics");
    expect(metricsDelta).toBeDefined();
    // Codex doesn't provide USD cost
    expect(metricsDelta!.costUsd).toBeUndefined();

    const turnEnd = result.deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
  });

  test("turn.failed produces error and turn_end", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "turn.failed",
      error: { message: "Rate limit exceeded" },
    });

    expect(result.error).toBe("Rate limit exceeded");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toContain("Rate limit exceeded");

    const turnEnd = result.deltas.find((d) => d.deltaType === "turn_end");
    expect(turnEnd).toBeDefined();
  });

  test("error event produces error", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "error",
      message: "Connection lost",
    });

    expect(result.error).toBe("Connection lost");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain("Connection lost");
  });

  // ── Agent message (text streaming) ─────────────────────

  test("item.updated (agent_message) produces text deltas with diffing", () => {
    const parser = createParser();

    // First update
    const r1 = parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-1", type: "agent_message", text: "Hello" },
    });
    expect(r1.deltas).toHaveLength(1);
    expect(r1.deltas[0].deltaType).toBe("text");
    expect(r1.deltas[0].text).toBe("Hello");

    // Second update — only the new part
    const r2 = parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-1", type: "agent_message", text: "Hello world" },
    });
    expect(r2.deltas).toHaveLength(1);
    expect(r2.deltas[0].text).toBe(" world");
  });

  test("text diffing handles backtrack (non-append-only update)", () => {
    const parser = createParser();

    // First update
    parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-2", type: "agent_message", text: "Hello there" },
    });

    // Model revises — new text does NOT start with previous
    const r2 = parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-2", type: "agent_message", text: "Hi everyone" },
    });
    // Backtrack guard: emit full text
    expect(r2.deltas[0].text).toBe("Hi everyone");
  });

  test("text diffing returns empty for duplicate update", () => {
    const parser = createParser();

    parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-3", type: "agent_message", text: "Same" },
    });

    const r2 = parser.handleEvent({
      type: "item.updated",
      item: { id: "msg-3", type: "agent_message", text: "Same" },
    });
    // No delta for duplicate text
    expect(r2.messages).toHaveLength(0);
    expect(r2.deltas).toHaveLength(0);
  });

  test("item.completed (agent_message) produces assistant message", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: { id: "msg-4", type: "agent_message", text: "Done! The fix is applied." },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toBe("Done! The fix is applied.");
  });

  // ── Command execution ──────────────────────────────────

  test("item.started (command_execution) produces tool_start delta", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.started",
      item: { id: "cmd-1", type: "command_execution", command: "", aggregated_output: "", status: "in_progress" },
    });

    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0].deltaType).toBe("tool_start");
    expect(result.deltas[0].toolName).toBe("Bash");
  });

  test("item.updated (command_execution) produces tool_input delta", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.updated",
      item: { id: "cmd-2", type: "command_execution", command: "ls -la", aggregated_output: "", status: "in_progress" },
    });

    expect(result.deltas).toHaveLength(1);
    expect(result.deltas[0].deltaType).toBe("tool_input");
    expect(result.deltas[0].toolInput).toBe("ls -la");
  });

  test("item.completed (command_execution) produces Bash tool message", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "cmd-3",
        type: "command_execution",
        command: "echo hello",
        aggregated_output: "hello\n",
        exit_code: 0,
        status: "completed",
      },
    });

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg.role).toBe("tool");
    expect(msg.toolName).toBe("Bash");
    expect(msg.toolInput).toBe('{"command":"echo hello"}');
    expect(msg.toolOutput).toBe("hello\n");

    const toolEnd = result.deltas.find((d) => d.deltaType === "tool_end");
    expect(toolEnd).toBeDefined();
  });

  test("command_execution with non-zero exit code appends exit code", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "cmd-4",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    });

    expect(result.messages[0].toolOutput).toContain("[exit code: 1]");
  });

  // ── File change ────────────────────────────────────────

  test("item.completed (file_change) produces Edit tool messages", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "fc-1",
        type: "file_change",
        changes: [
          { path: "src/index.ts", kind: "update" },
          { path: "src/new.ts", kind: "add" },
        ],
        status: "completed",
      },
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].toolName).toBe("Edit");
    expect(result.messages[0].toolInput).toContain("src/index.ts");
    expect(result.messages[1].toolInput).toContain("src/new.ts");
    expect(result.messages[1].toolInput).toContain("add");

    const toolEnd = result.deltas.find((d) => d.deltaType === "tool_end");
    expect(toolEnd).toBeDefined();
  });

  // ── MCP tool call ──────────────────────────────────────

  test("item.completed (mcp_tool_call) produces tool message", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "my-server",
        tool: "fetch_data",
        arguments: { url: "https://example.com" },
        result: { content: [{ type: "text", text: "response data" }] },
        status: "completed",
      },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolName).toBe("fetch_data");
    expect(result.messages[0].toolInput).toContain("https://example.com");
  });

  test("item.completed (mcp_tool_call) with error sets isError metadata", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "mcp-2",
        type: "mcp_tool_call",
        server: "my-server",
        tool: "broken_tool",
        arguments: {},
        error: { message: "Server unavailable" },
        status: "failed",
      },
    });

    expect(result.messages[0].toolOutput).toContain("Server unavailable");
    expect(result.messages[0].metadata).toEqual({ isError: true });
  });

  // ── Web search ─────────────────────────────────────────

  test("item.completed (web_search) produces WebSearch tool message", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: { id: "ws-1", type: "web_search", query: "bun runtime docs" },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolName).toBe("WebSearch");
    expect(result.messages[0].toolInput).toContain("bun runtime docs");
  });

  // ── Todo list ──────────────────────────────────────────

  test("item.completed (todo_list) produces TodoWrite tool message", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Fix bug", completed: true },
          { text: "Write tests", completed: false },
        ],
      },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].toolName).toBe("TodoWrite");
    expect(result.messages[0].content).toContain("Fix bug");
    expect(result.messages[0].content).toContain("✅");
    expect(result.messages[0].content).toContain("⬜");
  });

  // ── Reasoning (should be silent) ──────────────────────

  test("item.completed (reasoning) is a no-op", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: { id: "r-1", type: "reasoning", text: "I think we should..." },
    });

    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });

  // ── Error item ─────────────────────────────────────────

  test("item.completed (error) produces error", () => {
    const parser = createParser();
    const result = parser.handleEvent({
      type: "item.completed",
      item: { id: "e-1", type: "error", message: "Sandbox violation" },
    });

    expect(result.error).toBe("Sandbox violation");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toContain("Sandbox violation");
  });

  // ── Unknown events ─────────────────────────────────────

  test("unknown event types return empty result", () => {
    const parser = createParser();
    const result = parser.handleEvent({ type: "unknown_future_event", data: {} });

    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  test("event without type returns empty result", () => {
    const parser = createParser();
    const result = parser.handleEvent({});

    expect(result.messages).toHaveLength(0);
    expect(result.deltas).toHaveLength(0);
  });
});
