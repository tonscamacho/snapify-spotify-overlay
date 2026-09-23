import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NoteIcon } from "./icons";
import { PaneStateBanner } from "./BrowsePane";

interface Props {
  isPlaying: boolean;
  /** Changes per track so the motion signature follows the music. */
  seed: string | null;
  /** True while the app is in a throttled episode: pins the unified
   *  banner above the canvas instead of a one-off note. */
  degraded?: boolean;
  onRetry?: () => void;
}

const BARS = 40;

function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Ambient motion visualizer. The Spotify Web API exposes no audio
 * stream, so this renders a deterministic motion signature seeded by
 * the track: layered sines advance only while the track plays and
 * freeze on pause. One rAF loop, no allocations per frame, paused
 * while the window is hidden. Reduced motion freezes it too unless
 * the user forces motion from the pane.
 */
export default function VisualizerPane(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ isPlaying: p.isPlaying, seed: hashSeed(p.seed ?? "idle") });

  stateRef.current.isPlaying = p.isPlaying;
  stateRef.current.seed = hashSeed(p.seed ?? "idle");

  // Reduced-motion override. The OS setting freezes the loop by default;
  // the user can force motion from the pane itself. Persisted beside the
  // other snapify-* prefs so the choice survives reloads.
  const [forceMotion, setForceMotion] = useState<boolean>(() => {
    try {
      return localStorage.getItem("snapify-force-motion") === "1";
    } catch {
      return false;
    }
  });
  const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const motionOff = reducedMotion && !forceMotion;
  const live = p.isPlaying && !motionOff;

  const enableMotion = () => {
    setForceMotion(true);
    try {
      localStorage.setItem("snapify-force-motion", "1");
    } catch {
      // Private mode. Lasts the session.
    }
  };
  const lightRef = useRef<boolean | null>(null);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 300, h: 120 });
  // Mirror of the render-time motion decision for the rAF closure, which
  // never re-subscribes: OS setting flips apply on the next frame.
  const motionRef = useRef({ isPlaying: p.isPlaying, motionOff });
  motionRef.current.isPlaying = p.isPlaying;
  motionRef.current.motionOff = motionOff;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const app = document.querySelector(".app");
    const readTheme = () => app?.getAttribute("data-theme") === "light";
    lightRef.current = readTheme();
    const themeObs = new MutationObserver(() => {
      lightRef.current = readTheme();
    });
    if (app) themeObs.observe(app, { attributes: true, attributeFilter: ["data-theme"] });
    const sizeObs = new ResizeObserver(() => {
      const w = canvas.clientWidth > 0 ? canvas.clientWidth : 300;
      const h = canvas.clientHeight > 0 ? canvas.clientHeight : 120;
      sizeRef.current = { w, h };
    });
    sizeObs.observe(canvas);

    let raf = 0;
    let t = 0;
    let lastStatic = "";

    const draw = () => {
      const { seed } = stateRef.current;
      const playing = motionRef.current.isPlaying && !motionRef.current.motionOff;
      if (!playing) {
        // Paused or reduced-motion: one static frame per track, then idle.
        const sig = `static:${seed}`;
        if (sig === lastStatic) return;
        lastStatic = sig;
      }
      const { w, h } = sizeRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const light = lightRef.current ?? false;
      const gap = 3;
      const bw = (w - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i += 1) {
        const ph = (seed % 360) * 0.017 + i * 0.55;
        const a = Math.sin(t * 1.7 + ph) * 0.5 + 0.5;
        const b = Math.sin(t * 3.1 + ph * 1.7 + i * 0.21) * 0.5 + 0.5;
        const idle = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(ph * 3));
        const level = playing ? 0.15 + 0.85 * (a * 0.65 + b * 0.35) : idle;
        const bh = Math.max(3, level * (h - 8));
        const x = i * (bw + gap);
        const y = (h - bh) / 2;
        ctx.fillStyle = light ? "rgba(20, 24, 31, 0.72)" : "rgba(244, 246, 248, 0.72)";
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, 2);
        ctx.fill();
      }
      if (playing) t += 1 / 60;
    };

    draw();
    const loop = () => {
      // While frozen (paused or reduced-motion) draw() keeps one static
      // frame per track and returns; the guard inside makes this cheap.
      if (!document.hidden) draw();
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(raf);
      themeObs.disconnect();
      sizeObs.disconnect();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(mq.matches);
    try {
      mq.addEventListener("change", onChange);
    } catch {
      // Older engines use the legacy listener form.
      mq.addListener(onChange);
    }
    return () => {
      try {
        mq.removeEventListener("change", onChange);
      } catch {
        mq.removeListener(onChange);
      }
    };
  }, []);

  if (!p.seed) {
    return (
      <>
        <div className="empty">
          <div className="empty-icon">
            <NoteIcon size={22} />
          </div>
          <div className="empty-title">Visualizer waits for music</div>
          <div className="empty-sub">Play a track and it moves here.</div>
          <button
            className="btn sm"
            onClick={() => void openUrl("https://open.spotify.com")}
          >
            OPEN SPOTIFY
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {p.degraded === true && (
        <PaneStateBanner tone="throttled" onRetry={p.onRetry} />
      )}
      <div className="viz-meta" role="status" aria-live="polite" aria-label={live ? "Visualizer live" : p.isPlaying ? "Visualizer still, reduced motion on" : "Visualizer paused"}>
        <span>{live ? "Live" : p.isPlaying ? "Still" : "Paused"}</span>
        <span className="viz-dot" data-on={live ? "1" : "0"} aria-hidden="true" />
      </div>
      <canvas ref={canvasRef} className="viz" aria-label="Playback visualizer" role="img" />
      {motionOff ? (
        <div className="hint viz-hint">
          Still: your system asks for reduced motion.{" "}
          <button className="btn sm" onClick={enableMotion}>
            Enable motion
          </button>
        </div>
      ) : (
        <div className="hint viz-hint">Motion follows playback. Still when paused.</div>
      )}
    </>
  );
}
