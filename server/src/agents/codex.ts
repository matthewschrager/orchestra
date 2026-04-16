import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { extractAskUserRequest } from "./askUser";
import { getCliVersion, hasCli } from "./cli";
import { extractToolResultImages, normalizeToolResultContent } from "./toolResultMedia";
import { CodexAppServerClient } from "./codex-app-server/client";
import type {
  AgentAdapter,
  AgentSession,
  ParsedMessage,
  ParseResult,
  PersistentSession,
  StartOpts,
} from "./types";
import { gitSpawnSync } from "../utils/git";

interface CodexParserOptions {
  cwd?: string;
}

const SUBAGENT_TOOL_NAME = "Agent";
const SPAWN_AGENT_TOOL_NAME = "spawn_agent";
const WAIT_AGENT_TOOL_NAME = "wait_agent";

export class CodexAdapter implements AgentAdapter {
  name = "codex";

  async detect(): Promise<boolean> {
    return hasCli("codex");
  }

  async getVersion(): Promise<string | null> {
    return getCliVersion("codex");
  }

  start(opts: StartOpts): AgentSession {
    return this.startPersistent(opts);
  }

  supportsResume(): boolean {
    return true;
  }

  supportsPersistent(): boolean {
    return true;
  }

  startPersistent(opts: StartOpts): PersistentSession {
    const parser = new CodexParser({
      cwd: opts.cwd,
    });
    const client = new CodexAppServerClient({
      cwd: opts.cwd,
      effortLevel: opts.effortLevel,
      model: opts.model,
      permissionMode: opts.permissionMode,
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
    });

    return {
      messages: client.events,
      abort: () => client.close(),
      parseMessage: (msg: unknown) => parser.handleEvent(msg),
      sessionId: opts.resumeSessionId,
      close: () => client.close(),
      resetTurnState: () => parser.resetTurnState(),
      injectMessage: async (text: string, _sessionId: string, priority?: "now" | "next") => {
        await client.injectMessage(text, priority);
      },
      setModel: async (model: string) => {
        await client.setModel(model);
      },
      setPermissionMode: async (mode: string) => {
        await client.setPermissionMode(mode);
      },
      resolveAttention: async (metadata, resolution) => {
        return await client.resolveAttention(metadata, resolution);
      },
    };
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

  resetTurnState(): void {
    this.lastTextByItemId.clear();
    this.lastCommandByItemId.clear();
    this.lastTodoSnapshotByItemId.clear();
    this.fileSnapshotsByItemId.clear();
    this.turnBaselineByPath = new Map<string, string>();
  }

  constructor(opts: string | CodexParserOptions = process.cwd()) {
    if (typeof opts === "string") {
      this.cwd = opts;
      return;
    }

    this.cwd = opts.cwd ?? process.cwd();
  }

  private readonly cwd: string;

  handleEvent(msg: unknown): ParseResult {
    const event = msg as Record<string, unknown>;
    const type = event.type as string;
    if (!type) return EMPTY;

    switch (type) {
      case "thread.started":
        return {
          messages: [],
          deltas: typeof event.model_name === "string"
            ? [{ deltaType: "metrics", modelName: event.model_name }]
            : [],
          sessionId: event.thread_id as string,
        };

      case "turn.started":
        return this.handleTurnStarted();

      case "thread.token_usage.updated":
        return this.handleTokenUsageUpdated(event);

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

      case "metrics.model": {
        const modelName = event.model_name as string | undefined;
        return modelName
          ? { messages: [], deltas: [{ deltaType: "metrics", modelName }] }
          : EMPTY;
      }

      case "attention.request": {
        const attention = event.attention as {
          kind?: "ask_user" | "permission" | "confirmation";
          prompt?: string;
          options?: string[];
          metadata?: Record<string, unknown>;
        } | undefined;
        if (!attention?.kind || !attention.prompt) return EMPTY;
        return {
          messages: [],
          deltas: [],
          attention: {
            kind: attention.kind,
            prompt: attention.prompt,
            options: attention.options,
            metadata: attention.metadata,
          },
        };
      }

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

  private handleTokenUsageUpdated(event: Record<string, unknown>): ParseResult {
    const usage = event.usage as {
      total_tokens?: number;
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
    } | undefined;

    if (!usage) return EMPTY;

    return {
      messages: [],
      deltas: [{
        deltaType: "metrics",
        contextTokens: usage.total_tokens
          ?? (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
        inputTokens: (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        contextWindow: event.context_window as number | undefined,
        modelName: event.model_name as string | undefined,
      }],
    };
  }

  private handleTurnCompleted(event: Record<string, unknown>): ParseResult {
    const usage = event.usage as {
      total_tokens?: number;
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
    } | undefined;
    const deltas: ParseResult["deltas"] = [];

    if (usage) {
      const turnContextTokens = usage.total_tokens
        ?? (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);
      const turnInputTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
      const turnOutputTokens = usage.output_tokens ?? 0;

      deltas.push({
        deltaType: "metrics",
        costUsd: undefined,
        durationMs: undefined,
        contextTokens: turnContextTokens,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        finalMetrics: true,
      });
    } else {
      deltas.push({
        deltaType: "metrics",
        costUsd: undefined,
        durationMs: undefined,
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
        const subagentStart = this.buildSubagentStart(toolName, item.arguments);
        if (subagentStart) {
          return {
            messages: [],
            deltas: [
              { deltaType: "tool_start", toolName: SUBAGENT_TOOL_NAME },
              { deltaType: "tool_input", toolInput: subagentStart.toolInput },
            ],
          };
        }
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
        const subagentMessage = this.buildSubagentToolMessage(toolName, args, result, error);
        if (subagentMessage) {
          return {
            messages: [subagentMessage],
            deltas: [{ deltaType: "tool_end" }],
          };
        }
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
    const items = (item.items as Array<{ text?: string; completed?: boolean; status?: string }>) ?? [];
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
    items: Array<{ text?: string; completed?: boolean; status?: string }>,
    opts: { activelyRunning: boolean },
  ): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }> {
    const firstIncompleteIndex = opts.activelyRunning
      ? items.findIndex((item) => item.completed !== true && item.status !== "completed")
      : -1;

    return items.map((item, index) => {
      const content = item.text ?? "";
      const explicitStatus = item.status === "completed"
        ? "completed"
        : item.status === "in_progress"
          ? "in_progress"
          : item.status === "pending"
            ? "pending"
            : null;
      const status = explicitStatus ?? (item.completed === true
        ? "completed"
        : index === firstIncompleteIndex
          ? "in_progress"
          : "pending");

      return {
        content,
        status,
        activeForm: content,
      };
    });
  }

  private buildSubagentStart(toolName: string, args: unknown): { toolInput: string } | null {
    if (toolName !== SPAWN_AGENT_TOOL_NAME) return null;
    return { toolInput: this.stringifySubagentInput(args) };
  }

  private buildSubagentToolMessage(
    toolName: string,
    args: unknown,
    result: { content?: unknown; structured_content?: unknown } | undefined,
    error: { message?: string } | undefined,
  ): ParsedMessage | null {
    if (toolName === SPAWN_AGENT_TOOL_NAME) {
      const subagentId = this.extractSubagentIdFromValue(result);
      const errorOutput = error?.message ? `Error: ${error.message}` : undefined;
      return {
        role: "tool",
        content: errorOutput ?? "",
        toolName: SUBAGENT_TOOL_NAME,
        toolInput: this.stringifySubagentInput(args),
        toolOutput: errorOutput,
        metadata: this.buildSubagentMetadata({
          sourceToolName: toolName,
          subagentId,
          isError: Boolean(errorOutput),
        }),
      };
    }

    if (toolName === WAIT_AGENT_TOOL_NAME) {
      const subagentId = this.extractSingleWaitTarget(args);
      if (!subagentId) return null;

      const parsedResult = error?.message
        ? {
            toolOutput: `Error: ${error.message}`,
            metadata: { isError: true },
          }
        : this.parseMcpToolResult(result);
      return {
        role: "tool",
        content: parsedResult.toolOutput,
        toolName: SUBAGENT_TOOL_NAME,
        toolInput: null,
        toolOutput: parsedResult.toolOutput || undefined,
        metadata: this.buildSubagentMetadata({
          sourceToolName: toolName,
          subagentId,
          isError: parsedResult.metadata?.isError === true,
          images: Array.isArray(parsedResult.metadata?.images) ? parsedResult.metadata.images : undefined,
        }),
      };
    }

    return null;
  }

  private stringifySubagentInput(args: unknown): string {
    const record = isRecord(args) ? args : {};
    const prompt = this.extractSubagentPrompt(record);
    const payload: Record<string, unknown> = {
      description: this.extractSubagentDescription(record, prompt),
    };
    if (prompt) payload.prompt = prompt;

    const subagentType = this.extractSubagentType(record);
    if (subagentType) payload.subagent_type = subagentType;

    const target = this.extractSingleWaitTarget(record);
    if (target) payload.subagent_id = target;

    return JSON.stringify(payload);
  }

  private extractSubagentPrompt(args: Record<string, unknown>): string | null {
    if (typeof args.message === "string" && args.message.trim()) return args.message.trim();

    const items = Array.isArray(args.items) ? args.items : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
    }

    return null;
  }

  private extractSubagentDescription(args: Record<string, unknown>, prompt: string | null): string {
    if (typeof args.description === "string" && args.description.trim()) return args.description.trim();
    if (prompt) return prompt.slice(0, 120);
    return "Sub-agent task";
  }

  private extractSubagentType(args: Record<string, unknown>): string | undefined {
    const value = args.agent_type ?? args.subagent_type ?? args.agentType ?? args.subagentType;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private extractSingleWaitTarget(args: unknown): string | undefined {
    if (!isRecord(args)) return undefined;
    if (typeof args.target === "string" && args.target.trim()) return args.target.trim();
    const targets = Array.isArray(args.targets)
      ? args.targets.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return targets.length === 1 ? targets[0] : undefined;
  }

  private extractSubagentIdFromValue(value: unknown, depth = 0): string | undefined {
    if (depth > 4 || value === null || value === undefined) return undefined;
    if (typeof value === "string") return undefined;

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.extractSubagentIdFromValue(item, depth + 1);
        if (nested) return nested;
      }
      return undefined;
    }

    if (!isRecord(value)) return undefined;

    const direct = value.agent_id ?? value.agentId ?? value.subagent_id ?? value.subagentId ?? value.id;
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    for (const nestedValue of Object.values(value)) {
      const nested = this.extractSubagentIdFromValue(nestedValue, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }

  private buildSubagentMetadata({
    sourceToolName,
    subagentId,
    isError,
    images,
  }: {
    sourceToolName: string;
    subagentId?: string;
    isError?: boolean;
    images?: unknown[];
  }): Record<string, unknown> {
    const metadata: Record<string, unknown> = { sourceToolName };
    if (subagentId) metadata.subagentId = subagentId;
    if (isError) metadata.isError = true;
    if (images && images.length > 0) metadata.images = images;
    return metadata;
  }

  private parseMcpToolResult(
    result: { content?: unknown; structured_content?: unknown } | undefined,
  ): Pick<ParsedMessage, "toolOutput" | "metadata"> & { toolOutput: string } {
    const normalized = normalizeToolResultContent(result?.content);
    const images = dedupeToolImages([
      ...normalized.images,
      ...extractToolResultImages(result?.structured_content),
    ]);
    let toolOutput = normalized.text;
    if (!toolOutput && images.length === 0 && result) {
      toolOutput = JSON.stringify(result.content ?? result.structured_content ?? result);
    }

    return {
      toolOutput,
      metadata: images.length > 0 ? { images } : undefined,
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
      const pathKey = this.normalizeChangePath(path);
      if (snapshots.has(pathKey)) continue;
      snapshots.set(pathKey, this.readFileText(path));
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
      const pathKey = this.normalizeChangePath(path);
      if (!pathKey || snapshot.has(pathKey)) continue;
      snapshot.set(pathKey, this.readFileText(path));
    }
    return snapshot;
  }

  private updateTurnBaseline(changes: Array<{ path?: string; kind?: string }>): void {
    for (const change of changes) {
      const path = change.path;
      if (!path) continue;
      const pathKey = this.normalizeChangePath(path);
      this.turnBaselineByPath.set(pathKey, change.kind === "delete" ? "" : this.readFileText(path));
    }
  }

  private buildFileChangePayload(
    change: { path?: string; kind?: string },
    beforeByPath?: Map<string, string>,
  ): Record<string, string> {
    const filePath = change.path ?? "unknown";
    const normalizedPath = this.normalizeChangePath(filePath);
    const changeKind = change.kind ?? "update";
    const oldString = beforeByPath?.get(normalizedPath) ?? this.turnBaselineByPath.get(normalizedPath) ?? "";
    const newString = changeKind === "delete" ? "" : this.readFileText(filePath);

    return {
      file_path: normalizedPath,
      old_string: oldString,
      new_string: newString,
      changeKind,
    };
  }

  private normalizeChangePath(path: string): string {
    const absolutePath = resolve(this.cwd, path);
    const relativePath = relative(this.cwd, absolutePath);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return this.toPosixPath(relativePath);
    }
    return this.toPosixPath(normalize(path));
  }

  private toPosixPath(path: string): string {
    return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
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

function dedupeToolImages<T extends { src: string }>(images: T[]): T[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.src)) return false;
    seen.add(image.src);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
