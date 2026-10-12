import type {
  ApiTimeRange,
  ClockBucket,
  ProfileRange,
  ProfileStats,
  QueueItem,
  RecentPlay,
  TopGenre,
} from "./types";

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
 *  range directly and no disclaimer is owed. */
export function rangeHonestyNote(r: ProfileRange): string | null {
  switch (r) {
    case "today":
    case "week":
      return "Sliced from long-term tops plus recent streams. Not a Spotify range.";
    case "year2026":
      return "2026 slice of lifetime tops. Spotify has no year range.";
    case "fourWeeks":
    case "sixMonths":
    case "lifetime":
      return null;
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

/** Aggregate stats over recent plays. Artist counts split the joined
 *  display string, so one `A, B` row credits both artists. Pure. */
export function deriveStats(plays: RecentPlay[]): ProfileStats {
  const tracks = new Set<string>();
  const artists = new Set<string>();
  let ms = 0;
  for (const p of plays) {
    tracks.add(p.trackId);
    for (const part of p.artists.split(",")) {
      const name = part.trim();
      if (name !== "") artists.add(name);
    }
    if (Number.isFinite(p.durationMs) && p.durationMs > 0) ms += p.durationMs;
  }
  return {
    plays: plays.length,
    minutes: Math.round(ms / 60000),
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
  };
}

/** Count genres across the top artists, sorted by count desc with an
 *  alphabetical tie-break, capped at `TOP_GENRE_CAP`. Names fold to
 *  lowercase so `Rock` and `rock` count together. Pure. */
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

/** Bucket plays into 24 local-hour buckets, index = hour. Always
 *  returns all 24 buckets so the chart never shifts shape. Pure. */
export function bucketListeningClocks(plays: RecentPlay[]): ClockBucket[] {
  const buckets: ClockBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, plays: 0 }));
  for (const p of plays) {
    const h = new Date(p.playedAt).getHours();
    if (h >= 0 && h < 24) buckets[h].plays += 1;
  }
  return buckets;
}

const DAY_MS = 86400000;

/** Window a client-sliced range over timestamped recent plays. Tops
 *  carry no timestamps, so only streams filter: `today` keeps plays
 *  since local midnight, `week` the rolling 7 days, `fourWeeks` 28
 *  days, `sixMonths` 182 days, `year2026` plays since local Jan 1
 *  2026, `lifetime` everything. Bounds are inclusive; plays stamped
 *  after `now` are dropped as clock skew. Pure. */
export function sliceClientRange(args: {
  plays: RecentPlay[];
  range: ProfileRange;
  now?: number;
}): RecentPlay[] {
  const { plays, range } = args;
  const now =
    typeof args.now === "number" && Number.isFinite(args.now) ? args.now : Date.now();
  let start: number | null;
  switch (range) {
    case "today": {
      const d = new Date(now);
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      break;
    }
    case "week":
      start = now - 7 * DAY_MS;
      break;
    case "fourWeeks":
      start = now - 28 * DAY_MS;
      break;
    case "sixMonths":
      start = now - 182 * DAY_MS;
      break;
    case "year2026":
      start = new Date(2026, 0, 1).getTime();
      break;
    case "lifetime":
      start = null;
      break;
    default:
      return unreachableRange(range);
  }
  if (start === null) return plays.slice();
  return plays.filter((p) => p.playedAt >= start && p.playedAt <= now);
}
