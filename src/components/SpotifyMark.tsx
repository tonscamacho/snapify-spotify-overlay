interface MarkProps {
  variant?: "full" | "icon";
  size?: number;
  label?: string;
}

// Spotify attribution mark. Full logo (icon + wordmark) in headers and
// browse; 21px-minimum icon only when space is under the 70px full-logo
// minimum (now-playing bar). Half-icon exclusion zone via padding.
// White on dark surfaces, black on light surfaces, green only on pure black or
// white. Never rotate, stretch, recolor, reshape, or place over art.
export default function SpotifyMark({ variant = "full", size = 21, label = "Spotify" }: MarkProps) {
  const isFull = variant === "full";
  return (
    <span
      className={`spotify-mark spotify-mark-${variant}`}
      role="img"
      aria-label={label}
      title={label}
      style={isFull ? { minWidth: 70 } : { minWidth: size, minHeight: size }}
    >
      <svg
        width={isFull ? Math.max(70, size * 4) : Math.max(21, size)}
        height={Math.max(21, size)}
        viewBox={isFull ? "0 0 120 32" : "0 0 32 32"}
        fill="currentColor"
        aria-hidden="true"
      >
        {isFull ? (
          <>
            <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path
              d="M9.5 13.2c4.4-1.3 8.9-.7 12.4 1.2M9.9 16.6c3.7-1.1 7.4-.6 10.3 1M10.2 19.8c3-0.9 5.9-.5 8.2.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <text x="34" y="21" fontSize="15" fontWeight="700" fontFamily="system, Helvetica Neue, Helvetica, Arial, sans-serif" fill="currentColor">
              Spotify
            </text>
          </>
        ) : (
          <>
            <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path
              d="M9.5 13.2c4.4-1.3 8.9-.7 12.4 1.2M9.9 16.6c3.7-1.1 7.4-.6 10.3 1M10.2 19.8c3-0.9 5.9-.5 8.2.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}
