import type { MouseEvent } from "react";

interface MergeAllPrsButtonProps {
  count: number;
  busy?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  stopPropagation?: boolean;
  onClick: () => void;
}

function labelForCount(count: number): string {
  return `${count} outstanding PR${count === 1 ? "" : "s"}`;
}

const SIDEBAR_TOOLTIP = "Merge all outstanding PRs";

export function MergeAllPrsButton({
  count,
  busy = false,
  compact = false,
  iconOnly = false,
  stopPropagation = false,
  onClick,
}: MergeAllPrsButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
    onClick();
  };

  if (iconOnly) {
    return (
      <button
        onClick={handleClick}
        disabled={busy}
        title={SIDEBAR_TOOLTIP}
        aria-label={SIDEBAR_TOOLTIP}
        className={[
          "relative inline-flex h-7 w-7 items-center justify-center rounded-lg",
          "bg-surface-3/60 text-content-2 hover:bg-surface-4 hover:text-content-1",
          "disabled:cursor-wait disabled:opacity-50",
        ].join(" ")}
      >
        {busy ? (
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="28 10"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <path d="M3 3.5h10M3 8h10M3 12.5h6" />
            <path d="M10.5 11.5 12 13l2.5-3" />
          </svg>
        )}
        <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-accent/80 px-[3px] text-[9px] font-semibold leading-[14px] text-base tabular-nums">
          {count}
        </span>
      </button>
    );
  }

  const compactClasses = compact
    ? "px-3 py-2 text-xs"
    : "px-4 py-3 text-sm";

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={[
        "inline-flex items-center justify-between gap-3 rounded-lg border border-edge-2",
        "bg-surface-2 text-content-2 hover:bg-surface-3 hover:text-content-1 disabled:opacity-50 disabled:cursor-wait",
        compactClasses,
        compact ? "w-full" : "min-w-[240px]",
      ].join(" ")}
      title={labelForCount(count)}
    >
      <span className="flex items-center gap-2 min-w-0">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-accent"
        >
          <path d="M3 3.5h10M3 8h10M3 12.5h6" />
          <path d="M10.5 11.5 12 13l2.5-3" />
        </svg>
        <span className="min-w-0 text-left">
          <span className="block font-medium text-content-1">
            {busy ? "Starting..." : "Merge all PRs"}
          </span>
          {!compact && (
            <span className="block text-[11px] text-content-3">
              {labelForCount(count)}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 rounded-md bg-surface-4 px-1.5 py-0.5 text-[11px] font-mono font-medium text-content-2 tabular-nums">
        {count}
      </span>
    </button>
  );
}
