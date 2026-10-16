import type {
  ApiTimeRange,
  ClockBucket,
  ProfileRange,
  ProfileStats,
  QueueItem,
  RecentPlay,
  TopGenre,
} from "./types";
import type { HistoryPlay } from "./history";
import { HISTORY_MIN_MS } from "./history";

/** localStorage key for the selected profile range. */
export const PROFILE_RANGE_KEY = "snapify-profile-range";

/** All selectable ranges, in UI order. */
export const PROFILE_RANGES: readonly ProfileRange[] = [
  "today",
  "week",
  "fourWeeks",
  "sixMonths",
  "year2026",
  "lifetime",
];

/** Fallback when the stored value is missing or corrupt. */
export const DEFAULT_PROFILE_RANGE: ProfileRange = "fourWeeks";

/** Cap for the derived genre strip. */
export const TOP_GENRE_CAP = 5;

/** How many of the most-streamed artists the stream-weighted genre
 *  join reads. The join is a name lookup against the fetched top
 *  artists, so a wider window only raises the odds of a match; the
 *  per-render cost stays one pass over the slice plus map lookups. */
export const STREAM_GENRE_TOP_ARTISTS = 50;

/** Coerce an unknown stored value to a valid range. Anything outside
 *  the six known strings falls back to the default so callers never
 *  branch on an invalid range. */
export function parseProfileRange(v: unknown): ProfileRange {
  if (
    v === "today" ||
    v === "week" ||
    v === "fourWeeks" ||
    v === "sixMonths" ||
    v === "year2026" ||
    v === "lifetime"
  ) {
    return v;
  }
  return DEFAULT_PROFILE_RANGE;
}

export function loadProfileRange(): ProfileRange {
  try {
    return parseProfileRange(localStorage.getItem(PROFILE_RANGE_KEY));
  } catch {
    return DEFAULT_PROFILE_RANGE;
  }
}

export function saveProfileRange(r: ProfileRange): void {
  try {
    localStorage.setItem(PROFILE_RANGE_KEY, r);
  } catch {
    // Private mode. The range lasts the session.
  }
}

function unreachableRange(r: never): never {
  throw new Error(`unreachable profile range: ${String(r)}`);
}

/** Map a profile range to the Spotify fetch it needs. Only `fourWeeks`
 *  and `sixMonths` have real Spotify ranges; `today`/`week`/`year2026`
 *  fetch `long_term` and slice on the client (see `sliceClientRange`). */
export function toApiTimeRange(r: ProfileRange): ApiTimeRange {
  switch (r) {
    case "fourWeeks":
      return "short_term";
    case "sixMonths":
      return "medium_term";
    case "lifetime":
    case "year2026":
    case "today":
    case "week":
      return "long_term";
    default:
      return unreachableRange(r);
  }
}

/** True for ranges sliced on the client from the `long_term` fetch. */
export function isClientSlice(r: ProfileRange): boolean {
  switch (r) {
    case "today":
    case "week":
    case "year2026":
      return true;
    case "fourWeeks":
    case "sixMonths":
    case "lifetime":
      return false;
    default:
      return unreachableRange(r);
  }
}

/** Honesty note for client-sliced ranges; null when Spotify serves the
 *  range directly and no disclaimer is owed. Pass `hasImported` when the
 *  local history store holds Extended-history imports: the note then
 *  names the import so counts never pose as pure Spotify data. */
export function rangeHonestyNote(r: ProfileRange, opts?: { hasImported?: boolean }): string | null {
  const imported = opts?.hasImported === true ? " Includes imported Extended history." : "";
  switch (r) {
    case "today":
    case "week":
      return `Sliced from long-term tops plus recent streams. Not a Spotify range.${imported}`;
    case "year2026":
      return `2026 slice of lifetime tops. Spotify has no year range.${imported}`;
    case "fourWeeks":
    case "sixMonths":
    case "lifetime":
      return imported === "" ? null : imported.trim();
    default:
      return unreachableRange(r);
  }
}

function joinArtists(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const names: string[] = [];
  for (const a of v) {
    if (a && typeof a === "object") {
      const n = (a as Record<string, unknown>)["name"];
      if (typeof n === "string" && n !== "") names.push(n);
    }
  }
  return names.join(", ");
}

/** First usable image url, or null when none parses. */
function pickImage(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  for (const img of v) {
    if (img && typeof img === "object") {
      const url = (img as Record<string, unknown>)["url"];
      if (typeof url === "string" && url !== "") return url;
    }
  }
  return null;
}

function albumImage(t: Record<string, unknown>): string | null {
  const album = t["album"];
  if (!album || typeof album !== "object") return null;
  return pickImage((album as Record<string, unknown>)["images"]);
}

/** Recently-played parser. Entries missing a track id or a parseable
 *  `played_at` are dropped; the rest get display fallbacks (`Unknown`
 *  name, empty artists/uri, 0 duration) matching the queue parsers. */
export function parseRecentPlays(raw: unknown): RecentPlay[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return [];
  const out: RecentPlay[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const track = e["track"];
    if (!track || typeof track !== "object") continue;
    const t = track as Record<string, unknown>;
    if (typeof t["id"] !== "string" || t["id"] === "") continue;
    const playedAt =
      typeof e["played_at"] === "string" ? Date.parse(e["played_at"] as string) : NaN;
    if (!Number.isFinite(playedAt)) continue;
    out.push({
      trackId: t["id"] as string,
      trackName: typeof t["name"] === "string" ? (t["name"] as string) : "Unknown",
      artists: joinArtists(t["artists"]),
      playedAt,
      image: albumImage(t),
      uri: typeof t["uri"] === "string" ? (t["uri"] as string) : "",
      durationMs: typeof t["duration_ms"] === "number" ? (t["duration_ms"] as number) : 0,
    });
  }
  return out;
}

/** Top-tracks parser. Entries without a uri are dropped (unplayable);
 *  the rest reuse `QueueItem`, the same row shape as every other track
 *  list in the app. */
export function parseTopTracks(raw: unknown): QueueItem[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return [];
  const out: QueueItem[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    if (typeof t["uri"] !== "string" || t["uri"] === "") continue;
    out.push({
      name: typeof t["name"] === "string" ? (t["name"] as string) : "Unknown",
      artists: joinArtists(t["artists"]),
      durationMs: typeof t["duration_ms"] === "number" ? (t["duration_ms"] as number) : 0,
      uri: t["uri"] as string,
    });
  }
  return out;
}

/** One top artist, validated at the parse boundary. Genres keep only
 *  non-empty strings; the image is the first usable url. */
export interface ProfileArtist {
  id: string;
  name: string;
  genres: string[];
  image: string | null;
  uri: string;
}

/** Top-artists parser. Entries without an id are dropped; genres keep
 *  only real strings so `deriveTopGenres` never sees junk. */
export function parseTopArtists(raw: unknown): ProfileArtist[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return [];
  const out: ProfileArtist[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    if (typeof a["id"] !== "string" || a["id"] === "") continue;
    const rawGenres = a["genres"];
    const genres = Array.isArray(rawGenres)
      ? rawGenres.filter(
          (g): g is string => typeof g === "string" && g.trim() !== "",
        )
      : [];
    out.push({
      id: a["id"] as string,
      name: typeof a["name"] === "string" ? (a["name"] as string) : "Unknown",
      genres,
      image: pickImage(a["images"]),
      uri: typeof a["uri"] === "string" ? (a["uri"] as string) : "",
    });
  }
  return out;
}

/** Listened ms behind a play: the import value when present, else
 *  the track duration. NaN when neither parses. */
function listenedMs(p: HistoryPlay): number {
  if (typeof p.msPlayed === "number" && Number.isFinite(p.msPlayed)) return p.msPlayed;
  if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs)) return p.durationMs;
  return NaN;
}

/** True when a play counts: at least 30s listened. Skipped-long and
 *  forward-button-long rows COUNT (stats.fm import parity — the only
 *  gate is the 30s floor, which already covers skipped-short); only
 *  previews (`ms<30000`), empty/non-track URIs (podcasts), and
 *  unparseable ms never reach a stat, a genre, or a clock bucket.
 *  Single derivation site for the TS layer; Rust `is_counted` mirrors
 *  this exactly (same floor, same track-uri gate, same dedupe). */
function isCountedPlay(p: HistoryPlay): boolean {
  if (p.uri === "" || !p.uri.startsWith("spotify:track:")) return false;
  const ms = listenedMs(p);
  return Number.isFinite(ms) && (ms as number) >= HISTORY_MIN_MS;
}

/** Aggregate stats over recent plays. Artist counts split the joined
 *  display string, so one `A, B` row credits both artists. Albums count
 *  distinct `albumName` values (imported rows only). Only the 30s floor
 *  plus the track-uri gate filter; skipped-long rows count. Pure.
 *  Single derivation site: Rust `history_aggregates` mirrors these
 *  exact rules over the full normalized store. */
export function deriveStats(plays: HistoryPlay[]): ProfileStats {
  const tracks = new Set<string>();
  const artists = new Set<string>();
  const albums = new Set<string>();
  let kept = 0;
  let ms = 0;
  for (const p of plays) {
    if (!isCountedPlay(p)) continue;
    kept += 1;
    tracks.add(p.trackId);
    for (const part of p.artists.split(",")) {
      const name = part.trim();
      if (name !== "") artists.add(name);
    }
    const album = typeof p.albumName === "string" ? p.albumName.trim() : "";
    if (album !== "") albums.add(album.toLowerCase());
    const heard = listenedMs(p);
    if (Number.isFinite(heard) && (heard as number) > 0) ms += heard as number;
  }
  const minutes = Math.round(ms / 60000);
  return {
    plays: kept,
    minutes,
    hours: Math.round(minutes / 60),
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    uniqueAlbums: albums.size,
  };
}

/** Count genres across the top artists, sorted by count desc with an
 *  alphabetical tie-break, capped at `TOP_GENRE_CAP`. Names fold to
 *  lowercase so `Rock` and `rock` count together. Pure. This is the
 *  API-only fallback: every fetched artist counts once, regardless of
 *  how much the user actually streamed them. */
export function deriveTopGenres(artists: ProfileArtist[]): TopGenre[] {
  const counts = new Map<string, number>();
  for (const a of artists) {
    for (const g of a.genres) {
      const genre = g.trim().toLowerCase();
      if (genre === "") continue;
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([genre, count]): TopGenre => ({ genre, count }))
    .sort((x, y) => y.count - x.count || (x.genre < y.genre ? -1 : x.genre > y.genre ? 1 : 0))
    .slice(0, TOP_GENRE_CAP);
}

/** One artist's stream weight inside a history slice. `artist` keeps
 *  the first-seen display spelling; matching folds to lowercase. */
export interface ArtistStreamRank {
  artist: string;
  streams: number;
  minutes: number;
}

/** Rank the slice's artists by counted streams, desc, with a
 *  case-insensitive alphabetical tie-break, capped at `topN`. Joint
 *  `A, B` rows credit both artists, mirroring `deriveStats`. Short
 *  and skipped plays never rank. Pure. */
export function rankArtistsByStreams(
  plays: HistoryPlay[],
  topN: number = STREAM_GENRE_TOP_ARTISTS,
): ArtistStreamRank[] {
  const cap =
    typeof topN === "number" && Number.isFinite(topN)
      ? Math.max(0, Math.floor(topN))
      : STREAM_GENRE_TOP_ARTISTS;
  const byArtist = new Map<string, { display: string; streams: number; ms: number }>();
  for (const p of plays) {
    if (!isCountedPlay(p)) continue;
    const heard = listenedMs(p);
    const ms = Number.isFinite(heard) && (heard as number) > 0 ? (heard as number) : 0;
    for (const part of p.artists.split(",")) {
      const name = part.trim();
      if (name === "") continue;
      const key = name.toLowerCase();
      const cur = byArtist.get(key);
      if (cur) {
        cur.streams += 1;
        cur.ms += ms;
      } else {
        byArtist.set(key, { display: name, streams: 1, ms });
      }
    }
  }
  return [...byArtist.values()]
    .map(
      (v): ArtistStreamRank => ({
        artist: v.display,
        streams: v.streams,
        minutes: Math.round(v.ms / 60000),
      }),
    )
    .sort((a, b) => {
      if (b.streams !== a.streams) return b.streams - a.streams;
      const al = a.artist.toLowerCase();
      const bl = b.artist.toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : 0;
    })
    .slice(0, cap);
}

/** Stream-weighted genres: the slice's most-streamed artists (see
 *  `rankArtistsByStreams`) join their genres from the fetched top
 *  artists by name, and each genre weighs the streams of the artists
 *  carrying it. Sorted by weight desc with an alphabetical
 *  tie-break, capped at `TOP_GENRE_CAP`. Returns [] when no ranked
 *  artist matches fetched genre data — the caller falls back to
 *  `deriveTopGenres`. Pure. */
export function deriveStreamGenres(args: {
  plays: HistoryPlay[];
  artists: ProfileArtist[];
  topN?: number;
}): TopGenre[] {
  const { plays, artists } = args;
  const lookup = new Map<string, string[]>();
  for (const a of artists) {
    const key = a.name.trim().toLowerCase();
    if (key === "") continue;
    const prev = lookup.get(key);
    if (prev) {
      for (const g of a.genres) {
        if (typeof g === "string" && g.trim() !== "" && !prev.includes(g)) prev.push(g);
      }
    } else {
      lookup.set(key, [...a.genres]);
    }
  }
  const counts = new Map<string, number>();
  for (const rank of rankArtistsByStreams(plays, args.topN ?? STREAM_GENRE_TOP_ARTISTS)) {
    const genres = lookup.get(rank.artist.trim().toLowerCase());
    if (!genres) continue;
    for (const g of genres) {
      const genre = g.trim().toLowerCase();
      if (genre === "") continue;
      counts.set(genre, (counts.get(genre) ?? 0) + rank.streams);
    }
  }
  return [...counts.entries()]
    .map(([genre, count]): TopGenre => ({ genre, count }))
    .sort((x, y) => y.count - x.count || (x.genre < y.genre ? -1 : x.genre > y.genre ? 1 : 0))
    .slice(0, TOP_GENRE_CAP);
}

/** Most-streamed genres with an API-only fallback. Imported history
 *  ranks the artists, so the strip follows actual listening; without
 *  an import the slice holds live recents only and the weights still
 *  apply. When nothing matches — tops failed, every top artist is
 *  genreless, or the slice is empty — this returns the plain
 *  `deriveTopGenres` count, and [] only when that is empty too. Pure. */
export function deriveTopGenresRanked(args: {
  plays: HistoryPlay[];
  artists: ProfileArtist[];
  topN?: number;
}): TopGenre[] {
  const weighted = deriveStreamGenres(args);
  return weighted.length > 0 ? weighted : deriveTopGenres(args.artists);
}

/** Bucket plays into 24 local-hour buckets, index = hour. Always
 *  returns all 24 buckets so the chart never shifts shape. `minutes`
 *  rounds each hour's listened ms, matching the `deriveStats` rounding
 *  per bucket. Short and skipped plays are not counted. Pure. */
export function bucketListeningClocks(plays: HistoryPlay[]): ClockBucket[] {
  const buckets: ClockBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    plays: 0,
    minutes: 0,
  }));
  const msPerHour: number[] = new Array<number>(24).fill(0);
  for (const p of plays) {
    if (!isCountedPlay(p)) continue;
    const h = new Date(p.playedAt).getHours();
    if (h < 0 || h >= 24) continue;
    buckets[h].plays += 1;
    const heard = listenedMs(p);
    if (Number.isFinite(heard) && (heard as number) > 0) msPerHour[h] += heard as number;
  }
  for (let h = 0; h < 24; h += 1) {
    buckets[h].minutes = Math.round(msPerHour[h] / 60000);
  }
  return buckets;
}

const DAY_MS = 86400000;

/** Start of a profile window in epoch ms. Single owner for the window
 *  math: `sliceClientRange`, `sliceStoreRange` callers, and the
 *  ProfilePane slice share this so the numbers cannot drift. Null
 *  means lifetime. */
export function rangeStartForRange(r: ProfileRange, now: number): number | null {
  switch (r) {
    case "today": {
      const d = new Date(now);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    case "week":
      return now - 7 * DAY_MS;
    case "fourWeeks":
      return now - 28 * DAY_MS;
    case "sixMonths":
      return now - 182 * DAY_MS;
    case "year2026":
      return new Date(2026, 0, 1).getTime();
    case "lifetime":
      return null;
    default:
      return unreachableRange(r);
  }
}

/** Window a client-sliced range over timestamped recent plays. Tops
 *  carry no timestamps, so only streams filter: `today` keeps plays
 *  since local midnight, `week` the rolling 7 days, `fourWeeks` 28
 *  days, `sixMonths` 182 days, `year2026` plays since local Jan 1
 *  2026, `lifetime` everything. Bounds are inclusive; plays stamped
 *  after `now` are dropped as clock skew. Pure. */
export function sliceClientRange(args: {
  plays: HistoryPlay[];
  range: ProfileRange;
  now?: number;
}): HistoryPlay[] {
  const { plays, range } = args;
  const now =
    typeof args.now === "number" && Number.isFinite(args.now) ? args.now : Date.now();
  const start = rangeStartForRange(range, now);
  if (start === null) return plays.slice();
  return plays.filter((p) => p.playedAt >= start && p.playedAt <= now);
}
