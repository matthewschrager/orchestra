// NOTE: @openai/codex-sdk is ESM-only (type: "module").
// All imports MUST use await import(), never top-level import or require().
// A top-level import would crash the server if the SDK is not installed.

import type {
  AgentAdapter,
  AgentSession,
  ParsedMessage,
  ParseResult,
  StartOpts,
} from "./types";

export class CodexAdapter implements AgentAdapter {
  name = "codex";

  async detect(): Promise<boolean> {
    try {
      await import("@openai/codex-sdk");
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const { readFileSync } = await import("fs");
      const { dirname, join } = await import("path");
      const sdkEntry = Bun.resolveSync("@openai/codex-sdk", process.cwd());
      // Walk up to find the package.json (dist/index.js → package root)
      let dir = dirname(sdkEntry);
      for (let i = 0; i < 5; i++) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
          if (pkg.name === "@openai/codex-sdk") return pkg.version ?? null;
        } catch {
          // not found here, go up
        }
        dir = dirname(dir);
      }
      return null;
    } catch {
      return null;
    }
  }

  start(opts: StartOpts): AgentSession {
    const abortController = new AbortController();
    const parser = new CodexParser();

    async function* generateEvents(): AsyncGenerator<unknown> {
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex();

      const threadOpts = {
        sandboxMode: "workspace-write" as const,
        workingDirectory: opts.cwd,
        approvalPolicy: "never" as const,
      };

      const thread = opts.resumeSessionId
        ? codex.resumeThread(opts.resumeSessionId, threadOpts)
        : codex.startThread(threadOpts);

      const { events } = await thread.runStreamed(opts.prompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        yield event;
      }
    }

    return {
      messages: generateEvents(),
      abort: () => abortController.abort(),
      parseMessage: (msg: unknown) => parser.handleEvent(msg),
      sessionId: opts.resumeSessionId,
    };
  }

  supportsResume(): boolean {
    return true;
  }
}

// ── Parser ──────────────────────────────────────────────────

/** Maps Codex ThreadEvent union → Orchestra ParseResult */
export class CodexParser {
  /** Tracks last-seen text per item ID for delta diffing */
  private readonly lastTextByItemId = new Map<string, string>();
  /** Tracks last-seen command per item ID for streaming tool input */
  private readonly lastCommandByItemId = new Map<string, string>();

  handleEvent(msg: unknown): ParseResult {
    const event = msg as Record<string, unknown>;
    const type = event.type as string;
    if (!type) return EMPTY;

    switch (type) {
      case "thread.started":
        return {
          messages: [],
          deltas: [],
          sessionId: event.thread_id as string,
        };

      case "turn.started":
        return EMPTY;

      case "turn.completed":
        return this.handleTurnCompleted(event);

      case "turn.failed":
        return this.handleTurnFailed(event);

      case "item.started":
        return this.handleItemStarted(event);

      case "item.updated":
        return this.handleItemUpdated(event);

      case "item.completed":
        return this.handleItemCompleted(event);

      case "error":
        return {
          messages: [{ role: "assistant", content: `**Agent error:** ${event.message ?? "unknown error"}` }],
          deltas: [],
          error: String(event.message ?? "unknown error"),
        };

      default:
        return EMPTY;
    }
  }

  // ── Event handlers ──────────────────────────────────────

  private handleTurnCompleted(event: Record<string, unknown>): ParseResult {
    const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const deltas: ParseResult["deltas"] = [];

    if (usage) {
      // Codex provides token counts but no USD cost
      deltas.push({
        deltaType: "metrics",
        costUsd: undefined,
        durationMs: undefined,
      });
    }
    deltas.push({ deltaType: "turn_end" });

    return { messages: [], deltas };
  }

  private handleTurnFailed(event: Record<string, unknown>): ParseResult {
    const error = event.error as { message?: string } | undefined;
    const errMsg = error?.message ?? "Turn failed";
    return {
      messages: [{ role: "assistant", content: `**Agent error:** ${errMsg}` }],
      deltas: [{ deltaType: "turn_end" }],
      error: errMsg,
    };
  }

  private handleItemStarted(event: Record<string, unknown>): ParseResult {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return EMPTY;

    const itemType = item.type as string;

    switch (itemType) {
      case "command_execution":
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName: "Bash" }],
        };

      case "file_change":
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName: "Edit" }],
        };

      case "mcp_tool_call": {
        const toolName = (item.tool as string) ?? "McpTool";
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName }],
        };
      }

      case "web_search":
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName: "WebSearch" }],
        };

      // agent_message, reasoning, todo_list, error: no tool_start delta
      default:
        return EMPTY;
    }
  }

  private handleItemUpdated(event: Record<string, unknown>): ParseResult {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return EMPTY;

    const itemType = item.type as string;
    const itemId = item.id as string;

    switch (itemType) {
      case "agent_message": {
        const fullText = (item.text as string) ?? "";
        const delta = this.diffText(itemId, fullText);
        if (!delta) return EMPTY;
        return {
          messages: [],
          deltas: [{ deltaType: "text", text: delta }],
        };
      }

      case "command_execution": {
        const command = (item.command as string) ?? "";
        const prev = this.lastCommandByItemId.get(itemId) ?? "";
        if (command !== prev) {
          this.lastCommandByItemId.set(itemId, command);
          const newInput = command.slice(prev.length) || command;
          return {
            messages: [],
            deltas: [{ deltaType: "tool_input", toolInput: newInput }],
          };
        }
        return EMPTY;
      }

      // Other item types: no meaningful streaming updates
      default:
        return EMPTY;
    }
  }

  private handleItemCompleted(event: Record<string, unknown>): ParseResult {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return EMPTY;

    const itemType = item.type as string;
    const itemId = item.id as string;

    switch (itemType) {
      case "agent_message": {
        const text = (item.text as string) ?? "";
        // Clean up diff tracking
        this.lastTextByItemId.delete(itemId);
        return {
          messages: [{ role: "assistant", content: text }],
          deltas: [],
        };
      }

      case "command_execution": {
        this.lastCommandByItemId.delete(itemId);
        const command = (item.command as string) ?? "";
        const output = (item.aggregated_output as string) ?? "";
        const exitCode = item.exit_code as number | undefined;
        const toolInput = JSON.stringify({ command });
        const toolOutput = exitCode !== undefined && exitCode !== 0
          ? `${output}\n[exit code: ${exitCode}]`
          : output;
        return {
          messages: [{
            role: "tool",
            content: toolOutput,
            toolName: "Bash",
            toolInput,
            toolOutput: toolOutput || undefined,
          }],
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "file_change": {
        const changes = (item.changes as Array<{ path?: string; kind?: string }>) ?? [];
        const messages: ParsedMessage[] = changes.map((change) => ({
          role: "tool" as const,
          content: `${change.kind ?? "update"}: ${change.path ?? "unknown"}`,
          toolName: "Edit",
          toolInput: JSON.stringify({
            file_path: change.path ?? "unknown",
            changeKind: change.kind ?? "update",
          }),
        }));
        return {
          messages,
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "mcp_tool_call": {
        const toolName = (item.tool as string) ?? "McpTool";
        const args = item.arguments;
        const result = item.result as { content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;
        const toolInput = JSON.stringify(args ?? {});
        const toolOutput = error?.message
          ? `Error: ${error.message}`
          : result ? JSON.stringify(result.content ?? result) : "";
        return {
          messages: [{
            role: "tool",
            content: toolOutput,
            toolName,
            toolInput,
            toolOutput: toolOutput || undefined,
            metadata: error ? { isError: true } : undefined,
          }],
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "web_search": {
        const query = (item.query as string) ?? "";
        return {
          messages: [{
            role: "tool",
            content: `Searched: ${query}`,
            toolName: "WebSearch",
            toolInput: JSON.stringify({ query }),
          }],
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "todo_list": {
        const items = (item.items as Array<{ text?: string; completed?: boolean }>) ?? [];
        return {
          messages: [{
            role: "tool",
            content: items.map((t) =>
              `${t.completed ? "✅" : "⬜"} ${t.text ?? ""}`
            ).join("\n"),
            toolName: "TodoWrite",
            toolInput: JSON.stringify({ items }),
          }],
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "reasoning":
        // Internal reasoning — don't surface to user
        return EMPTY;

      case "error": {
        const message = (item.message as string) ?? "unknown error";
        return {
          messages: [{ role: "assistant", content: `**Agent error:** ${message}` }],
          deltas: [],
          error: message,
        };
      }

      default:
        return EMPTY;
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Compute text delta for streaming. Codex sends full text on each update,
   * not incremental deltas. We diff against the previous value to emit only
   * the new characters.
   *
   * Backtrack guard: if the model revises text (prev is not a prefix of
   * fullText), emit the full text as a replacement.
   */
  private diffText(itemId: string, fullText: string): string {
    const prev = this.lastTextByItemId.get(itemId) ?? "";
    this.lastTextByItemId.set(itemId, fullText);
    if (prev === fullText) return "";
    if (!fullText.startsWith(prev)) return fullText;
    return fullText.slice(prev.length);
  }
}

const EMPTY: Readonly<ParseResult> = Object.freeze({ messages: [], deltas: [] });
