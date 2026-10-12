import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, toThrottleError } from "../lib/spotify";
import { parseUserProfile } from "../lib/browse";
import {
  bucketListeningClocks,
  deriveStats,
  deriveTopGenres,
  parseRecentPlays,
  parseTopArtists,
  parseTopTracks,
  rangeHonestyNote,
  sliceClientRange,
  toApiTimeRange,
  type ProfileArtist,
} from "../lib/profile";
import type { ProfileRange, QueueItem, RecentPlay, UserProfile } from "../lib/types";
import { formatMs } from "../lib/lrc";
import { LikePlusIcon, PlayIcon } from "./icons";

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

/** Timeframe options in UI order (mirrors PROFILE_RANGES in lib/profile). */
const RANGE_OPTIONS: ReadonlyArray<{ value: ProfileRange; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "fourWeeks", label: "4 weeks" },
  { value: "sixMonths", label: "6 months" },
  { value: "year2026", label: "2026" },
  { value: "lifetime", label: "Lifetime" },
];

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
  // Destructure the stable shell callbacks up front so every fetch helper
  // below depends on primitives, never on the per-render props object.
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

  // Mount: identity + streams once. Tops ride the range effect below so
  // the first paint and every switch share one debounced path. The live
  // flag drops the StrictMode remount's first round; invokes already sent
  // are idempotent reads.
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
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const sliced = useMemo(
    () => sliceClientRange({ plays: recents.items, range }),
    [recents.items, range],
  );
  const stats = useMemo(() => deriveStats(sliced), [sliced]);
  const genres = useMemo(() => deriveTopGenres(artists.items), [artists.items]);
  const clocks = useMemo(() => bucketListeningClocks(sliced), [sliced]);
  const amPlays = useMemo(
    () => clocks.slice(0, 12).reduce((n, b) => n + b.plays, 0),
    [clocks],
  );
  const pmPlays = useMemo(
    () => clocks.slice(12).reduce((n, b) => n + b.plays, 0),
    [clocks],
  );
  const peakHour = useMemo(() => {
    let best = 0;
    for (let h = 1; h < 24; h += 1) {
      if (clocks[h].plays > clocks[best].plays) best = h;
    }
    return best;
  }, [clocks]);
  const honesty = rangeHonestyNote(range);
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
          {me.image && <img src={me.image} alt="" loading="lazy" />}
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

      <div className="search-wrap">
        <label htmlFor="profile-range">Timeframe</label>
        <select
          id="profile-range"
          value={range}
          onChange={(e) => {
            const v = e.target.value;
            if (
              v === "today" ||
              v === "week" ||
              v === "fourWeeks" ||
              v === "sixMonths" ||
              v === "year2026" ||
              v === "lifetime"
            ) {
              changeRange(v);
            }
          }}
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {honesty && (
        <div className="dim" role="note">
          {honesty}
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
          <div className="num">{stats.uniqueTracks}</div>
          <div className="lbl">Tracks</div>
        </div>
        <div className="profile-tile">
          <div className="num">{stats.uniqueArtists}</div>
          <div className="lbl">Artists</div>
        </div>
        <div className="profile-tile">
          <div className="num">{topGenre ?? "—"}</div>
          <div className="lbl">Top genre</div>
        </div>
        <div className="profile-tile">
          <div className="num">{sliced.length > 0 ? formatPeakHour(peakHour) : "—"}</div>
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {(
          [
            { half: "AM", plays: amPlays },
            { half: "PM", plays: pmPlays },
          ] as const
        ).map((d) => {
          const frac = sliced.length > 0 ? d.plays / sliced.length : 0;
          const arc = (frac * 251.2).toFixed(1);
          return (
            <div
              key={d.half}
              role="img"
              aria-label={`${d.half} listening clock: ${d.plays} streams`}
            >
              <svg className="clock-ring" viewBox="0 0 100 100" aria-hidden="true">
                <circle className="ring-track" cx="50" cy="50" r="40" fill="none" strokeWidth="8" />
                <circle
                  className="ring-val"
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${arc} 251.2`}
                  transform="rotate(-90 50 50)"
                />
                <text x="50" y="46" textAnchor="middle">
                  {d.half}
                </text>
                <text x="50" y="60" textAnchor="middle">
                  {d.plays}
                </text>
              </svg>
            </div>
          );
        })}
      </div>

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
                {a.image ? <img src={a.image} alt="" loading="lazy" /> : null}
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
                {a.image ? <img src={a.image} alt="" loading="lazy" /> : null}
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
      {sliced.length > 0 ? (
        <ol className="queue">
          {sliced.map((r) => (
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
