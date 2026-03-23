import type { AgentAdapter, AgentProcess, ParsedMessage, ParseResult, SpawnOpts } from "./types";
import type { StreamDelta } from "shared";

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
        // Pass session_id via deltas so the session manager can store it for --resume.
        return {
          messages: [],
          deltas: [{
            deltaType: "turn_end",
            text: event.session_id,  // Piggyback session_id on turn_end delta
          }],
        };
      }

      case "tool_use":
        return {
          messages: [
            {
              role: "tool",
              content: "",
              toolName: event.tool?.name ?? "unknown",
              toolInput: JSON.stringify(event.tool?.input ?? {}),
            },
          ],
          deltas: [],
        };

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

      // ── Stream events (real-time deltas) ──────────────
      case "stream_event":
        return { messages: [], deltas: this.handleStreamEvent(event) };

      default:
        return { messages: [], deltas: [] };
    }
  }

  private currentBlockType: string | null = null;

  private handleStreamEvent(event: ClaudeStreamEvent): Omit<StreamDelta, "threadId">[] {
    const inner = event.event;
    if (!inner || !inner.type) return [];

    switch (inner.type) {
      case "content_block_start": {
        const block = inner.content_block;
        this.currentBlockType = block?.type ?? null;
        if (block?.type === "tool_use" && block.name) {
          return [{ deltaType: "tool_start", toolName: block.name }];
        }
        return [];
      }

      case "content_block_delta": {
        const delta = inner.delta;
        if (!delta) return [];
        if (delta.type === "text_delta" && delta.text) {
          return [{ deltaType: "text", text: delta.text }];
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          return [{ deltaType: "tool_input", toolInput: delta.partial_json }];
        }
        return [];
      }

      case "content_block_stop":
        // Only emit tool_end for tool_use blocks, not text blocks
        if (this.currentBlockType === "tool_use") {
          this.currentBlockType = null;
          return [{ deltaType: "tool_end" }];
        }
        this.currentBlockType = null;
        return [];

      case "message_stop":
        return [{ deltaType: "turn_end" }];

      default:
        return [];
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
  // For stream_event wrapper
  event?: {
    type: string;
    content_block?: { type: string; name?: string };
    delta?: { type: string; text?: string; partial_json?: string };
  };
}
