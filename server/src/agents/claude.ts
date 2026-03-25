import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAdapter,
  AgentSession,
  AttentionEvent,
  ParsedMessage,
  ParseResult,
  StartOpts,
} from "./types";

/** Tool names that trigger attention events */
const ASK_USER_TOOLS = new Set(["AskUserQuestion", "AskUserTool"]);

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  async detect(): Promise<boolean> {
    try {
      await import("@anthropic-ai/claude-agent-sdk");
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const { readFileSync } = await import("fs");
      const { dirname, join } = await import("path");
      const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", process.cwd());
      const pkg = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf-8"));
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }

  start(opts: StartOpts): AgentSession {
    const abortController = new AbortController();

    const iter = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        resume: opts.resumeSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        abortController,
      },
    });

    const parser = new ClaudeParser();

    return {
      messages: iter,
      abort: () => abortController.abort(),
      parseMessage: (msg: unknown) => parser.handleMessage(msg),
      sessionId: opts.resumeSessionId,
    };
  }

  supportsResume(): boolean {
    return true;
  }
}

// ── Parser ──────────────────────────────────────────────────

class ClaudeParser {
  private readonly activeToolBlocks = new Map<number, ActiveToolBlock>();
  private readonly activeTextBlocks = new Map<number, string>();
  /** Maps tool_use_id → tool_name for pairing and deduplication */
  private readonly toolUseNames = new Map<string, string>();
  /** tool_use IDs already persisted via stream_events — skip in assistant summary */
  private readonly persistedToolUseIds = new Set<string>();
  private readonly emittedAttentionKeys = new Set<string>();

  handleMessage(msg: unknown): ParseResult {
    // All SDK messages have a `type` field
    const event = msg as Record<string, unknown>;
    const type = event.type as string;

    // Extract session_id if present (most SDK messages carry it)
    const sessionId = typeof event.session_id === "string" && event.session_id
      ? event.session_id
      : undefined;

    const result = this.handleEvent(type, event);
    if (sessionId) {
      result.sessionId ??= sessionId;
    }
    return result;
  }

  private handleEvent(type: string, event: Record<string, unknown>): ParseResult {
    switch (type) {
      case "assistant": {
        // SDKAssistantMessage: { type: "assistant", message: BetaMessage, session_id }
        const message = event.message as { content?: unknown[] } | undefined;
        const blocks = (message?.content ?? []) as Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: string | Array<{ type: string; text?: string }>;
        }>;

        const messages: ParsedMessage[] = [];
        let attention: AttentionEvent | undefined;

        for (const block of blocks) {
          if (block.type === "tool_use" && block.name) {
            // Skip if already persisted via stream_event content_block_stop
            if (block.id && this.persistedToolUseIds.has(block.id)) {
              continue;
            }
            const toolInput = serializeToolInput(block.input);
            messages.push({
              role: "tool",
              content: "",
              toolName: block.name,
              toolInput,
            });
            if (block.id) {
              this.persistedToolUseIds.add(block.id);
              this.toolUseNames.set(block.id, block.name);
            }
            if (!attention) {
              const parsedInput = safeParseObject(toolInput);
              if (parsedInput) {
                attention = this.maybeExtractAskUserAttention(
                  block.name,
                  parsedInput,
                  block.id,
                  toolInput,
                );
              }
            }
          }
        }

        if (messages.length === 0) return { messages: [], deltas: [] };
        const result: ParseResult = { messages, deltas: [] };
        if (attention) result.attention = attention;
        return result;
      }

      case "user": {
        // SDKUserMessage: { type: "user", message: MessageParam, session_id }
        const message = event.message as { content?: unknown } | undefined;
        const userBlocks = (Array.isArray(message?.content) ? message!.content : []) as Array<{
          type: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: string | Array<{ type: string; text?: string }>;
        }>;

        const userMessages: ParsedMessage[] = [];
        for (const block of userBlocks) {
          if (block.type === "tool_result") {
            const outputContent = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(b => b.type === "text").map(b => b.text ?? "").join("")
                : "";
            const toolName = block.tool_use_id
              ? this.toolUseNames.get(block.tool_use_id)
              : undefined;
            const metadata = block.is_error ? { isError: true } : undefined;
            userMessages.push({
              role: "tool",
              content: outputContent,
              toolName,
              toolOutput: outputContent || undefined,
              metadata,
            });
          }
        }

        return { messages: userMessages, deltas: [] };
      }

      case "result": {
        // SDKResultMessage: SDKResultSuccess | SDKResultError
        // SDKResultError has subtype: "error_during_execution" | "error_max_turns" | etc.
        const deltas: ParseResult["deltas"] = [];
        const costUsd = event.total_cost_usd as number | undefined;
        const durationMs = event.duration_ms as number | undefined;
        const subtype = event.subtype as string | undefined;
        const isError = event.is_error as boolean | undefined;
        const errors = event.errors as string[] | undefined;

        // Extract token usage from modelUsage (per-model breakdown)
        const modelUsage = event.modelUsage as Record<string, {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          contextWindow?: number;
        }> | undefined;

        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let contextWindow: number | undefined;

        if (modelUsage) {
          // Find the primary model (largest context window) — its tokens
          // represent actual context occupancy. Summing across all models
          // (including sub-agents) inflates the count far beyond the window.
          let primaryKey: string | undefined;
          for (const [key, model] of Object.entries(modelUsage)) {
            if (model.contextWindow && (!contextWindow || model.contextWindow > contextWindow)) {
              contextWindow = model.contextWindow;
              primaryKey = key;
            }
          }

          if (primaryKey) {
            const pm = modelUsage[primaryKey];
            inputTokens = (pm.inputTokens ?? 0) + (pm.cacheReadInputTokens ?? 0) + (pm.cacheCreationInputTokens ?? 0);
            outputTokens = pm.outputTokens ?? 0;
          } else {
            // No context window info — fall back to summing all models
            inputTokens = 0;
            outputTokens = 0;
            for (const model of Object.values(modelUsage)) {
              inputTokens += (model.inputTokens ?? 0) + (model.cacheReadInputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0);
              outputTokens += model.outputTokens ?? 0;
            }
          }
        }

        if (costUsd !== undefined || durationMs !== undefined || inputTokens !== undefined) {
          deltas.push({ deltaType: "metrics", costUsd, durationMs, inputTokens, outputTokens, contextWindow });
        }
        deltas.push({
          deltaType: "turn_end",
          text: (event.session_id as string) || undefined,
        });

        const resultParse: ParseResult = { messages: [], deltas };

        // Detect SDK error results or zero-turn successes (no model interaction)
        const numTurns = event.num_turns as number | undefined;
        if (isError || (subtype && subtype.startsWith("error_"))) {
          const errorDetail = errors?.join("; ") || subtype || "unknown SDK error";
          resultParse.error = errorDetail;
        } else if (subtype === "success" && numTurns === 0) {
          const resultText = event.result as string | undefined;
          resultParse.error = resultText || "SDK completed with zero model turns";
        }

        // Check permission_denials for AskUserQuestion (fallback detection)
        const denials = event.permission_denials as Array<{
          tool_name: string;
          tool_use_id: string;
          tool_input: Record<string, unknown>;
        }> | undefined;

        if (denials && Array.isArray(denials)) {
          for (const denial of denials) {
            const attention = this.maybeExtractAskUserAttention(
              denial.tool_name,
              denial.tool_input,
              denial.tool_use_id,
            );
            if (attention) {
              resultParse.attention = attention;
              break;
            }
          }
        }

        return resultParse;
      }

      case "system": {
        // SDKSystemMessage: { type: "system", subtype: "init" | "compact_boundary", ... }
        // Skip init envelopes — they only carry metadata (tools, session_id, etc.)
        const subtype = event.subtype as string | undefined;
        if (subtype === "init" || subtype === "compact_boundary") {
          return { messages: [], deltas: [] };
        }

        // For any other system subtype, surface content if present
        const content = event.content;
        const sysContent = typeof content === "string"
          ? content
          : content ? JSON.stringify(content) : "";
        if (!sysContent) return { messages: [], deltas: [] };
        return {
          messages: [{ role: "assistant", content: sysContent }],
          deltas: [],
        };
      }

      case "stream_event":
        return this.handleStreamEvent(event);

      // Known event types that carry no user-visible content
      case "rate_limit_event":
      case "auth_status":
      case "status":
      case "api_retry":
      case "local_command_output":
      case "hook_started":
      case "hook_progress":
      case "hook_response":
      case "tool_progress":
      case "task_notification":
      case "task_started":
      case "task_progress":
      case "files_persisted":
      case "tool_use_summary":
      case "elicitation_complete":
      case "prompt_suggestion":
        return { messages: [], deltas: [] };

      default:
        if (type) {
          console.warn(`[claude] Unknown SDK message type: ${type}`);
        }
        return { messages: [], deltas: [] };
    }
  }

  private maybeExtractAskUserAttention(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    toolUseId?: string,
    serializedInput?: string,
  ): AttentionEvent | undefined {
    if (!ASK_USER_TOOLS.has(toolName) || !toolInput) return undefined;

    const dedupeKey = toolUseId || `${toolName}:${serializedInput ?? serializeToolInput(toolInput)}`;
    if (this.emittedAttentionKeys.has(dedupeKey)) return undefined;
    this.emittedAttentionKeys.add(dedupeKey);

    const questions = toolInput.questions as Array<{
      question?: string;
      header?: string;
      options?: Array<{ label?: string; description?: string }>;
    }> | undefined;

    const firstQ = questions?.[0];
    const prompt = firstQ?.question ?? "Agent needs your input";
    const options = firstQ?.options?.map((o) => o.label ?? "").filter(Boolean) ?? [];

    return {
      kind: "ask_user",
      prompt,
      options: options.length > 0 ? options : undefined,
      metadata: { toolInput },
    };
  }

  private handleStreamEvent(event: Record<string, unknown>): ParseResult {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner || !inner.type) return { messages: [], deltas: [] };
    const blockKey = (inner.index as number) ?? -1;

    switch (inner.type as string) {
      case "content_block_start": {
        const block = inner.content_block as {
          type: string;
          id?: string;
          name?: string;
          input?: unknown;
        } | undefined;
        if (block?.type === "tool_use" && block.name) {
          this.activeToolBlocks.set(blockKey, {
            id: block.id,
            name: block.name,
            initialInput: serializeToolInput(block.input),
            streamedInput: "",
          });
          if (block.id) this.toolUseNames.set(block.id, block.name);
          return { messages: [], deltas: [{ deltaType: "tool_start", toolName: block.name }] };
        }
        if (block?.type === "text") {
          this.activeTextBlocks.set(blockKey, "");
        }
        return { messages: [], deltas: [] };
      }

      case "content_block_delta": {
        const delta = inner.delta as {
          type: string;
          text?: string;
          partial_json?: string;
        } | undefined;
        if (!delta) return { messages: [], deltas: [] };
        if (delta.type === "text_delta" && delta.text) {
          const existing = this.activeTextBlocks.get(blockKey);
          if (existing !== undefined) {
            this.activeTextBlocks.set(blockKey, existing + delta.text);
          }
          return { messages: [], deltas: [{ deltaType: "text", text: delta.text }] };
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          const toolBlock = this.activeToolBlocks.get(blockKey);
          if (toolBlock) {
            toolBlock.streamedInput += delta.partial_json;
          }
          return { messages: [], deltas: [{ deltaType: "tool_input", toolInput: delta.partial_json }] };
        }
        if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
          return { messages: [], deltas: [] };
        }
        return { messages: [], deltas: [] };
      }

      case "content_block_stop": {
        // Handle completed tool blocks
        const toolBlock = this.activeToolBlocks.get(blockKey);
        if (toolBlock) {
          this.activeToolBlocks.delete(blockKey);

          // Skip if already persisted via tool_use or assistant event (reverse-order dedup)
          if (toolBlock.id && this.persistedToolUseIds.has(toolBlock.id)) {
            return { messages: [], deltas: [{ deltaType: "tool_end" }] };
          }
          if (toolBlock.id) this.persistedToolUseIds.add(toolBlock.id);

          const toolInput = finalizeToolInput(toolBlock);
          const msg: ParsedMessage = {
            role: "tool",
            content: "",
            toolName: toolBlock.name,
            toolInput,
          };

          let attention: AttentionEvent | undefined;
          const parsedToolInput = safeParseObject(toolInput);
          if (parsedToolInput) {
            attention = this.maybeExtractAskUserAttention(
              toolBlock.name,
              parsedToolInput,
              toolBlock.id,
              toolInput,
            );
          }

          return {
            messages: [msg],
            deltas: [{ deltaType: "tool_end" }],
            attention,
          };
        }

        // Handle completed text blocks — persist accumulated text
        const textContent = this.activeTextBlocks.get(blockKey);
        if (textContent !== undefined) {
          this.activeTextBlocks.delete(blockKey);
          if (textContent.trim()) {
            return {
              messages: [{ role: "assistant", content: textContent }],
              deltas: [],
            };
          }
        }

        return { messages: [], deltas: [] };
      }

      case "message_stop":
      case "message_start":
      case "message_delta":
        return { messages: [], deltas: [] };

      default:
        if (inner.type) {
          console.warn(`[claude] Unknown stream event type: ${inner.type}`);
        }
        return { messages: [], deltas: [] };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

interface ActiveToolBlock {
  id?: string;
  name: string;
  initialInput: string;
  streamedInput: string;
}

function serializeToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "{}";

  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

function finalizeToolInput(block: ActiveToolBlock): string {
  const initial = block.initialInput.trim();
  const streamed = block.streamedInput.trim();
  const candidates: string[] = [];

  if (initial && streamed) {
    candidates.push(initial + streamed);

    if (initial.endsWith("}") && streamed.startsWith(",")) {
      candidates.push(initial.slice(0, -1) + streamed);
    }

    if (initial === "{}" && streamed.startsWith(",")) {
      candidates.push(`{${streamed.slice(1)}`);
    }
  }

  if (streamed) candidates.push(streamed);
  if (initial) candidates.push(initial);

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next reconstruction candidate.
    }
  }

  return streamed || initial || "{}";
}

function safeParseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// Export helpers for tests
export { serializeToolInput, finalizeToolInput, safeParseObject, ClaudeParser };
