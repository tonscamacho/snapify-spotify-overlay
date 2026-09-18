import { useEffect, useMemo, useRef, useState } from "react";
import type { LyricsState } from "../lib/types";
import { activeCueIndex, activeWordIndex } from "../lib/lrc";
import { toRomaji, translateBatch, type TransLang } from "../lib/translate";
import { MicIcon, NoteIcon } from "./icons";

interface Props {
  lyrics: LyricsState;
  positionMs: number;
  clickToSeek: boolean;
  wordKaraoke: boolean;
  transLang: TransLang;
  onSeek: (ms: number) => void;
  onRetry: () => void;
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <div className="lyrics-meta">
      <MicIcon size={11} />
      <span>{children}</span>
    </div>
  );
}

const OFFSET_STORE_KEY = "snapify-lyrics-offset-v1";
const OFFSET_STEP_MS = 500;
const OFFSET_MAX_MS = 5000;

function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-OFFSET_MAX_MS, Math.min(OFFSET_MAX_MS, Math.round(v)));
}

function loadOffsets(): Record<string, number> {
  try {
    const raw = localStorage.getItem(OFFSET_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function formatOffset(ms: number): string {
  if (ms === 0) return "±0 ms";
  return `${ms > 0 ? "+" : ""}${ms} ms`;
}

export default function LyricsPane(p: Props) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useRef(
    typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const trackId = p.lyrics.kind === "ready" ? p.lyrics.data.trackId : null;

  // Per-track user calibration. Local component state + localStorage;
  // the Rust cache entry carries the same field (applied to served cue
  // timing, invalidated on duration change via the cache key) once its
  // setter IPC lands — see the slice report.
  const [offsetMs, setOffsetMs] = useState(0);
  useEffect(() => {
    if (!trackId) {
      setOffsetMs(0);
      return;
    }
    setOffsetMs(clampOffset(loadOffsets()[trackId] ?? 0));
  }, [trackId]);

  const nudge = (delta: number) => {
    if (!trackId) return;
    const next = clampOffset(offsetMs + delta);
    setOffsetMs(next);
    try {
      const all = loadOffsets();
      if (next === 0) delete all[trackId];
      else all[trackId] = next;
      localStorage.setItem(OFFSET_STORE_KEY, JSON.stringify(all));
    } catch {
      // Storage blocked: the nudge still applies for this session.
    }
  };

  // Calibration shifts cue (and word) timing; stored cues stay raw.
  const baseCues = p.lyrics.kind === "ready" ? p.lyrics.data.cues : [];
  const cues = useMemo(() => {
    if (offsetMs === 0) return baseCues;
    return baseCues.map((c) => ({
      ...c,
      t: c.t + offsetMs,
      words: c.words?.map((w) => ({ ...w, t: w.t + offsetMs })),
    }));
  }, [baseCues, offsetMs]);

  const synced = p.lyrics.kind === "ready" && p.lyrics.data.synced;
  const active = synced ? activeCueIndex(cues, p.positionMs) : -1;

  // Window to ~61 rows around the active cue so a long track stops
  // rebuilding every word span on each 500 ms tick.
  const lo = active < 0 ? 0 : Math.max(0, active - 30);
  const hi = active < 0 ? 60 : active + 31;

  // Romaji where available: pure kana map, no network. Computed for the
  // visible window only.
  const romaji = useMemo(() => {
    const m: Record<number, string> = {};
    for (let i = lo; i < Math.min(hi, cues.length); i++) {
      const r = toRomaji(cues[i]?.text ?? "");
      if (r) m[i] = r;
    }
    return m;
  }, [cues, lo, hi]);

  // Translation covers every visible line in one bounded batch, not just
  // the active line. One AbortController per run: a track or language
  // change aborts in-flight requests so no stale line ever lands under a
  // new track (aborted items resolve null without poisoning the cache).
  const [trans, setTrans] = useState<Record<number, string>>({});
  useEffect(() => {
    if (
      p.transLang === "off" ||
      active < 0 ||
      p.lyrics.kind !== "ready" ||
      !p.lyrics.data.synced
    ) {
      setTrans({});
      return;
    }
    const idxs: number[] = [];
    for (let i = lo; i < Math.min(hi, cues.length); i++) {
      if ((cues[i]?.text ?? "").trim()) idxs.push(i);
    }
    const lang = p.transLang;
    const ctrl = new AbortController();
    let live = true;
    setTrans({});
    if (idxs.length > 0) {
      void translateBatch(
        idxs.map((i) => cues[i].text),
        lang,
        ctrl.signal,
      ).then((results) => {
        if (!live) return;
        const m: Record<number, string> = {};
        results.forEach((t, k) => {
          if (t) m[idxs[k]] = t;
        });
        setTrans(m);
      });
    }
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [active, lo, hi, cues, p.transLang, p.lyrics]);

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({
        block: "center",
        behavior: reduceMotion.current ? "auto" : "smooth",
      });
    }
  }, [active]);

  if (p.lyrics.kind === "idle") {
    return (
      <>
        <div className="empty">
          <div className="empty-title">Lyrics wait for music</div>
          <div className="empty-sub">Play a track to fetch synced lyrics.</div>
          <button className="btn sm" onClick={p.onRetry}>
            Retry
          </button>
        </div>
        <div className="lyrics-attr">Lyrics provided by LRCLIB</div>
      </>
    );
  }
  if (p.lyrics.kind === "loading") {
    return (
      <>
        <div aria-label="Finding lyrics" role="status">
          <div className="skel skel-row" />
          <div className="skel skel-row" />
          <div className="skel skel-row" />
        </div>
      </>
    );
  }
  if (p.lyrics.kind === "error") {
    return (
      <>
        <div className="empty">
          <div className="empty-title">No synced lyrics</div>
          <div className="empty-sub">{p.lyrics.message}</div>
          <button className="btn" onClick={p.onRetry}>
            Retry
          </button>
        </div>
      </>
    );
  }

  const d = p.lyrics.data;
  if (d.instrumental) {
    return (
      <>
        <div className="empty">
          <div className="empty-icon">
            <NoteIcon size={22} />
          </div>
          <div className="empty-title">Instrumental</div>
          <div className="empty-sub">No words in this one.</div>
        </div>
      </>
    );
  }
  if (!d.synced) {
    return (
      <>
        <Meta>Unsynced{d.cached ? <span className="cached"> · Cached</span> : ""}</Meta>
        <div className="plain">{d.plain ?? "Lyrics text unavailable."}</div>
      </>
    );
  }
  return (
    <>
      <Meta>Synced{d.cached ? <span className="cached"> · Cached</span> : ""}</Meta>
      <div role="group" aria-label="Lyric sync calibration">
        <span aria-live="polite">Sync {formatOffset(offsetMs)}</span>{" "}
        <button
          type="button"
          className="btn sm"
          onClick={() => nudge(-OFFSET_STEP_MS)}
          aria-label="Shift lyrics earlier by 500 milliseconds"
        >
          −500 ms
        </button>{" "}
        <button
          type="button"
          className="btn sm"
          onClick={() => nudge(OFFSET_STEP_MS)}
          aria-label="Shift lyrics later by 500 milliseconds"
        >
          +500 ms
        </button>{" "}
        {offsetMs !== 0 && (
          <button
            type="button"
            className="btn sm"
            onClick={() => nudge(-offsetMs)}
            aria-label="Reset lyric sync offset"
          >
            Reset
          </button>
        )}
      </div>
      <div className="lyrics">
        {cues.slice(lo, hi).map((c, k) => {
          const i = lo + k;
          const isActive = i === active;
          const blank = c.text === "";
          const karaoke = p.wordKaraoke && isActive && !blank;
          const end = cues[i + 1]?.t ?? c.t + 4000;
          // True word timing wins when the provider ships it; otherwise
          // the long-standing linear interpolation across the line.
          const timedWords = karaoke && c.words && c.words.length > 0 ? c.words : null;
          const wActive = timedWords ? activeWordIndex(timedWords, p.positionMs) : -1;
          const frac =
            karaoke && !timedWords && end > c.t
              ? Math.min(1, Math.max(0, (p.positionMs - c.t) / (end - c.t)))
              : 1;
          const words = karaoke && !timedWords ? c.text.split(" ") : [];
          const doneCount = karaoke && !timedWords ? Math.floor(frac * words.length) : words.length;
          const lineTrans = trans[i];
          const lineRomaji = romaji[i];
          return (
            <button
              key={`${c.t}-${i}`}
              ref={isActive ? (activeRef as React.Ref<HTMLButtonElement>) : undefined}
              type="button"
              className={
                blank ? "line gap" : isActive ? "line on" : i < active ? "line past" : "line"
              }
              onClick={p.clickToSeek ? () => p.onSeek(c.t) : undefined}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && p.clickToSeek) {
                  e.preventDefault();
                  p.onSeek(c.t);
                }
              }}
              title={p.clickToSeek ? "Seek to this line" : c.text}
              aria-current={isActive ? "true" : undefined}
            >
              {karaoke ? (
                <>
                  {timedWords ? (
                    <>
                      {timedWords.map((w, wi) => (
                        <span key={wi} className={wi <= wActive ? "w w-done" : "w"}>
                          {w.text}
                          {wi < timedWords.length - 1 ? " " : ""}
                        </span>
                      ))}
                    </>
                  ) : (
                    <>
                      {words.map((w, wi) => (
                        <span key={wi} className={wi < doneCount ? "w w-done" : "w"}>
                          {w}
                          {wi < words.length - 1 ? " " : ""}
                        </span>
                      ))}
                    </>
                  )}
                  {lineRomaji && (
                    <div className="trans" lang="ja-Latn">
                      {lineRomaji}
                    </div>
                  )}
                  {lineTrans && (
                    <div className="trans" lang={p.transLang}>
                      {lineTrans}
                    </div>
                  )}
                </>
              ) : blank ? (
                "···"
              ) : (
                <>
                  {c.text}
                  {lineRomaji && (
                    <div className="trans" lang="ja-Latn">
                      {lineRomaji}
                    </div>
                  )}
                  {lineTrans && p.transLang !== "off" && (
                    <div className="trans" lang={p.transLang}>
                      {lineTrans}
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="lyrics-attr">Lyrics provided by LRCLIB</div>
    </>
  );
}
