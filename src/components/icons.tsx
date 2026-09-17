import type { ReactNode } from "react";

// In-app glyphs mirror `icon pack/svg/ui/` (viewBox 0 0 24, stroke 1.8,
// round caps): PlayIcon<->play.svg, PauseIcon<->pause.svg, NextIcon<->next.svg,
// PrevIcon<->prev.svg, ShuffleIcon<->shuffle.svg, RepeatIcon<->repeat.svg,
// RepeatOneIcon<->repeat-1.svg, VolumeIcon<->volume.svg, ListIcon<->queue.svg,
// MicIcon<->lyrics-mic.svg, SlidersIcon<->settings.svg, LockIcon<->lock.svg,
// UnlockIcon<->unlock.svg, MinusIcon<->minimize.svg, XIcon<->close.svg,
// NoteIcon<->note.svg, RefreshIcon<->refresh.svg. Dock-only glyphs with no
// pack counterpart: EyeIcon, EyeOffIcon, PencilIcon, CursorIcon, GearIcon,
// GridIcon, UndoIcon, ThroughIcon. Keep paths in sync there.

interface IconProps {
  size?: number;
  className?: string;
}

function Base({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7.5 4.8v14.4L19.5 12z" fill="currentColor" stroke="none" />
  </Base>
);

export const PauseIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="6.2" y="4.8" width="3.9" height="14.4" rx="1.3" fill="currentColor" stroke="none" />
    <rect x="13.9" y="4.8" width="3.9" height="14.4" rx="1.3" fill="currentColor" stroke="none" />
  </Base>
);

export const NextIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 5.8v12.4L13.5 12z" fill="currentColor" stroke="none" />
    <rect x="16" y="5.8" width="2.7" height="12.4" rx="1" fill="currentColor" stroke="none" />
  </Base>
);

export const PrevIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M19.5 5.8v12.4L10.5 12z" fill="currentColor" stroke="none" />
    <rect x="5.3" y="5.8" width="2.7" height="12.4" rx="1" fill="currentColor" stroke="none" />
  </Base>
);

export const ShuffleIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M16 3.5h4.5V8" />
    <path d="M4 20 20.5 3.5" />
    <path d="M20.5 15.5V20H16" />
    <path d="m14.5 14.5 6 6" />
    <path d="M4 4l4.5 4.5" />
  </Base>
);

export const RepeatIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m17 2.5 3.5 3.5L17 9.5" />
    <path d="M3.5 11V10a4 4 0 0 1 4-4h13" />
    <path d="m7 21.5-3.5-3.5L7 14.5" />
    <path d="M20.5 13v1a4 4 0 0 1-4 4h-13" />
  </Base>
);

export const RepeatOneIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m17 2.5 3.5 3.5L17 9.5" />
    <path d="M3.5 11V10a4 4 0 0 1 4-4h13" />
    <path d="m7 21.5-3.5-3.5L7 14.5" />
    <path d="M20.5 13v1a4 4 0 0 1-4 4h-13" />
    <path d="M10.9 11 12.2 10v4" />
  </Base>
);

export const VolumeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="M15 9a4.2 4.2 0 0 1 0 6" />
    <path d="M17.8 6.4a8 8 0 0 1 0 11.2" />
  </Base>
);

export const LockIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Base>
);

export const UnlockIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" />
  </Base>
);

export const SlidersIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M16.5 4h-2" />
    <path d="M9.5 4H3.5" />
    <path d="M20.5 12h-8" />
    <path d="M7.5 12h-4" />
    <path d="M20.5 20h-4" />
    <path d="M11.5 20h-8" />
    <path d="M14.5 2v4" />
    <path d="M7.5 10v4" />
    <path d="M16.5 18v4" />
    <path
      d="M19.5 2.8c.11.68.44 1.01 1.12 1.12-.68.11-1.01.44-1.12 1.12-.11-.68-.44-1.01-1.12-1.12.68-.11 1.01-.44 1.12-1.12Z"
      fill="currentColor"
      stroke="none"
    />
  </Base>
);

export const MinusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h14" />
  </Base>
);

export const XIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M17.5 6.5 6.5 17.5" />
    <path d="m6.5 6.5 11 11" />
  </Base>
);

export const NoteIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 17.5V5.5L20.5 3.5v13" />
    <circle cx="6.8" cy="17.5" r="2.7" />
    <circle cx="17.8" cy="16.5" r="2.7" />
    <path
      d="M4.9 2.9c.12.73.47 1.08 1.2 1.2-.73.12-1.08.47-1.2 1.2-.12-.73-.47-1.08-1.2-1.2.73-.12 1.08-.47 1.2-1.2Z"
      fill="currentColor"
      stroke="none"
    />
  </Base>
);

export const MicIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="3.2" width="6" height="9.3" rx="3" />
    <path d="M10.2 7.2h3.6" />
    <path d="M6.8 11a5.2 5.2 0 0 0 10.4 0" />
    <path d="M12 16.2v3.3" />
    <path d="M9 20.5h6" />
    <path
      d="M18.8 2.9c.11.68.44 1.01 1.12 1.12-.68.11-1.01.44-1.12 1.12-.11-.68-.44-1.01-1.12-1.12.68-.11 1.01-.44 1.12-1.12Z"
      fill="currentColor"
      stroke="none"
    />
  </Base>
);

export const ListIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M8.5 6.5h7.6" />
    <path d="M8.5 12h12" />
    <path d="M8.5 17.5h12" />
    <path d="M4 6.5h.01" />
    <path d="M4 12h.01" />
    <path d="M4 17.5h.01" />
    <path
      d="M19.2 3.1c.12.78.5 1.16 1.28 1.28-.78.12-1.16.5-1.28 1.28-.12-.78-.5-1.16-1.28-1.28.78-.12 1.16-.5 1.28-1.28Z"
      fill="currentColor"
      stroke="none"
    />
  </Base>
);

export const RefreshIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
    <path d="M20.5 3.5V8H16" />
  </Base>
);

// Official Spotify Like glyph: plain plus, never a heart or check.
export const LikePlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Base>
);

export const SeekBackIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M11 8.5A5.5 5.5 0 1 0 11 15.5" />
    <path d="M11 8.5 8.8 6.8" />
    <path d="M11 8.5h-3" />
    <path d="M4 4v5h5" />
  </Base>
);

export const SeekForwardIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M13 8.5a5.5 5.5 0 1 1 0 7" />
    <path d="m13 8.5 2.2-1.7" />
    <path d="M13 8.5h3" />
    <path d="M20 4v5h-5" />
  </Base>
);

export const OpenIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" />
  </Base>
);

// Dock-only glyphs: one distinct silhouette per dock control so no two
// buttons share an icon. Same 24-grid stroke language as above.

export const EyeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);

export const EyeOffIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 4l16 16" />
    <path d="M9.9 6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.4 17.4 0 0 1-3.4 4" />
    <path d="M6 7.4A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5c1.1 0 2.2-.2 3.1-.6" />
  </Base>
);

export const PencilIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20l1-4.2L16.6 4.2a2.12 2.12 0 0 1 3 3L8 18.8z" />
    <path d="M14.6 6.2l3 3" />
  </Base>
);

export const CursorIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5.5 3.5 19 12l-7.2 1.4L8.4 20.5z" />
  </Base>
);

export const GearIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v2.6" />
    <path d="M12 18.6v2.6" />
    <path d="M2.8 12h2.6" />
    <path d="M18.6 12h2.6" />
    <path d="M5.5 5.5l1.8 1.8" />
    <path d="M16.7 16.7l1.8 1.8" />
    <path d="M18.5 5.5l-1.8 1.8" />
    <path d="M7.3 16.7l-1.8 1.8" />
  </Base>
);

export const GridIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Base>
);

export const UndoIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M8.5 5.5 4 10l4.5 4.5" />
    <path d="M4 10h10a6 6 0 0 1 0 12h-3" />
  </Base>
);

export const ThroughIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8" />
    <path d="M11 12h9" />
    <path d="m16.5 8.5 3.5 3.5-3.5 3.5" />
  </Base>
);
