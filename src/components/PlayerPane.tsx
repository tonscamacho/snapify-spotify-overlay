import { useEffect, useState } from "react";
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
  VolumeIcon,
} from "./icons";
import SpotifyMark from "./SpotifyMark";

interface Props {
  snapshot: PlayerSnapshot;
  devices: DeviceInfo[];
  progressMs: number;
  busy: boolean;
  tier?: "premium" | "free";
  sdkDeviceId?: string | null;
  queuedCount?: number;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (ms: number) => void;
  onVolume: (v: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onTransfer: (id: string) => void;
  onRefreshDevices: () => void;
  onToast?: (kind: "success" | "info" | "error", text: string) => void;
}

const UPGRADE_TEXT =
  "Spotify Premium lets you play any track, podcast episode or audiobook, ad-free and with better audio quality. Go to spotify.com/premium to try it for free.";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

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
  const s = p.snapshot;
  const track = s.track;
  const shownVol = vol ?? s.volume ?? 50;
  const tier = p.tier ?? "premium";
  const isFree = tier === "free";
  const isEpisodic = track ? uriIsEpisodic(track.uri) : false;

  useEffect(() => {
    setLiked(false);
  }, [track?.id]);

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
    if (!track) return;
    const isEpisodeKind = track.uri.startsWith("spotify:episode:");
    const likeLabel = isEpisodeKind ? "New Episodes" : "Liked Songs";
    try {
      if (!liked) {
        await api.librarySave([track.uri]);
        setLiked(true);
        p.onToast?.("success", `Added to ${likeLabel}`);
      } else {
        await api.libraryRemove([track.uri]);
        setLiked(false);
        p.onToast?.("success", isEpisodeKind ? "Removed from New Episodes" : "Removed from Liked Songs");
      }
    } catch (e) {
      p.onToast?.("error", e instanceof Error ? e.message : String(e));
    }
  };

  if (!track) {
    return (
      <>
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
      </>
    );
  }

  const displayTitle = truncate(track.name, 23);
  const displayArtist = truncate(track.artists, 18);

  return (
    <div className="pane-fill">
      {p.queuedCount != null && p.queuedCount > 0 && (
        <div className="throttled-note" role="status">
          <span>
            Queued — will send after cooldown{p.queuedCount > 1 ? ` (${p.queuedCount})` : ""}.
          </span>
        </div>
      )}
      <div className="track-row">
        {track.image ? (
          <img className="cover" src={track.image} alt="" draggable={false} />
        ) : (
          <div className="cover cover-fallback">
            <NoteIcon size={22} />
          </div>
        )}
        <div className="track-meta">
          <div
            className="track-title"
            title={track.name}
            aria-label={`${track.name} by ${track.artists}`}
          >
            <span title={track.name}>{displayTitle}</span>
          </div>
          <div className="track-artist" title={`${track.artists} — ${track.album}`}>
            {track.explicit && (
              <span className="badge" title="Explicit" aria-label="Explicit">
                E
              </span>
            )}{" "}
            <span title={track.artists}>{displayArtist}</span>
            <span className="album-full" title={track.album}>
              {" "}
              · {truncate(track.album, 25)}
            </span>
          </div>
          <div className="track-tier">
            <span className="tier" title={isFree ? UPGRADE_TEXT : "Premium playback"}>
              {isFree ? "Free" : "Premium"}
            </span>
          </div>
        </div>
        <button
          className={`icon-btn${liked ? " is-on" : ""}`}
          onClick={() => void toggleLike()}
          title={liked ? "Remove from library" : "Add to library"}
          aria-label={liked ? "Remove from library" : "Save to library"}
          aria-pressed={liked}
        >
          <LikePlusIcon size={17} />
        </button>
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
          <p className="upgrade">{UPGRADE_TEXT}</p>
          <button
            className="btn sm primary"
            onClick={() => void openUrl("https://www.spotify.com/premium")}
            title={UPGRADE_TEXT}
          >
            GET SPOTIFY FREE
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

      <div className="transport">
        {isEpisodic && !isFree && (
          <button
            className="icon-btn"
            onClick={() => p.onSeek(Math.max(0, p.progressMs - 15000))}
            title="Back 15 seconds"
            aria-label="Back 15 seconds"
          >
            <SeekBackIcon size={17} />
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
          <ShuffleIcon size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={p.onPrev}
          disabled={p.busy || isFree}
          title={isFree ? UPGRADE_TEXT : "Previous"}
          aria-label="Previous track"
        >
          <PrevIcon size={19} />
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
          <NextIcon size={19} />
        </button>
        <button
          className={`icon-btn${s.repeat !== "off" ? " is-on" : ""}`}
          onClick={p.onRepeat}
          title={isFree ? UPGRADE_TEXT : `Repeat: ${s.repeat}`}
          aria-label="Cycle repeat mode"
          aria-pressed={s.repeat !== "off"}
          disabled={isFree}
        >
          {s.repeat === "track" ? <RepeatOneIcon size={17} /> : <RepeatIcon size={17} />}
        </button>
        {isEpisodic && !isFree && (
          <button
            className="icon-btn"
            onClick={() => p.onSeek(Math.min(track.durationMs, p.progressMs + 15000))}
            title="Forward 15 seconds"
            aria-label="Forward 15 seconds"
          >
            <SeekForwardIcon size={17} />
          </button>
        )}
      </div>

      <div className="device-row">
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
        <select
          className="device"
          value={s.deviceId ?? ""}
          aria-label="Playback device"
          onChange={(e) => e.target.value && p.onTransfer(e.target.value)}
        >
          <option value="" disabled>
            {s.deviceName ?? (p.devices.length === 0 ? "No devices — open Spotify" : "Device")}
          </option>
          {p.sdkDeviceId && (
            <option value={p.sdkDeviceId}>
              Snapify Overlay{p.sdkDeviceId === s.deviceId ? " — active" : ""}
            </option>
          )}
          {p.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.isActive ? " — active" : ""}
            </option>
          ))}
        </select>
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
      </div>
      <div className="player-foot">
        <SpotifyMark variant="icon" size={21} />
      </div>
    </div>
  );
}
