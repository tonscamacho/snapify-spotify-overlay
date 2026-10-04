import { memo } from "react";
import type { ReactNode } from "react";

export type Mp3LcdView = "track" | "time" | "eq";
export type Mp3Power = "on" | "boot" | "goodbye";

export interface Mp3LcdProps {
  title: string;
  artistLine: string;
  elapsed: string;
  total: string;
  remaining: string;
  lcd: Mp3LcdView;
  motion: boolean;
  power: Mp3Power;
  trackKey: string;
  live: boolean;
  label: string;
  seekBar: ReactNode;
}

function Mp3Lcd(p: Mp3LcdProps) {
  return (
    <div className="mp3-lcd" role="status" aria-live="polite" aria-label={p.label}>
      {p.motion && p.power === "on" && <div key={p.trackKey} className="mp3-sweep" aria-hidden="true" />}
      {p.power === "boot" ? (
        <div className="mp3-boot">Welcome</div>
      ) : p.power === "goodbye" ? (
        <div className="mp3-goodbye">Goodbye</div>
      ) : p.lcd === "time" ? (
        <div key={p.trackKey} className={p.motion ? "mp3-view mp3-slide" : "mp3-view"}>
          <div className="mp3-big">{p.elapsed}</div>
          <div className="mp3-sub">{p.total}</div>
          {p.seekBar}
        </div>
      ) : p.lcd === "eq" ? (
        <div className="mp3-view">
          <div className="mp3-sub">{p.title}</div>
          <div className="mp3-eq" data-live={p.live ? "on" : "off"} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="mp3-times">
            <span>{p.elapsed}</span>
            <span>-{p.remaining}</span>
          </div>
        </div>
      ) : (
        <div key={p.trackKey} className={p.motion ? "mp3-view mp3-slide" : "mp3-view"}>
          <div className="mp3-title" title={p.title}>
            <span className="mp3-title-inner" style={p.live ? undefined : { animationPlayState: "paused" }}>{p.title}</span>
          </div>
          <div className="mp3-artist" title={p.artistLine}>
            {p.artistLine}
          </div>
          {p.seekBar}
          <div className="mp3-times">
            <span>{p.elapsed}</span>
            <span>-{p.remaining}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(Mp3Lcd);
