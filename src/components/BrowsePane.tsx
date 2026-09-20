import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/spotify";
import {
  parseArtistDetail,
  parseAlbumDetail,
  parseAudiobookDetail,
  parseChapterDetail,
  parseEpisodeDetail,
  parseFollowedArtists,
  parsePlaylistDetail,
  parsePlaylistItems,
  parsePlaylistPage,
  parseSavedAlbums,
  parseSavedAudiobooks,
  parseSavedEpisodes,
  parseSavedShows,
  parseSavedTracks,
  parseSearch,
  parseShowDetail,
  parseTrackDetail,
  parseUserProfile,
  scopeHint,
  toLibraryItem,
  SEARCH_PAGE,
} from "../lib/browse";
import { usePagedList } from "../lib/usePagedList";
import type {
  BrowseEntry,
  BrowseState,
  DetailData,
  LibraryItem,
  QueueItem,
  SearchResults,
  UserProfile,
} from "../lib/types";
import { formatMs } from "../lib/lrc";
import { LikePlusIcon, OpenIcon, PlayIcon, RefreshIcon } from "./icons";
import SpotifyMark from "./SpotifyMark";

type LibTab = "playlists" | "albums" | "tracks" | "artists" | "shows" | "episodes" | "audiobooks";

/** The seven library sections. Buttons render wide; the select below
 *  renders under a 380 px container (same values, tablist kept wide). */
const LIB_TABS: readonly LibTab[] = [
  "playlists",
  "albums",
  "tracks",
  "artists",
  "shows",
  "episodes",
  "audiobooks",
];

function libTabLabel(t: LibTab): string {
  return t[0].toUpperCase() + t.slice(1);
}

interface Props {
  state: BrowseState;
  deviceId: string | null;
  queuedCount?: number;
  onChange: (s: BrowseState) => void;
  onPlayContext: (uri: string) => void;
  onPlayUris: (uris: string[]) => void;
  onQueueAdd: (uri: string) => void;
  onError: (m: string) => void;
}

/** Play needs at least one known track, except a walled playlist keeps its
 *  Play button: Spotify still plays the context URI even when the track
 *  list is owner-only, so hiding it would remove the one action that works.
 *  An empty owned playlist still hides Play instead of failing on press. */
function playableDetail(d: DetailData): boolean {
  if (d.kind === "playlist") return d.uri.length > 0 && (d.tracksTotal > 0 || d.walled);
  if (d.kind === "album") return d.tracks.length > 0;
  return true;
}

function Row({
  title,
  sub,
  image,
  right,
  spotifyUrl,
  onOpen,
  onPlay,
  onQueue,
}: {
  title: string;
  sub: string;
  image: string | null;
  right?: string;
  spotifyUrl?: string;
  onOpen: () => void;
  onPlay?: () => void;
  onQueue?: () => void;
}) {
  // Shelves are full-row Spotify-only, max 20 items, Spotify mark per row,
  // no mixed-service rows, link at row end into the Spotify app.
  const fullTitle = title;
  return (
    <li className="q browse-row">
      <button className="browse-thumb" onClick={onOpen} aria-label={`Open ${title}`} title={fullTitle}>
        {image ? <img src={image} alt="" loading="lazy" /> : <span className="cover-fallback" aria-hidden="true" />}
      </button>
      <button className="q-name browse-name" onClick={onOpen} title={fullTitle}>
        {title}
        {sub && <small>{sub}</small>}
      </button>
      <span className="row-mark" aria-hidden="true">
        <SpotifyMark variant="icon" size={16} />
      </span>
      {right && <span className="q-time">{right}</span>}
      {onPlay && (
        <button className="icon-btn sm row-act" onClick={onPlay} title={`Play ${title}`} aria-label={`Play ${title}`}>
          <PlayIcon size={13} />
        </button>
      )}
      {onQueue && (
        <button className="icon-btn sm row-act" onClick={onQueue} title={`Queue ${title}`} aria-label={`Queue ${title}`}>
          <LikePlusIcon size={13} />
        </button>
      )}
      {spotifyUrl && (
        <button
          className="icon-btn sm row-act"
          onClick={() => void openUrl(spotifyUrl)}
          title="OPEN SPOTIFY"
          aria-label={`Open ${title} in Spotify`}
        >
          <OpenIcon size={13} />
        </button>
      )}
    </li>
  );
}

function TrackRow({
  t,
  index,
  onPlay,
  onQueue,
  onOpen,
}: {
  t: QueueItem;
  index?: number;
  onPlay?: () => void;
  onQueue?: () => void;
  /** Open the track/episode detail (Save + show notes). Absent keeps the
   *  plain label for lists where detail adds nothing. */
  onOpen?: () => void;
}) {
  const label = (
    <>
      {t.name}
      <small>{t.artists}</small>
    </>
  );
  return (
    <li className="q">
      {typeof index === "number" && (
        <span className="q-index">{String(index + 1).padStart(2, "0")}</span>
      )}
      {onOpen ? (
        <button
          className="q-name browse-name"
          title={`${t.name} — ${t.artists}`}
          aria-label={`Open ${t.name}`}
          onClick={onOpen}
        >
          {label}
        </button>
      ) : (
        <span className="q-name" title={`${t.name} — ${t.artists}`}>
          {label}
        </span>
      )}
      <span className="q-time">{formatMs(t.durationMs)}</span>
      {onPlay && (
        <button
          className="icon-btn sm row-act"
          title={`Play ${t.name}`}
          aria-label={`Play ${t.name}`}
          onClick={onPlay}
        >
          <PlayIcon size={13} />
        </button>
      )}
      {onQueue && (
        <button
          className="icon-btn sm row-act"
          title={`Queue ${t.name}`}
          aria-label={`Queue ${t.name}`}
          onClick={() => onQueue()}
        >
          <LikePlusIcon size={13} />
        </button>
      )}
    </li>
  );
}

function Skeletons({ n = 3, label = "Loading" }: { n?: number; label?: string }) {
  return (
    <div aria-label={label} role="status">
      {Array.from({ length: n }, (_, i) => (
        <div className="skel skel-row" key={i} />
      ))}
    </div>
  );
}

function MoreSentinel({
  list,
}: {
  list: {
    loading: boolean;
    hasMore: boolean;
    throttled: string | null;
    retry: () => void;
    sentinelRef: React.RefCallback<HTMLDivElement>;
  };
}) {
  return (
    <li className="sentinel" aria-hidden="true">
      <div ref={list.sentinelRef} />
      {list.loading && list.hasMore && <div className="skel skel-row" />}
    </li>
  );
}

/** Detail entry for a playable uri, so track/episode rows can open their
 *  Save + show-notes detail instead of dead-ending. Null for junk. */
function entryForUri(uri: string, name?: string): BrowseEntry | null {
  const parts = uri.split(":");
  if (parts.length !== 3 || parts[0] !== "spotify" || !parts[2]) return null;
  const kind = parts[1];
  if (
    kind === "track" ||
    kind === "episode" ||
    kind === "chapter" ||
    kind === "show" ||
    kind === "album" ||
    kind === "playlist" ||
    kind === "artist" ||
    kind === "audiobook"
  ) {
    return { kind, id: parts[2], name } as BrowseEntry;
  }
  return null;
}

/** Unified pane-state banner (PR8). One component for the loading,
 *  queued-write, throttled, and capped states across panes — same
 *  `throttled-note` / `skel` visuals and copy as the old per-pane notes,
 *  no new visual language. PlayerPane and VisualizerPane import this;
 *  QueuePane keeps its own inline notes (out of slice bounds). */
export type PaneBannerTone = "loading" | "queued" | "throttled" | "capped";

export function PaneStateBanner({
  tone,
  message,
  count,
  onRetry,
  skeletonN = 3,
  contextLabel,
}: {
  tone: PaneBannerTone;
  /** Raw throttle message; only inspected for the quota-vs-rate copy. */
  message?: string;
  /** Parked write count for the queued copy. */
  count?: number;
  onRetry?: () => void;
  skeletonN?: number;
  contextLabel?: string;
}) {
  if (tone === "loading") {
    return <Skeletons n={skeletonN} label={contextLabel ?? "Loading"} />;
  }
  if (tone === "queued") {
    const n = typeof count === "number" ? count : 0;
    if (n <= 0) return null;
    return (
      <div className="throttled-note" role="status">
        <span>
          Queued — will send after cooldown{n > 1 ? ` (${n})` : ""}.
        </span>
      </div>
    );
  }
  if (tone === "capped") {
    return (
      <div className="throttled-note" role="status">
        <span>Showing first 10 — Spotify throttled the full queue.</span>
      </div>
    );
  }
  const quota = /quota-exceeded/i.test(message ?? "");
  return (
    <div className="throttled-note" role="status">
      <span>{quota ? "Spotify quota hit — cooling down." : "Spotify throttled — retrying in background."}</span>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Recent searches: local only, never leaves the machine. Capped at 8,
 *  most recent first, deduped. */
const SEARCH_RECENTS_KEY = "snapify-search-recents";
const SEARCH_RECENTS_MAX = 8;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_RECENTS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, SEARCH_RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function emptyResults(): SearchResults {
  return { tracks: [], artists: [], playlists: [], albums: [], shows: [], episodes: [], audiobooks: [] };
}

/** Merge paged search windows, deduping by uri/id so an overlapping backend
 *  page never duplicates rows (or React keys). */
function mergeSearch(pages: SearchResults[]): SearchResults {
  const out = emptyResults();
  const seen = new Set<string>();
  const takeTracks = (list: QueueItem[]) => {
    for (const t of list) {
      const k = `u:${t.uri}`;
      if (t.uri && seen.has(k)) continue;
      seen.add(k);
      out.tracks.push(t);
    }
  };
  const takeLib = (into: LibraryItem[], list: LibraryItem[]) => {
    for (const it of list) {
      const k = `l:${it.id}`;
      if (it.id && seen.has(k)) continue;
      seen.add(k);
      into.push(it);
    }
  };
  for (const pg of pages) {
    takeTracks(pg.tracks);
    takeTracks(pg.episodes);
    // Episodes share the tracks dedupe pool on purpose: the same uri must
    // never render twice even across buckets. Re-split below.
    takeLib(out.artists, pg.artists);
    takeLib(out.playlists, pg.playlists);
    takeLib(out.albums, pg.albums);
    takeLib(out.shows, pg.shows);
    takeLib(out.audiobooks, pg.audiobooks);
  }
  // Un-split episodes back out of the tracks pool.
  const eps = out.tracks.filter((t) => t.uri.startsWith("spotify:episode:"));
  out.tracks = out.tracks.filter((t) => !t.uri.startsWith("spotify:episode:"));
  out.episodes = eps;
  return out;
}

/** Paged search: one usePagedList sentinel pages offset windows of
 *  SEARCH_PAGE (10) per bucket through the existing limit/offset backend.
 *  Stops when no bucket fills the window, or when a page adds nothing new
 *  (mock-safe duplicate guard). */
function PagedSearch({
  query,
  resetKey,
  onOpen,
  onPlayContext,
  onPlayUris,
  onQueueAdd,
  onError,
  onFirstLoad,
}: {
  query: string;
  resetKey: string;
  onOpen: (e: BrowseEntry) => void;
  onPlayContext: (uri: string) => void;
  onPlayUris: (uris: string[]) => void;
  onQueueAdd: (uri: string) => void;
  onError: (m: string) => void;
  onFirstLoad: () => void;
}) {
  const err = useCallback((m: string) => onError(scopeHint(m) ?? m), [onError]);
  // URIs already rendered for this query: a repeated page (same fixture
  // twice, overlapping backend windows) ends paging instead of looping.
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    seenRef.current = new Set();
  }, [query]);
  const firstLoadRef = useRef(true);
  useEffect(() => {
    firstLoadRef.current = true;
  }, [query]);
  const list = usePagedList<SearchResults, number>(
    async (limit, cursor) => {
      const off = cursor ?? 0;
      const parsed = parseSearch(await api.searchRaw(query, limit, off), 0);
      const buckets: Array<{ len: number; uris: string[] }> = [
        { len: parsed.tracks.length, uris: parsed.tracks.map((t) => t.uri) },
        { len: parsed.artists.length, uris: parsed.artists.map((a) => a.id) },
        { len: parsed.playlists.length, uris: parsed.playlists.map((x) => x.id) },
        { len: parsed.albums.length, uris: parsed.albums.map((x) => x.id) },
        { len: parsed.shows.length, uris: parsed.shows.map((x) => x.id) },
        { len: parsed.episodes.length, uris: parsed.episodes.map((t) => t.uri) },
        { len: parsed.audiobooks.length, uris: parsed.audiobooks.map((x) => x.id) },
      ];
      const fresh = buckets.flatMap((b) => b.uris).filter((u) => u && !seenRef.current.has(u));
      for (const u of buckets.flatMap((b) => b.uris)) seenRef.current.add(u);
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        onFirstLoad();
      }
      const full = buckets.some((b) => b.len >= limit);
      return { items: [parsed], next: full && fresh.length > 0 ? off + limit : null };
    },
    { pageSize: SEARCH_PAGE, resetKey: `search:${resetKey}:${query}`, onError: err },
  );
  const merged = useMemo(() => mergeSearch(list.items), [list.items]);
  const empty =
    !list.loading &&
    list.items.length > 0 &&
    merged.tracks.length === 0 &&
    merged.artists.length === 0 &&
    merged.playlists.length === 0 &&
    merged.albums.length === 0 &&
    merged.shows.length === 0 &&
    merged.episodes.length === 0 &&
    merged.audiobooks.length === 0;

  if (list.loading && list.items.length === 0) return <PaneStateBanner tone="loading" />;
  return (
    <>
      {list.throttled && <PaneStateBanner tone="throttled" message={list.throttled} onRetry={list.retry} />}
      {empty && (
        <div className="empty">
          <div className="empty-title">No results</div>
          <div className="empty-sub">Try a different query.</div>
        </div>
      )}
      {merged.tracks.length > 0 && (
        <>
          <div className="pane-subhead">Songs</div>
          <ol className="queue">
            {merged.tracks.map((t, i) => (
              <TrackRow
                key={`s-t-${t.uri}-${i}`}
                t={t}
                onPlay={() => onPlayUris([t.uri])}
                onQueue={() => onQueueAdd(t.uri)}
                onOpen={(() => {
                  const e = entryForUri(t.uri, t.name);
                  return e ? () => onOpen(e) : undefined;
                })()}
              />
            ))}
          </ol>
        </>
      )}
      {merged.artists.length > 0 && (
        <>
          <div className="pane-subhead">Artists</div>
          <ol className="queue">
            {merged.artists.map((it) => (
              <Row
                key={`s-a-${it.id}`}
                title={it.name}
                sub="Artist"
                image={it.image}
                onOpen={() => onOpen({ kind: "artist", id: it.id, name: it.name })}
              />
            ))}
          </ol>
        </>
      )}
      {merged.playlists.length > 0 && (
        <>
          <div className="pane-subhead">Playlists</div>
          <ol className="queue">
            {merged.playlists.map((it) => (
              <Row
                key={`s-p-${it.id}`}
                title={it.name}
                sub={it.subtitle || "Playlist"}
                image={it.image}
                onOpen={() => onOpen({ kind: "playlist", id: it.id, name: it.name })}
                onPlay={() => onPlayContext(it.uri)}
              />
            ))}
          </ol>
        </>
      )}
      {merged.albums.length > 0 && (
        <>
          <div className="pane-subhead">Albums</div>
          <ol className="queue">
            {merged.albums.map((it) => (
              <Row
                key={`s-al-${it.id}`}
                title={it.name}
                sub={it.subtitle || "Album"}
                image={it.image}
                onOpen={() => onOpen({ kind: "album", id: it.id, name: it.name })}
                onPlay={() => onPlayContext(it.uri)}
              />
            ))}
          </ol>
        </>
      )}
      {merged.shows.length > 0 && (
        <>
          <div className="pane-subhead">Shows</div>
          <ol className="queue">
            {merged.shows.map((it) => (
              <Row
                key={`s-sh-${it.id}`}
                title={it.name}
                sub={it.subtitle || "Show"}
                image={it.image}
                onOpen={() => onOpen({ kind: "show", id: it.id, name: it.name })}
                onPlay={() => onPlayContext(it.uri)}
              />
            ))}
          </ol>
        </>
      )}
      {merged.episodes.length > 0 && (
        <>
          <div className="pane-subhead">Episodes</div>
          <ol className="queue">
            {merged.episodes.map((t, i) => (
              <TrackRow
                key={`s-e-${t.uri}-${i}`}
                t={t}
                onPlay={() => onPlayUris([t.uri])}
                onQueue={() => onQueueAdd(t.uri)}
                onOpen={(() => {
                  const e = entryForUri(t.uri, t.name);
                  return e ? () => onOpen(e) : undefined;
                })()}
              />
            ))}
          </ol>
        </>
      )}
      {merged.audiobooks.length > 0 && (
        <>
          <div className="pane-subhead">Audiobooks</div>
          <ol className="queue">
            {merged.audiobooks.map((it) => (
              <Row
                key={`s-ab-${it.id}`}
                title={it.name}
                sub={it.subtitle || "Audiobook"}
                image={it.image}
                onOpen={() => onOpen({ kind: "audiobook", id: it.id, name: it.name })}
                onPlay={() => onPlayContext(it.uri)}
              />
            ))}
          </ol>
        </>
      )}
      {(merged.tracks.length > 0 ||
        merged.artists.length > 0 ||
        merged.playlists.length > 0 ||
        merged.albums.length > 0 ||
        merged.shows.length > 0 ||
        merged.episodes.length > 0 ||
        merged.audiobooks.length > 0) && (
        <ol className="queue">
          <MoreSentinel list={list} />
        </ol>
      )}
      <div className="empty">
        <div className="empty-title">Categories · Genres · Markets</div>
        <div className="empty-sub">
          Removed or deprecated in 2026 for new client IDs. Open the Spotify app to browse categories.
        </div>
        <button className="btn sm" onClick={() => void openUrl("https://open.spotify.com/browse")}>
          OPEN SPOTIFY
        </button>
      </div>
    </>
  );
}

/** Optimistic library save with library_contains reconcile. Rolls back on a
 *  failed write or a disagreeing server; keeps the optimistic state when the
 *  check itself cannot run. */
function useLibrarySaved(uri: string | null, onError: (m: string) => void) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSaved(false);
    if (!uri) return;
    let live = true;
    void api
      .libraryContains([uri])
      .then((r) => {
        if (live) setSaved(r[0] === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [uri]);
  const toggle = useCallback(async () => {
    if (!uri || busy) return;
    const next = !saved;
    setSaved(next);
    setBusy(true);
    try {
      if (next) await api.librarySave([uri]);
      else await api.libraryRemove([uri]);
      try {
        const [s] = await api.libraryContains([uri]);
        if (s !== next) {
          setSaved(s);
          onError(s ? "Already in your library" : "Not saved — the change didn't stick");
          return;
        }
      } catch {
        // Keep the optimistic state when the check itself fails.
      }
    } catch (e) {
      setSaved(!next);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [uri, saved, busy, onError]);
  return { saved, busy, toggle };
}

/** Optimistic follow. No server reconcile: the check-follow page shape is a
 *  full list read, so a toggle that fails rolls back and a toggle that
 *  succeeds stands. */
function useFollowed(onError: (m: string) => void) {
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = useCallback(async (uri: string) => {
    if (!uri || busy) return;
    const next = !following;
    setFollowing(next);
    setBusy(true);
    try {
      if (next) await api.followPut([uri]);
      else await api.followDelete([uri]);
    } catch (e) {
      setFollowing(!next);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [following, busy, onError]);
  return { following, busy, toggle };
}

/** Paged library: playlists, albums, liked songs, followed artists.
 *  Mounted only on the library view so background tabs cost nothing. */
function LibraryList({
  tab,
  resetKey,
  onOpen,
  onPlayContext,
  onPlayUris,
  onQueueAdd,
  onError,
}: {
  tab: LibTab;
  resetKey: string;
  onOpen: (e: BrowseEntry) => void;
  onPlayContext: (uri: string) => void;
  onPlayUris: (uris: string[]) => void;
  onQueueAdd: (uri: string) => void;
  onError: (m: string) => void;
}) {
  const err = useCallback((m: string) => onError(scopeHint(m) ?? m), [onError]);
  const list = usePagedList<LibraryItem | QueueItem, number | string>(
    async (limit, cursor) => {
      // Shelves cap at 20 items per PLAN-master.md quota policy.
      const capped = Math.min(limit, 20);
      if (tab === "playlists") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parsePlaylistPage(await api.myPlaylists(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      if (tab === "albums") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parseSavedAlbums(await api.savedAlbums(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      if (tab === "tracks") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parseSavedTracks(await api.savedTracks(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      if (tab === "shows") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parseSavedShows(await api.savedShows(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      if (tab === "episodes") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parseSavedEpisodes(await api.savedEpisodes(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      if (tab === "audiobooks") {
        const off = typeof cursor === "number" ? cursor : 0;
        const parsed = parseSavedAudiobooks(await api.savedAudiobooks(capped, off));
        const next = off + parsed.items.length < parsed.total ? off + parsed.items.length : null;
        return { items: parsed.items.slice(0, 20), next };
      }
      const parsed = parseFollowedArtists(
        await api.followedArtists(capped, typeof cursor === "string" ? cursor : null),
      );
      return { items: parsed.items.slice(0, 20), next: parsed.after };
    },
    { pageSize: 20, resetKey: `${resetKey}:lib:${tab}`, onError: err },
  );

  if (list.loading && list.items.length === 0) return <PaneStateBanner tone="loading" />;
  if (list.items.length === 0 && list.throttled) {
    return (
      <>
        <PaneStateBanner tone="throttled" message={list.throttled} onRetry={list.retry} />
        <div className="empty">
          <div className="empty-title">Throttled</div>
          <div className="empty-sub">Spotify rate-limited this list. Stale results kept; retry when ready.</div>
          <button className="btn sm" onClick={list.retry}>
            Retry
          </button>
        </div>
      </>
    );
  }
  if (list.items.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">
          {tab === "tracks" ? "No liked songs yet" : "Nothing saved here"}
        </div>
        <div className="empty-sub">
          {tab === "tracks"
            ? "Heart songs in Spotify and they show here."
            : "Save it in Spotify, then refresh."}
        </div>
      </div>
    );
  }
  return (
    <>
      {list.throttled && <PaneStateBanner tone="throttled" message={list.throttled} onRetry={list.retry} />}
      <ol className="queue">
        {list.items.map((it, i) => {
          if ("durationMs" in it) {
            const t = it as QueueItem;
            const entry = entryForUri(t.uri, t.name);
            return (
              <TrackRow
                key={`${t.uri}-${i}`}
                t={t}
                index={i}
                onPlay={() => onPlayUris([t.uri])}
                onQueue={() => onQueueAdd(t.uri)}
                onOpen={entry ? () => onOpen(entry) : undefined}
              />
            );
          }
          return (
            <Row
              key={`${tab}-${(it as LibraryItem).id}`}
              title={(it as LibraryItem).name}
              sub={(it as LibraryItem).subtitle}
              image={(it as LibraryItem).image}
              onOpen={() => {
                const li = it as LibraryItem;
                if (!li.id) return;
                if (tab === "playlists") onOpen({ kind: "playlist", id: li.id, name: li.name });
                else if (tab === "albums") onOpen({ kind: "album", id: li.id, name: li.name });
                else if (tab === "shows") onOpen({ kind: "show", id: li.id, name: li.name });
                else if (tab === "audiobooks") onOpen({ kind: "audiobook", id: li.id, name: li.name });
                else if (tab === "episodes") onOpen({ kind: "episode", id: li.id, name: li.name });
                else onOpen({ kind: "artist", id: li.id, name: li.name });
              }}
              onPlay={(it as LibraryItem).uri ? () => onPlayContext((it as LibraryItem).uri) : undefined}
            />
          );
        })}
        <MoreSentinel list={list} />
      </ol>
    </>
  );
}

/** Paged playlist tracks for the detail view. The wall path keeps Play and
 *  Open actions: context playback still works for playlists the viewer
 *  does not own even though the track list itself is owner-only. */
function PlaylistTracks({
  id,
  resetKey,
  initialItems,
  initialTotal,
  playlistUri,
  ownerName,
  onPlayUris,
  onPlayContext,
  onQueueAdd,
  onOpen,
  onError,
}: {
  id: string;
  resetKey: string;
  initialItems?: QueueItem[];
  initialTotal?: number;
  playlistUri: string;
  ownerName: string;
  onPlayUris: (uris: string[]) => void;
  onPlayContext: (uri: string) => void;
  onQueueAdd: (uri: string) => void;
  onOpen: (e: BrowseEntry) => void;
  onError: (m: string) => void;
}) {
  const err = useCallback((m: string) => onError(scopeHint(m) ?? m), [onError]);
  // Last non-throttled load failure, so an unloadable list never
  // masquerades as an empty one. Clears per playlist and on recovery.
  const [loadError, setLoadError] = useState<string | null>(null);
  const errInline = useCallback(
    (m: string) => {
      setLoadError(m);
      err(m);
    },
    [err],
  );
  useEffect(() => {
    setLoadError(null);
  }, [resetKey, id]);
  const initialRef = useRef<{ id: string; items: QueueItem[]; total: number } | null>(null);
  initialRef.current =
    initialItems && initialItems.length > 0
      ? { id, items: initialItems, total: initialTotal ?? initialItems.length }
      : null;
  const list = usePagedList<QueueItem, number>(
    async (limit, cursor) => {
      const off = cursor ?? 0;
      const seed = initialRef.current;
      if (seed && seed.id === id && off < seed.items.length) {
        const slice = seed.items.slice(off, off + limit);
        const next = off + slice.length < seed.total ? off + slice.length : null;
        if (slice.length > 0 || seed.total <= seed.items.length) {
          return { items: slice, next };
        }
      }
      const raw = await api.playlistTracks(id, limit, off);
      setLoadError(null);
      const parsed = parsePlaylistItems(raw);
      const node = raw as Record<string, unknown> | null;
      const rawCount =
        node && Array.isArray(node["items"]) ? (node["items"] as unknown[]).length : parsed.items.length;
      const fetched = Math.max(rawCount, parsed.items.length, 1);
      const next = off + fetched < parsed.total ? off + fetched : null;
      return { items: parsed.items, next };
    },
    { pageSize: 50, resetKey: `pl-tracks:${resetKey}:${id}`, onError: errInline },
  );
  if (list.loading && list.items.length === 0) return <PaneStateBanner tone="loading" />;
  if (list.items.length === 0 && list.throttled) {
    return (
      <>
        <PaneStateBanner tone="throttled" message={list.throttled} onRetry={list.retry} />
        <div className="empty">
          <div className="empty-title">Throttled</div>
          <div className="empty-sub">Spotify rate-limited this playlist. Retry keeps your place.</div>
          <button className="btn sm" onClick={list.retry}>
            Retry
          </button>
        </div>
      </>
    );
  }
  if (!list.loading && list.items.length === 0 && !list.hasMore) {
    if (loadError) {
      const walled = /403/.test(loadError);
      return (
        <div className="empty">
          <div className="empty-title">{walled ? "Tracks unavailable" : "Couldn't load tracks"}</div>
          <div className="empty-sub">
            {walled
              ? `Spotify only shares track lists for playlists you own or collaborate on${ownerName ? ` (owner: ${ownerName})` : ""}. Playback still works. Ask the owner for a collaborator invite, then Retry. ID: ${id}.`
              : "Spotify didn't return this playlist's tracks."}
          </div>
          {walled && playlistUri && (
            <button className="btn sm primary" onClick={() => onPlayContext(playlistUri)}>
              Play
            </button>
          )}
          <button className="btn sm" onClick={list.retry}>
            Retry
          </button>
          {walled && (
            <button
              className="btn sm"
              onClick={() => void openUrl(`https://open.spotify.com/playlist/${id}`)}
            >
              Open in Spotify
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="empty">
        <div className="empty-title">No tracks here</div>
        <div className="empty-sub">Spotify returned no playable items for this playlist.</div>
      </div>
    );
  }
  return (
    <>
      {list.throttled && <PaneStateBanner tone="throttled" message={list.throttled} onRetry={list.retry} />}
      <ol className="queue">
        {list.items.map((t, i) => {
          const entry = entryForUri(t.uri, t.name);
          return (
            <TrackRow
              key={`${t.uri}-${i}`}
              t={t}
              index={i}
              onPlay={() => onPlayUris([t.uri])}
              onQueue={() => onQueueAdd(t.uri)}
              onOpen={entry ? () => onOpen(entry) : undefined}
            />
          );
        })}
        <MoreSentinel list={list} />
      </ol>
    </>
  );
}

export default function BrowsePane(p: Props) {
  const [libTab, setLibTab] = useState<LibTab>("playlists");
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [me, setMe] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [topArtists, setTopArtists] = useState<LibraryItem[]>([]);
  const [topTracks, setTopTracks] = useState<QueueItem[]>([]);
  const [recent, setRecent] = useState<QueueItem[]>([]);
  const [gen, setGen] = useState(0);
  // Debounced search input: `committed` is what PagedSearch pages. Recents
  // record the committed query once per distinct search, local only.
  const [committed, setCommitted] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const searchTimer = useRef<number | null>(null);

  const recordRecent = useCallback((q: string) => {
    const query = q.trim();
    if (!query) return;
    setRecents((prev) => {
      const next = [query, ...prev.filter((r) => r !== query)].slice(0, SEARCH_RECENTS_MAX);
      try {
        localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Private mode. Recents last the session.
      }
      return next;
    });
  }, []);

  const clearRecents = useCallback(() => {
    setRecents([]);
    try {
      localStorage.removeItem(SEARCH_RECENTS_KEY);
    } catch {
      // Private mode. Nothing persisted anyway.
    }
  }, []);

  const top = p.state.stack[p.state.stack.length - 1] ?? null;

  const detailGen = useRef(0);
  const fetchDetail = useCallback(
    async (entry: BrowseEntry) => {
      const id = ++detailGen.current;
      const stale = () => id !== detailGen.current;
      setDetailLoading(true);
      setDetail(null);
      try {
        if (entry.kind === "playlist") {
          const d = parsePlaylistDetail(await api.playlist(entry.id));
          if (stale()) return;
          setDetail(d);
        } else if (entry.kind === "album") {
          const [a, tr] = await Promise.all([
            api.album(entry.id),
            api.albumTracks(entry.id, 20, 0),
          ]);
          if (stale()) return;
          const base = parseAlbumDetail(a);
          // Merge paged tracks strip for the detail view.
          if (base && base.kind === "album") {
            const paged = tr as Record<string, unknown>;
            const items = Array.isArray(paged["items"])
              ? (paged["items"] as Array<Record<string, unknown>>)
              : [];
            if (items.length > 0 && base.tracks.length === 0) {
              setDetail({
                ...base,
                tracks: items
                  .filter((t) => typeof t["uri"] === "string")
                  .map((t) => ({
                    name: typeof t["name"] === "string" ? (t["name"] as string) : "Unknown",
                    artists: base.artists,
                    durationMs: typeof t["duration_ms"] === "number" ? (t["duration_ms"] as number) : 0,
                    uri: t["uri"] as string,
                  })),
              });
            } else {
              setDetail(base);
            }
          } else {
            setDetail(base);
          }
        } else if (entry.kind === "artist") {
          // Dropped GET /artists/{id}/top-tracks. Albums strip + related
          // artists load first so the page paints; then one search on the
          // artist's own name backfills the top-songs strip. The strip is
          // labeled "from search" where it renders. A failed search keeps
          // the honestly-empty state instead of blocking the page.
          const [a, al, rel] = await Promise.all([
            api.artist(entry.id),
            api.artistAlbums(entry.id, 10, 0),
            api.relatedArtists(entry.id).catch(() => null),
          ]);
          if (stale()) return;
          const base = parseArtistDetail(a, al, rel);
          setDetail(base);
          try {
            const node = a as Record<string, unknown> | null;
            const name =
              node && typeof node["name"] === "string" ? (node["name"] as string) : "";
            if (base && base.kind === "artist" && name.trim()) {
              const found = parseSearch(await api.searchRaw(name.trim(), 5, 0), 0);
              if (stale()) return;
              if (found.tracks.length > 0) {
                setDetail({ ...base, topTracks: found.tracks.slice(0, 10) });
              }
            }
          } catch {
            // Keep the base detail; the strip stays empty with its hint.
          }
        } else if (entry.kind === "show") {
          const [s, ep] = await Promise.all([
            api.show(entry.id),
            api.showEpisodes(entry.id, 20, 0),
          ]);
          if (stale()) return;
          setDetail(parseShowDetail(s, ep));
        } else if (entry.kind === "episode") {
          const e = await api.episode(entry.id);
          if (stale()) return;
          setDetail(parseEpisodeDetail(e));
        } else if (entry.kind === "audiobook") {
          const [b, ch] = await Promise.all([
            api.audiobook(entry.id),
            api.audiobookChapters(entry.id, 20, 0).catch(() => null),
          ]);
          if (stale()) return;
          setDetail(parseAudiobookDetail(b, ch));
        } else if (entry.kind === "chapter") {
          const c = await api.chapter(entry.id);
          if (stale()) return;
          setDetail(parseChapterDetail(c));
        } else {
          const t = await api.track(entry.id);
          if (stale()) return;
          setDetail(parseTrackDetail(t));
        }
      } catch (e) {
        if (stale()) return;
        const m = e instanceof Error ? e.message : String(e);
        p.onError(scopeHint(m) ?? m);
      } finally {
        if (!stale()) setDetailLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (top) void fetchDetail(top);
    if (!top) setDetail(null);
  }, [top?.kind, top && "id" in top ? (top as { id: string }).id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (p.state.view !== "search") return;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => setCommitted(p.state.query), 450);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [p.state.query, p.state.view]);

  const fetchProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const [meRaw, topA, topT, rec] = await Promise.all([
        api.me(),
        api.top("artists", 5, 0),
        api.top("tracks", 5, 0),
        api.recent(8),
      ]);
      setMe(parseUserProfile(meRaw));
      const ta = topA as Record<string, unknown>;
      setTopArtists(
        Array.isArray(ta["items"])
          ? (ta["items"] as Array<Record<string, unknown>>).map((x) => toLibraryItem(x, "Artist"))
          : [],
      );
      const tt = topT as Record<string, unknown>;
      const tlist = Array.isArray(tt["items"]) ? (tt["items"] as Array<Record<string, unknown>>) : [];
      setTopTracks(
        tlist.map((o) => ({
          name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
          artists: Array.isArray(o["artists"])
            ? (o["artists"] as Array<Record<string, unknown>>)
                .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
                .filter(Boolean)
                .join(", ")
            : "",
          durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
          uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
        })),
      );
      const rc = rec as Record<string, unknown>;
      const rlist = Array.isArray(rc["items"]) ? (rc["items"] as Array<Record<string, unknown>>) : [];
      setRecent(
        rlist
          .map((w) => w["track"] as Record<string, unknown> | undefined)
          .filter((t): t is Record<string, unknown> => !!t && typeof t["uri"] === "string")
          .map((o) => ({
            name: typeof o["name"] === "string" ? (o["name"] as string) : "Unknown",
            artists: Array.isArray(o["artists"])
              ? (o["artists"] as Array<Record<string, unknown>>)
                  .map((a) => (typeof a["name"] === "string" ? (a["name"] as string) : ""))
                  .filter(Boolean)
                  .join(", ")
              : "",
            durationMs: typeof o["duration_ms"] === "number" ? (o["duration_ms"] as number) : 0,
            uri: typeof o["uri"] === "string" ? (o["uri"] as string) : "",
          })),
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      p.onError(scopeHint(m) ?? m);
    } finally {
      setProfileLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (p.state.view === "profile" && !top) void fetchProfile();
  }, [p.state.view, top, fetchProfile]);

  const open = (e: BrowseEntry) => p.onChange({ ...p.state, stack: [...p.state.stack, e] });
  const back = () => p.onChange({ ...p.state, stack: p.state.stack.slice(0, -1) });
  const refresh = () => {
    if (p.state.view === "library") setGen((g) => g + 1);
    else if (p.state.view === "profile") void fetchProfile();
    else setGen((g) => g + 1);
  };
  const errInline = useCallback(
    (m: string) => p.onError(scopeHint(m) ?? m),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const lib = useLibrarySaved(
    top && (top.kind === "track" || top.kind === "episode" || top.kind === "chapter")
      ? (detail && "uri" in detail ? detail.uri : null)
      : null,
    errInline,
  );
  const follow = useFollowed(errInline);

  if (top) {
    const label = top.name ?? top.id;
    return (
      <>
        <PaneStateBanner tone="queued" count={p.queuedCount} />
        <div className="pane-subhead">
          <button className="icon-btn sm" onClick={back} title="Back" aria-label="Back">
            ←
          </button>
          <span title={label}>{label}</span>
          <SpotifyMark variant="full" size={18} />
        </div>
        {detailLoading ? (
          <>
            <div className="skel skel-head" aria-hidden="true" />
            <PaneStateBanner tone="loading" skeletonN={4} contextLabel="Loading detail" />
          </>
        ) : detail ? (
          <>
            <div className="detail-head">
              {detail.image && <img src={detail.image} alt="" loading="lazy" />}
              <div>
                <div className="detail-title">{detail.name}</div>
                <div className="dim">
                  {detail.kind === "playlist" && detail.owner}
                  {detail.kind === "album" && `${detail.artists}${detail.explicit ? " · Explicit" : ""}`}
                  {detail.kind === "artist" && detail.genres.join(" · ")}
                  {detail.kind === "show" && `${detail.publisher}${detail.explicit ? " · Explicit" : ""}`}
                  {detail.kind === "episode" && `${detail.show}${detail.explicit ? " · Explicit" : ""}`}
                  {detail.kind === "audiobook" && `${detail.authors}${detail.explicit ? " · Explicit" : ""}`}
                  {detail.kind === "chapter" && `${detail.book}${detail.explicit ? " · Explicit" : ""}`}
                  {detail.kind === "track" && `${detail.artists} · ${detail.album}${detail.explicit ? " · Explicit" : ""}`}
                </div>
                {playableDetail(detail) && (
                  <button className="btn sm primary" onClick={() => p.onPlayContext(detail.uri)}>
                    Play
                  </button>
                )}{" "}
                {(detail.kind === "track" ||
                  detail.kind === "episode" ||
                  detail.kind === "chapter") &&
                  detail.uri && (
                    <button
                      className="btn sm"
                      onClick={() => void lib.toggle()}
                      disabled={lib.busy}
                      aria-pressed={lib.saved}
                      title={lib.saved ? "Remove from your library" : "Save to your library"}
                      aria-label={lib.saved ? "Remove from your library" : "Save to your library"}
                    >
                      {lib.saved ? "Saved ✓" : "Save"}
                    </button>
                  )}
                {(detail.kind === "playlist" ||
                  detail.kind === "artist" ||
                  detail.kind === "show" ||
                  detail.kind === "audiobook") &&
                  detail.uri && (
                    <button
                      className="btn sm"
                      onClick={() => void follow.toggle(detail.uri)}
                      disabled={follow.busy}
                      aria-pressed={follow.following}
                      title={follow.following ? "Unfollow" : "Follow"}
                      aria-label={follow.following ? "Unfollow" : "Follow"}
                    >
                      {follow.following ? "Following ✓" : "Follow"}
                    </button>
                  )}
              </div>
            </div>
            {detail.kind === "playlist" && top.kind === "playlist" ? (
              <PlaylistTracks
                key={top.id}
                id={top.id}
                resetKey={String(gen)}
                initialItems={detail.tracks}
                initialTotal={detail.tracksTotal}
                playlistUri={detail.uri}
                ownerName={detail.owner}
                onPlayUris={p.onPlayUris}
                onPlayContext={p.onPlayContext}
                onQueueAdd={p.onQueueAdd}
                onOpen={open}
                onError={p.onError}
              />
            ) : detail.kind === "artist" ? (
              <>
                {detail.topTracks.length > 0 && (
                  <>
                    <div
                      className="pane-subhead"
                      title="Spotify removed the artist top-tracks endpoint in 2026 — these songs come from search."
                    >
                      Top songs · from search
                    </div>
                    <ol className="queue">
                      {detail.topTracks.slice(0, 10).map((t, i) => (
                        <TrackRow
                          key={`${t.uri}-${i}`}
                          t={t}
                          index={i}
                          onPlay={() => p.onPlayUris([t.uri])}
                          onQueue={() => p.onQueueAdd(t.uri)}
                          onOpen={(() => {
                            const e = entryForUri(t.uri, t.name);
                            return e ? () => open(e) : undefined;
                          })()}
                        />
                      ))}
                    </ol>
                  </>
                )}
                {detail.albums.length > 0 && (
                  <>
                    <div className="pane-subhead">Albums</div>
                    <ol className="queue">
                      {detail.albums.slice(0, 20).map((it) => (
                        <Row
                          key={`a-al-${it.id}`}
                          title={it.name}
                          sub={it.subtitle || "Album"}
                          image={it.image}
                          onOpen={() => open({ kind: "album", id: it.id, name: it.name })}
                          onPlay={() => p.onPlayContext(it.uri)}
                        />
                      ))}
                    </ol>
                  </>
                )}
                {detail.topTracks.length === 0 && detail.albums.length === 0 && (
                  <div className="empty">
                    <div className="empty-title">No top tracks</div>
                    <div className="empty-sub">Search this artist for songs and albums.</div>
                    <button className="btn sm" onClick={back}>Back</button>
                  </div>
                )}
              </>
            ) : detail.kind === "show" ? (
              <ol className="queue">
                {detail.episodes.slice(0, 20).map((t, i) => (
                  <TrackRow
                    key={`${t.uri}-${i}`}
                    t={t}
                    index={i}
                    onPlay={() => p.onPlayUris([t.uri])}
                    onQueue={() => p.onQueueAdd(t.uri)}
                    onOpen={(() => {
                      const e = entryForUri(t.uri, t.name);
                      return e ? () => open(e) : undefined;
                    })()}
                  />
                ))}
              </ol>
            ) : detail.kind === "audiobook" ? (
              <ol className="queue">
                {detail.chapters.slice(0, 20).map((t, i) => (
                  <TrackRow
                    key={`${t.uri}-${i}`}
                    t={t}
                    index={i}
                    onPlay={() => p.onPlayUris([t.uri])}
                    onQueue={() => p.onQueueAdd(t.uri)}
                    onOpen={(() => {
                      const e = entryForUri(t.uri, t.name);
                      return e ? () => open(e) : undefined;
                    })()}
                  />
                ))}
              </ol>
            ) : detail.kind === "episode" || detail.kind === "chapter" || detail.kind === "track" ? (
              <>
                {(detail.kind === "episode" || detail.kind === "chapter") && (
                  <div className="detail-notes" style={{ margin: "6px 0" }}>
                    <button
                      className="btn sm"
                      onClick={() =>
                        void openUrl(`https://open.spotify.com/${detail.uriType}/${top.id}`)
                      }
                      title="Open show notes in Spotify"
                      aria-label="Open show notes in Spotify"
                    >
                      Show notes
                    </button>
                  </div>
                )}
                <ol className="queue">
                  <TrackRow
                    t={{
                      name: detail.name,
                      artists: detail.kind === "episode" ? detail.show : detail.kind === "chapter" ? detail.book : detail.artists,
                      durationMs: detail.durationMs,
                      uri: detail.uri,
                    }}
                    onPlay={() => p.onPlayUris([detail.uri])}
                    onQueue={() => p.onQueueAdd(detail.uri)}
                  />
                </ol>
              </>
            ) : (
              <ol className="queue">
                {detail.tracks.slice(0, 20).map((t, i) => (
                  <TrackRow
                    key={`${t.uri}-${i}`}
                    t={t}
                    index={i}
                    onPlay={() => p.onPlayUris([t.uri])}
                    onQueue={() => p.onQueueAdd(t.uri)}
                    onOpen={(() => {
                      const e = entryForUri(t.uri, t.name);
                      return e ? () => open(e) : undefined;
                    })()}
                  />
                ))}
              </ol>
            )}
          </>
        ) : (
          <div className="empty">
            <div className="empty-title">Nothing here</div>
            <div className="empty-sub">Spotify returned no detail for this item.</div>
            <button className="btn sm" onClick={back}>Back</button>
          </div>
        )}
      </>
    );
  }

  const views = ["library", "search", "profile"] as const;
  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = views[(idx + dir + views.length) % views.length];
    p.onChange({ ...p.state, view: next, stack: [] });
    const tabs = (e.currentTarget.parentElement?.querySelectorAll('[role="tab"]') ?? []) as unknown as HTMLElement[];
    tabs[(idx + dir + views.length) % views.length]?.focus();
  };

  return (
    <>
      <PaneStateBanner tone="queued" count={p.queuedCount} />
      <div className="browse-tabs" role="tablist" aria-label="Browse">
        <SpotifyMark variant="full" size={18} />
        {views.map((v, i) => (
          <button
            key={v}
            role="tab"
            id={`browse-tab-${v}`}
            aria-selected={p.state.view === v}
            aria-controls={`browse-panel-${v}`}
            tabIndex={p.state.view === v ? 0 : -1}
            className={`chip${p.state.view === v ? " chip-on" : ""}`}
            onClick={() => p.onChange({ ...p.state, view: v, stack: [] })}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        {p.state.view === "library" && (
          <>
            <span className="sep" aria-hidden="true" />
            {/* Narrow-pane fallback for the seven library tabs: a labelled
              select under a 380 px container. The tab buttons keep their
              tablist semantics at wider widths (CSS hides one or the
              other, never both). */}
            <select
              className="browse-tab-select"
              aria-label="Library section"
              value={libTab}
              onChange={(e) => setLibTab(e.target.value as LibTab)}
            >
              {LIB_TABS.map((t) => (
                <option key={t} value={t}>
                  {libTabLabel(t)}
                </option>
              ))}
            </select>
            {LIB_TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={libTab === t}
                className={`chip lib-tab${libTab === t ? " chip-on" : ""}`}
                onClick={() => setLibTab(t)}
                aria-label={`Library: ${t}`}
              >
                {libTabLabel(t)}
              </button>
            ))}
          </>
        )}
        <button
          className="icon-btn sm"
          title="Refresh"
          aria-label="Refresh browse"
          onClick={refresh}
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {p.state.view === "library" && (
        <div role="tabpanel" id="browse-panel-library" aria-labelledby="browse-tab-library">
        <LibraryList
          tab={libTab}
          resetKey={String(gen)}
          onOpen={open}
          onPlayContext={p.onPlayContext}
          onPlayUris={p.onPlayUris}
          onQueueAdd={p.onQueueAdd}
          onError={p.onError}
        />
        </div>
      )}

      {p.state.view === "search" && (
        <div role="tabpanel" id="browse-panel-search" aria-labelledby="browse-tab-search">
          <div role="search" className="search-wrap">
          <input
            className="search-input"
            value={p.state.query}
            placeholder="Search songs, artists, playlists, shows…"
            aria-label="Search Spotify"
            onChange={(e) => p.onChange({ ...p.state, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                p.onChange({ ...p.state, query: "" });
              }
            }}
          />
          {p.state.query && (
            <button
              className="btn sm"
              onClick={() => p.onChange({ ...p.state, query: "" })}
              aria-label="Clear search"
            >
              Clear
            </button>
          )}
          </div>
          {recents.length > 0 && (
            <div className="recents" aria-label="Recent searches">
              <span className="dim">Recent: </span>
              {recents.map((r) => (
                <button
                  key={r}
                  className="chip"
                  title={`Search ${r} again`}
                  aria-label={`Search ${r} again`}
                  onClick={() => p.onChange({ ...p.state, query: r })}
                >
                  {r}
                </button>
              ))}
              <button
                className="btn sm"
                aria-label="Clear recent searches"
                onClick={clearRecents}
              >
                Clear
              </button>
            </div>
          )}
          {!committed.trim() ? (
            <div className="empty">
              <div className="empty-title">Search Spotify</div>
              <div className="empty-sub">Results open playlists, artists, albums, shows, episodes, and audiobooks.</div>
            </div>
          ) : (
            <PagedSearch
              query={committed.trim()}
              resetKey={String(gen)}
              onOpen={open}
              onPlayContext={p.onPlayContext}
              onPlayUris={p.onPlayUris}
              onQueueAdd={p.onQueueAdd}
              onError={p.onError}
              onFirstLoad={() => recordRecent(committed.trim())}
            />
          )}
        </div>
      )}

      {p.state.view === "profile" && (
        <div role="tabpanel" id="browse-panel-profile" aria-labelledby="browse-tab-profile">
          {profileLoading && !me ? (
            <>
              <div className="skel skel-head" aria-hidden="true" />
              <PaneStateBanner tone="loading" skeletonN={4} contextLabel="Loading profile" />
            </>
          ) : (
            <>
              {me && (
                <div className="detail-head">
                  {me.image && <img src={me.image} alt="" loading="lazy" />}
                  <div>
                    <div className="detail-title">{me.name}</div>
                    <div className="dim">{me.accountId}</div>
                  </div>
                </div>
              )}
              {topArtists.length > 0 && (
                <>
                  <div className="pane-subhead">Top artists</div>
                  <ol className="queue">
                    {topArtists.map((it) => (
                      <Row
                        key={`t-a-${it.id}`}
                        title={it.name}
                        sub="Artist"
                        image={it.image}
                        onOpen={() => open({ kind: "artist", id: it.id, name: it.name })}
                      />
                    ))}
                  </ol>
                </>
              )}
              {topTracks.length > 0 && (
                <>
                  <div className="pane-subhead">Top songs</div>
                  <ol className="queue">
                    {topTracks.map((t, i) => (
                      <TrackRow
                        key={`t-t-${t.uri}-${i}`}
                        t={t}
                        onPlay={() => p.onPlayUris([t.uri])}
                        onQueue={() => p.onQueueAdd(t.uri)}
                      />
                    ))}
                  </ol>
                </>
              )}
              {recent.length > 0 && (
                <>
                  <div className="pane-subhead">Recently played</div>
                  <ol className="queue">
                    {recent.map((t, i) => (
                      <TrackRow key={`r-${t.uri}-${i}`} t={t} onQueue={() => p.onQueueAdd(t.uri)} />
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
