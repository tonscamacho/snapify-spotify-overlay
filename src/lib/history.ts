import type { RecentPlay } from "./types";

/** Minimum listened milliseconds that counts as a stream. Rows under
 *  this are previews, not listens. */
export const HISTORY_MIN_MS = 30000;

/** History store schema version. Only v1 loads; anything else falls
 *  back to an empty store. */
export const HISTORY_STORE_VERSION = 1 as const;

/** Where a play came from. `api` is a live Spotify poll, `imported`
 *  is a row from a user-exported Extended history file. */
export type HistorySource = "api" | "imported";

/** A countable listen. A structural superset of `RecentPlay`: every
 *  extra field is optional, so existing `RecentPlay[]` callers keep
 *  compiling unchanged. */
export interface HistoryPlay extends RecentPlay {
  /** Original `ms_played`. Falls back to `durationMs` when absent. */
  msPlayed?: number;
  /** True when the export marks the row skipped. Kept rows use false. */
  skipped?: boolean;
  /** Origin of the row. Defaults to `api`. */
  source?: HistorySource;
}

/** One validated Extended-history row, after field allowlisting and
 *  before counting rules run. */
export interface ExtendedRow {
  playedAt: number;
  msPlayed: number;
  trackName: string;
  artistName: string;
  albumName: string;
  uri: string;
  skipped: boolean;
  reasonEnd: string | null;
}

/** Per-file import tallies. Every dropped row lands in exactly one
 *  bucket; `kept` plus the dropped buckets always sums to `total`. */
export interface ImportCounts {
  total: number;
  kept: number;
  droppedShort: number;
  droppedSkipped: number;
  droppedNoUri: number;
  droppedDuplicate: number;
  droppedInvalid: number;
}

/** Versioned local store. `importedRanges` names the import batches
 *  already merged, so repeat imports stay idempotent. */
export interface HistoryStore {
  version: 1;
  plays: HistoryPlay[];
  importedRanges: string[];
}

/** Why `syncAppend` kept or refused a single listen. */
export type SyncAppendReason =
  | "appended"
  | "duplicate"
  | "short"
  | "skipped"
  | "no-uri"
  | "future"
  | "invalid";

/** The outcome of one `syncAppend` call. */
export interface SyncAppendEvent {
  reason: SyncAppendReason;
  play: HistoryPlay | null;
}

/** The store plus the event from one `syncAppend` call. */
export interface SyncAppendResult {
  store: HistoryStore;
  event: SyncAppendEvent;
}

/** The plays plus the tallies from one `parseExtendedHistory` call. */
export interface ParsedExtendedHistory {
  plays: HistoryPlay[];
  counts: ImportCounts;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function resolveNow(now: unknown): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

/** Parse an export timestamp. Accepts ISO strings (`ts`), epoch
 *  millis numbers (`playedAt`), and all-digit millis strings (Rust
 *  `parse_ts_millis` parity). Returns NaN when nothing parses. */
function parseStamp(v: unknown): number {
  if (typeof v === "string") {
    const t = v.trim();
    if (t !== "" && /^\d+$/.test(t)) {
      const m = Number(t);
      return Number.isFinite(m) ? m : NaN;
    }
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : NaN;
  }
  const n = asFiniteNumber(v);
  return n === null ? NaN : n;
}

/** Track id from a `spotify:track:<id>` uri. Falls back to the raw
 *  uri when the shape is unexpected; callers drop empty uris first. */
function idFromUri(uri: string): string {
  const parts = uri.split(":");
  const last = parts[parts.length - 1] ?? "";
  return last !== "" ? last : uri;
}

/** Dedupe key. One uri at one timestamp is one listen. */
function playKey(uri: string, playedAt: number): string {
  return `${uri}@${playedAt}`;
}

/** Newest first, uri ascending on ties so the order is deterministic. */
function byNewestFirst(a: HistoryPlay, b: HistoryPlay): number {
  if (b.playedAt !== a.playedAt) return b.playedAt - a.playedAt;
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
}

function emptyCounts(total: number): ImportCounts {
  return { total, kept: 0, droppedShort: 0, droppedSkipped: 0, droppedNoUri: 0, droppedDuplicate: 0, droppedInvalid: 0 } satisfies ImportCounts;
}

/** Empty v1 store. The App poll hook starts here when no
 *  persisted store exists yet. */
export function emptyStore(): HistoryStore {
  return { version: HISTORY_STORE_VERSION, plays: [], importedRanges: [] } satisfies HistoryStore;
}

/** Allowlist one raw export entry. Accepts endsong rows and
 *  Streaming_History_Audio minimal rows; both use `ts`, `ms_played`,
 *  `master_metadata_*`, and `spotify_track_uri`. Unknown fields are
 *  ignored. Returns null when the stamp or the ms value does not
 *  parse; an empty uri stays on the row so the caller can tally it. */
function parseExtendedRow(v: unknown): ExtendedRow | null {
  if (!isRecord(v)) return null;
  const playedAt = parseStamp(v["ts"] ?? v["playedAt"] ?? v["played_at"]);
  if (!Number.isFinite(playedAt) || playedAt <= 0) return null;
  const ms = asFiniteNumber(v["ms_played"] ?? v["msPlayed"] ?? v["durationMs"]);
  if (ms === null || ms < 0) return null;
  // The uri may be empty here; the caller buckets empty uris
  // separately so the tally can tell them apart from bad rows.
  const uri = asTrimmedString(v["spotify_track_uri"] ?? v["uri"]);
  const reasonEnd = asTrimmedString(v["reason_end"] ?? v["reasonEnd"]);
  const skipped = v["skipped"] === true || reasonEnd === "fwdbtn";
  return {
    playedAt,
    msPlayed: ms,
    trackName: asTrimmedString(v["master_metadata_track_name"] ?? v["trackName"] ?? v["name"]) || "Unknown",
    artistName: asTrimmedString(v["master_metadata_album_artist_name"] ?? v["artists"] ?? v["artistName"]),
    albumName: asTrimmedString(v["master_metadata_album_album_name"] ?? v["albumName"]),
    uri,
    skipped,
    reasonEnd: reasonEnd === "" ? null : reasonEnd,
  };
}

function rowToPlay(row: ExtendedRow): HistoryPlay {
  return {
    trackId: idFromUri(row.uri),
    trackName: row.trackName,
    artists: row.artistName,
    playedAt: row.playedAt,
    image: null,
    uri: row.uri,
    durationMs: row.msPlayed,
    msPlayed: row.msPlayed,
    skipped: false,
    source: "imported" satisfies HistorySource,
  };
}

/** Parse an Extended-history file. Unknown input yields empty plays
 *  with zero counts; nothing here throws. Rules, in order: invalid
 *  rows out, empty uris out, plays under 30s out, skipped and
 *  forward-button rows out, repeats of `uri@playedAt` out. Survivors
 *  sort newest first. Future stamps count as invalid. */
export function parseExtendedHistory(raw: unknown, now?: number): ParsedExtendedHistory {
  const at = resolveNow(now);
  const rows = Array.isArray(raw) ? raw : [];
  const counts = emptyCounts(rows.length);
  if (!Array.isArray(raw)) return { plays: [], counts };
  const seen = new Set<string>();
  const plays: HistoryPlay[] = [];
  for (const entry of rows) {
    const row = parseExtendedRow(entry);
    if (row === null || row.playedAt > at) {
      counts.droppedInvalid += 1;
      continue;
    }
    // parseExtendedRow already rejects empty uris as null, but the
    // bucket must still distinguish them for the honesty tally.
    if (row.uri === "") {
      counts.droppedNoUri += 1;
      continue;
    }
    if (row.msPlayed < HISTORY_MIN_MS) {
      counts.droppedShort += 1;
      continue;
    }
    if (row.skipped) {
      counts.droppedSkipped += 1;
      continue;
    }
    const key = playKey(row.uri, row.playedAt);
    if (seen.has(key)) {
      counts.droppedDuplicate += 1;
      continue;
    }
    seen.add(key);
    plays.push(rowToPlay(row));
  }
  plays.sort(byNewestFirst);
  counts.kept = plays.length;
  return { plays, counts };
}

/** Coerce an unknown value to a countable play. Drops rows with no
 *  uri or no usable timestamp; fills display fallbacks for the rest.
 *  `playedAt` accepts numbers and all-digit millis strings (Rust
 *  `parse_ts_millis` parity). Never throws. */
function coercePlay(v: unknown): HistoryPlay | null {
  if (!isRecord(v)) return null;
  const uri = asTrimmedString(v["uri"]);
  if (uri === "") return null;
  const playedRaw = v["playedAt"];
  const playedAt =
    typeof playedRaw === "string" && playedRaw.trim() !== "" && /^\d+$/.test(playedRaw.trim())
      ? Number(playedRaw.trim())
      : asFiniteNumber(playedRaw);
  if (playedAt === null || !Number.isFinite(playedAt) || playedAt <= 0) return null;
  const durationMs = asFiniteNumber(v["durationMs"]) ?? 0;
  const msPlayed = asFiniteNumber(v["msPlayed"]) ?? durationMs;
  const skipped = v["skipped"] === true;
  const source = v["source"] === "imported" ? ("imported" satisfies HistorySource) : ("api" satisfies HistorySource);
  return {
    trackId: asTrimmedString(v["trackId"]) || idFromUri(uri),
    trackName: asTrimmedString(v["trackName"]) || "Unknown",
    artists: asTrimmedString(v["artists"]),
    playedAt,
    image: typeof v["image"] === "string" && (v["image"] as string) !== "" ? (v["image"] as string) : null,
    uri,
    durationMs,
    msPlayed,
    skipped,
    source,
  };
}

function toPlayList(v: unknown): HistoryPlay[] {
  const arr = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v["plays"]) ? (v["plays"] as unknown[]) : [];
  const out: HistoryPlay[] = [];
  for (const entry of arr) {
    const p = coercePlay(entry);
    if (p !== null) out.push(p);
  }
  return out;
}

function toRanges(v: unknown): string[] {
  if (!isRecord(v) || !Array.isArray(v["importedRanges"])) return [];
  const out: string[] = [];
  for (const r of v["importedRanges"] as unknown[]) {
    if (typeof r === "string" && r.trim() !== "" && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Merge two stores or play lists. Unknown sides become empty;
 *  nothing here throws. Base wins on key conflicts, so repeat
 *  imports are idempotent. Result sorts newest first. */
export function mergeHistory(base: unknown, incoming: unknown): HistoryStore {
  const seen = new Map<string, HistoryPlay>();
  for (const p of [...toPlayList(base), ...toPlayList(incoming)]) {
    const key = playKey(p.uri, p.playedAt);
    if (!seen.has(key)) seen.set(key, p);
  }
  const plays = [...seen.values()].sort(byNewestFirst);
  const importedRanges = [...toRanges(base), ...toRanges(incoming).filter((r) => !toRanges(base).includes(r))];
  return { version: HISTORY_STORE_VERSION, plays, importedRanges } satisfies HistoryStore;
}

/** Effective listened ms: the export value when present, else the
 *  track duration. NaN when neither parses. */
function effectiveMs(p: HistoryPlay): number {
  if (typeof p.msPlayed === "number" && Number.isFinite(p.msPlayed)) return p.msPlayed;
  if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs)) return p.durationMs;
  return NaN;
}

/** Append one poll-observed listen to a store. Pure: the input store
 *  is never mutated. Returns the store plus the reason, so the App
 *  poll hook can log without branching. Nothing here throws. */
export function syncAppend(store: unknown, listen: unknown, now?: number): SyncAppendResult {
  const at = resolveNow(now);
  const base = toPlayList(store);
  const ranges = toRanges(store);
  const invalid = {
    store: { version: HISTORY_STORE_VERSION, plays: base.sort(byNewestFirst), importedRanges: ranges } satisfies HistoryStore,
    event: { reason: "invalid" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
  } satisfies SyncAppendResult;
  if (!isRecord(listen)) return invalid;
  if (asTrimmedString(listen["uri"]) === "") {
    return {
      store: invalid.store,
      event: { reason: "no-uri" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
    } satisfies SyncAppendResult;
  }
  const play = coercePlay(listen);
  if (play === null) return invalid;
  if (play.playedAt > at) {
    return {
      store: invalid.store,
      event: { reason: "future" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
    } satisfies SyncAppendResult;
  }
  const ms = effectiveMs(play);
  if (!Number.isFinite(ms)) return invalid;
  if (ms < HISTORY_MIN_MS) {
    return {
      store: invalid.store,
      event: { reason: "short" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
    } satisfies SyncAppendResult;
  }
  if (play.skipped === true) {
    return {
      store: invalid.store,
      event: { reason: "skipped" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
    } satisfies SyncAppendResult;
  }
  const key = playKey(play.uri, play.playedAt);
  if (base.some((p) => playKey(p.uri, p.playedAt) === key)) {
    return {
      store: invalid.store,
      event: { reason: "duplicate" satisfies SyncAppendReason, play: null } satisfies SyncAppendEvent,
    } satisfies SyncAppendResult;
  }
  const plays = [...base, play].sort(byNewestFirst);
  return {
    store: { version: HISTORY_STORE_VERSION, plays, importedRanges: ranges } satisfies HistoryStore,
    event: { reason: "appended" satisfies SyncAppendReason, play } satisfies SyncAppendEvent,
  } satisfies SyncAppendResult;
}

/** Slice a store to an inclusive `[start, now]` window. `start` null
 *  means lifetime. Future stamps drop as clock skew. Unknown stores
 *  or args yield []. Store order is preserved. Nothing here throws. */
export function sliceStoreRange(store: unknown, args: unknown): HistoryPlay[] {
  if (!isRecord(args)) return [];
  const startRaw = args["start"];
  const start = startRaw === null ? null : asFiniteNumber(startRaw);
  if (startRaw !== null && start === null) return [];
  const at = resolveNow(args["now"]);
  return toPlayList(store).filter(
    (p) => (start === null || p.playedAt >= start) && p.playedAt <= at,
  );
}
