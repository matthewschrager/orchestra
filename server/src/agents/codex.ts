// NOTE: @openai/codex-sdk is ESM-only (type: "module").
// All imports MUST use await import(), never top-level import or require().
// A top-level import would crash the server if the SDK is not installed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractAskUserRequest } from "./askUser";
import { normalizeToolResultContent } from "./toolResultMedia";
import type {
  AgentAdapter,
  AgentSession,
  ParsedMessage,
  ParseResult,
  StartOpts,
} from "./types";
import { gitSpawnSync } from "../utils/git";

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
    const parser = new CodexParser(opts.cwd);

    async function* generateEvents(): AsyncGenerator<unknown> {
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex();

      const threadOpts = {
        modelReasoningEffort: opts.effortLevel,
        sandboxMode: "danger-full-access" as const,
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
  /** Tracks the last emitted todo snapshot per item ID to avoid duplicate TodoWrites. */
  private readonly lastTodoSnapshotByItemId = new Map<string, string>();
  /** Snapshots file contents before a Codex file_change applies. */
  private readonly fileSnapshotsByItemId = new Map<string, Map<string, string>>();
  /** Turn-level fallback snapshot when Codex only emits completed file_change items. */
  private turnBaselineByPath = new Map<string, string>();

  constructor(private readonly cwd: string = process.cwd()) {}

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
        return this.handleTurnStarted();

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
    const usage = event.usage as {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
    } | undefined;
    const deltas: ParseResult["deltas"] = [];

    if (usage) {
      // Codex SDK turn.completed exposes token usage, but not cost/model/context metadata.
      deltas.push({
        deltaType: "metrics",
        costUsd: undefined,
        durationMs: undefined,
        inputTokens: (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        finalMetrics: true,
      });
    }
    deltas.push({ deltaType: "turn_end" });
    this.resetTurnState();

    return { messages: [], deltas };
  }

  private handleTurnFailed(event: Record<string, unknown>): ParseResult {
    const error = event.error as { message?: string } | undefined;
    const errMsg = error?.message ?? "Turn failed";
    this.resetTurnState();
    return {
      messages: [{ role: "assistant", content: `**Agent error:** ${errMsg}` }],
      deltas: [{ deltaType: "turn_end" }],
      error: errMsg,
    };
  }

  private handleTurnStarted(): ParseResult {
    this.turnBaselineByPath = this.captureTurnBaseline();
    this.fileSnapshotsByItemId.clear();
    return EMPTY;
  }

  private handleItemStarted(event: Record<string, unknown>): ParseResult {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return EMPTY;

    const itemType = item.type as string;
    const itemId = item.id as string;

    switch (itemType) {
      case "command_execution":
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName: "Bash" }],
        };

      case "file_change":
        this.captureFileSnapshots(itemId, item.changes);
        return {
          messages: [],
          deltas: [{ deltaType: "tool_start", toolName: "Edit" }],
        };

      case "mcp_tool_call": {
        const toolName = (item.tool as string) ?? "McpTool";
        const askUser = extractAskUserRequest(toolName, item.arguments);
        if (askUser) {
          return {
            messages: [],
            deltas: [
              { deltaType: "tool_start", toolName: askUser.canonicalToolName },
              { deltaType: "tool_input", toolInput: askUser.serializedInput },
            ],
          };
        }
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

      case "todo_list":
        return this.buildTodoSnapshot(itemId, item);

      // agent_message, reasoning, error: no tool_start delta
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

      case "file_change":
        this.captureFileSnapshots(itemId, item.changes);
        return EMPTY;

      case "todo_list":
        return this.buildTodoSnapshot(itemId, item);

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
            metadata: exitCode === undefined ? undefined : { exitCode },
          }],
          deltas: [{ deltaType: "tool_end" }],
        };
      }

      case "file_change": {
        const changes = (item.changes as Array<{ path?: string; kind?: string }>) ?? [];
        const beforeByPath = this.fileSnapshotsByItemId.get(itemId);
        const messages: ParsedMessage[] = changes.map((change) => ({
          role: "tool" as const,
          content: `${change.kind ?? "update"}: ${change.path ?? "unknown"}`,
          toolName: "Edit",
          toolInput: JSON.stringify(this.buildFileChangePayload(change, beforeByPath)),
        }));
        this.updateTurnBaseline(changes);
        this.fileSnapshotsByItemId.delete(itemId);
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
        const askUser = error?.message ? null : extractAskUserRequest(toolName, args);
        if (askUser) {
          return {
            messages: [{
              role: "tool",
              content: "",
              toolName: askUser.canonicalToolName,
              toolInput: askUser.serializedInput,
              metadata: { sourceToolName: toolName },
            }],
            deltas: [{ deltaType: "tool_end" }],
            attention: askUser.attention,
          };
        }

        const toolInput = JSON.stringify(args ?? {});
        const parsedResult = error?.message
          ? {
              toolOutput: `Error: ${error.message}`,
              metadata: { isError: true },
            }
          : this.parseMcpToolResult(result);
        return {
          messages: [{
            role: "tool",
            content: parsedResult.toolOutput,
            toolName,
            toolInput,
            toolOutput: parsedResult.toolOutput || undefined,
            metadata: parsedResult.metadata,
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
        return this.buildTodoSnapshot(itemId, item, { terminal: true });
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

  private buildTodoSnapshot(
    itemId: string,
    item: Record<string, unknown>,
    opts?: { terminal?: boolean },
  ): ParseResult {
    const items = (item.items as Array<{ text?: string; completed?: boolean }>) ?? [];
    const todos = this.normalizeTodoItems(items, { activelyRunning: !opts?.terminal });
    const toolInput = JSON.stringify({ todos });
    const prev = this.lastTodoSnapshotByItemId.get(itemId);
    const changed = todos.length > 0 && toolInput !== prev;

    if (opts?.terminal) {
      this.lastTodoSnapshotByItemId.delete(itemId);
    } else if (todos.length > 0) {
      this.lastTodoSnapshotByItemId.set(itemId, toolInput);
    }

    if (!changed && !opts?.terminal) return EMPTY;

    const messages: ParsedMessage[] = changed
      ? [{
          role: "tool",
          content: todos.map((todo) =>
            `${todo.status === "completed" ? "✅" : todo.status === "in_progress" ? "▸" : "⬜"} ${todo.content}`
          ).join("\n"),
          toolName: "TodoWrite",
          toolInput,
        }]
      : [];

    return {
      messages,
      deltas: opts?.terminal ? [{ deltaType: "tool_end" }] : [],
    };
  }

  private normalizeTodoItems(
    items: Array<{ text?: string; completed?: boolean }>,
    opts: { activelyRunning: boolean },
  ): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }> {
    // The Codex SDK exposes todo items as { text, completed } only. It does not tell us
    // which incomplete item is currently active, so we synthesize one for live updates by
    // promoting the first unfinished item to in_progress while the todo_list item is active.
    const firstIncompleteIndex = opts.activelyRunning
      ? items.findIndex((item) => item.completed !== true)
      : -1;

    return items.map((item, index) => {
      const content = item.text ?? "";
      const status = item.completed === true
        ? "completed"
        : index === firstIncompleteIndex
          ? "in_progress"
          : "pending";

      return {
        content,
        status,
        activeForm: content,
      };
    });
  }

  private parseMcpToolResult(
    result: { content?: unknown; structured_content?: unknown } | undefined,
  ): Pick<ParsedMessage, "toolOutput" | "metadata"> & { toolOutput: string } {
    const normalized = normalizeToolResultContent(result?.content);
    let toolOutput = normalized.text;
    if (!toolOutput && normalized.images.length === 0 && result) {
      toolOutput = JSON.stringify(result.content ?? result.structured_content ?? result);
    }

    return {
      toolOutput,
      metadata: normalized.images.length > 0 ? { images: normalized.images } : undefined,
    };
  }

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

  private captureFileSnapshots(itemId: string, rawChanges: unknown): void {
    const changes = (rawChanges as Array<{ path?: string }> | undefined) ?? [];
    if (changes.length === 0) return;

    const snapshots = this.fileSnapshotsByItemId.get(itemId) ?? new Map<string, string>();
    for (const change of changes) {
      const path = change.path;
      if (!path || snapshots.has(path)) continue;
      snapshots.set(path, this.readFileText(path));
    }
    this.fileSnapshotsByItemId.set(itemId, snapshots);
  }

  private captureTurnBaseline(): Map<string, string> {
    const result = gitSpawnSync(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return new Map();

    const snapshot = new Map<string, string>();
    const output = new TextDecoder().decode(result.stdout);
    for (const path of output.split("\0")) {
      if (!path || snapshot.has(path)) continue;
      snapshot.set(path, this.readFileText(path));
    }
    return snapshot;
  }

  private updateTurnBaseline(changes: Array<{ path?: string; kind?: string }>): void {
    for (const change of changes) {
      const path = change.path;
      if (!path) continue;
      this.turnBaselineByPath.set(path, change.kind === "delete" ? "" : this.readFileText(path));
    }
  }

  private buildFileChangePayload(
    change: { path?: string; kind?: string },
    beforeByPath?: Map<string, string>,
  ): Record<string, string> {
    const filePath = change.path ?? "unknown";
    const changeKind = change.kind ?? "update";
    const oldString = beforeByPath?.get(filePath) ?? this.turnBaselineByPath.get(filePath) ?? "";
    const newString = changeKind === "delete" ? "" : this.readFileText(filePath);

    return {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      changeKind,
    };
  }

  private resetTurnState(): void {
    this.fileSnapshotsByItemId.clear();
    this.turnBaselineByPath = new Map();
  }

  private readFileText(path: string): string {
    const absPath = resolve(this.cwd, path);
    if (!existsSync(absPath)) return "";
    try {
      return readFileSync(absPath, "utf-8");
    } catch {
      return "";
    }
  }
}

const EMPTY: Readonly<ParseResult> = Object.freeze({ messages: [], deltas: [] });
