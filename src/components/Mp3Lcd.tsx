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

const MP3_LCD_CSS = [
  ".mp3-lcd{width:176px;height:76px;margin-top:8px;border-radius:4px;position:relative;overflow:hidden;flex:none;z-index:1;",
  "background:var(--mp3-lcd-bg);color:var(--mp3-lcd-fg);",
  "box-shadow:inset 0 2px 6px rgba(0,0,0,.65),inset 0 0 0 2px rgba(0,0,0,.55);text-shadow:0 0 4px currentColor}",
  ".mp3-lcd::after{content:\"\";position:absolute;inset:0;pointer-events:none;z-index:3;",
  "background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(0,0,0,.22) 2px 3px)}",
  ".mp3-sweep{position:absolute;left:0;right:0;top:-45%;height:45%;z-index:2;pointer-events:none;",
  "background:linear-gradient(rgba(255,255,255,0),rgba(255,255,255,.28),rgba(255,255,255,0));",
  "animation:mp3sweep 600ms ease-out 1}",
  ".mp3-view{position:absolute;inset:4px 6px;display:flex;flex-direction:column;justify-content:center;z-index:1}",
  ".mp3-slide{animation:mp3slide 220ms ease-out 1}",
  ".mp3-title{font-size:15px;line-height:18px;height:18px;white-space:nowrap;overflow:hidden}",
  ".mp3-title-inner{display:inline-block;white-space:nowrap;min-width:100%;animation:mp3marquee 7s ease-in-out infinite alternate}",
  ".mp3-artist{font-size:10px;line-height:12px;height:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9;margin-top:2px}",
  ".mp3-bar{height:6px;margin-top:5px;outline-offset:2px;cursor:pointer}",
  ".mp3-bar-track{width:100%;height:100%;background:rgba(127,127,127,.35);overflow:hidden}",
  ".mp3-fill{display:block;width:100%;height:100%;background:currentColor;transform-origin:0 50%;transition:transform 240ms steps(6)}",
  ".mp3-times{display:flex;justify-content:space-between;font-size:9px;line-height:12px;height:12px;margin-top:2px;opacity:.9}",
  ".mp3-big{font-size:26px;line-height:30px;height:30px;white-space:nowrap;overflow:hidden}",
  ".mp3-sub{font-size:10px;line-height:12px;height:12px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mp3-eq{display:flex;align-items:flex-end;gap:5px;height:34px;margin-top:2px}",
  ".mp3-eq i{flex:1;background:currentColor;height:100%;transform:scaleY(.45);transform-origin:50% 100%;animation:mp3eq 900ms ease-in-out infinite}",
  ".mp3-eq i:nth-child(2){animation-duration:740ms;animation-delay:-220ms}",
  ".mp3-eq i:nth-child(3){animation-duration:1050ms;animation-delay:-560ms}",
  ".mp3-eq i:nth-child(4){animation-duration:820ms;animation-delay:-110ms}",
  ".mp3-eq i:nth-child(5){animation-duration:970ms;animation-delay:-430ms}",
  ".mp3-eq[data-live=off] i{animation-play-state:paused}",
  ".mp3-boot{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;letter-spacing:2px;z-index:1;",
  "animation:mp3boot 600ms ease-out 1}",
  ".mp3-goodbye{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;letter-spacing:2px;z-index:1;",
  "animation:mp3fade 500ms ease-out 1}",
  "@keyframes mp3marquee{from{transform:translateX(0)}to{transform:translateX(min(0px,calc(160px - 100%)))}}",
  "@keyframes mp3eq{0%,100%{transform:scaleY(.22)}50%{transform:scaleY(1)}}",
  "@keyframes mp3sweep{from{transform:translateY(0)}to{transform:translateY(360%)}}",
  "@keyframes mp3slide{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}",
  "@keyframes mp3boot{from{transform:translateY(5px);opacity:0}to{transform:translateY(0);opacity:1}}",
  "@keyframes mp3fade{from{opacity:0}to{opacity:1}}",
  ".mp3-body[data-motion=off] .mp3-title-inner{min-width:0;max-width:100%;display:block;overflow:hidden;text-overflow:ellipsis}",
  "@media (prefers-reduced-motion:reduce){.mp3-lcd *{animation:none}}",
].join("\n");

function Mp3Lcd(p: Mp3LcdProps) {
  return (
    <div className="mp3-lcd" role="status" aria-live="polite" aria-label={p.label}>
      <style>{MP3_LCD_CSS}</style>
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
            <span className="mp3-title-inner">{p.title}</span>
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
