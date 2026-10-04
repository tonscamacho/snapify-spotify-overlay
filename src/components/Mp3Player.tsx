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

const MP3_BODY_CSS = [
  ".mp3-body{--mp3-b1:#6a3fb5;--mp3-b2:#4a2683;--mp3-edge:#9a72e0;--mp3-ring:#eceaf2;--mp3-ring-in:#c6c2d4;--mp3-lcd-fg:#cfe8c0;--mp3-lcd-bg:#202a1e;--mp3-ink:#f5f2fc;",
  "width:200px;height:340px;border-radius:18px;position:relative;display:flex;flex-direction:column;align-items:center;",
  "padding:12px 12px 12px;box-sizing:border-box;overflow:hidden;",
  "background:linear-gradient(160deg,var(--mp3-edge) 0%,var(--mp3-b1) 22%,var(--mp3-b2) 82%,#22153c 100%);",
  "box-shadow:0 10px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.4),inset 0 -3px 6px rgba(0,0,0,.35);",
  "color:var(--mp3-ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;user-select:none}",
  ".mp3-body[data-variant=silver]{--mp3-b1:#c9ccd2;--mp3-b2:#9aa0a8;--mp3-edge:#f2f4f6;--mp3-ring:#f6f8fa;--mp3-ring-in:#b9bec6;--mp3-lcd-fg:#d8e6ef;--mp3-lcd-bg:#1b2229}",
  ".mp3-body[data-variant=pink]{--mp3-b1:#e58bb4;--mp3-b2:#b44e82;--mp3-edge:#f7c3da;--mp3-ring:#fbeef4;--mp3-ring-in:#d9a4bf;--mp3-lcd-fg:#ffe3ee;--mp3-lcd-bg:#2a1c22}",
  ".mp3-body[data-variant=black]{--mp3-b1:#33343a;--mp3-b2:#17181c;--mp3-edge:#5a5d66;--mp3-ring:#3a3b42;--mp3-ring-in:#17181c;--mp3-lcd-fg:#cfe8c0;--mp3-lcd-bg:#141a12}",
  ".mp3-body::before{content:\"\";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:5;",
  "background:linear-gradient(115deg,rgba(255,255,255,.24) 0%,rgba(255,255,255,.06) 26%,transparent 44%)}",
  ".mp3-top{width:176px;height:16px;display:flex;align-items:center;gap:6px;z-index:1}",
  ".mp3-led{width:6px;height:6px;border-radius:50%;background:#3a2b2b;box-shadow:inset 0 1px 1px rgba(0,0,0,.6);flex:none}",
  ".mp3-led[data-state=play]{background:#37e05a;box-shadow:0 0 4px rgba(55,224,90,.9)}",
  ".mp3-led[data-state=pause]{background:#c22f2f;box-shadow:0 0 3px rgba(194,47,47,.7)}",
  ".mp3-brand{font-size:7px;letter-spacing:1px;opacity:.85;white-space:nowrap;overflow:hidden;flex:1}",
  ".mp3-batt{display:flex;align-items:center;gap:1px;flex:none}",
  ".mp3-batt i{width:4px;height:8px;background:var(--mp3-ink);opacity:.9;display:block}",
  ".mp3-batt i + i{margin-left:1px}",
  ".mp3-batt em{width:5px;height:6px;border:1px solid var(--mp3-ink);border-left:0;display:block;margin-left:1px;box-sizing:border-box}",
  ".mp3-status{width:176px;min-height:16px;margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:6px;",
  "font-size:9px;line-height:14px;z-index:1}",
  ".mp3-hold{letter-spacing:1px;border:1px solid currentColor;border-radius:2px;padding:0 3px;font-size:8px;line-height:12px}",
  ".mp3-hold[data-on=off]{opacity:0}",
  ".mp3-retry{background:transparent;border:1px solid currentColor;color:inherit;border-radius:3px;font:inherit;font-size:8px;",
  "line-height:12px;padding:0 5px;height:14px;cursor:pointer;flex:none}",
  ".mp3-wheel{position:relative;width:140px;height:140px;flex:none;border-radius:50%;margin-top:8px;z-index:1;",
  "background:radial-gradient(circle at 35% 30%,var(--mp3-ring) 0%,var(--mp3-ring-in) 72%,rgba(0,0,0,.35) 100%);",
  "box-shadow:0 3px 8px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.5)}",
  ".mp3-btn{border:0;padding:0;cursor:pointer;color:inherit;font:inherit;display:flex;align-items:center;justify-content:center;",
  "transition:transform 80ms ease-out,opacity 120ms}",
  ".mp3-btn:disabled{opacity:.4;cursor:default}",
  ".mp3-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}",
  ".mp3-wheel-btn{position:absolute;background:transparent;color:#2b2b33;border-radius:50%;width:38px;height:38px}",
  ".mp3-body[data-variant=purple] .mp3-wheel-btn{color:#3d2a68}",
  ".mp3-wheel-prev{left:8px;top:51px}",
  ".mp3-wheel-next{right:8px;top:51px}",
  ".mp3-center{position:absolute;left:44px;top:44px;width:52px;height:52px;border-radius:50%;color:#f2f0f8;",
  "background:radial-gradient(circle at 38% 32%,#6f6a86 0%,#3c3a48 60%,#23222b 100%);",
  "box-shadow:0 2px 5px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.35)}",
  ".mp3-wheel-btn:active:not(:disabled),.mp3-center:active:not(:disabled),.mp3-sub-btn:active:not(:disabled){transform:translateY(2px)}",
  ".mp3-subrow{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px;z-index:1}",
  ".mp3-sub-btn{width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.32);color:var(--mp3-ink);font-size:12px;line-height:1;",
  "box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 1px 2px rgba(0,0,0,.4)}",
  ".mp3-sub-btn[data-on=true]{box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 0 0 2px rgba(255,255,255,.55)}",
  ".mp3-foot{margin-top:auto;font-size:7px;letter-spacing:2px;opacity:.7;z-index:1}",
  ".mp3-body[data-motion=off] *{animation:none}",
  "@media (prefers-reduced-motion:reduce){.mp3-body *{animation:none}}",
].join("\n");

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
        <i className="mp3-fill" style={{ transform: `scaleX(${ratio})` }} />
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
      style={pending !== null ? { opacity: 0.55, transition: "opacity 150ms" } : undefined}
    >
      <style>{MP3_BODY_CSS}</style>
      <div className="mp3-top">
        <span className="mp3-led" data-state={ledState} aria-hidden="true" />
        <span className="mp3-brand" aria-hidden="true">
          DIGITAL MP3 PLAYER
        </span>
        <span className="mp3-batt" role="img" aria-label="Battery full">
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
      <div className="mp3-wheel" role="group" aria-label="Control wheel" onKeyDown={wheelKey}>
        <button
          className="mp3-btn mp3-wheel-btn mp3-wheel-prev"
          type="button"
          onClick={p.onPrev}
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
