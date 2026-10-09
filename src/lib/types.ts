export type PaneType = "player" | "lyrics" | "queue" | "visualizer" | "browse";

/** Row density preference. Compact saves vertical space in small
 *  panes, spacious airs out large ones. Orthogonal to pane size. */
export type Density = "compact" | "default" | "spacious";

/** Pane surface finish. Solid is the opaque default; glass is an
 *  opt-in Apple Liquid Glass look (translucent + backdrop blur). */
export type Surface = "solid" | "glass";

/** Pane/control corner style. Rounded is the default; sharp zeroes
 *  the radius vars (pill shapes like dock/chips keep 999px). */
export type Corners = "rounded" | "sharp";

/** Custom overlay background color (2.5.4). Empty string means "theme
 *  default" (no override); otherwise a normalized lowercase `#rrggbb`
 *  hex. The empty case keeps unknown-value fallback safe: any invalid
 *  stored value coerces to "" at the parse boundary (App read +
 *  onChange), so illegal states are unrepresentable past parsing. */
export type OverlayColor = string;

/** localStorage key for the custom overlay background color. */
export const OVERLAY_COLOR_KEY = "snapify-overlay-color";

/** Per-pane theme override. Absent (`undefined`) inherits the global
 *  theme — the same empty-means-default contract as OverlayColor. */
export type PaneThemeOverride =
  | "dark"
  | "light"
  | "sparkles"
  | "pastel"
  | "neo-light"
  | "neo-dark";

/** Shadow finish for one pane. `neu` is the neumorphic dual-shadow
 *  pair; otherwise sm/lg map to the existing shadow tokens. */
export type PaneShadow = "none" | "sm" | "lg" | "neu";

/** Opacity/blur finish for one pane. `glass` opts this pane into the
 *  backdrop-filter + sheen treatment even when the global surface is
 *  solid (neo panes force `solid` per the glass-x-neo default). */
export type PaneSurfaceOverride = "solid" | "glass";

/** All optional. Absent (`undefined`) field inherits the corresponding
 *  global value, so a fresh/legacy pane renders pixel-identical. */
export interface PaneStyleOverride {
  /** Normalized lowercase #rrggbb, or undefined = theme default. */
  bg?: string;
  /** Undefined = inherit global theme. */
  theme?: PaneThemeOverride;
  /** Font family stack token or CSS font-family value. */
  fontFamily?: string;
  /** px value. */
  fontSize?: number;
  /** CSS font-weight. */
  fontWeight?: number | string;
  /** CSS text-align. */
  textAlign?: "left" | "center" | "right";
  /** px value; neo panes floor at 20. */
  radius?: number;
  shadow?: PaneShadow;
  surface?: PaneSurfaceOverride;
  /** 0.4-1, same range as PaneState.opacity; undefined keeps opacity. */
  opacity?: number;
}

/** Theme-default surface hex, mirrored from App.css `--surface` per
 *  theme. Used as the native color-input value and hex placeholder
 *  while `OverlayColor` is "" (theme default). */
export const THEME_DEFAULT_SURFACE: Record<string, string> = {
  dark: "#17171a",
  light: "#ffffff",
  sparkles: "#0b1330",
  pastel: "#fff9ef",
  "neo-light": "#e0e5ec",
  "neo-dark": "#2A2D34",
};

/** Parse an unknown stored/input value into a valid OverlayColor.
 *  Accepts "" (theme default), `#rrggbb`, `#rgb` (expanded), or
 *  bare `rrggbb` / `rgb` (a `#` is added). Anything else coerces to
 *  "" so callers never branch on invalid colors. */
export function parseOverlayColor(v: unknown): OverlayColor {
  if (typeof v !== "string") return "";
  const t = v.trim().toLowerCase();
  if (t === "") return "";
  const hex = t.startsWith("#") ? t.slice(1) : t;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return "";
}

/** Convert a normalized `#rrggbb` hex to `rgba(r, g, b, alpha)`.
 *  Returns "" for non-hex input so glass vars never receive garbage. */
export function overlayColorToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  if (!m) return "";
  const n = m[1];
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface PaneState {
  id: string;
  type: PaneType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Per-pane opacity, 0.4–1. Persisted in layout v3. */
  opacity: number;
  /** Per-pane style override. Absent = fully inherit the global theme
   *  (pixel-identical to pre-per-pane rendering). Persisted in v5. */
  style?: PaneStyleOverride;
  visible: boolean;
  /** PR8 collapse: true hides the pane body so the pane is header only
   *  (all types, including the player). The player mini card is an
   *  expanded-only compact state (narrow/short), never a collapsed state.
   *  Persisted in v4; absent (v3 docs) means expanded. */
  collapsed?: boolean;
  z: number;
}

export interface LayoutState {
  version: 3;
  preset: string;
  panes: PaneState[];
}

/** One layout-undo step: a deep snapshot of the panes plus the preset
 *  label. The App keeps a bounded stack (see LAYOUT_UNDO_DEPTH in
 *  layout.ts); Ctrl+Z in edit mode pops the last entry. */
export interface LayoutUndoEntry {
  panes: PaneState[];
  preset: string;
}

/** PR8 scene profiles. One persisted arrangement per scene; the dock
 *  switches the active scene and the stage swaps to its geometry. */
export type SceneName = "game" | "focus" | "stream";

/** One scene's arrangement: the preset label plus its pane geometry
 *  (including each pane's `collapsed` flag). */
export interface SceneSlot {
  preset: string;
  panes: PaneState[];
}

/** Schema v5 layout doc, stored under the same `snapify-layout-v3` key.
 *  v3 JSON (`{ version: 3, preset, panes }`) still loads via the v3
 *  fallback and migrates (see `migrateV3ToV4` in layout.ts); v4 docs
 *  migrate via `migrateV4ToV5` (pure version stamp: absent `style` =
 *  inherit). */
export interface SceneLayout {
  version: 5;
  activeScene: SceneName;
  scenes: Record<SceneName, SceneSlot>;
}

export interface TrackInfo {
  id: string;
  name: string;
  artists: string;
  album: string;
  image: string | null;
  durationMs: number;
  uri: string;
  explicit: boolean;
}

export interface PlayerSnapshot {
  empty: boolean;
  isPlaying: boolean;
  progressMs: number;
  fetchedAt: number;
  track: TrackInfo | null;
  deviceId: string | null;
  deviceName: string | null;
  volume: number | null;
  shuffle: boolean;
  repeat: string;
}

export interface LyricWord {
  t: number;
  text: string;
}

export interface LyricCue {
  t: number;
  text: string;
  /** True word timing when the provider ships it (LRCLIB enhanced /
   *  inline word tags). Absent means the renderer falls back to linear
   *  interpolation across the line. */
  words?: LyricWord[];
}

export interface LyricsData {
  trackId: string;
  synced: boolean;
  instrumental: boolean;
  cues: LyricCue[];
  plain: string | null;
  cached: boolean;
}

export type LyricsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: LyricsData }
  | { kind: "error"; message: string };

export interface QueueItem {
  name: string;
  artists: string;
  durationMs: number;
  uri: string;
}

/** Where the current queue is playing from. Spotify reports the context
 *  uri and type but never the display name; the name resolves separately
 *  and stays null until it does so no stale label ever renders. */
export type QueueContextKind = "playlist" | "album" | "artist" | "show";

export interface QueueContext {
  kind: QueueContextKind;
  id: string;
  uri: string;
  name: string | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  volume: number | null;
}

export type BrowseView = "library" | "search" | "profile";

export type BrowseEntry =
  | { kind: "playlist"; id: string; name?: string }
  | { kind: "album"; id: string; name?: string }
  | { kind: "artist"; id: string; name?: string }
  | { kind: "show"; id: string; name?: string }
  | { kind: "episode"; id: string; name?: string }
  | { kind: "audiobook"; id: string; name?: string }
  | { kind: "chapter"; id: string; name?: string }
  | { kind: "track"; id: string; name?: string };

export interface BrowseState {
  view: BrowseView;
  stack: BrowseEntry[];
  query: string;
}

export interface LibraryItem {
  id: string;
  name: string;
  subtitle: string;
  image: string | null;
  uri: string;
}

export type DetailData =
  | { kind: "playlist"; name: string; image: string | null; owner: string; tracks: QueueItem[]; tracksTotal: number; uri: string; walled: boolean }
  | { kind: "album"; name: string; image: string | null; artists: string; tracks: QueueItem[]; uri: string; explicit: boolean }
  | { kind: "artist"; name: string; image: string | null; genres: string[]; topTracks: QueueItem[]; albums: LibraryItem[]; uri: string }
  | { kind: "show"; name: string; image: string | null; publisher: string; episodes: QueueItem[]; uri: string; explicit: boolean }
  | { kind: "episode"; name: string; image: string | null; show: string; durationMs: number; uri: string; explicit: boolean; uriType: "episode" }
  | { kind: "audiobook"; name: string; image: string | null; authors: string; chapters: QueueItem[]; uri: string; explicit: boolean }
  | { kind: "chapter"; name: string; image: string | null; book: string; durationMs: number; uri: string; explicit: boolean; uriType: "chapter" }
  | { kind: "track"; name: string; image: string | null; artists: string; album: string; durationMs: number; uri: string; explicit: boolean; uriType: "track" };

export interface SearchResults {
  tracks: QueueItem[];
  artists: LibraryItem[];
  playlists: LibraryItem[];
  albums: LibraryItem[];
  shows: LibraryItem[];
  episodes: QueueItem[];
  audiobooks: LibraryItem[];
}

export interface UserProfile {
  id: string;
  name: string;
  image: string | null;
  accountId: string;
}
