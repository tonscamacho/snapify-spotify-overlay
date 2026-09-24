import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DeviceInfo, PlayerSnapshot } from "../lib/types";
import { formatMs } from "../lib/lrc";
import { api } from "../lib/spotify";
import {
  LikePlusIcon,
  NextIcon,
  NoteIcon,
  OpenIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RefreshIcon,
  RepeatIcon,
  RepeatOneIcon,
  SeekBackIcon,
  SeekForwardIcon,
  ShuffleIcon,
  ThroughIcon,
  VolumeIcon,
} from "./icons";
import SpotifyMark from "./SpotifyMark";
import { PaneStateBanner } from "./BrowsePane";

interface Props {
  snapshot: PlayerSnapshot;
  devices: DeviceInfo[];
  progressMs: number;
  busy: boolean;
  tier?: "premium" | "free";
  sdkDeviceId?: string | null;
  queuedCount?: number;
  /** True while the app is in a throttled episode: pins the unified
   *  banner above the player. Retry re-polls the player. */
  degraded?: boolean;
  onRetry?: () => void;
  /** Render the mini row (art + title + play/pause) alongside the full
   *  player. The App sets this when the pane is collapsed or narrow
   *  enough for the 280 px container query to show it; otherwise the
   *  mini stays out of the DOM so track text and Play/Pause resolve
   *  exactly once. */
  compact?: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (ms: number) => void;
  onVolume: (v: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onTransfer: (id: string) => void;
  /** Build the headless SDK player and move playback onto it. */
  onPlayHere: () => void;
  onRefreshDevices: () => void;
  onToast?: (kind: "success" | "info" | "error", text: string) => void;
}

/** Remembered playback destination, per device list. The SDK device id is
 *  ephemeral per session, so "sdk" remembers the *kind*; a Connect choice
 *  remembers the concrete device id and only restores when that id is still
 *  present. Restored as the panel selection on boot, never as a silent
 *  transfer. */
export interface DeviceChoice {
  kind: "sdk" | "connect";
  deviceId?: string;
}

const DEVICE_CHOICE_KEY = "snapify-device-choice";

export function readDeviceChoice(): DeviceChoice | null {
  try {
    const raw = localStorage.getItem(DEVICE_CHOICE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DeviceChoice>;
    if (v.kind === "sdk") return { kind: "sdk" };
    if (v.kind === "connect" && typeof v.deviceId === "string" && v.deviceId) {
      return { kind: "connect", deviceId: v.deviceId };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeDeviceChoice(c: DeviceChoice): void {
  try {
    localStorage.setItem(DEVICE_CHOICE_KEY, JSON.stringify(c));
  } catch {
    // Private mode. Choice lasts the session.
  }
}

const DEVICE_OPEN_KEY = "snapify-device-open";

function readDeviceOpen(): boolean {
  try {
    return localStorage.getItem(DEVICE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Local per-episode resume store. Spotify keeps server-side progress for
 *  shows, but a local stamp survives account switches and offline gaps, and
 *  costs one tiny JSON blob. Keyed by episode (or chapter) id. */
const EPISODE_RESUME_KEY = "snapify-episode-resume";
const RESUME_SAVE_EVERY_MS = 5000;

function readResumeStore(): Record<string, number> {
  try {
    const raw = localStorage.getItem(EPISODE_RESUME_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, ms] of Object.entries(v)) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) out[k] = Math.floor(ms);
    }
    return out;
  } catch {
    return {};
  }
}

export function readEpisodeResume(episodeId: string): number | null {
  const ms = readResumeStore()[episodeId];
  return typeof ms === "number" ? ms : null;
}

export function writeEpisodeResume(episodeId: string, ms: number): void {
  try {
    const store = readResumeStore();
    if (ms > 5000) store[episodeId] = Math.floor(ms);
    else delete store[episodeId];
    const keys = Object.keys(store).slice(-50);
    const trimmed: Record<string, number> = {};
    for (const k of keys) trimmed[k] = store[k];
    localStorage.setItem(EPISODE_RESUME_KEY, JSON.stringify(trimmed));
  } catch {
    // Private mode. Resume lasts the session.
  }
}

const UPGRADE_TEXT =
  "Spotify Premium lets you play any track, podcast episode or audiobook, ad-free and with better audio quality. Go to spotify.com/premium to try it for free.";

function openSpotifyUrl(uri: string, trackId: string): string {
  // Link every Spotify surface back with exactly OPEN SPOTIFY.
  const parts = uri.split(":");
  if (parts.length === 3 && ["track", "episode", "album", "playlist", "artist", "show", "audiobook"].includes(parts[1])) {
    return `https://open.spotify.com/${parts[1]}/${parts[2]}`;
  }
  return `https://open.spotify.com/track/${trackId}`;
}

function uriIsEpisodic(uri: string): boolean {
  return uri.startsWith("spotify:episode:") || uri.startsWith("spotify:chapter:");
}

export default function PlayerPane(p: Props) {
  const [vol, setVol] = useState<number | null>(null);
  const [liked, setLiked] = useState(false);
  // Like in flight: the heart is disabled until the write settles so a
  // double-click cannot interleave save/remove out of order.
  const [likeBusy, setLikeBusy] = useState(false);
  const [choice, setChoice] = useState<DeviceChoice | null>(() => readDeviceChoice());
  const [devicesOpen, setDevicesOpen] = useState(() => readDeviceOpen());
  const [selectedId, setSelectedId] = useState<string>("");
  const [resumeMs, setResumeMs] = useState<number | null>(null);
  const s = p.snapshot;
  const track = s.track;
  const shownVol = vol ?? s.volume ?? 50;
  const tier = p.tier ?? "premium";
  const isFree = tier === "free";
  const isEpisodic = track ? uriIsEpisodic(track.uri) : false;
  const progressRef = useRef(p.progressMs);
  progressRef.current = p.progressMs;

  // Reconcile the heart against server truth on every track change, so a
  // stale optimistic state never renders. Toggles below stay optimistic and
  // roll back on failure or disagreement.
  useEffect(() => {
    let live = true;
    setLiked(false);
    setLikeBusy(false);
    const uri = track?.uri;
    if (!uri) return;
    void api
      .libraryContains([uri])
      .then((r) => {
        if (live) setLiked(r[0] === true);
      })
      .catch(() => {
        // Offline: keep the heart off rather than guessing.
      });
    return () => {
      live = false;
    };
  }, [track?.id]);

  // Resume stamp: load on episode change, persist every few seconds while
  // playing. Pristine starts (<5 s) clear the stamp.
  useEffect(() => {
    setResumeMs(null);
    if (!isEpisodic || !track) return;
    const saved = readEpisodeResume(track.id);
    if (saved != null && track.durationMs > 0 && saved < track.durationMs - 5000) {
      setResumeMs(saved);
    }
  }, [track?.id]);

  useEffect(() => {
    if (!isEpisodic || !track || !s.isPlaying) return;
    const id = track.id;
    const t = window.setInterval(() => {
      writeEpisodeResume(id, progressRef.current);
    }, RESUME_SAVE_EVERY_MS);
    return () => window.clearInterval(t);
  }, [isEpisodic, track?.id, s.isPlaying]);

  // Restore the remembered destination as the panel selection when the
  // device list arrives. Selection only: no silent transfer on boot.
  // Without a memory, the active device is the starting selection so Keep
  // there is a one-click confirm, not a hunt through the dropdown.
  useEffect(() => {
    if (selectedId) return;
    if (
      choice?.kind === "connect" &&
      choice.deviceId &&
      p.devices.some((d) => d.id === choice.deviceId)
    ) {
      setSelectedId(choice.deviceId);
    } else if (s.deviceId) {
      setSelectedId(s.deviceId);
    }
  }, [p.devices, s.deviceId, choice, selectedId]);

  const activeName =
    s.deviceName ??
    (p.sdkDeviceId && s.deviceId === p.sdkDeviceId ? "Snapify Overlay" : null) ??
    (p.devices.length === 0 ? "No devices — open Spotify" : "Choose a device");

  const playHere = () => {
    const next: DeviceChoice = { kind: "sdk" };
    setChoice(next);
    writeDeviceChoice(next);
    p.onPlayHere();
  };

  const keepThere = () => {
    if (!selectedId) return;
    const next: DeviceChoice = { kind: "connect", deviceId: selectedId };
    setChoice(next);
    writeDeviceChoice(next);
    p.onTransfer(selectedId);
  };

  const commitSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isFree) return;
    if (!track || track.durationMs <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    p.onSeek(Math.round(ratio * track.durationMs));
  };

  const onSeekKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isFree || !track) return;
    const step = isEpisodic ? 15000 : 5000;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      p.onSeek(Math.max(0, p.progressMs - step));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      p.onSeek(Math.min(track.durationMs, p.progressMs + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      p.onSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      p.onSeek(track.durationMs);
    }
  };

  const toggleLike = async () => {
    if (!track || likeBusy) return;
    const isEpisodeKind = track.uri.startsWith("spotify:episode:");
    const likeLabel = isEpisodeKind ? "New Episodes" : "Liked Songs";
    const next = !liked;
    setLiked(next);
    setLikeBusy(true);
    try {
      if (next) await api.librarySave([track.uri]);
      else await api.libraryRemove([track.uri]);
      // Reconcile against server truth. A disagreement rolls back so the
      // heart never lies; a reconcile failure keeps the optimistic state.
      try {
        const [saved] = await api.libraryContains([track.uri]);
        if (saved !== next) {
          setLiked(saved);
          p.onToast?.(
            "info",
            saved ? "Already in your library" : "Not saved — the change didn't stick",
          );
          return;
        }
      } catch {
        // Keep the optimistic state when the check itself fails.
      }
      p.onToast?.(
        "success",
        next ? `Added to ${likeLabel}` : isEpisodeKind ? "Removed from New Episodes" : "Removed from Liked Songs",
      );
    } catch (e) {
      setLiked(!next);
      p.onToast?.("error", e instanceof Error ? e.message : String(e));
    } finally {
      setLikeBusy(false);
    }
  };

  if (!track) {
    return (
      <>
        <div className="player-full">
        <div className="empty">
          <div className="empty-icon">
            <NoteIcon size={22} />
          </div>
          <div className="empty-title">Nothing playing</div>
          <div className="empty-sub">Start playback in Spotify and it shows here.</div>
          <button className="btn sm primary" onClick={() => void openUrl("https://open.spotify.com")}>
            OPEN SPOTIFY
          </button>
        </div>
        <div className="player-foot">
          <SpotifyMark variant="icon" size={21} />
          <span className="tier" title={isFree ? UPGRADE_TEXT : "Premium playback"}>
            {isFree ? "Free" : "Premium"}
          </span>
        </div>
        </div>
        {p.compact === true && (
          <div className="mini-row">
            <div className="mini-cover cover-fallback" aria-hidden="true">
              <NoteIcon size={16} />
            </div>
            <div className="mini-title">Nothing playing</div>
          </div>
        )}
      </>
    );
  }

  const showResume =
    isEpisodic &&
    resumeMs != null &&
    Math.abs(resumeMs - p.progressMs) > 10000 &&
    resumeMs < track.durationMs - 5000;

  const toggleDevices = () => {
    setDevicesOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(DEVICE_OPEN_KEY, next ? "1" : "0");
      } catch {
        // Private mode. Open state lasts the session.
      }
      return next;
    });
  };

  return (
    <div className="pane-fill">
      <PaneStateBanner tone="queued" count={p.queuedCount} />
      {p.degraded === true && (
        <PaneStateBanner tone="throttled" onRetry={p.onRetry} />
      )}
      <div className="player-full player-card">
      <div className="art-top">
        {track.image ? (
          <img className="art-img" src={track.image} alt="" draggable={false} />
        ) : (
          <div className="art-img art-fallback" aria-hidden="true">
            <NoteIcon size={28} />
          </div>
        )}
        <div className="art-overlay">
          <div className="art-transport">
            {isEpisodic && !isFree && (
              <button
                className="icon-btn"
                onClick={() => p.onSeek(Math.max(0, p.progressMs - 15000))}
                title="Back 15 seconds"
                aria-label="Back 15 seconds"
              >
                <SeekBackIcon size={16} />
              </button>
            )}
            <button
              className={`icon-btn${s.shuffle ? " is-on" : ""}`}
              onClick={p.onShuffle}
              title={isFree ? UPGRADE_TEXT : "Shuffle"}
              aria-label="Toggle shuffle"
              aria-pressed={s.shuffle}
              disabled={isFree}
            >
              <ShuffleIcon size={16} />
            </button>
            <button
              className="icon-btn"
              onClick={p.onPrev}
              disabled={p.busy || isFree}
              title={isFree ? UPGRADE_TEXT : "Previous"}
              aria-label="Previous track"
            >
              <PrevIcon size={18} />
            </button>
            {s.isPlaying ? (
              <button
                className="play-disc"
                onClick={p.onPause}
                disabled={p.busy}
                title="Pause"
                aria-label="Pause"
              >
                <PauseIcon size={19} />
              </button>
            ) : (
              <button
                className="play-disc"
                onClick={p.onPlay}
                disabled={p.busy}
                title={isFree ? UPGRADE_TEXT : "Play"}
                aria-label="Play"
              >
                <PlayIcon size={19} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={p.onNext}
              disabled={p.busy || isFree}
              title={isFree ? UPGRADE_TEXT : "Next"}
              aria-label="Next track"
            >
              <NextIcon size={18} />
            </button>
            <button
              className={`icon-btn${s.repeat !== "off" ? " is-on" : ""}`}
              onClick={p.onRepeat}
              title={isFree ? UPGRADE_TEXT : `Repeat: ${s.repeat}`}
              aria-label="Cycle repeat mode"
              aria-pressed={s.repeat !== "off"}
              disabled={isFree}
            >
              {s.repeat === "track" ? <RepeatOneIcon size={16} /> : <RepeatIcon size={16} />}
            </button>
            {isEpisodic && !isFree && (
              <button
                className="icon-btn"
                onClick={() => p.onSeek(Math.min(track.durationMs, p.progressMs + 15000))}
                title="Forward 15 seconds"
                aria-label="Forward 15 seconds"
              >
                <SeekForwardIcon size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {isFree ? (
        <div className="free-bar" role="note" aria-label="Playback restricted">
          <div className="bar info-only" aria-hidden="true">
            <i
              style={{
                width: `${track.durationMs > 0 ? Math.min(100, (p.progressMs / track.durationMs) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="times">
            <span>{formatMs(p.progressMs)}</span>
            <span>-{formatMs(Math.max(0, track.durationMs - p.progressMs))}</span>
          </div>
          <p className="upgrade">Playback needs Premium.</p>
          <button
            className="btn sm primary"
            onClick={() => void openUrl("https://www.spotify.com/premium")}
            title={UPGRADE_TEXT}
          >
            GET PREMIUM
          </button>
        </div>
      ) : (
        <>
          <div
            className="bar"
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuenow={Math.round(p.progressMs)}
            aria-valuemax={track.durationMs}
            aria-valuetext={`${formatMs(p.progressMs)} of ${formatMs(track.durationMs)}`}
            onClick={commitSeek}
            onKeyDown={onSeekKey}
          >
            <i
              style={{
                width: `${track.durationMs > 0 ? Math.min(100, (p.progressMs / track.durationMs) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="times">
            <span>{formatMs(p.progressMs)}</span>
            <span>-{formatMs(Math.max(0, track.durationMs - p.progressMs))}</span>
          </div>
        </>
      )}

      <div className="track-meta card-meta">
        <div className="title-row">
          <div
            className="track-title"
            title={track.name}
            aria-label={`${track.name} by ${track.artists}`}
          >
            <span title={track.name}>{track.name}</span>
          </div>
          <button
            className={`like-check${liked ? " is-on" : ""}`}
            onClick={() => void toggleLike()}
            disabled={likeBusy}
            title={liked ? "Remove from library" : "Add to library"}
            aria-label={liked ? "Remove from library" : "Save to library"}
            aria-pressed={liked}
          >
            <LikePlusIcon size={14} />
          </button>
        </div>
        <div className="track-artist" title={`${track.artists} — ${track.album}`}>
          {track.explicit && (
            <span className="badge" title="Explicit" aria-label="Explicit">
              E
            </span>
          )}{" "}
          <span title={track.artists}>{track.artists}</span>
          <span className="album-full" title={track.album}>
            {" "}
            · {track.album}
          </span>
        </div>
      </div>

      {isEpisodic && (
        <div className="episode-row" role="group" aria-label="Episode extras">
          {showResume && (
            <button
              className="btn sm"
              onClick={() => {
                p.onSeek(resumeMs);
                setResumeMs(null);
              }}
              title={`Resume from ${formatMs(resumeMs)}`}
              aria-label={`Resume from ${formatMs(resumeMs)}`}
            >
              Resume {formatMs(resumeMs)}
            </button>
          )}
          <button
            className="btn sm"
            onClick={() => void openUrl(openSpotifyUrl(track.uri, track.id))}
            title="Open show notes in Spotify"
            aria-label="Open show notes in Spotify"
          >
            Show notes
          </button>
          <label className="speed-label" htmlFor="ep-speed">
            Speed
          </label>
          <select
            id="ep-speed"
            className="device"
            value="1"
            disabled
            aria-disabled="true"
            title="Speed isn't exposed by the Spotify playback SDK, so this stays off on purpose."
            onChange={() => {}}
          >
            <option value="1">1×</option>
          </select>
          <span className="dim" title="The Web Playback SDK has no playback-rate control.">
            N/A via SDK
          </span>
        </div>
      )}

      <div className="device-row card-device">
        <button
          className="device-toggle"
          onClick={toggleDevices}
          title="Connect to a device"
          aria-label="Choose playback device"
          aria-expanded={devicesOpen}
        >
          <ThroughIcon size={14} />
          <span className="device-now" title={`Sound plays on: ${activeName}`}>
            {activeName}
          </span>
        </button>
        <VolumeIcon size={14} />
        <input
          className="vol"
          type="range"
          min={0}
          max={100}
          value={shownVol}
          aria-label="Volume"
          aria-valuetext={`${shownVol} percent`}
          onChange={(e) => setVol(Number(e.target.value))}
          onPointerUp={(e) => {
            p.onVolume(Number((e.target as HTMLInputElement).value));
            setVol(null);
          }}
          onKeyUp={(e) => {
            p.onVolume(Number((e.target as HTMLInputElement).value));
            setVol(null);
          }}
          onBlur={(e) => {
            if (vol !== null) {
              p.onVolume(Number((e.target as HTMLInputElement).value));
              setVol(null);
            }
          }}
        />
        {devicesOpen && (
          <div className="device-pop" role="group" aria-label="Playback device">
            <div className="device-pop-head">
              Sound plays on: <strong>{activeName}</strong>
              {choice?.kind === "sdk" && <span className="dim"> (remembered: this overlay)</span>}
              {choice?.kind === "connect" && choice.deviceId && (
                <span className="dim"> (remembered)</span>
              )}
            </div>
            <div className="device-list">
              {p.sdkDeviceId && (
                <button
                  className={`device-cell${p.sdkDeviceId === s.deviceId ? " is-active" : ""}`}
                  aria-pressed={selectedId === p.sdkDeviceId}
                  onClick={() => setSelectedId(p.sdkDeviceId as string)}
                  title="Snapify Overlay"
                >
                  <i className="device-dot" aria-hidden="true" />
                  <span>
                    Snapify Overlay{p.sdkDeviceId === s.deviceId ? " — active" : ""}
                  </span>
                </button>
              )}
              {p.devices.map((d) => (
                <button
                  key={d.id}
                  className={`device-cell${d.isActive ? " is-active" : ""}`}
                  aria-pressed={selectedId === d.id}
                  onClick={() => setSelectedId(d.id)}
                  title={d.name}
                >
                  <i className="device-dot" aria-hidden="true" />
                  <span>
                    {d.name}
                    {d.isActive ? " — active" : ""}
                  </span>
                </button>
              ))}
              {!p.sdkDeviceId && p.devices.length === 0 && (
                <div className="device-empty">No devices — open Spotify</div>
              )}
            </div>
            <div className="device-pop-actions">
              <button
                className="btn sm primary"
                onClick={playHere}
                title="Play through this overlay (Spotify headless SDK)"
                aria-label="Play here via this overlay"
              >
                Play here
              </button>
              <button
                className="btn sm"
                onClick={keepThere}
                disabled={!selectedId}
                title="Keep playback on the chosen Spotify device (Connect)"
                aria-label="Keep playback there"
              >
                Keep there
              </button>
            </div>
            <div className="device-pop-foot">
              <button
                className="icon-btn sm"
                onClick={p.onRefreshDevices}
                title="Refresh devices"
                aria-label="Refresh devices"
              >
                <RefreshIcon size={14} />
              </button>
              <button
                className="icon-btn sm"
                onClick={() => void openUrl(openSpotifyUrl(track.uri, track.id))}
                title="OPEN SPOTIFY"
                aria-label="Open in Spotify"
              >
                <OpenIcon size={14} />
              </button>
              <span className="dim">Play here: sound from this overlay. Keep there: stay on the chosen device.</span>
            </div>
          </div>
        )}
      </div>
      </div>
      {/* Mini player row (PR8): art + title + play/pause only. Rendered
        only when the App flags the pane compact (collapsed or narrow);
        a 280 px container query or the collapsed flag swaps it in for
        the full player (see App.css). */}
      {p.compact === true && (
        <div className="mini-row">
        {track.image ? (
          <img className="mini-cover" src={track.image} alt="" draggable={false} />
        ) : (
          <div className="mini-cover cover-fallback" aria-hidden="true">
            <NoteIcon size={16} />
          </div>
        )}
        <div
          className="mini-title"
          title={`${track.name} — ${track.artists}`}
        >
          {track.name}
        </div>
        {s.isPlaying ? (
          <button
            className="play-disc mini-play"
            onClick={p.onPause}
            disabled={p.busy}
            title="Pause"
            aria-label="Pause"
          >
            <PauseIcon size={15} />
          </button>
        ) : (
          <button
            className="play-disc mini-play"
            onClick={p.onPlay}
            disabled={p.busy || isFree}
            title={isFree ? UPGRADE_TEXT : "Play"}
            aria-label="Play"
          >
            <PlayIcon size={15} />
          </button>
        )}
        </div>
      )}
    </div>
  );
}
