import type {
  AgentAdapter,
  AgentOutputParser,
  AgentProcess,
  AttentionEvent,
  ParsedMessage,
  ParseResult,
  SpawnOpts,
} from "./types";

/** Tool names that trigger attention events */
const ASK_USER_TOOLS = new Set(["AskUserQuestion", "AskUserTool"]);

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  async detect(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    const args = [
      "--output-format", "stream-json",
      "--include-partial-messages",
      ...this.getBypassFlags(),
      "--verbose",
      "-p", opts.prompt,
    ];

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    const proc = Bun.spawn(["claude", ...args], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc };
  }

  createParser(): AgentOutputParser {
    return new ClaudeParser();
  }

  supportsResume(): boolean {
    return true;
  }

  getBypassFlags(): string[] {
    return ["--dangerously-skip-permissions"];
  }
}

class ClaudeParser implements AgentOutputParser {
  private readonly activeToolBlocks = new Map<number, ActiveToolBlock>();
  private readonly activeTextBlocks = new Map<number, string>();
  /** Maps tool_use_id → tool_name for pairing and deduplication */
  private readonly toolUseNames = new Map<string, string>();
  /** tool_use IDs already persisted via stream_events — skip in assistant summary */
  private readonly persistedToolUseIds = new Set<string>();
  private readonly emittedAttentionKeys = new Set<string>();

  parseOutput(line: string): ParseResult {
    const trimmed = line.trim();
    if (!trimmed) return { messages: [], deltas: [] };

    let data: ClaudeStreamEvent;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — treat as raw assistant output
      return { messages: [{ role: "assistant", content: trimmed }], deltas: [] };
    }

    const result = this.handleEvent(data);
    if (typeof data.session_id === "string" && data.session_id) {
      result.sessionId ??= data.session_id;
    }
    return result;
  }

  private handleEvent(event: ClaudeStreamEvent): ParseResult {
    switch (event.type) {
      case "assistant": {
        // Text is already persisted via stream_event content_block_stop.
        // Only extract tool_use blocks here — these may not arrive via
        // stream_events in multi-turn conversations (e.g., after subagent execution).
        const blocks = event.message?.content ?? [];
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
            if (block.id) this.toolUseNames.set(block.id, block.name);
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
        // Extract tool_result blocks — Claude wraps tool outputs in user events.
        // Pair each result with its tool_use via tool_use_id → toolName lookup.
        const userBlocks = event.message?.content ?? [];
        const userMessages: ParsedMessage[] = [];

        for (const block of userBlocks) {
          if (block.type === "tool_result") {
            const outputContent = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(b => b.type === "text").map(b => b.text ?? "").join("")
                : "";
            // Look up the tool name from the corresponding tool_use
            const toolName = block.tool_use_id
              ? this.toolUseNames.get(block.tool_use_id)
              : undefined;
            userMessages.push({
              role: "tool",
              content: outputContent,
              toolName,
              toolOutput: outputContent || undefined,
            });
          }
        }

        return { messages: userMessages, deltas: [] };
      }

      case "result": {
        // Don't persist text — the `assistant` event already captured it.
        // Emit metrics delta with cost/duration, then turn_end with session_id.
        const deltas: Array<{ deltaType: string; text?: string; costUsd?: number; durationMs?: number }> = [];
        const costUsd = event.cost_usd ?? event.total_cost_usd;
        if (costUsd !== undefined || event.duration_ms !== undefined) {
          deltas.push({
            deltaType: "metrics",
            costUsd,
            durationMs: event.duration_ms,
          });
        }
        // Always emit turn_end on result — don't gate on session_id presence.
        // session_id is piggybacked when available, but the turn is over regardless.
        deltas.push({
          deltaType: "turn_end",
          text: event.session_id || undefined,
        });

        const resultParse: ParseResult = { messages: [], deltas };

        // Fallback: some AskUserQuestion calls only surface in permission_denials.
        if (event.permission_denials && Array.isArray(event.permission_denials)) {
          for (const denial of event.permission_denials) {
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
        // Surface user-facing system messages, but ignore init envelopes that only
        // carry metadata like tools/session_id.
        const sysContent = typeof event.content === "string"
          ? event.content
          : event.content ? JSON.stringify(event.content) : "";
        if (!sysContent) return { messages: [], deltas: [] };
        return {
          messages: [{ role: "assistant", content: sysContent }],
          deltas: [],
        };
      }

      case "tool_use": {
        const toolName = event.tool?.name ?? "unknown";
        const toolInput = event.tool?.input as Record<string, unknown> | undefined;
        const serializedInput = serializeToolInput(toolInput);
        const result: ParseResult = {
          messages: [
            {
              role: "tool",
              content: "",
              toolName,
              toolInput: serializedInput,
            },
          ],
          deltas: [],
        };

        const attention = this.maybeExtractAskUserAttention(
          toolName,
          toolInput,
          event.tool?.id,
          serializedInput,
        );
        if (attention) {
          result.attention = attention;
        }

        return result;
      }

      case "tool_result":
        return {
          messages: [
            {
              role: "tool",
              content: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? ""),
              toolName: event.tool_name ?? undefined,
              toolOutput: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? ""),
            },
          ],
          deltas: [],
        };

      // ── Stream events (real-time deltas + tool persistence) ──
      case "stream_event":
        return this.handleStreamEvent(event);

      // Known event types that carry no user-visible content
      case "rate_limit_event":
        return { messages: [], deltas: [] };

      default:
        if (event.type) {
          console.warn(`[claude] Unknown event type: ${event.type}`, JSON.stringify(event).slice(0, 200));
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

  private handleStreamEvent(event: ClaudeStreamEvent): ParseResult {
    const inner = event.event;
    if (!inner || !inner.type) return { messages: [], deltas: [] };
    const blockKey = inner.index ?? -1;

    switch (inner.type) {
      case "content_block_start": {
        const block = inner.content_block;
        if (block?.type === "tool_use" && block.name) {
          this.activeToolBlocks.set(blockKey, {
            id: block.id,
            name: block.name,
            initialInput: serializeToolInput(block.input),
            streamedInput: "",
          });
          // Track tool_use_id → name so user-event tool_results can be paired
          if (block.id) this.toolUseNames.set(block.id, block.name);
          return { messages: [], deltas: [{ deltaType: "tool_start", toolName: block.name }] };
        }
        if (block?.type === "text") {
          this.activeTextBlocks.set(blockKey, "");
        }
        return { messages: [], deltas: [] };
      }

      case "content_block_delta": {
        const delta = inner.delta;
        if (!delta) return { messages: [], deltas: [] };
        if (delta.type === "text_delta" && delta.text) {
          // Accumulate text for persistence on content_block_stop
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
          const toolInput = finalizeToolInput(toolBlock);
          const msg: ParsedMessage = {
            role: "tool",
            content: "",
            toolName: toolBlock.name,
            toolInput,
          };
          this.activeToolBlocks.delete(blockKey);
          if (toolBlock.id) this.persistedToolUseIds.add(toolBlock.id);

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

// ── Claude stream-json event types ──────────────────────

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content: Array<{
      type: string;
      text?: string;
      // tool_use fields
      id?: string;
      name?: string;
      input?: unknown;
      // tool_result fields
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }>;
  };
  result?: string | { text?: string };
  cost_usd?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  tool?: { id?: string; name?: string; input?: unknown };
  tool_name?: string;
  content?: unknown;
  // permission_denials from result event (AskUserQuestion gets denied in -p mode)
  permission_denials?: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }>;
  // For stream_event wrapper
  event?: {
    type: string;
    index?: number;
    content_block?: { type: string; id?: string; name?: string; input?: unknown };
    delta?: {
      type: string;
      text?: string;
      partial_json?: string;
      thinking?: string;
      signature?: string;
    };
  };
}

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
