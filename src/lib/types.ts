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

export interface PaneState {
  id: string;
  type: PaneType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Per-pane opacity, 0.4–1. Persisted in layout v3. */
  opacity: number;
  visible: boolean;
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
