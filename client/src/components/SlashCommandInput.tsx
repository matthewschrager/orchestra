import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SlashCommand } from "shared";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  commands: SlashCommand[];
  placeholder?: string;
  rows?: number;
}

export function SlashCommandInput({
  value,
  onChange,
  onSubmit,
  commands,
  placeholder,
  rows = 2,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Parse slash command from start of input
  const parsedCommand = useMemo(() => {
    const match = value.match(/^(\/[\w-]*)([\s\S]*)/);
    if (!match) return null;
    return { token: match[1], rest: match[2] };
  }, [value]);

  // Still typing the command name (no space after it yet)?
  const isTypingCommand =
    parsedCommand !== null && parsedCommand.rest === "";

  // Exact match against a known command
  const isRecognizedCommand =
    parsedCommand !== null &&
    commands.some((c) => c.name === parsedCommand.token);

  // Autocomplete candidates
  const filteredCommands = useMemo(() => {
    if (!isTypingCommand || !parsedCommand) return [];
    return commands.filter((c) => c.name.startsWith(parsedCommand.token));
  }, [isTypingCommand, parsedCommand, commands]);

  // Show dropdown while typing prefix, hide once exact-matched
  const showAutocomplete =
    isTypingCommand && filteredCommands.length > 0 && !isRecognizedCommand;

  // Highlight command token when it's recognized OR partially matches
  const shouldHighlight =
    parsedCommand !== null &&
    (isRecognizedCommand ||
      (isTypingCommand && filteredCommands.length > 0));

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
      onChange(cmd.name + " ");
      setSelectedIndex(0);
      textareaRef.current?.focus();
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
        onChange("");
        return;
      }
    }

    // Enter sends, Shift+Enter inserts newline (skip during IME composition)
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
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
        {shouldHighlight && parsedCommand && (
          <div
            ref={backdropRef}
            className="absolute inset-0 px-3 py-2 text-sm whitespace-pre-wrap break-words overflow-hidden pointer-events-none border border-transparent rounded-lg"
            aria-hidden="true"
          >
            <span className="text-accent underline decoration-accent/50 underline-offset-2">
              {parsedCommand.token}
            </span>
            <span className="text-content-1">{parsedCommand.rest}</span>
          </div>
        )}

        {/* Textarea — text goes transparent when overlay is active */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setSelectedIndex(0);
          }}
          placeholder={placeholder}
          rows={rows}
          className={[
            "w-full bg-surface-2 border border-edge-2 rounded-lg px-3 py-2 text-sm",
            "resize-none focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent",
            "placeholder:text-content-3",
            shouldHighlight
              ? "text-transparent selection:bg-accent/20"
              : "",
          ].join(" ")}
          style={shouldHighlight ? { caretColor: "var(--color-content-1)" } : undefined}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
        />
      </div>
    </div>
  );
}
