import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ASK_USER_TOOL_NAME_ALIASES, extractAskUserRequest, isAskUserToolName } from "./askUser";
import { getCliVersion, hasCli } from "./cli";
import type {
  AgentAdapter,
  AgentSession,
  AttentionEvent,
  ParsedMessage,
  ParseResult,
  PersistentSession,
  StartOpts,
} from "./types";
import { normalizeToolResultContent } from "./toolResultMedia";
import type { ModelOption } from "shared";

/** Mutable ref so canUseTool can read the current permission mode without closure rebinding. */
interface PermissionModeRef {
  current: string;
}

/** Tool names handled as plan-approval attention items.
 *  ExitPlanMode has requiresUserInteraction()=true in the CLI, which causes a Zod
 *  validation error in headless SDK mode. We deny it in canUseTool and surface it
 *  as an attention item — same flow as AskUserQuestion. */
const PLAN_APPROVAL_TOOLS = new Set(["ExitPlanMode"]);

/** Combined set of tools denied in canUseTool (used for skipping denial tool_results) */
const ORCHESTRA_HANDLED_TOOLS = new Set([...ASK_USER_TOOL_NAME_ALIASES, ...PLAN_APPROVAL_TOOLS]);

const DEBUG = process.env.ORCHESTRA_DEBUG === "1";

// ── Lazy model discovery cache ─────────────────────────────
let cachedModels: ModelOption[] | null = null;
export function getCachedClaudeModels(): ModelOption[] | null { return cachedModels; }

/**
 * Factory: creates a custom permission handler bound to a mutable PermissionModeRef.
 *
 * - AskUserQuestion/AskUserTool: denied with interrupt — Orchestra surfaces them
 *   as attention items for the user to answer.
 * - ExitPlanMode: denied with interrupt — the SDK's requiresUserInteraction() check
 *   causes a Zod validation error in headless mode when the tool is allowed to execute.
 *   By denying here, the agent gets a clean message instead of a cryptic Zod error.
 *   Orchestra surfaces a "plan approval" attention item, and on approval calls
 *   setPermissionMode() to exit plan mode at the CLI level.
 */
function createCanUseTool(modeRef: PermissionModeRef): CanUseTool {
  return async (toolName, input, _options) => {
    if (isAskUserToolName(toolName)) {
      if (DEBUG) console.log(`[claude] canUseTool: denying ${toolName} with interrupt (mode=${modeRef.current})`);
      return { behavior: "deny", message: "Handled by Orchestra", interrupt: true };
    }
    if (PLAN_APPROVAL_TOOLS.has(toolName)) {
      if (DEBUG) console.log(`[claude] canUseTool: denying ${toolName} — plan approval handled by Orchestra (mode=${modeRef.current})`);
      return {
        behavior: "deny",
        message: "Plan submitted for user review via Orchestra. The user will approve or reject the plan. Do not retry ExitPlanMode — Orchestra will handle the transition.",
        interrupt: true,
      };
    }
    // updatedInput is required by the CLI's Zod validation schema even though the
    // SDK TypeScript types mark it optional. Pass through the original input.
    return { behavior: "allow", updatedInput: input };
  };
}

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  async detect(): Promise<boolean> {
    return hasCli("claude");
  }

  async getVersion(): Promise<string | null> {
    return getCliVersion("claude");
  }

  /** Legacy per-turn session — creates a new subprocess per call */
  start(opts: StartOpts): AgentSession {
    const abortController = new AbortController();
    const effort = opts.effortLevel === "low" || opts.effortLevel === "medium" || opts.effortLevel === "high"
      ? opts.effortLevel
      : undefined;
    const model = opts.model || undefined;
    const mode = (opts.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan") ?? "bypassPermissions";
    const modeRef: PermissionModeRef = { current: mode };

    const iter = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        effort,
        model,
        resume: opts.resumeSessionId,
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        canUseTool: createCanUseTool(modeRef),
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

  /** Persistent session — subprocess stays alive between turns, follow-ups via streamInput() */
  startPersistent(opts: StartOpts): PersistentSession {
    const effort = opts.effortLevel === "low" || opts.effortLevel === "medium" || opts.effortLevel === "high"
      ? opts.effortLevel
      : undefined;
    const model = opts.model || undefined;
    const mode = (opts.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan") ?? "bypassPermissions";
    const modeRef: PermissionModeRef = { current: mode };
    if (DEBUG) console.log(`[claude] startPersistent permissionMode=${mode} cwd=${opts.cwd}`);
    const q: Query = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        effort,
        model,
        resume: opts.resumeSessionId,
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        canUseTool: createCanUseTool(modeRef),
      },
    });

    const parser = new ClaudeParser();

    // Lazy model discovery — fire-and-forget on first persistent session
    if (!cachedModels) {
      q.supportedModels().then((sdkModels) => {
        cachedModels = sdkModels.map((m) => ({
          value: m.value,
          label: m.displayName,
        }));
        if (DEBUG) console.log(`[claude] Discovered ${cachedModels.length} models from SDK`);
      }).catch(() => {});
    }

    return {
      messages: q, // Query extends AsyncGenerator<SDKMessage>
      abort: () => q.close(),
      parseMessage: (msg: unknown) => parser.handleMessage(msg),
      sessionId: opts.resumeSessionId,
      close: () => q.close(),
      resetTurnState: () => parser.resetTurnState(),
      async injectMessage(text: string, sessionId: string, priority?: "now" | "next"): Promise<void> {
        const userMsg: SDKUserMessage = {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          session_id: sessionId,
          priority: priority ?? "next",
        };
        // streamInput expects AsyncIterable — wrap in single-element generator
        await q.streamInput(
          (async function* () {
            yield userMsg;
          })(),
        );
      },
      async setModel(newModel: string): Promise<void> {
        await q.setModel(newModel);
      },
      async setPermissionMode(newMode: string): Promise<void> {
        modeRef.current = newMode;
        await q.setPermissionMode(newMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk");
      },
    };
  }

  supportsResume(): boolean {
    return true;
  }

  supportsPersistent(): boolean {
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
  /** Per-request input tokens from the latest primary-model message_start event.
   *  This is the ACTUAL context occupancy — unlike modelUsage which is cumulative. */
  private lastPrimaryInputTokens: number | undefined;
  /** Per-request output tokens from the latest primary-model message_delta event. */
  private lastPrimaryOutputTokens: number | undefined;

  /** Reset turn-level state between turns in persistent sessions.
   *  Clears active blocks (should be empty at turn boundary) and dedup sets.
   *  Keeps toolUseNames since tool_use_ids are globally unique per session.
   *  Clears per-request token trackers so stale values don't block cumulative fallback
   *  if the new turn's message_start never fires (e.g. resumed session, error). */
  resetTurnState(): void {
    this.activeToolBlocks.clear();
    this.activeTextBlocks.clear();
    this.persistedToolUseIds.clear();
    this.emittedAttentionKeys.clear();
    this.lastPrimaryInputTokens = undefined;
    this.lastPrimaryOutputTokens = undefined;
  }

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
            // ExitPlanMode → surface as plan-approval attention (same flow as AskUser)
            if (!attention && PLAN_APPROVAL_TOOLS.has(block.name)) {
              attention = this.makeExitPlanModeAttention(block.id);
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
            const toolName = block.tool_use_id
              ? this.toolUseNames.get(block.tool_use_id)
              : undefined;
            // Skip tool_results for Orchestra-handled tools — the denial response from
            // canUseTool(interrupt:true) is noise, not useful content
            if (toolName && ORCHESTRA_HANDLED_TOOLS.has(toolName)) continue;

            const normalized = normalizeToolResultContent(block.content);
            const metadata = {
              ...(block.is_error ? { isError: true } : {}),
              ...(normalized.images.length > 0 ? { images: normalized.images } : {}),
            };
            userMessages.push({
              role: "tool",
              content: normalized.text,
              toolName,
              toolOutput: normalized.text || undefined,
              metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
        let modelName: string | undefined;

        if (modelUsage) {
          // Find the primary model (largest context window) for contextWindow + modelName.
          for (const [name, model] of Object.entries(modelUsage)) {
            if (model.contextWindow && (!contextWindow || model.contextWindow > contextWindow)) {
              contextWindow = model.contextWindow;
              modelName = name;
            }
          }

          // IMPORTANT: modelUsage reports CUMULATIVE token totals across all API calls
          // in the session. Over multiple turns, cumulative inputTokens far exceeds the
          // context window (because conversation history is re-sent each turn).
          //
          // For context occupancy, we use per-request tokens extracted from message_start
          // stream events (set in handleStreamEvent). These represent the actual context
          // size for the latest API call — what the model actually "sees" right now.
          if (this.lastPrimaryInputTokens !== undefined) {
            inputTokens = this.lastPrimaryInputTokens;
            outputTokens = this.lastPrimaryOutputTokens ?? 0;
          } else if (modelName && modelUsage[modelName]) {
            // Fallback: no stream events seen (e.g. resumed session) — use cumulative
            // from primary model. Not ideal but better than nothing.
            const pm = modelUsage[modelName];
            inputTokens = (pm.inputTokens ?? 0) + (pm.cacheReadInputTokens ?? 0) + (pm.cacheCreationInputTokens ?? 0);
            outputTokens = pm.outputTokens ?? 0;
          } else {
            // No stream events AND no contextWindow info — fall back to summing all models
            inputTokens = 0;
            outputTokens = 0;
            for (const model of Object.values(modelUsage)) {
              inputTokens += (model.inputTokens ?? 0) + (model.cacheReadInputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0);
              outputTokens += model.outputTokens ?? 0;
            }
          }
        }

        if (costUsd !== undefined || durationMs !== undefined || inputTokens !== undefined) {
          deltas.push({ deltaType: "metrics", costUsd, durationMs, inputTokens, outputTokens, contextWindow, modelName });
        }
        deltas.push({
          deltaType: "turn_end",
          text: (event.session_id as string) || undefined,
        });

        const resultParse: ParseResult = { messages: [], deltas };

        // Check permission_denials for Orchestra-handled tools (before error detection —
        // an interrupted denial from canUseTool is expected, not an error)
        const denials = event.permission_denials as Array<{
          tool_name: string;
          tool_use_id: string;
          tool_input: Record<string, unknown>;
        }> | undefined;

        let hasOrchestraDenial = false;
        if (denials && Array.isArray(denials)) {
          for (const denial of denials) {
            if (ORCHESTRA_HANDLED_TOOLS.has(denial.tool_name)) {
              hasOrchestraDenial = true;
            }
            // Try AskUser attention extraction from denials
            if (!resultParse.attention) {
              const attention = this.maybeExtractAskUserAttention(
                denial.tool_name,
                denial.tool_input,
                denial.tool_use_id,
              );
              if (attention) {
                resultParse.attention = attention;
              }
            }
            // Try ExitPlanMode attention extraction from denials
            if (!resultParse.attention && PLAN_APPROVAL_TOOLS.has(denial.tool_name)) {
              resultParse.attention = this.makeExitPlanModeAttention(denial.tool_use_id);
            }
          }
        }

        // Detect SDK error results or zero-turn successes (no model interaction).
        // Skip error surfacing when the result is from an expected Orchestra denial
        // (canUseTool deny+interrupt produces an error-shaped result that isn't a real error).
        const numTurns = event.num_turns as number | undefined;
        if (!hasOrchestraDenial) {
          if (isError || (subtype && subtype.startsWith("error_"))) {
            const errorDetail = errors?.join("; ") || subtype || "unknown SDK error";
            resultParse.error = errorDetail;
          } else if (subtype === "success" && numTurns === 0) {
            const resultText = event.result as string | undefined;
            resultParse.error = resultText || "SDK completed with zero model turns";
          }
        }

        return resultParse;
      }

      case "system": {
        // SDKSystemMessage: { type: "system", subtype: "init" | "compact_boundary", ... }
        const subtype = event.subtype as string | undefined;
        if (subtype === "init") {
          // Extract model name from init event (available immediately at session start)
          const model = event.model as string | undefined;
          if (model) {
            return { messages: [], deltas: [{ deltaType: "metrics", modelName: model }] };
          }
          return { messages: [], deltas: [] };
        }
        if (subtype === "compact_boundary") {
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
    const askUser = extractAskUserRequest(toolName, toolInput);
    if (!askUser) return undefined;

    const dedupeKey = toolUseId || `${toolName}:${serializedInput ?? askUser.serializedInput}`;
    if (this.emittedAttentionKeys.has(dedupeKey)) return undefined;
    this.emittedAttentionKeys.add(dedupeKey);

    return askUser.attention;
  }

  /** Create a plan-approval attention event for ExitPlanMode.
   *  Uses the same dedup mechanism as AskUserQuestion to prevent duplicate cards. */
  private makeExitPlanModeAttention(toolUseId?: string): AttentionEvent | undefined {
    const dedupeKey = toolUseId || "ExitPlanMode";
    if (this.emittedAttentionKeys.has(dedupeKey)) return undefined;
    this.emittedAttentionKeys.add(dedupeKey);

    return {
      kind: "confirmation",
      prompt: "Agent has a plan ready and wants to proceed with implementation.",
      options: ["Approve plan", "Reject plan"],
      metadata: { source: "exit_plan_mode" },
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
          // ExitPlanMode → surface as plan-approval attention (same flow as AskUser)
          if (!attention && PLAN_APPROVAL_TOOLS.has(toolBlock.name)) {
            attention = this.makeExitPlanModeAttention(toolBlock.id);
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

      case "message_start": {
        // Extract per-request input tokens from primary-model messages only.
        // parent_tool_use_id is null for the primary model, non-null for sub-agents.
        // These per-request values represent actual context occupancy (vs cumulative
        // modelUsage which inflates over multiple turns).
        const parentToolUseId = event.parent_tool_use_id as string | null;
        if (parentToolUseId === null) {
          const msg = inner.message as {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          } | undefined;
          if (msg?.usage) {
            const u = msg.usage;
            this.lastPrimaryInputTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0);
            // Emit metrics delta so context indicator updates in real-time during streaming.
            // Include outputTokens: 0 to reset stale output from previous turn (#3).
            return {
              messages: [],
              deltas: [{ deltaType: "metrics", inputTokens: this.lastPrimaryInputTokens, outputTokens: 0 }],
            };
          }
        }
        return { messages: [], deltas: [] };
      }
      case "message_delta": {
        // Extract per-request output tokens from primary-model message_delta.
        const parentId = event.parent_tool_use_id as string | null;
        if (parentId === null) {
          const deltaUsage = inner.usage as { output_tokens?: number } | undefined;
          if (deltaUsage?.output_tokens !== undefined) {
            this.lastPrimaryOutputTokens = deltaUsage.output_tokens;
          }
        }
        return { messages: [], deltas: [] };
      }
      case "message_stop":
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
export { createCanUseTool, serializeToolInput, finalizeToolInput, safeParseObject, ClaudeParser };
