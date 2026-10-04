import { memo } from "react";
import type { PlayerSnapshot } from "../lib/types";
import { formatMs } from "../lib/lrc";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
} from "./icons";
import Mp3Lcd from "./Mp3Lcd";
import type { Mp3LcdView, Mp3Power } from "./Mp3Lcd";

export type { Mp3LcdView, Mp3Power } from "./Mp3Lcd";

export type Mp3Variant = "purple" | "silver" | "pink" | "black";
export type Mp3PendingAction = "play" | "pause" | "next" | "prev" | null;

export interface Mp3PlayerProps {
  snapshot: PlayerSnapshot;
  progressMs: number;
  busy?: boolean;
  busyPrev?: boolean;
  busyPlayPause?: boolean;
  busyNext?: boolean;
  pendingAction?: Mp3PendingAction;
  tier?: "premium" | "free";
  degraded?: boolean;
  variant?: Mp3Variant;
  lcd?: Mp3LcdView;
  motion?: boolean;
  power?: Mp3Power;
  locked?: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (ms: number) => void;
  onVolume: (v: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onRetry?: () => void;
}

const VOL_STEP = 5;
const SEEK_STEP_MS = 5000;

function clampVol(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function Mp3Player(p: Mp3PlayerProps) {
  const s = p.snapshot;
  const track = s.track;
  const variant = p.variant ?? "purple";
  const lcd = p.lcd ?? "track";
  const motion = p.motion ?? true;
  const power = p.power ?? "on";
  const locked = p.locked ?? false;
  const tier = p.tier ?? "premium";
  const degraded = p.degraded ?? false;
  const pending = p.pendingAction ?? null;
  const isFree = tier === "free";
  const busyPrev = p.busyPrev ?? p.busy ?? false;
  const busyToggle = p.busyPlayPause ?? p.busy ?? false;
  const busyNext = p.busyNext ?? p.busy ?? false;
  const dur = track?.durationMs ?? 0;
  const ratio = dur > 0 ? Math.min(1, Math.max(0, p.progressMs / dur)) : 0;
  const title = track?.name ?? "No track";
  const artistLine = !track
    ? "Start Spotify"
    : track.artists !== ""
      ? track.album !== ""
        ? `${track.artists} - ${track.album}`
        : track.artists
      : track.album !== ""
        ? track.album
        : "Unknown";
  const canTransport = track !== null && !isFree;
  const baseVol = typeof s.volume === "number" ? s.volume : 50;
  const elapsed = formatMs(p.progressMs);
  const total = formatMs(dur);
  const remaining = formatMs(Math.max(0, dur - p.progressMs));
  const trackKey = track?.id ?? "empty";
  const lcdLabel =
    power === "boot"
      ? "Player starting"
      : power === "goodbye"
        ? "Player off"
        : `${title} by ${artistLine}, ${elapsed} of ${total}`;
  const ledState = track === null ? "idle" : s.isPlaying ? "play" : "pause";

  const seekRatio = (r: number) => {
    if (!track || dur <= 0 || isFree) return;
    p.onSeek(Math.round(Math.min(1, Math.max(0, r)) * dur));
  };

  const seekKey = (e: { key: string; preventDefault: () => void }) => {
    if (!track || dur <= 0 || isFree) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      p.onSeek(Math.max(0, p.progressMs - SEEK_STEP_MS));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      p.onSeek(Math.min(dur, p.progressMs + SEEK_STEP_MS));
    } else if (e.key === "Home") {
      e.preventDefault();
      p.onSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      p.onSeek(dur);
    }
  };

  const wheelKey = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!busyPrev && canTransport) p.onPrev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!busyNext && canTransport) p.onNext();
    }
  };

  const seekBar = (
    <div
      className="mp3-bar"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuenow={Math.round(p.progressMs)}
      aria-valuemax={dur}
      aria-valuetext={`${elapsed} of ${total}`}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const w = rect.width > 0 ? rect.width : 1;
        seekRatio((e.clientX - rect.left) / w);
      }}
      onKeyDown={seekKey}
    >
      <div className="mp3-bar-track">
        <i className="mp3-fill" style={motion ? { transform: `scaleX(${ratio})` } : { transform: `scaleX(${ratio})`, transition: "none" }} />
      </div>
    </div>
  );

  const statusText = degraded
    ? "WAIT"
    : s.isPlaying
      ? `PLAY${s.shuffle ? " SHF" : ""}${s.repeat !== "off" ? " RPT" : ""}`
      : `STOP${s.shuffle ? " SHF" : ""}${s.repeat !== "off" ? " RPT" : ""}`;

  return (
    <div
      className="mp3-body"
      data-variant={variant}
      data-motion={motion ? "on" : "off"}
      role="region"
      aria-label="MP3 player"
      aria-busy={pending !== null}
      style={pending !== null ? (motion ? { opacity: 0.55, transition: "opacity 150ms" } : { opacity: 0.55 }) : undefined}
    >
      <div className="mp3-top">
        <span className="mp3-led" data-state={ledState} aria-hidden="true" />
        <span className="mp3-brand" aria-hidden="true">
          DIGITAL MP3 PLAYER
        </span>
        <span className="mp3-batt" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <em />
        </span>
      </div>
      <Mp3Lcd
        title={title}
        artistLine={artistLine}
        elapsed={elapsed}
        total={total}
        remaining={remaining}
        lcd={lcd}
        motion={motion}
        power={power}
        trackKey={trackKey}
        live={motion && s.isPlaying}
        label={lcdLabel}
        seekBar={seekBar}
      />
      <div className="mp3-status">
        <span>
          {statusText}
          {degraded && p.onRetry ? (
            <button className="mp3-retry" type="button" onClick={p.onRetry} aria-label="Retry loading player">
              Retry
            </button>
          ) : null}
        </span>
        <span className="mp3-hold" data-on={locked ? "on" : "off"} aria-hidden={!locked}>
          HOLD
        </span>
      </div>
      <div className="mp3-wheel" role="group" aria-label="Control wheel">
        <button
          className="mp3-btn mp3-wheel-btn mp3-wheel-prev"
          type="button"
          onClick={p.onPrev}
          onKeyDown={wheelKey}
          disabled={busyPrev || !canTransport}
          title="Previous"
          aria-label="Previous track"
        >
          <PrevIcon size={17} />
        </button>
        <button
          className="mp3-btn mp3-wheel-btn mp3-wheel-next"
          type="button"
          onClick={p.onNext}
          onKeyDown={wheelKey}
          disabled={busyNext || !canTransport}
          title="Next"
          aria-label="Next track"
        >
          <NextIcon size={17} />
        </button>
        {s.isPlaying ? (
          <button
            className="mp3-btn mp3-center"
            type="button"
            onClick={p.onPause}
            onKeyDown={wheelKey}
            disabled={busyToggle}
            title="Pause"
            aria-label="Pause"
          >
            <PauseIcon size={20} />
          </button>
        ) : (
          <button
            className="mp3-btn mp3-center"
            type="button"
            onClick={p.onPlay}
            onKeyDown={wheelKey}
            disabled={busyToggle || !canTransport}
            title="Play"
            aria-label="Play"
          >
            <PlayIcon size={20} />
          </button>
        )}
      </div>
      <div className="mp3-subrow" role="group" aria-label="Playback options">
        <button
          className="mp3-btn mp3-sub-btn"
          type="button"
          onClick={p.onShuffle}
          disabled={isFree}
          title="Shuffle"
          aria-label="Toggle shuffle"
          aria-pressed={s.shuffle}
          data-on={s.shuffle ? "true" : "false"}
        >
          <ShuffleIcon size={13} />
        </button>
        <button
          className="mp3-btn mp3-sub-btn"
          type="button"
          onClick={() => p.onVolume(clampVol(baseVol - VOL_STEP))}
          disabled={isFree}
          title="Volume down"
          aria-label="Volume down"
        >
          {"\u2212"}
        </button>
        <button
          className="mp3-btn mp3-sub-btn"
          type="button"
          onClick={() => p.onVolume(clampVol(baseVol + VOL_STEP))}
          disabled={isFree}
          title="Volume up"
          aria-label="Volume up"
        >
          {"+"}
        </button>
        <button
          className="mp3-btn mp3-sub-btn"
          type="button"
          onClick={p.onRepeat}
          disabled={isFree}
          title={`Repeat: ${s.repeat}`}
          aria-label="Cycle repeat mode"
          aria-pressed={s.repeat !== "off"}
          data-on={s.repeat !== "off" ? "true" : "false"}
        >
          {s.repeat === "track" ? <RepeatOneIcon size={13} /> : <RepeatIcon size={13} />}
        </button>
      </div>
      <div className="mp3-foot" aria-hidden="true">
        STEREO DIGITAL AUDIO
      </div>
    </div>
  );
}

export default memo(Mp3Player);
