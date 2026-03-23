import { useState } from "react";
import type { AttentionItem, AttentionResolution } from "shared";

interface AttentionInboxProps {
  items: AttentionItem[];
  onResolve: (attentionId: string, resolution: AttentionResolution) => void;
  onNavigateToThread: (threadId: string) => void;
}

export function AttentionInbox({ items, onResolve, onNavigateToThread }: AttentionInboxProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="text-4xl mb-3 opacity-50">✓</div>
        <div className="text-content-2 font-medium">All clear!</div>
        <div className="text-content-3 text-sm mt-1">Your agents are running smoothly.</div>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3 overflow-y-auto">
      <div className="text-content-3 text-xs font-medium uppercase tracking-wider px-1">
        {items.length} {items.length === 1 ? "item" : "items"} need attention
      </div>
      {items.map((item) => (
        <AttentionCard
          key={item.id}
          item={item}
          onResolve={onResolve}
          onNavigateToThread={onNavigateToThread}
        />
      ))}
    </div>
  );
}

function AttentionCard({ item, onResolve, onNavigateToThread }: {
  item: AttentionItem;
  onResolve: (attentionId: string, resolution: AttentionResolution) => void;
  onNavigateToThread: (threadId: string) => void;
}) {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [customText, setCustomText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSelectOption = (index: number) => {
    setSelectedOption(index);
    setCustomText("");
  };

  const handleSubmit = () => {
    if (submitting) return;
    setSubmitting(true);

    let resolution: AttentionResolution;
    if (item.kind === "permission") {
      // Should not reach here — permissions use Allow/Deny buttons
      return;
    }

    if (selectedOption !== null) {
      resolution = { type: "user", optionIndex: selectedOption };
    } else if (customText.trim()) {
      resolution = { type: "user", text: customText.trim() };
    } else {
      return;
    }

    onResolve(item.id, resolution);
  };

  const handleAllow = () => {
    if (submitting) return;
    setSubmitting(true);
    onResolve(item.id, { type: "user", action: "allow" });
  };

  const handleDeny = () => {
    if (submitting) return;
    setSubmitting(true);
    onResolve(item.id, { type: "user", action: "deny" });
  };

  const accentClass = item.kind === "permission"
    ? "border-l-red-500"
    : "border-l-amber-500";

  const timeAgo = formatTimeAgo(item.createdAt);

  return (
    <div className={`bg-surface-2 border border-edge-1 border-l-4 ${accentClass} rounded-lg p-4`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-3">
          {item.kind === "ask_user" ? "Question" : item.kind === "permission" ? "Permission Required" : "Confirmation"}
        </span>
        <span className="text-[10px] text-content-3">{timeAgo}</span>
      </div>

      {/* Thread link */}
      <button
        onClick={() => onNavigateToThread(item.threadId)}
        className="text-[11px] text-accent hover:underline mb-2 block"
      >
        View in thread →
      </button>

      {/* Prompt */}
      <div className={`text-sm text-content-1 mb-3 ${item.kind === "permission" ? "font-mono text-xs" : ""}`}>
        {item.prompt}
      </div>

      {/* Actions based on kind */}
      {item.kind === "permission" ? (
        <div className="flex gap-2">
          <button
            onClick={handleAllow}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium min-h-[44px] disabled:opacity-50"
          >
            {submitting ? "Sending..." : "Allow"}
          </button>
          <button
            onClick={handleDeny}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-lg bg-surface-3 hover:bg-surface-2 text-content-2 text-sm font-medium border border-edge-1 min-h-[44px] disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      ) : (
        <>
          {/* Options */}
          {item.options && item.options.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {item.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleSelectOption(i)}
                  disabled={submitting}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm min-h-[44px] border transition-colors ${
                    selectedOption === i
                      ? "border-accent bg-accent/10 text-content-1"
                      : "border-edge-1 bg-surface-1 text-content-2 hover:border-edge-2"
                  } disabled:opacity-50`}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {/* Custom text input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => {
                setCustomText(e.target.value);
                setSelectedOption(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (selectedOption !== null || customText.trim())) {
                  handleSubmit();
                }
              }}
              placeholder="Or type a response..."
              disabled={submitting}
              className="flex-1 px-3 py-2 rounded-lg bg-surface-1 border border-edge-1 text-sm text-content-1 placeholder:text-content-3 focus:ring-2 focus:ring-accent focus:border-transparent min-h-[44px] disabled:opacity-50"
            />
            <button
              onClick={handleSubmit}
              disabled={submitting || (selectedOption === null && !customText.trim())}
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/80 text-white text-sm font-medium min-h-[44px] disabled:opacity-50"
            >
              {submitting ? "..." : "Send"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}
