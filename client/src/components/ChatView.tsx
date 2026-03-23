import { useEffect, useRef, useState } from "react";
import type { Message, Thread } from "shared";

interface Props {
  messages: Message[];
  thread: Thread;
  streamingText?: string;
  streamingTool?: string;
  streamingToolInput?: string;
}

export function ChatView({ messages, thread, streamingText, streamingTool, streamingToolInput }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll on new messages or streaming content
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, streamingText, streamingTool, streamingToolInput, autoScroll]);

  // Detect manual scroll
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setAutoScroll(atBottom);
  };

  const isStreaming = !!(streamingText || streamingTool);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-3"
    >
      {/* Thread header */}
      <div className="mb-4 pb-3 border-b border-slate-800">
        <h2 className="text-lg font-semibold">{thread.title}</h2>
        <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
          <span>{thread.agent}</span>
          <span>·</span>
          <span>{thread.status}</span>
          {thread.branch && (
            <>
              <span>·</span>
              <span className="font-mono">{thread.branch}</span>
            </>
          )}
        </div>
      </div>

      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Streaming content — replaces "Thinking..." */}
      {thread.status === "running" && (
        <>
          {streamingTool && (
            <div className="max-w-[80%] py-1">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-indigo-400" />
                <span className="font-mono">{streamingTool}</span>
                {streamingToolInput && (
                  <span className="text-slate-500 truncate max-w-[300px]">
                    {extractToolContext(streamingTool, streamingToolInput)}
                  </span>
                )}
              </div>
            </div>
          )}

          {streamingText ? (
            <div className="max-w-[80%]" aria-live="polite">
              <div className="bg-slate-800 rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap">
                {streamingText}
                <span className="inline-block w-0.5 h-4 bg-slate-400 ml-0.5 animate-pulse align-text-bottom" />
              </div>
            </div>
          ) : !streamingTool ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-2">
              <span className="animate-pulse">Thinking...</span>
            </div>
          ) : null}
        </>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-indigo-600 rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="max-w-[80%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-300 py-1"
        >
          <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>
            ▸
          </span>
          <span className="font-mono">{message.toolName || "tool"}</span>
        </button>
        {expanded && (
          <div className="ml-4 mt-1 space-y-1">
            {message.toolInput && (
              <pre className="text-xs bg-slate-900 rounded p-2 overflow-x-auto text-slate-400">
                {formatJson(message.toolInput)}
              </pre>
            )}
            {message.toolOutput && (
              <pre className="text-xs bg-slate-900 rounded p-2 overflow-x-auto text-slate-300 max-h-64 overflow-y-auto">
                {truncate(message.toolOutput, 2000)}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  // Assistant message
  return (
    <div className="max-w-[80%]">
      <div className="bg-slate-800 rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function extractToolContext(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input);
    // Show the most useful field for common tools
    if (parsed.file_path || parsed.filePath) return parsed.file_path || parsed.filePath;
    if (parsed.path) return parsed.path;
    if (parsed.command) return parsed.command.slice(0, 80);
    if (parsed.pattern) return parsed.pattern;
    if (parsed.query) return parsed.query.slice(0, 80);
    if (parsed.url) return parsed.url;
    return "";
  } catch {
    // Input is still streaming (partial JSON) — try to extract file_path
    const pathMatch = input.match(/"(?:file_path|filePath|path)"\s*:\s*"([^"]+)"/);
    if (pathMatch) return pathMatch[1];
    const cmdMatch = input.match(/"command"\s*:\s*"([^"]{1,80})/);
    if (cmdMatch) return cmdMatch[1];
    return "";
  }
}

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}
