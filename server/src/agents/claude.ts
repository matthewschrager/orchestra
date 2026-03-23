import type { AgentAdapter, AgentProcess, ParsedMessage, SpawnOpts } from "./types";

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
      ...this.getBypassFlags(),
      "--verbose",
    ];

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    const proc = Bun.spawn(["claude", ...args], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });

    return { proc };
  }

  parseOutput(line: string): ParsedMessage[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let data: ClaudeStreamEvent;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — treat as raw assistant output
      return [{ role: "assistant", content: trimmed }];
    }

    return this.handleEvent(data);
  }

  sendInput(agentProc: AgentProcess, text: string): void {
    agentProc.proc.stdin.write(text + "\n");
    agentProc.proc.stdin.flush();
  }

  supportsResume(): boolean {
    return true;
  }

  getBypassFlags(): string[] {
    return ["--dangerously-skip-permissions"];
  }

  // ── Private ─────────────────────────────────────────

  private handleEvent(event: ClaudeStreamEvent): ParsedMessage[] {
    switch (event.type) {
      case "assistant": {
        const textParts = (event.message?.content ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);
        if (textParts.length === 0) return [];
        return [{ role: "assistant", content: textParts.join("") }];
      }

      case "user":
        return []; // Echo of our own input — skip

      case "result": {
        const text =
          typeof event.result === "string"
            ? event.result
            : event.result?.text ?? JSON.stringify(event.result);
        return [
          {
            role: "assistant",
            content: text,
            metadata: {
              costUsd: event.cost_usd,
              durationMs: event.duration_ms,
              sessionId: event.session_id,
            },
          },
        ];
      }

      case "tool_use":
        return [
          {
            role: "tool",
            content: "",
            toolName: event.tool?.name ?? "unknown",
            toolInput: JSON.stringify(event.tool?.input ?? {}),
          },
        ];

      case "tool_result":
        return [
          {
            role: "tool",
            content: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? ""),
            toolName: event.tool_name ?? undefined,
            toolOutput: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? ""),
          },
        ];

      default:
        return [];
    }
  }
}

// ── Claude stream-json event types (subset) ─────────────

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
}
