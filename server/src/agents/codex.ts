// NOTE: @openai/codex-sdk is ESM-only (type: "module").
// All imports MUST use await import(), never top-level import or require().
// A top-level import would crash the server if the SDK is not installed.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { extractAskUserRequest } from "./askUser";
import { extractToolResultImages, normalizeToolResultContent } from "./toolResultMedia";
import type {
  AgentAdapter,
  AgentSession,
  ParsedMessage,
  ParseResult,
  StartOpts,
} from "./types";
import { gitSpawnSync } from "../utils/git";
import { toCodexPermissionConfig, type PermissionMode } from "shared";

interface CodexCumulativeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface CodexParserOptions {
  cwd?: string;
  sessionId?: string;
  cumulativeUsageBaseline?: CodexCumulativeUsage;
  suppressTokenMetrics?: boolean;
  onCumulativeUsage?: (sessionId: string, usage: CodexCumulativeUsage) => void;
}

export class CodexAdapter implements AgentAdapter {
  name = "codex";
  private readonly cumulativeUsageBySessionId = new Map<string, CodexCumulativeUsage>();

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
    const cumulativeUsageBaseline = opts.resumeSessionId
      ? this.cumulativeUsageBySessionId.get(opts.resumeSessionId)
      : undefined;
    const parser = new CodexParser({
      cwd: opts.cwd,
      sessionId: opts.resumeSessionId,
      cumulativeUsageBaseline,
      suppressTokenMetrics: !!opts.resumeSessionId && !cumulativeUsageBaseline,
      onCumulativeUsage: (sessionId, usage) => {
        this.cumulativeUsageBySessionId.set(sessionId, usage);
      },
    });

    async function* generateEvents(): AsyncGenerator<unknown> {
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex();

      const codexPerms = toCodexPermissionConfig(opts.permissionMode as PermissionMode | undefined);
      const threadOpts = {
        model: opts.model || undefined,
        modelReasoningEffort: opts.effortLevel,
        sandboxMode: codexPerms.sandboxMode as "danger-full-access" | "container-only",
        workingDirectory: opts.cwd,
        approvalPolicy: codexPerms.approvalPolicy as "never" | "unless-allow-listed" | "on-failure",
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
  /** Current Codex thread ID, used to persist cumulative usage baselines across turns. */
  private currentSessionId: string | undefined;
  /** Last cumulative usage snapshot surfaced by the Codex SDK for this thread. */
  private cumulativeUsageBaseline: CodexCumulativeUsage | undefined;
  /**
   * Resumed sessions may not have a baseline after Orchestra restarts. In that case,
   * suppress token metrics for the first resumed turn instead of surfacing a bogus
   * multi-turn cumulative total.
   */
  private suppressTokenMetrics: boolean;
  private readonly onCumulativeUsage?: (sessionId: string, usage: CodexCumulativeUsage) => void;

  constructor(opts: string | CodexParserOptions = process.cwd()) {
    if (typeof opts === "string") {
      this.cwd = opts;
      this.currentSessionId = undefined;
      this.cumulativeUsageBaseline = undefined;
      this.suppressTokenMetrics = false;
      this.onCumulativeUsage = undefined;
      return;
    }

    this.cwd = opts.cwd ?? process.cwd();
    this.currentSessionId = opts.sessionId;
    this.cumulativeUsageBaseline = opts.cumulativeUsageBaseline;
    this.suppressTokenMetrics = opts.suppressTokenMetrics ?? false;
    this.onCumulativeUsage = opts.onCumulativeUsage;
  }

  private readonly cwd: string;

  handleEvent(msg: unknown): ParseResult {
    const event = msg as Record<string, unknown>;
    const type = event.type as string;
    if (!type) return EMPTY;

    switch (type) {
      case "thread.started":
        this.currentSessionId = event.thread_id as string;
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
      const cumulativeUsage = {
        inputTokens: usage.input_tokens ?? 0,
        cachedInputTokens: usage.cached_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };

      // The Codex SDK's turn.completed usage is derived from the thread's cumulative
      // token totals, not the latest request. Recover per-turn totals by diffing
      // against the last cumulative snapshot we observed for this session.
      //
      // If Orchestra resumes an existing Codex session without a cached baseline
      // (e.g. after a server restart), suppress token metrics for that turn rather
      // than surfacing a misleading multi-turn total.
      const turnInputTokens = this.suppressTokenMetrics
        ? undefined
        : this.diffUsage(
            cumulativeUsage.inputTokens + cumulativeUsage.cachedInputTokens,
            (this.cumulativeUsageBaseline?.inputTokens ?? 0) + (this.cumulativeUsageBaseline?.cachedInputTokens ?? 0),
          );
      const turnOutputTokens = this.suppressTokenMetrics
        ? undefined
        : this.diffUsage(
            cumulativeUsage.outputTokens,
            this.cumulativeUsageBaseline?.outputTokens ?? 0,
          );

      deltas.push({
        deltaType: "metrics",
        costUsd: undefined,
        durationMs: undefined,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        finalMetrics: true,
      });

      if (this.currentSessionId) {
        this.onCumulativeUsage?.(this.currentSessionId, cumulativeUsage);
      }
      this.cumulativeUsageBaseline = cumulativeUsage;
      this.suppressTokenMetrics = false;
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

  private diffUsage(current: number, previous: number): number {
    return Math.max(current - previous, 0);
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
