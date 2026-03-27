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

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  commands: SlashCommand[];
  history?: string[];
  placeholder?: string;
  rows?: number;
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
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // Find the slash token at the cursor position
  const slashToken = useMemo(() => findSlashToken(value, cursorPos), [value, cursorPos]);

  // Exact match against a known command
  const isRecognizedCommand =
    slashToken !== null &&
    commands.some((c) => c.name === slashToken.token);

  // Autocomplete candidates
  const filteredCommands = useMemo(() => {
    if (!slashToken) return [];
    return commands.filter((c) => c.name.startsWith(slashToken.token));
  }, [slashToken, commands]);

  // Show dropdown while typing prefix, hide once exact-matched or dismissed
  const showAutocomplete =
    !dismissed && slashToken !== null && filteredCommands.length > 0 && !isRecognizedCommand;

  // Build highlighted segments for the overlay
  const highlightSegments = useMemo(() => buildHighlightSegments(value, commands), [value, commands]);

  const hasHighlights = highlightSegments.some((s) => s.highlight);

  // Clamp selectedIndex when filtered list shrinks
  useEffect(() => {
    if (filteredCommands.length > 0 && selectedIndex >= filteredCommands.length) {
      setSelectedIndex(filteredCommands.length - 1);
    }
  }, [filteredCommands.length, selectedIndex]);

  useEffect(() => {
    if (historyIndex === null) return;
    if (history[historyIndex] !== value) {
      setHistoryIndex(null);
    }
  }, [history, historyIndex, value]);

  // Scroll selected item into view within the dropdown
  useEffect(() => {
    if (!showAutocomplete) return;
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    const item = dropdown.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, showAutocomplete]);

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
    if (showAutocomplete) {
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
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
      {/* Autocomplete dropdown */}
      {showAutocomplete && (
        <div ref={dropdownRef} className="absolute bottom-full left-0 mb-1 w-72 max-h-64 overflow-y-auto bg-surface-3 border border-edge-2 rounded-lg shadow-xl shadow-black/40 z-10">
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.name}
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
            "w-full border border-edge-2 rounded-lg px-3 py-2 text-sm",
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
