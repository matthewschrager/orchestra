import type { PrStatus } from "shared";

interface Props {
  prUrl: string | null;
  prStatus: PrStatus | null;
  prNumber: number | null;
}

// Octicons-derived SVG icons at 16x16 viewBox, rendered at w-2.5 h-2.5
function PrOpenIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function PrMergedIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
    </svg>
  );
}

function PrClosedIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-1.143-2.471a.75.75 0 1 0-1.065-1.058L9.1 4.414 7.958 3.272a.75.75 0 0 0-1.065 1.058L8.036 5.47l-1.143 1.14a.75.75 0 0 0 1.065 1.06L9.1 6.527l1.142 1.141a.75.75 0 1 0 1.065-1.058L10.164 5.47l1.143-1.14ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function PrDraftIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" />
    </svg>
  );
}

const STATUS_CONFIG: Record<
  string,
  {
    icon: React.ComponentType<{ className?: string }> | null;
    bg: string;
    label: (n: number | null) => string;
    tooltip: (n: number | null) => string;
  }
> = {
  draft: {
    icon: PrDraftIcon,
    bg: "bg-gray-700/40 text-gray-400",
    label: (n) => (n ? `Draft #${n}` : "Draft"),
    tooltip: (n) => (n ? `Pull request #${n}, draft` : "Pull request, draft"),
  },
  open: {
    icon: PrOpenIcon,
    bg: "bg-emerald-900/40 text-emerald-300",
    label: (n) => (n ? `PR #${n}` : "PR"),
    tooltip: (n) => (n ? `Pull request #${n}, open` : "Pull request, open"),
  },
  merged: {
    icon: PrMergedIcon,
    bg: "bg-purple-900/40 text-purple-300",
    label: (n) => (n ? `Merged #${n}` : "Merged"),
    tooltip: (n) => (n ? `Pull request #${n}, merged` : "Pull request, merged"),
  },
  closed: {
    icon: PrClosedIcon,
    bg: "bg-red-900/40 text-red-300",
    label: (n) => (n ? `Closed #${n}` : "Closed"),
    tooltip: (n) => (n ? `Pull request #${n}, closed` : "Pull request, closed"),
  },
};

/**
 * PR status badge for sidebar/mobile thread lists.
 * Renders as a <span> (NOT clickable — lives inside thread row <button>).
 * Shows status-specific icon + color + PR number.
 * Falls back to plain green "PR" when prStatus is null.
 */
export function PrBadge({ prUrl, prStatus, prNumber }: Props) {
  if (!prUrl) return null;

  // Fallback: prUrl exists but no status yet (pre-migration, gh unavailable)
  if (!prStatus) {
    return (
      <span
        className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-300"
        title="Pull request"
      >
        PR
      </span>
    );
  }

  const config = STATUS_CONFIG[prStatus];
  // Unknown status string (future value, DB corruption) — fallback to plain badge
  if (!config) {
    return (
      <span
        className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/40 text-emerald-300"
        title="Pull request"
      >
        PR
      </span>
    );
  }

  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded ${config.bg}`}
      title={config.tooltip(prNumber)}
    >
      {Icon && <Icon className="shrink-0 opacity-80" />}
      {config.label(prNumber)}
    </span>
  );
}
