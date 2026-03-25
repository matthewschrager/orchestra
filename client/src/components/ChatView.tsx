import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Message, Thread } from "shared";
import { MarkdownContent } from "./MarkdownContent";
import { DiffRenderer } from "./renderers/DiffRenderer";
import { BashRenderer } from "./renderers/BashRenderer";
import { ReadRenderer } from "./renderers/ReadRenderer";
import { SearchRenderer, searchSummary } from "./renderers/SearchRenderer";
import { SubAgentCard } from "./renderers/SubAgentCard";
import { extractQuestionPreview, formatAnswers, isAskUserTool, parseQuestions, type ParsedQuestion } from "../lib/askUser";
import { MessageAttachments } from "./AttachmentPreview";
import type { Attachment } from "shared";

export interface ChatViewHandle {
  scrollToBottom: () => void;
  scrollToTop: () => void;
}

interface Props {
  messages: Message[];
  thread: Thread;
  streamingText?: string;
  streamingTool?: string;
  streamingToolInput?: string;
  turnEnded?: boolean;
  onSubmitAnswers?: (text: string) => void;
}

export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView(
  { messages, thread, streamingText, streamingTool, streamingToolInput, turnEnded, onSubmitAnswers },
  ref,
) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Track how many messages existed when user scrolled away, for the "N new" badge
  const [msgCountAtScrollAway, setMsgCountAtScrollAway] = useState(0);
  // Guard: suppress handleScroll during programmatic smooth-scroll to prevent flicker
  const isProgrammaticScroll = useRef(false);

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // Detect which ask-user tool messages have been answered (user replied after them)
  const answeredQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    let lastUserSeq = -1;
    for (const msg of messages) {
      if (msg.role === "user") lastUserSeq = msg.seq;
    }
    for (const msg of messages) {
      if (isAskUserTool(msg.toolName) && msg.toolInput && !msg.toolOutput && msg.seq < lastUserSeq) {
        ids.add(msg.id);
      }
    }
    return ids;
  }, [messages]);

  // Auto-scroll on new messages or streaming content
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, streamingText, streamingTool, streamingToolInput, autoScroll]);

  // Reset scroll-away state when switching threads
  useEffect(() => {
    setMsgCountAtScrollAway(0);
    setAutoScroll(true);
  }, [thread.id]);

  // Track when user scrolls away to count new messages for the FAB badge
  useEffect(() => {
    if (!autoScroll && msgCountAtScrollAway === 0) {
      setMsgCountAtScrollAway(messages.length);
    } else if (autoScroll && msgCountAtScrollAway > 0) {
      setMsgCountAtScrollAway(0);
    }
  }, [autoScroll, messages.length, msgCountAtScrollAway]);

  const newMessageCount = !autoScroll && msgCountAtScrollAway > 0
    ? Math.max(0, messages.length - msgCountAtScrollAway)
    : 0;

  // Detect manual scroll (suppressed during programmatic smooth-scrolls)
  const handleScroll = () => {
    if (isProgrammaticScroll.current) return;
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setAutoScroll(atBottom);
  };

  const scrollToBottom = useCallback(() => {
    isProgrammaticScroll.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setAutoScroll(true);
    // Re-enable scroll detection after animation settles
    setTimeout(() => { isProgrammaticScroll.current = false; }, 500);
  }, []);

  const scrollToTop = useCallback(() => {
    isProgrammaticScroll.current = true;
    containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => { isProgrammaticScroll.current = false; }, 500);
  }, []);

  useImperativeHandle(ref, () => ({ scrollToBottom, scrollToTop }), [scrollToBottom, scrollToTop]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4"
    >
      {/* Thread header — tap to scroll to top */}
      <div className="mb-6 pb-4 border-b border-edge-1 cursor-pointer group" role="button" tabIndex={0} onClick={scrollToTop} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") scrollToTop(); }}>
        <h2 className="text-lg font-semibold tracking-tight group-hover:text-accent transition-colors">{thread.title}</h2>
        <div className="flex items-center gap-2 mt-1.5 text-xs text-content-3">
          <span className="text-content-2">{thread.agent}</span>
          <span className="text-content-3">&middot;</span>
          <ThreadStatusBadge status={thread.status} errorMessage={thread.errorMessage} />
          {thread.branch && (
            <>
              <span className="text-content-3">&middot;</span>
              <span className="font-mono text-content-2">{thread.branch}</span>
            </>
          )}
        </div>
      </div>

      {/* Error banner when thread ended with an error */}
      {thread.status === "error" && thread.errorMessage && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-950/30 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-red-400 font-medium mb-1">
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 5h2v4H7V5zm0 5h2v2H7v-2z"/>
            </svg>
            <span>Error</span>
          </div>
          <p className="text-sm text-red-300/80 font-mono break-all">{thread.errorMessage}</p>
        </div>
      )}

      {grouped.map((item, i) =>
        Array.isArray(item) ? (
          <ToolGroup key={`tg-${item[0].id}`} messages={item} answeredIds={answeredQuestionIds} onSubmitAnswers={onSubmitAnswers} />
        ) : (
          <MessageBubble key={item.id} message={item} />
        ),
      )}

      {/* Streaming status — active tool + text */}
      {thread.status === "running" && !turnEnded && (
        <div className="py-1">
          {/* Active ask-user tool — show the question inline while streaming */}
          {isAskUserTool(streamingTool) ? (
            <div className="my-2 max-w-[80%] rounded-lg border border-sky-500/20 bg-sky-950/20 px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5 text-xs text-sky-400/80 font-medium">
                <Spinner />
                <span>Agent is asking...</span>
              </div>
              {streamingToolInput && (
                <div className="text-sm text-content-1">
                  <MarkdownContent content={extractQuestionPreview(streamingToolInput)} />
                  <span className="inline-block w-0.5 h-4 bg-sky-400 ml-0.5 animate-pulse align-text-bottom" />
                </div>
              )}
            </div>
          ) : streamingTool ? (
            <div className="flex items-center gap-2 text-xs text-content-2 py-0.5">
              <Spinner />
              <span className="font-mono truncate">
                {formatToolLabel(streamingTool, extractToolContext(streamingTool, streamingToolInput ?? ""), true)}
              </span>
            </div>
          ) : null}

          {/* Streaming text */}
          {streamingText ? (
            <div className="max-w-[80%] mt-2" aria-live="polite">
              <div className="bg-surface-3 rounded-lg px-4 py-3 text-sm border-l-2 border-l-accent/20">
                <MarkdownContent content={streamingText} />
                <span className="inline-block w-0.5 h-4 bg-accent ml-0.5 animate-pulse align-text-bottom" />
              </div>
            </div>
          ) : !streamingTool ? (
            <div className="flex items-center gap-2 text-xs text-content-3 py-1">
              <Spinner />
              <span>Thinking...</span>
            </div>
          ) : null}
        </div>
      )}

      <div ref={bottomRef} />

      {/* Jump-to-bottom FAB — visible when scrolled up */}
      {!autoScroll && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-3 left-full -ml-14 mr-2 z-10 flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full bg-surface-2 border border-edge-2 hover:border-accent/40 hover:bg-surface-3 shadow-lg text-xs text-content-2 hover:text-content-1 transition-all"
          aria-label={newMessageCount > 0 ? `${newMessageCount} new messages — jump to bottom` : "Jump to bottom"}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 12.5a.5.5 0 01-.354-.146l-4.5-4.5a.5.5 0 01.708-.708L8 11.293l4.146-4.147a.5.5 0 01.708.708l-4.5 4.5A.5.5 0 018 12.5z"/>
            <path d="M8 8.5a.5.5 0 01-.354-.146l-4.5-4.5a.5.5 0 11.708-.708L8 7.293l4.146-4.147a.5.5 0 11.708.708l-4.5 4.5A.5.5 0 018 8.5z"/>
          </svg>
          {newMessageCount > 0 && (
            <span className="text-accent font-medium">{newMessageCount} new</span>
          )}
        </button>
      )}
    </div>
  );
});

// ── Message grouping ────────────────────────────────────

type GroupedItem = Message | Message[];

function groupMessages(msgs: Message[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let toolBuffer: Message[] = [];

  const flush = () => {
    if (toolBuffer.length > 0) {
      result.push(toolBuffer);
      toolBuffer = [];
    }
  };

  for (const msg of msgs) {
    if (msg.role === "tool") {
      toolBuffer.push(msg);
    } else {
      flush();
      result.push(msg);
    }
  }
  flush();
  return result;
}

// ── Tool pairing ────────────────────────────────────────

interface ToolPair {
  id: string;
  name: string;
  input: string | null;
  output: string | null;
  context: string;
}

function pairTools(toolMsgs: Message[]): ToolPair[] {
  const pairs: ToolPair[] = [];
  const consumed = new Set<number>();
  let i = 0;
  while (i < toolMsgs.length) {
    if (consumed.has(i)) { i++; continue; }
    const msg = toolMsgs[i];
    // tool_use: has toolInput, no toolOutput
    if (msg.toolInput && !msg.toolOutput) {
      // For Agent tools, sub-agent internal tool events appear between the
      // Agent tool_use and its tool_result, so scan forward to find the match.
      let matchIdx = -1;
      for (let j = i + 1; j < toolMsgs.length; j++) {
        if (consumed.has(j)) continue;
        const candidate = toolMsgs[j];
        if (candidate.toolOutput && (!candidate.toolName || candidate.toolName === msg.toolName)) {
          matchIdx = j;
          break;
        }
        // Stop scanning if we hit another tool_use with the same name (next invocation)
        if (candidate.toolInput && !candidate.toolOutput && candidate.toolName === msg.toolName) {
          break;
        }
      }
      if (matchIdx !== -1) {
        consumed.add(matchIdx);
        pairs.push({
          id: msg.id,
          name: msg.toolName || "tool",
          input: msg.toolInput,
          output: toolMsgs[matchIdx].toolOutput,
          context: extractToolContext(msg.toolName || "tool", msg.toolInput),
        });
        i++;
        continue;
      }
    }
    // Single tool message (unpaired)
    pairs.push({
      id: msg.id,
      name: msg.toolName || "tool",
      input: msg.toolInput,
      output: msg.toolOutput,
      context: msg.toolInput ? extractToolContext(msg.toolName || "tool", msg.toolInput) : "",
    });
    i++;
  }
  return pairs;
}

// ── Components ──────────────────────────────────────────

function ToolGroup({ messages, answeredIds, onSubmitAnswers }: { messages: Message[]; answeredIds: Set<string>; onSubmitAnswers?: (text: string) => void }) {
  const pairs = useMemo(() => pairTools(messages), [messages]);
  const grouped = useMemo(() => groupConsecutiveTools(pairs), [pairs]);
  const [expandAll, setExpandAll] = useState(false);

  return (
    <div className="space-y-0.5">
      {grouped.length > 4 && (
        <button
          onClick={() => setExpandAll(!expandAll)}
          className="text-[10px] text-content-3 hover:text-content-2 mb-0.5"
        >
          {expandAll ? "Collapse all" : "Expand all"}
        </button>
      )}
      {grouped.map((group) =>
        group.length === 1 ? (
          <ToolLine key={group[0].id} pair={group[0]} isAnswered={answeredIds.has(group[0].id)} onSubmitAnswers={onSubmitAnswers} forceExpand={expandAll} />
        ) : (
          <ToolGroupRow key={group[0].id} pairs={group} forceExpand={expandAll} />
        ),
      )}
    </div>
  );
}

function ToolGroupRow({ pairs, forceExpand }: { pairs: ToolPair[]; forceExpand: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = expanded || forceExpand;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs py-0.5 text-content-3 hover:text-content-2 cursor-pointer"
      >
        <ToolIcon name={pairs[0].name} />
        <span className="font-mono">
          {TOOL_VERBS[pairs[0].name]?.[1] ?? pairs[0].name} {pairs.length} files
        </span>
        <span className={`text-[10px] text-content-3 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}>
          &#9656;
        </span>
      </button>
      {isOpen && (
        <div className="ml-5 space-y-0.5">
          {pairs.map((pair) => (
            <ToolLine key={pair.id} pair={pair} isAnswered={false} forceExpand={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function groupConsecutiveTools(pairs: ToolPair[]): ToolPair[][] {
  const groups: ToolPair[][] = [];
  let current: ToolPair[] = [];

  for (const pair of pairs) {
    // Ask-user tools always get their own group
    if (isAskUserTool(pair.name)) {
      if (current.length > 0) groups.push(current);
      groups.push([pair]);
      current = [];
      continue;
    }
    if (current.length > 0 && current[0].name === pair.name) {
      current.push(pair);
    } else {
      if (current.length > 0) groups.push(current);
      current = [pair];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function ToolLine({ pair, isAnswered, onSubmitAnswers, forceExpand = false }: { pair: ToolPair; isAnswered: boolean; onSubmitAnswers?: (text: string) => void; forceExpand?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = pair.input || pair.output;
  const isOpen = expanded || forceExpand;

  // Render ask-user tools as prominent question cards
  if (isAskUserTool(pair.name)) {
    return <QuestionCard pair={pair} isAnswered={isAnswered} onSubmitAnswers={onSubmitAnswers} />;
  }

  // Render Agent tool_use as a SubAgentCard
  if (pair.name === "Agent") {
    return <SubAgentCard input={pair.input} output={pair.output} isActive={!pair.output} />;
  }

  // Rich renderer dispatch — always show rich content for supported tools
  const richRenderer = getRichRenderer(pair);
  const hasRichRenderer = richRenderer !== null;

  // For tools with rich renderers, show inline by default (no expand needed)
  // For tools without, show expandable raw JSON
  const toolBadge = getToolBadge(pair);

  return (
    <div>
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`flex items-center gap-2 text-xs py-0.5 ${
          hasDetails ? "text-content-3 hover:text-content-2 cursor-pointer" : "text-content-3 cursor-default"
        }`}
        aria-expanded={isOpen}
      >
        <ToolIcon name={pair.name} />
        <span className="font-mono truncate">
          {formatToolLabel(pair.name, pair.context, false)}
        </span>
        {toolBadge && (
          <span className="text-[10px] text-content-3 shrink-0">{toolBadge}</span>
        )}
        {hasDetails && (
          <span className={`text-[10px] text-content-3 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}>
            &#9656;
          </span>
        )}
      </button>
      {isOpen && (
        hasRichRenderer ? richRenderer : (
          <div className="ml-5 mt-0.5 mb-1 space-y-1.5">
            {pair.input && (
              <pre className="text-xs bg-surface-2 rounded-lg p-3 overflow-x-auto text-content-2 border border-edge-1">
                {formatJson(pair.input)}
              </pre>
            )}
            {pair.output && (
              <pre className="text-xs bg-surface-2 rounded-lg p-3 overflow-x-auto text-content-1 max-h-64 overflow-y-auto border border-edge-1">
                {truncate(pair.output, 2000)}
              </pre>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** Dispatch to the appropriate rich renderer based on tool name */
function getRichRenderer(pair: ToolPair): React.ReactNode | null {
  switch (pair.name) {
    case "Edit":
      return <DiffRenderer input={pair.input} />;
    case "Bash":
      return <BashRenderer input={pair.input} output={pair.output} />;
    case "Read":
      return <ReadRenderer input={pair.input} output={pair.output} />;
    case "Grep":
    case "Glob":
      return <SearchRenderer input={pair.input} output={pair.output} />;
    case "TodoWrite":
      return <TodoRenderer input={pair.input} />;
    default:
      return null;
  }
}

/** Get an optional badge for the tool line (e.g., match count for search) */
function getToolBadge(pair: ToolPair): string | null {
  switch (pair.name) {
    case "Grep":
    case "Glob":
      return pair.output ? searchSummary(pair.input, pair.output) : null;
    default:
      return null;
  }
}

function ToolIcon({ name }: { name: string }) {
  const cls = "w-3 h-3 shrink-0 text-accent/50";
  switch (name) {
    case "Read":
      return <svg className={cls} viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1zm1 3v1h8V4H4zm0 3v1h8V7H4zm0 3v1h5v-1H4z"/></svg>;
    case "Edit":
    case "Write":
      return <svg className={cls} viewBox="0 0 16 16" fill="currentColor"><path d="M11.7 1.3a1 1 0 011.4 0l1.6 1.6a1 1 0 010 1.4l-9 9-3.4.9a.5.5 0 01-.6-.6l.9-3.4 9-9z"/></svg>;
    case "Bash":
      return <svg className={cls} viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 2l3 2-3 2v1l4-3-4-3v1zm4 5h3v1H8v-1z"/></svg>;
    case "Grep":
    case "Glob":
    case "WebSearch":
      return <svg className={cls} viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zm-1.1 3.8l3.3 3.3-1.4 1.4-3.3-3.3a5.5 5.5 0 111.4-1.4z"/></svg>;
    case "TodoWrite":
      return <svg className={cls} viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h10a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1zm1 3v1h1.5l.5-.5.5.5H8V4H4zm0 3v1h1.5l.5-.5.5.5H8V7H4zm0 3v1h1.5l.5-.5.5.5H8v-1H4zm5-6v1h3V4H9zm0 3v1h3V7H9zm0 3v1h3v-1H9z"/></svg>;
    default:
      return <span className="w-3 h-3 shrink-0 text-accent/50 text-[10px] leading-3 text-center">&#10003;</span>;
  }
}

function QuestionCard({ pair, isAnswered, onSubmitAnswers }: { pair: ToolPair; isAnswered: boolean; onSubmitAnswers?: (text: string) => void }) {
  const questions = parseQuestions(pair.input);
  const [selections, setSelections] = useState<Map<number, string[]>>(new Map());
  const [customInputs, setCustomInputs] = useState<Map<number, string>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  if (questions.length === 0) {
    return (
      <div className="my-2 max-w-[80%] rounded-lg border border-sky-500/20 bg-sky-950/20 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-sky-400/80 font-medium">
          <span>?</span>
          <span>Agent is asking</span>
        </div>
        <div className="text-sm text-content-3 mt-1">(could not parse question)</div>
      </div>
    );
  }

  const handleToggleOption = (qIndex: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = prev.get(qIndex) ?? [];
      if (multiSelect) {
        next.set(qIndex, current.includes(label) ? current.filter((l) => l !== label) : [...current, label]);
      } else {
        next.set(qIndex, current.includes(label) ? [] : [label]);
      }
      return next;
    });
    // Clear custom text when selecting an option
    setCustomInputs((prev) => {
      if (!prev.has(qIndex)) return prev;
      const next = new Map(prev);
      next.delete(qIndex);
      return next;
    });
  };

  const handleCustomInput = (qIndex: number, text: string) => {
    setCustomInputs((prev) => {
      const next = new Map(prev);
      if (text) next.set(qIndex, text);
      else next.delete(qIndex);
      return next;
    });
    // Clear option selection when typing custom text
    if (text) {
      setSelections((prev) => {
        if (!prev.has(qIndex)) return prev;
        const next = new Map(prev);
        next.delete(qIndex);
        return next;
      });
    }
  };

  const hasAnyAnswer = questions.some((_, i) => {
    const selected = selections.get(i);
    const custom = customInputs.get(i);
    return (selected && selected.length > 0) || (custom && custom.trim());
  });

  const handleSubmit = () => {
    if (!hasAnyAnswer || submitting) return;
    setSubmitting(true);
    const text = formatAnswers(questions, selections, customInputs);
    onSubmitAnswers?.(text);
  };

  const disabled = isAnswered || submitting;

  return (
    <div className={`my-2 max-w-[80%] space-y-3 ${disabled ? "opacity-60" : ""}`}>
      {questions.map((q, i) => {
        const selected = selections.get(i) ?? [];
        const customText = customInputs.get(i) ?? "";

        return (
          <div key={i} className="rounded-lg border border-sky-500/20 bg-sky-950/20 px-4 py-3">
            {q.header && (
              <div className="text-xs text-sky-400/80 font-medium mb-1">{q.header}</div>
            )}
            <div className="text-sm text-content-1 mb-2">
              <MarkdownContent content={q.question} />
            </div>
            {q.multiSelect && (
              <div className="text-xs text-sky-400/60 mb-1.5">(select all that apply)</div>
            )}
            {q.options && q.options.length > 0 && (
              <div className="space-y-1.5">
                {q.options.map((opt, j) => {
                  const isSelected = selected.includes(opt.label);
                  return (
                    <button
                      key={j}
                      disabled={disabled}
                      onClick={() => handleToggleOption(i, opt.label, !!q.multiSelect)}
                      className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
                        isSelected
                          ? "border-sky-500/40 bg-sky-950/40"
                          : "bg-surface-2/60 border-edge-1 hover:border-sky-500/30 hover:bg-surface-3"
                      } ${disabled ? "pointer-events-none" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        {isSelected && <span className="text-sky-400 text-xs shrink-0">&#10003;</span>}
                        <div className={`text-sm ${isSelected ? "text-sky-300" : "text-content-1"}`}>{opt.label}</div>
                      </div>
                      {opt.description && (
                        <div className={`text-xs text-content-3 mt-0.5 ${isSelected ? "ml-5" : ""}`}>{opt.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Custom text input — always shown */}
            {!disabled && (
              <input
                type="text"
                value={customText}
                onChange={(e) => handleCustomInput(i, e.target.value)}
                placeholder={q.options?.length ? "Or type a custom response..." : "Type your answer..."}
                className="w-full mt-2 bg-surface-2 border border-edge-2 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent placeholder:text-content-3"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasAnyAnswer) handleSubmit();
                }}
              />
            )}
          </div>
        );
      })}
      {/* Submit button */}
      {!disabled && (
        <button
          onClick={handleSubmit}
          disabled={!hasAnyAnswer || submitting}
          className="px-5 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
        >
          {submitting ? "Submitting..." : "Submit answers"}
        </button>
      )}
    </div>
  );
}

function Spinner({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={`shrink-0 text-accent animate-spin ${className}`} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" strokeLinecap="round" />
    </svg>
  );
}

function ThreadStatusBadge({ status, errorMessage }: { status: string; errorMessage?: string | null }) {
  const styles: Record<string, string> = {
    running: "bg-emerald-900/30 text-emerald-400 border-emerald-500/20",
    pending: "bg-amber-900/30 text-amber-400 border-amber-500/20",
    waiting: "bg-amber-900/30 text-amber-400 border-amber-500/20",
    paused: "bg-surface-3 text-content-3 border-edge-2",
    done: "bg-accent/10 text-accent border-accent/20",
    error: "bg-red-900/30 text-red-400 border-red-500/20",
  };
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${styles[status] ?? "bg-surface-3 text-content-3 border-edge-2"}`}
      title={status === "error" && errorMessage ? errorMessage : undefined}
    >
      {status}
    </span>
  );
}

function MessageBubble({ message }: { message: Message }) {
  // Skip empty or artifact-only messages (e.g. '""' from JSON.stringify(""))
  const trimmed = message.content.trim();
  const attachments = (message.metadata?.attachments as Attachment[] | undefined) ?? [];
  const hasAttachments = attachments.length > 0;

  if (!trimmed && !hasAttachments) return null;
  // Skip if only artifact content like '""'
  if (trimmed === '""' && !hasAttachments) return null;

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-accent-dim/80 border-r-2 border-r-accent/40 rounded-lg px-4 py-3 text-sm text-content-1">
          {trimmed && <div className="whitespace-pre-wrap">{message.content}</div>}
          {hasAttachments && <MessageAttachments attachments={attachments} />}
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="max-w-[80%]">
      <div className="bg-surface-3 rounded-lg px-4 py-3 text-sm border-l-2 border-l-accent/20">
        <MarkdownContent content={message.content} />
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────

const TOOL_VERBS: Record<string, [string, string]> = {
  Read: ["Reading", "Read"],
  Edit: ["Editing", "Edited"],
  Write: ["Writing", "Wrote"],
  Bash: ["Running", "Ran"],
  Grep: ["Searching", "Searched"],
  Glob: ["Finding files", "Found files"],
  Agent: ["Spawning agent", "Agent"],
  WebSearch: ["Searching web", "Searched web"],
  WebFetch: ["Fetching", "Fetched"],
  NotebookEdit: ["Editing notebook", "Edited notebook"],
  AskUserQuestion: ["Asking", "Asked"],
  AskUserTool: ["Asking", "Asked"],
};

function formatToolLabel(name: string, context: string, active: boolean): string {
  const [activeVerb, doneVerb] = TOOL_VERBS[name] ?? [name, name];
  const verb = active ? activeVerb : doneVerb;
  const ctx = shortenPath(context);
  return ctx ? `${verb} ${ctx}` : verb;
}

function shortenPath(p: string): string {
  if (!p || !p.includes("/")) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return parts.slice(-3).join("/");
}

function extractToolContext(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input);
    if (parsed.file_path || parsed.filePath) return parsed.file_path || parsed.filePath;
    if (parsed.path) return parsed.path;
    if (parsed.command) return parsed.command.slice(0, 80);
    if (parsed.pattern) return parsed.pattern;
    if (parsed.query) return parsed.query.slice(0, 80);
    if (parsed.url) return parsed.url;
    if (Array.isArray(parsed.todos)) {
      const active = parsed.todos.find((t: Record<string, unknown>) => t.status === "in_progress");
      if (active) return (active.activeForm as string) || (active.content as string) || "";
      const done = parsed.todos.filter((t: Record<string, unknown>) => t.status === "completed").length;
      return `${done}/${parsed.todos.length} tasks`;
    }
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
