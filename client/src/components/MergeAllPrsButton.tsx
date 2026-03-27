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
          "relative inline-flex h-7 w-7 items-center justify-center rounded-lg border border-amber-400/15",
          "bg-amber-500/8 text-amber-100 hover:bg-amber-500/14 hover:text-amber-50",
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
        <span className="absolute -right-1 -top-1 min-w-[15px] rounded-full bg-amber-200/90 px-1 text-[9px] font-bold leading-[15px] text-amber-950 shadow-[0_1px_2px_rgba(0,0,0,0.25)]">
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
        "inline-flex items-center justify-between gap-3 rounded-xl border border-amber-400/20",
        "bg-amber-500/10 text-amber-100 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-wait",
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
          className="shrink-0"
        >
          <path d="M3 3.5h10M3 8h10M3 12.5h6" />
          <path d="M10.5 11.5 12 13l2.5-3" />
        </svg>
        <span className="min-w-0 text-left">
          <span className="block font-medium text-amber-50">
            {busy ? "Starting..." : "Merge all PRs"}
          </span>
          {!compact && (
            <span className="block text-[11px] text-amber-100/70">
              {labelForCount(count)}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 rounded-full bg-amber-200/12 px-2 py-0.5 text-[11px] font-semibold text-amber-100">
        {count}
      </span>
    </button>
  );
}
