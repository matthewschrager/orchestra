import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SlashCommand } from "shared";
import { canNavigateInputHistory, getNextInputHistoryState } from "../lib/inputHistory";

/** Find the slash token at the given cursor position within text. */
export function findSlashToken(value: string, cursorPos: number): { token: string; start: number; end: number } | null {
  const before = value.slice(0, cursorPos);
  const match = before.match(/(^|[\s])(\/[\w-]*)$/);
  if (!match) return null;
  const token = match[2];
  const start = before.length - token.length;
  // Extend end past cursor to cover the full word (handles cursor mid-token)
  const afterCursor = value.slice(cursorPos);
  const trailingMatch = afterCursor.match(/^[\w-]*/);
  const end = cursorPos + (trailingMatch ? trailingMatch[0].length : 0);
  const fullToken = value.slice(start, end);
  return { token: fullToken, start, end };
}

/** Find the @file token at the given cursor position within text. */
export function findAtToken(value: string, cursorPos: number): { token: string; query: string; start: number; end: number } | null {
  const before = value.slice(0, cursorPos);
  const match = before.match(/(^|[\s])(@[^\s]*)$/);
  if (!match) return null;
  const token = match[2]; // includes leading "@"
  const start = before.length - token.length;
  // Extend end past cursor to cover the full token (non-whitespace)
  const afterCursor = value.slice(cursorPos);
  const trailingMatch = afterCursor.match(/^[^\s]*/);
  const end = cursorPos + (trailingMatch ? trailingMatch[0].length : 0);
  const fullToken = value.slice(start, end);
  const query = fullToken.slice(1); // strip leading "@"
  return { token: fullToken, query, start, end };
}

/** Build highlighted segments for the overlay — marks recognized/partial command tokens. */
export function buildHighlightSegments(value: string, commands: SlashCommand[]): { text: string; highlight: boolean }[] {
  const segments: { text: string; highlight: boolean }[] = [];
  const regex = /\/[\w-]+/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(value)) !== null) {
    const token = match[0];
    const isKnown = commands.some((c) => c.name === token);
    const isPartial = commands.some((c) => c.name.startsWith(token) && c.name !== token);
    if (isKnown || isPartial) {
      if (match.index > lastIndex) {
        segments.push({ text: value.slice(lastIndex, match.index), highlight: false });
      }
      segments.push({ text: token, highlight: true });
      lastIndex = match.index + token.length;
    }
  }
  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex), highlight: false });
  }
  return segments;
}

/** Compute the new value and cursor position after selecting a command. */
export function replaceSlashToken(
  value: string,
  slashToken: { start: number; end: number },
  commandName: string,
): { newValue: string; newCursorPos: number } {
  const before = value.slice(0, slashToken.start);
  const after = value.slice(slashToken.end);
  const newValue = before + commandName + " " + after;
  const newCursorPos = slashToken.start + commandName.length + 1;
  return { newValue, newCursorPos };
}

/** Compute the new value and cursor position after selecting a file. */
export function replaceAtToken(
  value: string,
  atToken: { start: number; end: number },
  filePath: string,
): { newValue: string; newCursorPos: number } {
  const before = value.slice(0, atToken.start);
  const after = value.slice(atToken.end);
  const newValue = before + filePath + " " + after;
  const newCursorPos = atToken.start + filePath.length + 1;
  return { newValue, newCursorPos };
}

/** Measure the pixel X-offset of a caret position within a textarea. */
function getCaretXOffset(textarea: HTMLTextAreaElement, position: number): number {
  const mirror = document.createElement("div");
  const style = getComputedStyle(textarea);

  mirror.style.position = "absolute";
  mirror.style.top = "-9999px";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.font = style.font;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.padding = style.padding;
  mirror.style.border = style.border;
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";

  const textBefore = textarea.value.substring(0, position);
  mirror.textContent = textBefore;

  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // zero-width space
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const left = marker.offsetLeft;
  document.body.removeChild(mirror);

  return left;
}

type DropdownMode = "slash" | "file" | null;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (interrupt?: boolean) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  commands: SlashCommand[];
  history?: string[];
  placeholder?: string;
  rows?: number;
  fileSuggestions?: string[];
  fileLoading?: boolean;
  onFileQueryChange?: (query: string | null) => void;
}

export function SlashCommandInput({
  value,
  onChange,
  onSubmit,
  onPaste,
  commands,
  history = [],
  placeholder,
  rows = 2,
  fileSuggestions = [],
  fileLoading = false,
  onFileQueryChange,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // Find tokens at the cursor position
  const slashToken = useMemo(() => findSlashToken(value, cursorPos), [value, cursorPos]);
  const atToken = useMemo(() => findAtToken(value, cursorPos), [value, cursorPos]);

  // Exact match against a known command
  const isRecognizedCommand =
    slashToken !== null &&
    commands.some((c) => c.name === slashToken.token);

  // Autocomplete candidates for slash commands
  const filteredCommands = useMemo(() => {
    if (!slashToken) return [];
    return commands.filter((c) => c.name.startsWith(slashToken.token));
  }, [slashToken, commands]);

  // Determine which dropdown to show (only one at a time)
  const showSlash = !dismissed && slashToken !== null && filteredCommands.length > 0 && !isRecognizedCommand;
  const showFiles = !dismissed && !showSlash && atToken !== null && atToken.query.length >= 1 && (fileSuggestions.length > 0 || fileLoading);

  const dropdownMode: DropdownMode = showSlash ? "slash" : showFiles ? "file" : null;

  // Notify parent of @ query changes (compare against previous to avoid over-firing)
  const prevAtQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const query = atToken?.query ?? null;
    // Only fire when the actual query string changes
    if (query !== prevAtQueryRef.current) {
      prevAtQueryRef.current = query;
      onFileQueryChange?.(query);
    }
  }, [atToken?.query, onFileQueryChange]);

  // Build highlighted segments for the overlay
  const highlightSegments = useMemo(() => buildHighlightSegments(value, commands), [value, commands]);
  const hasHighlights = highlightSegments.some((s) => s.highlight);

  // Reset selectedIndex when dropdown mode changes
  const prevDropdownModeRef = useRef<DropdownMode>(null);
  useEffect(() => {
    if (dropdownMode !== prevDropdownModeRef.current) {
      prevDropdownModeRef.current = dropdownMode;
      setSelectedIndex(0);
    }
  }, [dropdownMode]);

  // Clamp selectedIndex when active list shrinks
  useEffect(() => {
    const listLen = dropdownMode === "slash" ? filteredCommands.length : fileSuggestions.length;
    if (listLen > 0 && selectedIndex >= listLen) {
      setSelectedIndex(listLen - 1);
    }
  }, [filteredCommands.length, fileSuggestions.length, selectedIndex, dropdownMode]);

  useEffect(() => {
    if (historyIndex === null) return;
    if (history[historyIndex] !== value) {
      setHistoryIndex(null);
    }
  }, [history, historyIndex, value]);

  // Scroll selected item into view within the dropdown
  useEffect(() => {
    if (!dropdownMode) return;
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    const item = dropdown.querySelector("[data-selected=true]") as HTMLElement | null;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, dropdownMode]);

  // Track pixel X-offset of the slash token for cursor-positioned dropdown
  const [caretLeft, setCaretLeft] = useState<number>(0);
  useEffect(() => {
    if (dropdownMode === "slash" && slashToken && textareaRef.current) {
      setCaretLeft(getCaretXOffset(textareaRef.current, slashToken.start));
    }
  }, [dropdownMode, slashToken?.start]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!slashToken) return;
      const { newValue, newCursorPos } = replaceSlashToken(value, slashToken, cmd.name);
      onChange(newValue);
      setCursorPos(newCursorPos);
      setSelectedIndex(0);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    },
    [onChange, value, slashToken],
  );

  const selectFile = useCallback(
    (filePath: string) => {
      if (!atToken) return;
      const { newValue, newCursorPos } = replaceAtToken(value, atToken, filePath);
      onChange(newValue);
      setCursorPos(newCursorPos);
      setSelectedIndex(0);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    },
    [onChange, value, atToken],
  );

  const applyHistoryValue = useCallback(
    (nextValue: string) => {
      const nextCursorPos = nextValue.length;
      onChange(nextValue);
      setCursorPos(nextCursorPos);
      setSelectedIndex(0);
      setDismissed(false);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(nextCursorPos, nextCursorPos);
        }
      }, 0);
    },
    [onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash command dropdown keyboard handling
    if (dropdownMode === "slash") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) =>
          Math.min(i + 1, filteredCommands.length - 1),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !e.shiftKey)
      ) {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          selectCommand(filteredCommands[selectedIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    // File dropdown keyboard handling
    if (dropdownMode === "file") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) =>
          Math.min(i + 1, fileSuggestions.length - 1),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !e.shiftKey)
      ) {
        e.preventDefault();
        if (fileSuggestions[selectedIndex]) {
          selectFile(fileSuggestions[selectedIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    const hasHistoryModifiers = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
    const ta = textareaRef.current;
    const selectionStart = ta?.selectionStart ?? cursorPos;
    const selectionEnd = ta?.selectionEnd ?? cursorPos;
    const canNavigateHistory = !hasHistoryModifiers && canNavigateInputHistory(value, selectionStart, selectionEnd, historyIndex);

    if (e.key === "ArrowUp" && canNavigateHistory) {
      const nextHistory = getNextInputHistoryState(history, historyIndex, "older");
      if (nextHistory) {
        e.preventDefault();
        setHistoryIndex(nextHistory.index);
        applyHistoryValue(nextHistory.value);
        return;
      }
    }

    if (e.key === "ArrowDown" && historyIndex !== null && canNavigateHistory) {
      const nextHistory = getNextInputHistoryState(history, historyIndex, "newer");
      if (nextHistory) {
        e.preventDefault();
        setHistoryIndex(nextHistory.index);
        applyHistoryValue(nextHistory.value);
        return;
      }
    }

    // Enter sends, Shift+Enter inserts newline (skip during IME composition)
    // Cmd/Ctrl+Enter sends with interrupt (steers the agent mid-turn)
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const interrupt = e.metaKey || e.ctrlKey;
      onSubmit(interrupt);
    }
  };

  const updateCursor = () => {
    const ta = textareaRef.current;
    if (ta) setCursorPos(ta.selectionStart);
  };

  const handleScroll = () => {
    if (backdropRef.current && textareaRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div className="relative flex-1">
      {/* Slash command autocomplete dropdown */}
      {dropdownMode === "slash" && (
        <div ref={dropdownRef} role="listbox" className="absolute bottom-full mb-1 w-72 max-h-64 overflow-y-auto bg-surface-3 border border-edge-2 rounded-lg shadow-xl shadow-black/40 z-10"
          style={{ left: `${Math.max(0, Math.min(caretLeft, (textareaRef.current?.offsetWidth ?? 288) - 288))}px` }}>
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.name}
              role="option"
              aria-selected={i === selectedIndex}
              data-selected={i === selectedIndex}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-3 ${
                i === selectedIndex
                  ? "bg-accent/15 text-content-1"
                  : "text-content-2 hover:bg-surface-4"
              }`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus
                selectCommand(cmd);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="font-mono text-accent shrink-0">
                {cmd.name}
              </span>
              <span className="text-xs text-content-3 truncate">
                {cmd.description}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* File autocomplete dropdown */}
      {dropdownMode === "file" && (
        <div ref={dropdownRef} role="listbox" aria-label="File suggestions" className="absolute bottom-full left-0 mb-1 w-full max-w-96 max-h-64 overflow-y-auto bg-surface-3 border border-edge-2 rounded-lg shadow-xl shadow-black/40 z-10">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-content-3 border-b border-edge-2">
            Files
          </div>
          {fileLoading && fileSuggestions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-content-3 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-content-3 border-t-transparent rounded-full animate-spin" />
              Loading files...
            </div>
          ) : (
            fileSuggestions.map((file, i) => {
              const lastSlash = file.lastIndexOf("/");
              const dir = lastSlash >= 0 ? file.slice(0, lastSlash + 1) : "";
              const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
              return (
                <button
                  key={file}
                  role="option"
                  aria-selected={i === selectedIndex}
                  data-selected={i === selectedIndex}
                  className={`w-full text-left px-3 py-1.5 text-sm font-mono truncate ${
                    i === selectedIndex
                      ? "bg-accent/15 text-content-1"
                      : "text-content-2 hover:bg-surface-4"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectFile(file);
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <span className="text-content-3 text-xs">{dir}</span>
                  <span className="text-accent">{name}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Overlay container */}
      <div className="relative">
        {/* Backdrop: styled text visible through the transparent textarea */}
        {hasHighlights && (
          <div
            ref={backdropRef}
            className="absolute inset-0 px-3 py-2 text-sm whitespace-pre-wrap break-words overflow-hidden pointer-events-none border border-transparent rounded-lg bg-surface-2"
            aria-hidden="true"
          >
            {highlightSegments.map((seg, i) =>
              seg.highlight ? (
                <span key={i} className="text-accent underline decoration-accent/50 underline-offset-2">
                  {seg.text}
                </span>
              ) : (
                <span key={i} className="text-content-1">{seg.text}</span>
              ),
            )}
          </div>
        )}

        {/* Textarea — text goes transparent when overlay is active */}
        <textarea
          ref={textareaRef}
          value={value}
          aria-expanded={dropdownMode !== null}
          onChange={(e) => {
            onChange(e.target.value);
            setHistoryIndex(null);
            setCursorPos(e.target.selectionStart);
            setSelectedIndex(0);
            setDismissed(false);
          }}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={rows}
          className={[
            "block w-full border border-edge-2 rounded-lg px-3 py-2 text-sm",
            "relative resize-none focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
            "placeholder:text-content-3",
            hasHighlights
              ? "bg-transparent text-transparent selection:bg-accent/20"
              : "bg-surface-2",
          ].join(" ")}
          style={hasHighlights ? { caretColor: "var(--color-content-1)" } : undefined}
          onKeyDown={handleKeyDown}
          onSelect={updateCursor}
          onScroll={handleScroll}
        />
      </div>
    </div>
  );
}
