interface ParsedAgent {
  description: string;
  subagentType?: string;
}

export function parseAgentPrompt(input: string | null): ParsedAgent | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    const prompt = extractPrompt(parsed);
    const description: string = parsed.description || prompt?.slice(0, 120) || "Sub-agent task";
    const subagentType: string | undefined = parsed.subagent_type || parsed.subagentType || parsed.agent_type || parsed.agentType;
    return { description, subagentType };
  } catch {
    return { description: "Sub-agent task", subagentType: undefined };
  }
}

function extractPrompt(parsed: Record<string, unknown>): string | null {
  if (typeof parsed.prompt === "string" && parsed.prompt.trim()) return parsed.prompt.trim();
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  if (!Array.isArray(parsed.items)) return null;

  for (const item of parsed.items) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

interface Props {
  input: string | null;
  output: string | null;
  isActive: boolean;
  metadata?: Record<string, unknown> | null;
}

export function SubAgentCard({ input, output, isActive, metadata }: Props) {
  const agent = parseAgentPrompt(input);
  if (!agent) return null;

  const hasResult = !!output;
  const isError = metadata?.isError === true;

  if (!isActive && hasResult && !isError) {
    // Collapsed done state — single line
    return (
      <div className="flex items-center gap-2 text-xs py-0.5 text-content-3">
        <span className="text-emerald-400">✓</span>
        <span className="truncate">
          {agent.subagentType && <span className="text-content-3">[{agent.subagentType}] </span>}
          {agent.description}
        </span>
      </div>
    );
  }

  return (
    <div className={`subagent-card ${
      isError
        ? "subagent-card-error"
        : isActive
          ? "subagent-card-running"
          : "subagent-card-done"
    }`}>
      <div className="flex items-center gap-2">
        {isActive ? (
          <span className="subagent-spinner" />
        ) : isError ? (
          <span className="text-red-400 text-xs">✗</span>
        ) : (
          <span className="text-emerald-400 text-xs">✓</span>
        )}
        <span className="text-xs font-medium truncate">
          {agent.subagentType && <span className="text-content-3">[{agent.subagentType}] </span>}
          {agent.description}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ml-auto shrink-0 ${
          isActive
            ? "bg-emerald-900/30 text-emerald-400 border border-emerald-500/20"
            : isError
              ? "bg-red-900/30 text-red-400 border border-red-500/20"
              : "bg-accent/8 text-accent/60 border border-accent/15"
        }`}>
          {isActive ? "running" : isError ? "error" : "done"}
        </span>
      </div>
      {isError && output && (
        <div className="text-xs text-red-300/70 mt-1 ml-5 truncate">{output.slice(0, 120)}</div>
      )}
    </div>
  );
}
