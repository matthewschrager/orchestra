interface OrchestraLogoProps {
  size?: number;
  color?: string;
  className?: string;
}

/**
 * "Code Conductor" logo — terminal prompt chevron + cursor block +
 * sweeping conductor-baton slashes inside a circular border.
 */
export function OrchestraLogo({ size = 32, color = "currentColor", className }: OrchestraLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Terminal prompt chevron */}
      <path
        d="M 16 26 L 22 32 L 16 38"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Cursor / baton */}
      <rect x="26" y="30" width="2.5" height="4" fill={color} />

      {/* Code slashes — conductor sweep */}
      <g opacity="0.6">
        <line x1="32" y1="24" x2="36" y2="32" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <line x1="38" y1="26" x2="42" y2="34" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <line x1="44" y1="30" x2="48" y2="38" stroke={color} strokeWidth="2" strokeLinecap="round" />
      </g>

      {/* Circular container */}
      <circle cx="32" cy="32" r="22" stroke={color} strokeWidth="2" fill="none" opacity="0.3" />
    </svg>
  );
}
