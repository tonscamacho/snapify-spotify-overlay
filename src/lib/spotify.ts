import { invoke } from "@tauri-apps/api/core";
import type {
  DeviceInfo,
  PlayerSnapshot,
  QueueContext,
  QueueContextKind,
  QueueItem,
  TrackInfo,
} from "./types";

function asTrack(item: unknown): TrackInfo | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string") return null;
  const artists = Array.isArray(o["artists"])
    ? (o["artists"] as Array<Record<string, unknown>>)
        .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
        .filter(Boolean)
        .join(", ")
    : "";
  const images = (o["album"] as Record<string, unknown> | undefined)?.["images"] as
    | Array<Record<string, unknown>>
    | undefined;
  const image =
    images && images.length > 0 && typeof images[0]["url"] === "string"
      ? (images[0]["url"] as string)
      : null;
  return {
    id: o["id"] as string,
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
    artists,
    album:
      typeof (o["album"] as Record<string, unknown> | undefined)?.["name"] === "string"
        ? ((o["album"] as Record<string, unknown>)["name"] as string)
        : "",
    image,
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
    explicit: o["explicit"] === true,
  };
}

export function parsePlayer(raw: unknown): PlayerSnapshot {
  const fallback: PlayerSnapshot = {
    empty: true,
    isPlaying: false,
    progressMs: 0,
    fetchedAt: Date.now(),
    track: null,
    deviceId: null,
    deviceName: null,
    volume: null,
    shuffle: false,
    repeat: "off",
  };
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  if (o["empty"] === true || !o["item"]) return fallback;
  const device = o["device"] as Record<string, unknown> | undefined;
  return {
    empty: false,
    isPlaying: o["is_playing"] === true,
    progressMs: typeof o["progress_ms"] === "number" ? (o["progress_ms"] as number) : 0,
    fetchedAt: Date.now(),
    track: asTrack(o["item"]),
    deviceId:
      device && typeof device["id"] === "string" ? (device["id"] as string) : null,
    deviceName:
      device && typeof device["name"] === "string"
        ? (device["name"] as string)
        : null,
    volume:
      device && typeof device["volume_percent"] === "number"
        ? (device["volume_percent"] as number)
        : null,
    shuffle: o["shuffle_state"] === true,
    repeat: typeof o["repeat_state"] === "string" ? (o["repeat_state"] as string) : "off",
  };
}

export function parseDevices(raw: unknown): DeviceInfo[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)["devices"];
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).map((d) => ({
    id: typeof d["id"] === "string" ? (d["id"] as string) : "",
    name: typeof d["name"] === "string" ? (d["name"] as string) : "Device",
    kind: typeof d["type"] === "string" ? (d["type"] as string) : "",
    isActive: d["is_active"] === true,
    volume: typeof d["volume_percent"] === "number" ? (d["volume_percent"] as number) : null,
  }));
}

function parseTrackLite(o: Record<string, unknown>): QueueItem {
  const artists = Array.isArray(o["artists"])
    ? (o["artists"] as Array<Record<string, unknown>>)
        .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
        .filter(Boolean)
        .join(", ")
    : "";
  return {
    name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
    artists,
    durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
    uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
  };
}

const QUEUE_CONTEXT_KINDS: ReadonlySet<string> = new Set(["playlist", "album", "artist", "show"]);

export function parseQueueContext(raw: unknown): Omit<QueueContext, "name"> | null {
  if (!raw || typeof raw !== "object") return null;
  const ctx = (raw as Record<string, unknown>)["context"];
  if (!ctx || typeof ctx !== "object") return null;
  const o = ctx as Record<string, unknown>;
  const type = o["type"];
  const uri = o["uri"];
  if (typeof type !== "string" || typeof uri !== "string") return null;
  if (!QUEUE_CONTEXT_KINDS.has(type)) return null;
  const parts = uri.split(":");
  if (parts.length !== 3 || parts[0] !== "spotify" || parts[1] !== type || !parts[2]) return null;
  return { kind: type as QueueContextKind, id: parts[2], uri };
}

export function parseQueue(raw: unknown): { current: QueueItem | null; upcoming: QueueItem[] } {
  const out = { current: null as QueueItem | null, upcoming: [] as QueueItem[] };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  if (o["currently_playing"] && typeof o["currently_playing"] === "object") {
    out.current = parseTrackLite(o["currently_playing"] as Record<string, unknown>);
  }
  if (Array.isArray(o["queue"])) {
    out.upcoming = (o["queue"] as Array<Record<string, unknown>>)
      .slice(0, 10)
      .map(parseTrackLite);
  }
  return out;
}

export type ThrottleKind = "throttled" | "quota";

/** Typed throttle error surfaced from Rust 429s. `retryAfterSec` is the
 *  numeric `Retry-After` value when the backend sent a parseable integer,
 *  otherwise null (callers fall back to their own cooldown default). */
export interface ThrottleInfo {
  kind: ThrottleKind;
  retryAfterSec: number | null;
  message: string;
}

function messageOf(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o["message"] === "string") return o["message"] as string;
  }
  return String(input ?? "");
}

/** Extract the numeric `retry after {n}s` from a Rust throttle string. */
export function parseRetryAfterSec(input: unknown): number | null {
  const m = /retry after (\d+)\s*s/i.exec(messageOf(input));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Single routing point for all 429 detection. Returns the typed throttle
 *  info, or null when the error is not a throttle/quota signal. */
export function toThrottleError(input: unknown): ThrottleInfo | null {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (o["kind"] === "throttled" || o["kind"] === "quota") {
      const raw = o["retryAfterSec"];
      const retryAfterSec =
        typeof raw === "number" && Number.isFinite(raw) ? raw : parseRetryAfterSec(o["message"] ?? "");
      return {
        kind: o["kind"] as ThrottleKind,
        retryAfterSec,
        message: messageOf(o["message"] ?? input),
      };
    }
  }
  const message = messageOf(input);
  const s = message.toLowerCase();
  const quota = s.includes("quota-exceeded") || (s.includes("quota") && (s.includes("429") || s.includes("retry after") || s.includes("back off")));
  if (quota) {
    return { kind: "quota", retryAfterSec: parseRetryAfterSec(message), message };
  }
  if (
    s.includes("rate-limited") ||
    s.includes("429") ||
    s.includes("cooling down") ||
    s.includes("retry after")
  ) {
    return { kind: "throttled", retryAfterSec: parseRetryAfterSec(message), message };
  }
  return null;
}

/** Back-compat predicate: true for any throttled or quota error. */
export function isThrottledError(input: unknown): boolean {
  return toThrottleError(input) !== null;
}

/** True only for quota-exceeded (long cooldown) errors. */
export function isQuotaError(input: unknown): boolean {
  return toThrottleError(input)?.kind === "quota";
}

/** Numeric Retry-After seconds, or null when absent/unparseable. */
export function getRetryAfterSec(input: unknown): number | null {
  return toThrottleError(input)?.retryAfterSec ?? null;
}

export const api = {
  authStatus: () => invoke<{ logged_in: boolean; awaiting_callback: boolean }>("auth_status"),
  startLogin: () => invoke<string>("start_login"),
  logout: () => invoke<void>("logout"),
  freshToken: () => invoke<string>("get_fresh_token"),
  autostartState: () => invoke<boolean>("autostart_state"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  player: async () => parsePlayer(await invoke<unknown>("get_player")),
  devices: async () => parseDevices(await invoke<unknown>("get_devices")),
  queue: async () => {
    const raw = await invoke<unknown>("get_queue");
    return { ...parseQueue(raw), context: parseQueueContext(raw) };
  },
  play: (device_id?: string | null) => invoke("play", { deviceId: device_id ?? null }),
  pause: (device_id?: string | null) => invoke("pause", { deviceId: device_id ?? null }),
  next: (device_id?: string | null) => invoke("next_track", { deviceId: device_id ?? null }),
  prev: (device_id?: string | null) => invoke("prev_track", { deviceId: device_id ?? null }),
  seek: (position_ms: number, device_id?: string | null) =>
    invoke("seek", { positionMs: position_ms, deviceId: device_id ?? null }),
  volume: (volume_percent: number, device_id?: string | null) =>
    invoke("set_volume", { volumePercent: Math.round(volume_percent), deviceId: device_id ?? null }),
  shuffle: (enabled: boolean, device_id?: string | null) =>
    invoke("set_shuffle", { enabled, deviceId: device_id ?? null }),
  repeat: (mode: string, device_id?: string | null) =>
    invoke("set_repeat", { mode, deviceId: device_id ?? null }),
  transfer: (device_id: string, play_now: boolean) =>
    invoke("transfer_playback", { deviceId: device_id, playNow: play_now }),
  queueAdd: (uri: string, device_id?: string | null) =>
    invoke("add_to_queue", { uri, deviceId: device_id ?? null }),
  me: () => invoke<unknown>("get_me"),
  myPlaylists: (limit = 20, offset = 0) =>
    invoke<unknown>("get_my_playlists", { limit, offset }),
  createPlaylist: (name: string, isPublic = false) =>
    invoke<unknown>("create_playlist", { name, public: isPublic }),
  savedTracks: (limit = 20, offset = 0) => invoke<unknown>("get_my_tracks", { limit, offset }),
  savedAlbums: (limit = 20, offset = 0) => invoke<unknown>("get_my_albums", { limit, offset }),
  savedShows: (limit = 20, offset = 0) => invoke<unknown>("get_my_shows", { limit, offset }),
  savedEpisodes: (limit = 20, offset = 0) => invoke<unknown>("get_my_episodes", { limit, offset }),
  savedAudiobooks: (limit = 20, offset = 0) => invoke<unknown>("get_my_audiobooks", { limit, offset }),
  followedArtists: (limit = 20, after?: string | null) =>
    invoke<unknown>("get_followed_artists", { limit, after: after ?? null }),
  myFollowing: (kind: string, limit = 20, after?: string | null) =>
    invoke<unknown>("get_my_following", { kind, limit, after: after ?? null }),
  libraryContains: (uris: string[]) =>
    invoke<boolean[]>("library_contains", { uris }),
  librarySave: (uris: string[]) =>
    invoke<unknown>("library_save", { uris }),
  libraryRemove: (uris: string[]) =>
    invoke<unknown>("library_remove", { uris }),
  followPut: (uris: string[]) =>
    invoke<unknown>("follow_put", { uris }),
  followDelete: (uris: string[]) =>
    invoke<unknown>("follow_delete", { uris }),
  top: (kind: string, limit = 10, offset = 0) =>
    invoke<unknown>("get_my_top", { kind, limit, offset }),
  recent: (limit = 10) => invoke<unknown>("get_recently_played", { limit }),
  playlist: (playlist_id: string) => invoke<unknown>("get_playlist", { playlistId: playlist_id }),
  playlistItems: (playlist_id: string, limit = 50, offset = 0) =>
    invoke<unknown>("get_playlist_items", { playlistId: playlist_id, limit, offset }),
  playlistTracks: (playlist_id: string, limit = 50, offset = 0) =>
    invoke<unknown>("get_playlist_items", { playlistId: playlist_id, limit, offset }),
  playlistAdd: (playlist_id: string, uris: string[]) =>
    invoke<unknown>("add_playlist_items", { playlistId: playlist_id, uris }),
  playlistRemove: (playlist_id: string, uris: string[]) =>
    invoke<unknown>("remove_playlist_items", { playlistId: playlist_id, uris }),
  playlistReorder: (playlist_id: string, range_start: number, insert_before: number, range_length = 1) =>
    invoke<unknown>("reorder_playlist_items", { playlistId: playlist_id, rangeStart: range_start, insertBefore: insert_before, rangeLength: range_length }),
  track: (track_id: string) => invoke<unknown>("get_track", { trackId: track_id }),
  artist: (artist_id: string) => invoke<unknown>("get_artist", { artistId: artist_id }),
  relatedArtists: (artist_id: string) =>
    invoke<unknown>("get_related_artists", { artistId: artist_id }),
  artistAlbums: (artist_id: string, limit = 10, offset = 0) =>
    invoke<unknown>("get_artist_albums", { artistId: artist_id, limit, offset }),
  album: (album_id: string) => invoke<unknown>("get_album", { albumId: album_id }),
  albumTracks: (album_id: string, limit = 20, offset = 0) =>
    invoke<unknown>("get_album_tracks", { albumId: album_id, limit, offset }),
  show: (show_id: string) => invoke<unknown>("get_show", { showId: show_id }),
  showEpisodes: (show_id: string, limit = 20, offset = 0) =>
    invoke<unknown>("get_show_episodes", { showId: show_id, limit, offset }),
  episode: (episode_id: string) => invoke<unknown>("get_episode", { episodeId: episode_id }),
  audiobook: (audiobook_id: string) =>
    invoke<unknown>("get_audiobook", { audiobookId: audiobook_id }),
  audiobookChapters: (audiobook_id: string, limit = 20, offset = 0) =>
    invoke<unknown>("get_audiobook_chapters", { audiobookId: audiobook_id, limit, offset }),
  chapter: (chapter_id: string) => invoke<unknown>("get_chapter", { chapterId: chapter_id }),
  searchRaw: (query: string, limit = 5, offset = 0) =>
    invoke<unknown>("search", { query, limit, offset }),
  playContext: (context_uri: string, device_id?: string | null) =>
    invoke("play_context", { contextUri: context_uri, deviceId: device_id ?? null }),
  playUris: (uris: string[], device_id?: string | null) =>
    invoke("play_uris", { uris, deviceId: device_id ?? null }),
  requestLogCounts: () =>
    invoke<{
      total: number;
      ok: number;
      rate_limited: number;
      quota_exceeded: number;
      unauthorized: number;
      other: number;
    }>("request_log_counts"),
  requestLogRecent: (limit = 50) =>
    invoke<
      Array<{ method: string; path: string; result: string; retry_after: number | null }>
    >("request_log_recent", { limit }),
  lyrics: (p: {
    track_id: string;
    track_name: string;
    artist_name: string;
    album_name: string;
    duration_ms: number;
  }) =>
    invoke<{
      trackId: string;
      synced: boolean;
      instrumental: boolean;
      cues: Array<{ t: number; text: string }>;
      plain: string | null;
      cached: boolean;
    }>("get_lyrics", {
      trackId: p.track_id,
      trackName: p.track_name,
      artistName: p.artist_name,
      albumName: p.album_name,
      durationMs: p.duration_ms,
    }),
};
