export type PaneType = "player" | "lyrics" | "queue" | "visualizer" | "browse";

/** Row density preference. Compact saves vertical space in small
 *  panes, spacious airs out large ones. Orthogonal to pane size. */
export type Density = "compact" | "default" | "spacious";

export interface PaneState {
  id: string;
  type: PaneType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Per-pane glass opacity, 0.4–1. Persisted in layout v3. */
  opacity: number;
  visible: boolean;
  z: number;
}

export interface LayoutState {
  version: 3;
  preset: string;
  panes: PaneState[];
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

export interface LyricCue {
  t: number;
  text: string;
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
  | { kind: "playlist"; name: string; image: string | null; owner: string; tracks: QueueItem[]; tracksTotal: number; uri: string }
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
