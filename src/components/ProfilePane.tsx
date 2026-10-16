import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, toThrottleError } from "../lib/spotify";
import { parseUserProfile } from "../lib/browse";
import {
  bucketListeningClocks,
  deriveStats,
  deriveTopGenres,
  deriveTopGenresRanked,
  parseRecentPlays,
  parseTopArtists,
  parseTopTracks,
  rangeHonestyNote,
  rangeStartForRange,
  toApiTimeRange,
  type ProfileArtist,
} from "../lib/profile";
import {
  emptyStore,
  HISTORY_IMPORT_MAX_BYTES,
  HISTORY_PAGE_SIZE,
  mergeHistory,
  parseExtendedHistory,
  type HistoryPlay,
  type HistoryStore,
  type ImportCounts,
} from "../lib/history";
import type { ClockBucket, ProfileRange, QueueItem, RecentPlay, TopGenre, UserProfile } from "../lib/types";
import { formatMs } from "../lib/lrc";
import { LikePlusIcon, PlayIcon } from "./icons";
import ListeningClocks from "./ListeningClocks";
import ProfileRangeMenu from "./ProfileRangeMenu";

interface Props {
  range: ProfileRange;
  /** Primary range setter (the shell persists + stores). */
  onRange: (r: ProfileRange) => void;
  /** Alias for the Batch 2b shell, which passes only range+onRangeChange. */
  onRangeChange?: (r: ProfileRange) => void;
  queuedCount?: number;
  /** True while the app is in a throttled episode. Rendered as a plain
   *  note (never `throttled-note`) so per-section Retry banners stay the
   *  only `throttled-note` nodes in the pane. */
  degraded?: boolean;
  onPlayContext: (uri: string) => void;
  onPlayUris: (uris: string[]) => void;
  onQueueAdd: (uri: string) => void;
  onError: (m: string) => void;
  onRetryPlayer: () => void;
}

/** Commit delay for range switches. Rapid picks settle on the last one:
 *  only the latest generation fires, so a burst costs one tops fetch. */
const RANGE_COMMIT_MS = 200;

/** One derived album row. Spotify has no top-albums endpoint, so albums
 *  come from a deeper top-tracks window (see ALBUM_WINDOW). */
interface AlbumEntry {
  name: string;
  image: string | null;
  uri: string;
}

/** Depth of the tracks window the album strip derives from. Top songs
 *  shows the top 10; albums mine the top 50 so the strip is not a copy
 *  of the songs list. */
const ALBUM_WINDOW = 50;

/** Lifetime threshold where the pane switches from the exact local
 *  slice (full store + recents in memory, precise for tests/small
 *  libraries) to Rust per-range aggregates + 100-row cursor pages.
 *  Small stores stay on the legacy path so existing specs keep their
 *  exact numbers; 191k/350k lifetimes ride aggregates and never hold
 *  the full array (heap bounded, render ≤~1k nodes). */
const AGGREGATE_THRESHOLD = 1000;

/** Per-range aggregates from Rust (`get_history_stats` extended):
 *  counts/minutes/hours/tracks/artists/albums + 24 clocks + peak +
 *  top-50 stream-weighted artist ranks. Single Rust derivation site. */
interface HistoryAggregates {
  total: number;
  totalMs: number;
  minutes: number;
  hours: number;
  uniqueTracks: number;
  uniqueArtists: number;
  uniqueAlbums: number;
  hasImported: boolean;
  clocks: ClockBucket[];
  peakHour: number;
  artistRanks: { artist: string; streams: number; minutes: number }[];
}

function coerceAggregates(raw: unknown): HistoryAggregates | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const clocksRaw = Array.isArray(r["clocks"]) ? (r["clocks"] as unknown[]) : [];
  const clocks: ClockBucket[] = Array.from({ length: 24 }, (_, hour) => {
    const found = clocksRaw.find(
      (b): b is Record<string, unknown> =>
        !!b && typeof b === "object" && (b as Record<string, unknown>)["hour"] === hour,
    );
    return {
      hour,
      plays: found ? num(found["plays"]) : 0,
      minutes: found ? num(found["minutes"]) : 0,
    };
  });
  const ranksRaw = Array.isArray(r["artistRanks"]) ? (r["artistRanks"] as unknown[]) : [];
  const artistRanks = ranksRaw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      artist: typeof x["artist"] === "string" ? (x["artist"] as string) : "",
      streams: num(x["streams"]),
      minutes: num(x["minutes"]),
    }))
    .filter((x) => x.artist !== "");
  return {
    total: num(r["total"]),
    totalMs: num(r["totalMs"]),
    minutes: num(r["minutes"]),
    hours: num(r["hours"]),
    uniqueTracks: num(r["uniqueTracks"]),
    uniqueArtists: num(r["uniqueArtists"]),
    uniqueAlbums: num(r["uniqueAlbums"]),
    hasImported: r["hasImported"] === true,
    clocks,
    peakHour: Math.min(23, Math.max(0, Math.floor(num(r["peakHour"])))),
    artistRanks,
  };
}

/** Stream-weighted genres from Rust artist ranks + fetched top artists.
 *  Mirrors `deriveStreamGenres` but reads precomputed ranks (no full
 *  slice needed), so 350k lifetimes still surface what was heard. */
function genresFromRanks(
  ranks: { artist: string; streams: number }[],
  artists: ProfileArtist[],
): TopGenre[] {
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
  for (const rank of ranks) {
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
    .slice(0, 5);
}

/** Recent-streams render page. The store holds lifetime truth uncapped
 *  (normalized Rust tracks + compact plays; 350k rows stay bounded),
 *  but every rendered row costs ~6 DOM nodes plus two listeners;
 *  rendering the whole slice at 50k rows measured +116MB and ~250k
 *  nodes. Stats/clocks/genres derive from Rust per-range aggregates
 *  over the full store (fallback: local `deriveStats` over the slice);
 *  the list holds only the current 100-row page (`pageHistoryPlays` /
 *  `get_history_page`), with an honest Showing-count note. Render nodes
 *  stay ≤~1k. Mirrors `HISTORY_PAGE_SIZE` in lib/history. */
export const RECENT_PAGE_SIZE = 100;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isQuotaMessage(m: string): boolean {
  return /quota-exceeded/i.test(m);
}

/** Unique albums from a top-tracks page, in first-seen order. Entries
 *  without an album name are dropped; image keeps the first usable url. */
function parseTopAlbums(raw: unknown): AlbumEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: AlbumEntry[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    const album = t["album"];
    if (!album || typeof album !== "object") continue;
    const a = album as Record<string, unknown>;
    const name = typeof a["name"] === "string" ? a["name"] : "";
    if (name === "") continue;
    const id = typeof a["id"] === "string" && a["id"] !== "" ? (a["id"] as string) : `name:${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let image: string | null = null;
    const images = a["images"];
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img && typeof img === "object") {
          const url = (img as Record<string, unknown>)["url"];
          if (typeof url === "string" && url !== "") {
            image = url;
            break;
          }
        }
      }
    }
    out.push({
      name,
      image,
      uri: typeof a["uri"] === "string" ? (a["uri"] as string) : "",
    });
  }
  return out;
}

function formatPeakHour(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const n = h % 12 === 0 ? 12 : h % 12;
  return `${n} ${suffix}`;
}

function formatStreamTime(playedAt: number): string {
  try {
    return new Date(playedAt).toLocaleString();
  } catch {
    return "";
  }
}

interface SectionState<T> {
  items: T;
  error: string | null;
  loading: boolean;
}

function idleSection<T>(items: T): SectionState<T> {
  return { items, error: null, loading: true };
}

/**
 * Signed-in profile stats. Presentational apart from fetching: the range
 * lives in the shell (persisted beside the other display prefs) and all
 * derivations run through lib/profile, so every number on screen traces
 * to a pure helper. Client-sliced ranges (today/week/2026) carry the
 * verbatim honesty note; direct ranges owe no disclaimer.
 */
export default function ProfilePane(p: Props) {
  const {
    range,
    onRange,
    onRangeChange,
    queuedCount,
    degraded,
    onPlayContext,
    onPlayUris,
    onQueueAdd,
    onError,
    onRetryPlayer,
  } = p;
  const [me, setMe] = useState<UserProfile | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [songs, setSongs] = useState<SectionState<QueueItem[]>>(() => idleSection([]));
  const [artists, setArtists] = useState<SectionState<ProfileArtist[]>>(() => idleSection([]));
  const [albums, setAlbums] = useState<SectionState<AlbumEntry[]>>(() => idleSection([]));
  const [recents, setRecents] = useState<SectionState<RecentPlay[]>>(() => idleSection([]));
  // Local history store: imported Extended-history rows plus the live
  // recents merge below. Seeded empty; get_history_stats flips hasImported
  // once on mount, imports merge via mergeHistory. Small libraries stay
  // on this exact path; lifetimes over AGGREGATE_THRESHOLD switch to
  // Rust aggregates + cursor pages (never the full array). Never throws.
  const [store, setStore] = useState<HistoryStore>(() => emptyStore());
  const [aggregates, setAggregates] = useState<HistoryAggregates | null>(null);
  const [useAggregates, setUseAggregates] = useState(false);
  const [pageItems, setPageItems] = useState<HistoryPlay[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [pageTotal, setPageTotal] = useState(0);
  const [hasImported, setHasImported] = useState(false);
  const [importCounts, setImportCounts] = useState<ImportCounts | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Multi-file import notes: per-file read/parse/skip failures plus the
  // file count. Rendered in the existing import slot beside the tally,
  // so no new banner class enters the pane.
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [importFiles, setImportFiles] = useState<number | null>(null);
  // Visible Recent-streams rows. Resets on range/store changes below so a
  // narrower slice or a fresh import never strands a stale deep page.
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE_SIZE);

  // Generation guard: every tops round takes a number; only the latest
  // commits, so StrictMode remounts and rapid range bursts never paint
  // stale windows. Retry clicks take a fresh number for the same reason.
  const genRef = useRef(0);
  const rangeRef = useRef<ProfileRange>(range);
  rangeRef.current = range;

  const reportSectionError = useCallback(
    (m: string) => {
      // Throttles surface as per-section banners with Retry; the shell
      // latch (degraded + toast) is only for non-throttle failures so a
      // 429 never parks the whole app in a degraded episode.
      if (toThrottleError(m) === null) onError(m);
    },
    [onError],
  );

  const fetchMe = useCallback(async () => {
    setMeLoading(true);
    setMeError(null);
    try {
      const u = parseUserProfile(await api.me());
      if (u) {
        setMe(u);
        setMeError(null);
      } else {
        setMeError("Spotify returned an empty profile.");
      }
    } catch (e) {
      const m = messageOf(e);
      setMeError(m);
      reportSectionError(m);
    } finally {
      setMeLoading(false);
    }
  }, [reportSectionError]);

  const fetchRecents = useCallback(async () => {
    setRecents((s) => ({ ...s, loading: true }));
    try {
      const items = parseRecentPlays(await api.recent(50));
      setRecents({ items, error: null, loading: false });
    } catch (e) {
      const m = messageOf(e);
      setRecents((s) => ({ ...s, error: m, loading: false }));
      reportSectionError(m);
    }
  }, [reportSectionError]);

  const fetchSongs = useCallback(
    async (r: ProfileRange, gen: number) => {
      setSongs((s) => ({ ...s, loading: true }));
      try {
        const items = parseTopTracks(await api.top("tracks", 10, 0, toApiTimeRange(r)));
        if (gen !== genRef.current) return;
        setSongs({ items, error: null, loading: false });
      } catch (e) {
        if (gen !== genRef.current) return;
        const m = messageOf(e);
        setSongs((s) => ({ ...s, error: m, loading: false }));
        reportSectionError(m);
      }
    },
    [reportSectionError],
  );

  const fetchArtists = useCallback(
    async (r: ProfileRange, gen: number) => {
      setArtists((s) => ({ ...s, loading: true }));
      try {
        const items = parseTopArtists(await api.top("artists", 10, 0, toApiTimeRange(r)));
        if (gen !== genRef.current) return;
        setArtists({ items, error: null, loading: false });
      } catch (e) {
        if (gen !== genRef.current) return;
        const m = messageOf(e);
        setArtists((s) => ({ ...s, error: m, loading: false }));
        reportSectionError(m);
      }
    },
    [reportSectionError],
  );

  const fetchAlbums = useCallback(
    async (r: ProfileRange, gen: number) => {
      setAlbums((s) => ({ ...s, loading: true }));
      try {
        const items = parseTopAlbums(await api.top("tracks", ALBUM_WINDOW, 0, toApiTimeRange(r)));
        if (gen !== genRef.current) return;
        setAlbums({ items, error: null, loading: false });
      } catch (e) {
        if (gen !== genRef.current) return;
        const m = messageOf(e);
        setAlbums((s) => ({ ...s, error: m, loading: false }));
        reportSectionError(m);
      }
    },
    [reportSectionError],
  );

  // Mount: identity + streams + history flag once. Tops ride the range
  // effect below so the first paint and every switch share one debounced
  // path. The live flag drops the StrictMode remount's first round;
  // invokes already sent are idempotent reads.
  useEffect(() => {
    let live = true;
    void (async () => {
      setMeLoading(true);
      setMeError(null);
      try {
        const u = parseUserProfile(await api.me());
        if (!live) return;
        if (u) setMe(u);
        else setMeError("Spotify returned an empty profile.");
      } catch (e) {
        if (!live) return;
        const m = messageOf(e);
        setMeError(m);
        if (toThrottleError(m) === null) onError(m);
      } finally {
        if (live) setMeLoading(false);
      }
    })();
    void (async () => {
      try {
        const items = parseRecentPlays(await api.recent(50));
        if (!live) return;
        setRecents({ items, error: null, loading: false });
      } catch (e) {
        if (!live) return;
        const m = messageOf(e);
        setRecents((s) => ({ ...s, error: m, loading: false }));
        if (toThrottleError(m) === null) onError(m);
      }
    })();
    // History once: aggregates name imports and decide the data path.
    // Small libraries load the full play list and derive exactly (legacy
    // path, keeps specs exact); lifetimes over the threshold hold only
    // aggregates + the first 100-row page (heap bounded, render ≤~1k).
    // Best-effort; a missing Rust side keeps hasImported false.
    void (async () => {
      let agg: HistoryAggregates | null = null;
      try {
        const raw = await invoke<unknown>("get_history_stats", {
          start: null,
          now: Date.now(),
        });
        if (!live) return;
        agg = coerceAggregates(raw);
        if (agg) {
          setAggregates(agg);
          if (agg.hasImported) setHasImported(true);
          if (raw && typeof raw === "object") {
            const imported = (raw as Record<string, unknown>)["importedRanges"];
            if (Array.isArray(imported) && imported.length > 0) setHasImported(true);
          }
        } else if (raw && typeof raw === "object") {
          const flag = (raw as Record<string, unknown>)["hasImported"];
          if (flag === true) setHasImported(true);
          const imported = (raw as Record<string, unknown>)["importedRanges"];
          if (Array.isArray(imported) && imported.length > 0) setHasImported(true);
        }
      } catch {
        // History never breaks the pane.
      }
      const lifetimeTotal = agg?.total ?? 0;
      if (lifetimeTotal > AGGREGATE_THRESHOLD) {
        // Large lifetime: aggregates + first page only, never the full array.
        if (!live) return;
        setUseAggregates(true);
        try {
          const page = await invoke<unknown>("get_history_page", {
            start: null,
            now: Date.now(),
            cursor: null,
            limit: HISTORY_PAGE_SIZE,
          });
          if (!live) return;
          if (page && typeof page === "object") {
            const rec = page as Record<string, unknown>;
            const items = Array.isArray(rec["items"]) ? (rec["items"] as HistoryPlay[]) : [];
            setPageItems(items);
            setPageCursor(typeof rec["nextCursor"] === "string" ? (rec["nextCursor"] as string) : null);
            setPageTotal(typeof rec["total"] === "number" ? (rec["total"] as number) : items.length);
          }
        } catch {
          // Paging never breaks the pane.
        }
        return;
      }
      try {
        const stored = await invoke<unknown>("get_history_plays");
        if (!live) return;
        if (stored && typeof stored === "object") {
          const next = mergeHistory(emptyStore(), stored);
          if (next.plays.length > 0 || next.importedRanges.length > 0) {
            setStore(next);
          }
          if (next.importedRanges.length > 0) setHasImported(true);
        }
      } catch {
        // History never breaks the pane.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Large-lifetime range effect: refetch per-range aggregates + first
  // page on every range switch (debounced with the tops fetch below).
  // Small libraries stay on the exact local slice and skip these calls.
  useEffect(() => {
    if (!useAggregates) return;
    let live = true;
    const t = window.setTimeout(() => {
      void (async () => {
        const now = Date.now();
        const start = rangeStartForRange(range, now);
        try {
          const raw = await invoke<unknown>("get_history_stats", { start, now });
          if (!live) return;
          const agg = coerceAggregates(raw);
          if (agg) {
            setAggregates(agg);
            if (agg.hasImported) setHasImported(true);
          }
        } catch {
          // Aggregates never break the pane.
        }
        try {
          const page = await invoke<unknown>("get_history_page", {
            start,
            now,
            cursor: null,
            limit: HISTORY_PAGE_SIZE,
          });
          if (!live) return;
          if (page && typeof page === "object") {
            const rec = page as Record<string, unknown>;
            const items = Array.isArray(rec["items"]) ? (rec["items"] as HistoryPlay[]) : [];
            setPageItems(items);
            setPageCursor(typeof rec["nextCursor"] === "string" ? (rec["nextCursor"] as string) : null);
            setPageTotal(typeof rec["total"] === "number" ? (rec["total"] as number) : items.length);
          }
        } catch {
          // Paging never breaks the pane.
        }
      })();
    }, RANGE_COMMIT_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [range, useAggregates]);

  // Range effect: debounce the commit, then refetch the three tops
  // windows concurrently. Each window keeps its own error state so one
  // 429 degrades only its section; stale lists stay until replaced.
  // Deps are the range plus the (shell-stable) fetchers, so App polls
  // and toasts never reset the guard timer.
  useEffect(() => {
    const gen = ++genRef.current;
    const r = range;
    const t = window.setTimeout(() => {
      void fetchSongs(r, gen);
      void fetchArtists(r, gen);
      void fetchAlbums(r, gen);
    }, RANGE_COMMIT_MS);
    return () => window.clearTimeout(t);
  }, [range, fetchSongs, fetchArtists, fetchAlbums]);

  // Per-section retries refetch only their window (fresh generation so a
  // late range round cannot overwrite the recovery).
  const retrySongs = useCallback(
    () => void fetchSongs(rangeRef.current, ++genRef.current),
    [fetchSongs],
  );
  const retryArtists = useCallback(
    () => void fetchArtists(rangeRef.current, ++genRef.current),
    [fetchArtists],
  );
  const retryAlbums = useCallback(
    () => void fetchAlbums(rangeRef.current, ++genRef.current),
    [fetchAlbums],
  );

  const changeRange = useCallback(
    (r: ProfileRange) => {
      if (r === rangeRef.current) return;
      onRange(r);
      onRangeChange?.(r);
    },
    [onRange, onRangeChange],
  );

  // Import Extended history: dialog multi-pick -> one Rust-side read
  // per path -> a single import_history with the combined rows, so
  // cross-file dedupe/tally is one transaction. The bytes never cross
  // a frontend fs read, so the frontend fs scope stays tight at
  // $APPLOCALDATA. Merges parsed plays locally for instant stats;
  // counts + per-file notes render in the throttle slot so no new
  // banner class enters the pane. Files over 25MB are skipped with a
  // note; a bad file never aborts the rest.
  const handleImport = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const picked = await dialog.open({
        multiple: true,
        filters: [{ name: "Spotify history", extensions: ["json"] }],
      });
      if (!picked) return;
      const paths = (Array.isArray(picked) ? picked : [picked]).filter(
        (v): v is string => typeof v === "string" && v !== "",
      );
      if (paths.length === 0) return;
      const notes: string[] = [];
      const batches: string[] = [];
      const combined: unknown[] = [];
      for (const path of paths) {
        const base = path.split(/[\\/]/).pop() ?? "import";
        let text: string;
        try {
          text = await invoke<string>("read_history_file", { path });
        } catch (e) {
          notes.push(`${base}: ${messageOf(e)}`);
          continue;
        }
        if (text.length > HISTORY_IMPORT_MAX_BYTES) {
          notes.push(`${base}: skipped, file over 25MB`);
          continue;
        }
        let rows: unknown;
        try {
          rows = JSON.parse(text);
        } catch {
          notes.push(`${base}: not valid JSON`);
          continue;
        }
        const arr = Array.isArray(rows) ? rows : [];
        if (arr.length === 0) {
          notes.push(`${base}: no rows`);
          continue;
        }
        batches.push(base);
        combined.push(...arr);
      }
      setImportFiles(paths.length);
      setImportNotes(notes);
      if (combined.length === 0) {
        if (notes.length === 0) setImportError("No history rows found.");
        return;
      }
      const parsed = parseExtendedHistory(combined, Date.now());
      try {
        const counts = await invoke<ImportCounts>("import_history", {
          rows: combined,
          batch: batches.join(", "),
        });
        setImportCounts(counts);
      } catch (e) {
        setImportError(messageOf(e));
        return;
      }
      if (parsed.plays.length > 0) {
        setStore((prev) => mergeHistory(prev, parsed.plays));
      }
      // A non-empty import always names itself in the honesty note, even
      // when the Rust stats round-trip is mocked to null in web tests.
      if (parsed.plays.length > 0 || parsed.counts.kept > 0) setHasImported(true);
      try {
        const raw = await invoke<unknown>("get_history_stats", { start: null, now: Date.now() });
        if (raw && typeof raw === "object") {
          const agg = coerceAggregates(raw);
          if (agg) {
            setAggregates(agg);
            if (agg.hasImported) setHasImported(true);
            // Cross the threshold mid-session (e.g. the 191k import):
            // switch to aggregates + first page and stop holding the array.
            if (agg.total > AGGREGATE_THRESHOLD) {
              setUseAggregates(true);
              const now = Date.now();
              const start = rangeStartForRange(rangeRef.current, now);
              try {
                const page = await invoke<unknown>("get_history_page", {
                  start,
                  now,
                  cursor: null,
                  limit: HISTORY_PAGE_SIZE,
                });
                if (page && typeof page === "object") {
                  const rec = page as Record<string, unknown>;
                  const items = Array.isArray(rec["items"]) ? (rec["items"] as HistoryPlay[]) : [];
                  setPageItems(items);
                  setPageCursor(typeof rec["nextCursor"] === "string" ? (rec["nextCursor"] as string) : null);
                  setPageTotal(typeof rec["total"] === "number" ? (rec["total"] as number) : items.length);
                }
              } catch {
                // Paging never breaks the import.
              }
            }
          } else if ((raw as Record<string, unknown>)["hasImported"] === true) {
            setHasImported(true);
          }
        }
      } catch {
        // Flag already set from the local parse.
      }
      // When the file held no countable rows, still surface the tally so
      // an empty import never looks like a silent no-op.
      if (parsed.plays.length === 0) {
        setImportCounts(parsed.counts);
      }
    } catch (e) {
      setImportError(messageOf(e));
    } finally {
      setImporting(false);
    }
  }, []);

  // Store slice for stats/clocks: Rust imports first, live recents merged
  // in with uri@playedAt dedupe. Empty store keeps the exact recents-only
  // numbers the pane shipped with.
  const combinedPlays = useMemo<HistoryPlay[]>(() => {
    const recentsHist: HistoryPlay[] = recents.items.map((r) => ({
      trackId: r.trackId,
      trackName: r.trackName,
      artists: r.artists,
      playedAt: r.playedAt,
      image: r.image,
      uri: r.uri,
      durationMs: r.durationMs,
      msPlayed: r.durationMs,
      skipped: false,
      source: "api" as const,
    }));
    const seen = new Set<string>();
    for (const pl of store.plays) seen.add(`${pl.uri}@${pl.playedAt}`);
    const extra: HistoryPlay[] = [];
    for (const pl of recentsHist) {
      const key = `${pl.uri}@${pl.playedAt}`;
      if (!seen.has(key)) {
        seen.add(key);
        extra.push(pl);
      }
    }
    return [...store.plays, ...extra];
  }, [store.plays, recents.items]);

  const sliced = useMemo(() => {
    const now = Date.now();
    const start = rangeStartForRange(range, now);
    // Filter the already-coerced combined list directly: routing through
    // sliceStoreRange would re-coerce every row into fresh objects (one
    // more full-size copy per derivation). Same window semantics —
    // inclusive [start, now], future stamps dropped as clock skew.
    return combinedPlays.filter(
      (pl) => (start === null || pl.playedAt >= start) && pl.playedAt <= now,
    );
  }, [combinedPlays, range]);
  // A new window or a changed store resets the list pager; the effect
  // keys on the slice length (not the array identity) so repolls that
  // rebuild the array without adding rows keep the user's page.
  useEffect(() => setRecentLimit(RECENT_PAGE_SIZE), [range, sliced.length]);
  const visibleRecents = useMemo(
    () => sliced.slice(0, recentLimit),
    [sliced, recentLimit],
  );
  // Stats/clocks/genres: exact local slice for small libraries; Rust
  // per-range aggregates (same 30s/skipped-long/dedupe rules) for
  // lifetimes over the threshold — no full array in memory.
  const stats = useMemo(() => {
    if (useAggregates && aggregates) {
      return {
        plays: aggregates.total,
        minutes: aggregates.minutes,
        hours: aggregates.hours,
        uniqueTracks: aggregates.uniqueTracks,
        uniqueArtists: aggregates.uniqueArtists,
        uniqueAlbums: aggregates.uniqueAlbums,
      };
    }
    return deriveStats(sliced);
  }, [useAggregates, aggregates, sliced]);
  // Most-streamed genres: the slice ranks artists by counted streams and
  // joins genres from the fetched top artists, so an import (or a thin
  // tops window) still surfaces what was actually heard. Without a match
  // this falls back to the plain top-artists count; the strip stays empty
  // only when no genre data exists anywhere. Large lifetimes join the
  // precomputed Rust ranks instead of scanning the slice.
  const genres = useMemo(() => {
    if (useAggregates && aggregates) {
      const weighted = genresFromRanks(aggregates.artistRanks, artists.items);
      if (weighted.length > 0) return weighted;
      return deriveTopGenres(artists.items);
    }
    return deriveTopGenresRanked({ plays: sliced, artists: artists.items });
  }, [useAggregates, aggregates, sliced, artists.items]);
  const clocks = useMemo(() => {
    if (useAggregates && aggregates) return aggregates.clocks;
    return bucketListeningClocks(sliced);
  }, [useAggregates, aggregates, sliced]);
  const peakHour = useMemo(() => {
    if (useAggregates && aggregates) return aggregates.peakHour;
    let best = 0;
    for (let h = 1; h < 24; h += 1) {
      if (clocks[h].plays > clocks[best].plays) best = h;
    }
    return best;
  }, [useAggregates, aggregates, clocks]);

  // Next-page loader for large lifetimes: cursor paging appends the next
  // 100 rows without ever holding the full store (render stays ≤~1k).
  const loadMorePage = useCallback(async () => {
    if (!pageCursor) return;
    const now = Date.now();
    const start = rangeStartForRange(rangeRef.current, now);
    try {
      const page = await invoke<unknown>("get_history_page", {
        start,
        now,
        cursor: pageCursor,
        limit: HISTORY_PAGE_SIZE,
      });
      if (page && typeof page === "object") {
        const rec = page as Record<string, unknown>;
        const items = Array.isArray(rec["items"]) ? (rec["items"] as HistoryPlay[]) : [];
        if (items.length > 0) setPageItems((prev) => [...prev, ...items]);
        setPageCursor(typeof rec["nextCursor"] === "string" ? (rec["nextCursor"] as string) : null);
      }
    } catch {
      // Paging never breaks the list.
    }
  }, [pageCursor]);
  const honesty = rangeHonestyNote(range, { hasImported });
  const topGenre = genres.length > 0 ? genres[0].genre : null;

  // Same copy contract as the shared pane banner (quota vs rate), kept
  // inline so this module never pulls the BrowsePane import chain into
  // unit-test renders.
  const renderThrottle = (error: string | null, onRetry: () => void) => {
    if (error === null) return null;
    const quota = isQuotaMessage(error);
    const throttled = toThrottleError(error) !== null;
    return (
      <div className="throttled-note" role="status">
        <span>
          {quota
            ? "Spotify quota hit — cooling down."
            : throttled
              ? "Spotify throttled — retrying in background."
              : error}
        </span>
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  };

  const skeletons = (label: string) => (
    <div aria-label={label} role="status">
      <div className="skel skel-row" />
      <div className="skel skel-row" />
      <div className="skel skel-row" />
    </div>
  );

  return (
    <>
      {queuedCount != null && queuedCount > 0 && (
        <div className="throttled-note" role="status">
          <span>
            Queued — will send after cooldown{queuedCount > 1 ? ` (${queuedCount})` : ""}.
          </span>
        </div>
      )}
      {degraded === true && (
        <div className="dim" role="status">
          <span>Spotify throttled — showing last updated content.</span>{" "}
          <button className="btn sm" onClick={onRetryPlayer}>
            Retry player
          </button>
        </div>
      )}

      {me ? (
        <div className="detail-head">
          {me.image && <img src={me.image} alt="" loading="lazy" decoding="async" />}
          <div>
            <div className="detail-title">{me.name}</div>
            <div className="dim">{me.accountId}</div>
          </div>
        </div>
      ) : meLoading ? (
        <div className="skel skel-head" aria-hidden="true" />
      ) : (
        meError && (
          <div className="throttled-note" role="status">
            <span>{meError}</span>
            <button className="btn sm" onClick={() => void fetchMe()}>
              Retry
            </button>
          </div>
        )
      )}

      <div className="range-menu">
        <label id="profile-range-label">Timeframe</label>
        <ProfileRangeMenu value={range} onChange={changeRange} labelId="profile-range-label" />
      </div>
      {honesty && (
        <div className="dim" role="note">
          {honesty}
        </div>
      )}
      <div className="search-wrap">
        <button className="btn sm" onClick={() => void handleImport()} disabled={importing}>
          {importing ? "Importing…" : "Import history"}
        </button>
        {importCounts && (
          <span className="dim" role="status">
            {`Imported ${importCounts.kept} of ${importCounts.total}${importFiles !== null && importFiles > 1 ? ` across ${importFiles} files` : ""} (${importCounts.droppedShort} short, ${importCounts.droppedSkipped} skipped, ${importCounts.droppedNoUri} no-uri, ${importCounts.droppedDuplicate} dupes, ${importCounts.droppedInvalid} invalid).`}
          </span>
        )}
        {importNotes.length > 0 && (
          <span className="dim" role="status">
            {importNotes.join("; ")}
          </span>
        )}
      </div>
      {importError && (
        <div className="throttled-note" role="status">
          <span>{importError}</span>
          <button className="btn sm" onClick={() => setImportError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="pane-subhead profile-subhead">Stats</div>
      <div className="profile-tiles">
        <div className="profile-tile">
          <div className="num">{`${stats.plays} stream${stats.plays === 1 ? "" : "s"}`}</div>
          <div className="lbl">Streams</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.minutes}</div>
          <div className="lbl">Minutes</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.hours}</div>
          <div className="lbl">Hours</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.uniqueTracks}</div>
          <div className="lbl">Tracks</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.uniqueArtists}</div>
          <div className="lbl">Artists</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.uniqueAlbums}</div>
          <div className="lbl">Albums</div>
        </div>
        <div className="profile-tile">
          <div className="num">{topGenre ?? "—"}</div>
          <div className="lbl">Top genre</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.plays > 0 ? formatPeakHour(peakHour) : "—"}</div>
          <div className="lbl">Peak hour</div>
        </div>
      </div>

      <div className="pane-subhead profile-subhead">Top genres</div>
      {genres.length > 0 ? (
        <div className="profile-chips">
          {genres.map((g) => (
            <span key={g.genre} className="profile-chip">
              {`${g.genre} · ${g.count}`}
            </span>
          ))}
        </div>
      ) : (
        !artists.loading && <div className="dim">No genres yet.</div>
      )}

      <div className="pane-subhead profile-subhead">Listening clocks</div>
      <ListeningClocks buckets={clocks} />

      <div className="pane-subhead profile-subhead">Top songs</div>
      {renderThrottle(songs.error, retrySongs)}
      {songs.items.length > 0 ? (
        <ol className="queue">
          {songs.items.map((t, i) => (
            <li className="q" key={`ps-${t.uri}-${i}`} title={t.uri}>
              <span className="q-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="q-name">
                {t.name}
                {t.artists && <small>{t.artists}</small>}
              </span>
              <span className="q-time">{formatMs(t.durationMs)}</span>
              <button
                className="icon-btn sm row-act"
                onClick={() => onPlayUris([t.uri])}
                title={`Play ${t.name}`}
                aria-label={`Play ${t.name}`}
              >
                <PlayIcon size={13} />
              </button>
              <button
                className="icon-btn sm row-act"
                onClick={() => onQueueAdd(t.uri)}
                title={`Queue ${t.name}`}
                aria-label={`Queue ${t.name}`}
              >
                <LikePlusIcon size={13} />
              </button>
            </li>
          ))}
        </ol>
      ) : songs.loading ? (
        skeletons("Loading top songs")
      ) : (
        !songs.error && (
          <div className="empty">
            <div className="empty-title">No top songs</div>
            <div className="empty-sub">Spotify has nothing ranked here yet.</div>
          </div>
        )
      )}

      <div className="pane-subhead profile-subhead">Top artists</div>
      {renderThrottle(artists.error, retryArtists)}
      {artists.items.length > 0 ? (
        <ol className="queue">
          {artists.items.map((a) => (
            <li className="q" key={`pa-${a.id}`} title={a.uri}>
              <span className="browse-thumb profile-thumb" aria-hidden="true">
                {a.image ? <img src={a.image} alt="" loading="lazy" decoding="async" /> : null}
              </span>
              <span className="q-name">
                {a.name}
                {a.genres.length > 0 && <small>{a.genres.slice(0, 3).join(", ")}</small>}
              </span>
              {a.uri !== "" && (
                <button
                  className="icon-btn sm row-act"
                  onClick={() => onPlayContext(a.uri)}
                  title={`Play ${a.name}`}
                  aria-label={`Play ${a.name}`}
                >
                  <PlayIcon size={13} />
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : artists.loading ? (
        skeletons("Loading top artists")
      ) : (
        !artists.error && (
          <div className="empty">
            <div className="empty-title">No top artists</div>
            <div className="empty-sub">Spotify has nothing ranked here yet.</div>
          </div>
        )
      )}

      <div className="pane-subhead profile-subhead">Top albums · from top songs</div>
      {renderThrottle(albums.error, retryAlbums)}
      {albums.items.length > 0 ? (
        <ol className="queue">
          {albums.items.map((a, i) => (
            <li className="q" key={`pal-${a.name}-${i}`} title={a.uri}>
              <span className="browse-thumb profile-thumb" aria-hidden="true">
                {a.image ? <img src={a.image} alt="" loading="lazy" decoding="async" /> : null}
              </span>
              <span className="q-name">
                {a.name}
                <small>Album</small>
              </span>
              {a.uri !== "" && (
                <button
                  className="icon-btn sm row-act"
                  onClick={() => onPlayContext(a.uri)}
                  title={`Play ${a.name}`}
                  aria-label={`Play ${a.name}`}
                >
                  <PlayIcon size={13} />
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : albums.loading ? (
        skeletons("Loading top albums")
      ) : (
        !albums.error && (
          <div className="empty">
            <div className="empty-title">No top albums</div>
            <div className="empty-sub">Spotify has nothing ranked here yet.</div>
          </div>
        )
      )}

      <div className="pane-subhead profile-subhead">Recent streams</div>
      {renderThrottle(recents.error, () => void fetchRecents())}
      {useAggregates ? (
        pageItems.length > 0 ? (
          <>
            <ol className="queue">
              {pageItems.map((r) => (
                <li className="q" key={`pr-${r.trackId}-${r.playedAt}`} title={r.uri}>
                  <span className="q-name">
                    {r.trackName}
                    {r.artists && <small>{r.artists}</small>}
                  </span>
                  <span className="q-time">{formatStreamTime(r.playedAt)}</span>
                  {r.uri !== "" && (
                    <>
                      <button
                        className="icon-btn sm row-act"
                        onClick={() => onPlayUris([r.uri])}
                        title={`Play ${r.trackName}`}
                        aria-label={`Play ${r.trackName}`}
                      >
                        <PlayIcon size={13} />
                      </button>
                      <button
                        className="icon-btn sm row-act"
                        onClick={() => onQueueAdd(r.uri)}
                        title={`Queue ${r.trackName}`}
                        aria-label={`Queue ${r.trackName}`}
                      >
                        <LikePlusIcon size={13} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ol>
            {pageCursor !== null && (
              <div className="search-wrap">
                <span className="dim" role="status">
                  {`Showing ${pageItems.length} of ${pageTotal} streams.`}
                </span>
                <button className="btn sm" onClick={() => void loadMorePage()}>
                  Show more
                </button>
              </div>
            )}
          </>
        ) : recents.loading ? (
          skeletons("Loading recent streams")
        ) : (
          !recents.error && (
            <div className="empty">
              <div className="empty-title">No recent streams</div>
              <div className="empty-sub">Plays in this range show up here.</div>
            </div>
          )
        )
      ) : sliced.length > 0 ? (
        <>
          <ol className="queue">
            {visibleRecents.map((r) => (
              <li className="q" key={`pr-${r.trackId}-${r.playedAt}`} title={r.uri}>
                <span className="q-name">
                  {r.trackName}
                  {r.artists && <small>{r.artists}</small>}
                </span>
                <span className="q-time">{formatStreamTime(r.playedAt)}</span>
                {r.uri !== "" && (
                  <>
                    <button
                      className="icon-btn sm row-act"
                      onClick={() => onPlayUris([r.uri])}
                      title={`Play ${r.trackName}`}
                      aria-label={`Play ${r.trackName}`}
                    >
                      <PlayIcon size={13} />
                    </button>
                    <button
                      className="icon-btn sm row-act"
                      onClick={() => onQueueAdd(r.uri)}
                      title={`Queue ${r.trackName}`}
                      aria-label={`Queue ${r.trackName}`}
                    >
                      <LikePlusIcon size={13} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
          {sliced.length > visibleRecents.length && (
            <div className="search-wrap">
              <span className="dim" role="status">
                {`Showing ${visibleRecents.length} of ${sliced.length} streams.`}
              </span>
              <button
                className="btn sm"
                onClick={() => setRecentLimit((n) => n + RECENT_PAGE_SIZE)}
              >
                Show more
              </button>
            </div>
          )}
        </>
      ) : recents.loading ? (
        skeletons("Loading recent streams")
      ) : (
        !recents.error && (
          <div className="empty">
            <div className="empty-title">No recent streams</div>
            <div className="empty-sub">Plays in this range show up here.</div>
          </div>
        )
      )}
    </>
  );
}
