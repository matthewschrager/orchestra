import { useCallback, useEffect, useRef, useState } from "react";

interface EditableTitleProps {
  title: string;
  onSave: (newTitle: string) => void;
  className?: string;
}

export function EditableTitle({ title, onSave, className = "" }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft with prop when not editing (e.g., AI title arrives via WS)
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  // Auto-focus input on edit start
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const save = useCallback(() => {
    if (!editing) return; // Guard against double-fire from blur after Enter/Escape
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      onSave(trimmed);
    }
    setEditing(false);
  }, [editing, draft, title, onSave]);

  const cancel = useCallback(() => {
    setDraft(title);
    setEditing(false);
  }, [title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [save, cancel],
  );

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={save}
        onKeyDown={handleKeyDown}
        className={`bg-transparent border-b border-accent outline-none ${className}`}
        aria-label="Edit thread title"
        maxLength={80}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={`text-left truncate group/title cursor-text ${className}`}
      title="Click to edit title"
      aria-label="Edit thread title"
    >
      <span className="group-hover/title:text-accent transition-colors">{title}</span>
      <svg
        className="inline-block ml-1.5 w-3 h-3 text-content-3 opacity-0 group-hover/title:opacity-100 transition-opacity"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        <path d="m15 5 4 4" />
      </svg>
    </button>
  );
}
