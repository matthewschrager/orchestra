import type { AgentAdapter, AgentProcess, AttentionEvent, ParsedMessage, ParseResult, SpawnOpts } from "./types";
import type { StreamDelta } from "shared";

/** Tool names that trigger attention events */
const ASK_USER_TOOLS = new Set(["AskUserQuestion", "AskUserTool"]);
const PERMISSION_TOOLS = new Set(["BashTool", "EditTool", "WriteTool"]);

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

    return this.handleEvent(data);
  }

  supportsResume(): boolean {
    return true;
  }

  getBypassFlags(): string[] {
    return ["--dangerously-skip-permissions"];
  }

  // ── Private ─────────────────────────────────────────

  private handleEvent(event: ClaudeStreamEvent): ParseResult {
    switch (event.type) {
      case "assistant": {
        const textParts = (event.message?.content ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);
        if (textParts.length === 0) return { messages: [], deltas: [] };
        return { messages: [{ role: "assistant", content: textParts.join("") }], deltas: [] };
      }

      case "user":
        return { messages: [], deltas: [] }; // Echo of our own input — skip

      case "result": {
        // Don't persist text — the `assistant` event already captured it.
        // Emit metrics delta with cost/duration, then turn_end with session_id.
        const deltas: Array<{ deltaType: string; text?: string; costUsd?: number; durationMs?: number }> = [];
        if (event.cost_usd !== undefined || event.duration_ms !== undefined) {
          deltas.push({
            deltaType: "metrics",
            costUsd: event.cost_usd,
            durationMs: event.duration_ms,
          });
        }
        deltas.push({
          deltaType: "turn_end",
          text: event.session_id,  // Piggyback session_id on turn_end delta
        });

        const resultParse: ParseResult = { messages: [], deltas };

        // Check permission_denials for AskUserQuestion (in -p mode, it gets denied)
        if (event.permission_denials && Array.isArray(event.permission_denials)) {
          for (const denial of event.permission_denials) {
            if (ASK_USER_TOOLS.has(denial.tool_name) && denial.tool_input) {
              resultParse.attention = this.extractAskUserAttention(denial.tool_input);
              break;
            }
          }
        }

        return resultParse;
      }

      case "system": {
        // Surface system messages as assistant messages
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
        const result: ParseResult = {
          messages: [
            {
              role: "tool",
              content: "",
              toolName,
              toolInput: JSON.stringify(toolInput ?? {}),
            },
          ],
          deltas: [],
        };

        // Detect AskUserQuestion → attention event
        if (ASK_USER_TOOLS.has(toolName) && toolInput) {
          result.attention = this.extractAskUserAttention(toolInput);
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

      default:
        if (event.type) {
          console.warn(`[claude] Unknown event type: ${event.type}`, JSON.stringify(event).slice(0, 200));
        }
        return { messages: [], deltas: [] };
    }
  }

  private extractAskUserAttention(toolInput: Record<string, unknown>): AttentionEvent {
    const questions = toolInput.questions as Array<{
      question?: string;
      header?: string;
      options?: Array<{ label?: string; description?: string }>;
    }> | undefined;

    const firstQ = questions?.[0];
    const prompt = firstQ?.question ?? "Agent needs your input";
    const options = firstQ?.options?.map((o) => o.label ?? "") ?? [];

    return {
      kind: "ask_user",
      prompt,
      options: options.length > 0 ? options : undefined,
      metadata: { toolInput },
    };
  }

  private currentBlockType: string | null = null;
  private currentToolName: string | null = null;
  private currentToolInput = "";

  private handleStreamEvent(event: ClaudeStreamEvent): ParseResult {
    const inner = event.event;
    if (!inner || !inner.type) return { messages: [], deltas: [] };

    switch (inner.type) {
      case "content_block_start": {
        const block = inner.content_block;
        this.currentBlockType = block?.type ?? null;
        if (block?.type === "tool_use" && block.name) {
          this.currentToolName = block.name;
          this.currentToolInput = "";
          return { messages: [], deltas: [{ deltaType: "tool_start", toolName: block.name }] };
        }
        return { messages: [], deltas: [] };
      }

      case "content_block_delta": {
        const delta = inner.delta;
        if (!delta) return { messages: [], deltas: [] };
        if (delta.type === "text_delta" && delta.text) {
          return { messages: [], deltas: [{ deltaType: "text", text: delta.text }] };
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          this.currentToolInput += delta.partial_json;
          return { messages: [], deltas: [{ deltaType: "tool_input", toolInput: delta.partial_json }] };
        }
        return { messages: [], deltas: [] };
      }

      case "content_block_stop": {
        if (this.currentBlockType === "tool_use") {
          // Persist tool_use as a message AND emit delta
          const msg: ParsedMessage = {
            role: "tool",
            content: "",
            toolName: this.currentToolName || "unknown",
            toolInput: this.currentToolInput,
          };
          this.currentBlockType = null;
          this.currentToolName = null;
          this.currentToolInput = "";
          return { messages: [msg], deltas: [{ deltaType: "tool_end" }] };
        }
        this.currentBlockType = null;
        return { messages: [], deltas: [] };
      }

      case "message_stop":
        // Don't emit turn_end here — the top-level `result` event handles it
        // with the session_id attached, preventing a race where the client
        // sees "turn ended" before the session_id is captured.
        return { messages: [], deltas: [] };

      // Standard Anthropic API envelope events — no content to render
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
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
  result?: string | { text?: string };
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  tool?: { name?: string; input?: unknown };
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
    content_block?: { type: string; name?: string };
    delta?: { type: string; text?: string; partial_json?: string };
  };
}
