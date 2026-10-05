import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export const HOLD_MS = 500;
export const WHEEL_STEP_DEG = 30;

/** Max onPrev/onNext invocations per pointermove; excess rotation carries over. */
export const MAX_WHEEL_STEPS_PER_MOVE = 3;

export type Mp3WheelVariant = "purple" | "silver" | "pink" | "black";
export type Mp3WheelView = "track" | "time" | "eq";

export const MP3_VIEW_ORDER: readonly Mp3WheelView[] = ["track", "time", "eq"];

/**
 * Standalone MP3 click wheel. Mount inside `.mp3-body` (provided by the shell
 * owner): the wheel renders only the `.mp3w` root and relies on the ancestor
 * for body styling. When wired into the overlay window, the integration owner
 * must cover `.mp3w` in overlay region reporting (`SELECTORS` in
 * `src/lib/overlay.ts`) or the wheel will not be clickable in
 * interactive mode.
 *
 * Transport debounce contract: radial drag fires at most
 * `MAX_WHEEL_STEPS_PER_MOVE` `onPrev`/`onNext` calls per pointermove, with
 * excess rotation carried to the next event. The wheel is stateless, so the
 * shell must ignore transport callbacks while its busy flags are set and
 * pass `disabled` to lock all five buttons plus drag.
 */
export interface Mp3WheelProps {
  onPrev: () => void;
  onNext: () => void;
  onMenu: () => void;
  onVol: () => void;
  onPlayPause: () => void;
  onCenterHold: () => void;
  onMenuHold: () => void;
  disabled?: boolean;
  variant?: Mp3WheelVariant;
  volArmed?: boolean;
  playing?: boolean;
  motion?: boolean;
  size?: number;
}

export function nextMp3View(view: Mp3WheelView): Mp3WheelView {
  const i = MP3_VIEW_ORDER.indexOf(view);
  return MP3_VIEW_ORDER[(i + 1) % MP3_VIEW_ORDER.length] ?? "track";
}

export function angleOf(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export function shortestDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function stepsForDelta(
  accumulated: number,
  stepDeg: number = WHEEL_STEP_DEG,
): { steps: number; rest: number } {
  const steps = Math.trunc(accumulated / stepDeg);
  return { steps, rest: accumulated - steps * stepDeg };
}

/** Split a raw step count into firings now vs steps carried to the next event. */
export function clampWheelSteps(
  steps: number,
  max: number = MAX_WHEEL_STEPS_PER_MOVE,
): { fire: number; carry: number } {
  const fire = Math.max(-max, Math.min(max, steps));
  return { fire, carry: steps - fire };
}

interface WheelPalette {
  ring1: string;
  ring2: string;
  arc: string;
  arcActive: string;
  sep: string;
  label: string;
  center: string;
  centerEdge: string;
  glyph: string;
  focus: string;
}

const VARIANT_COLORS: Record<Mp3WheelVariant, WheelPalette> = {
  purple: {
    ring1: "#a87fe8",
    ring2: "#4a2683",
    arc: "#3a2a63",
    arcActive: "#574493",
    sep: "#241a40",
    label: "#e6d9ff",
    center: "#6a3fb5",
    centerEdge: "#9a72e0",
    glyph: "#f2eaff",
    focus: "#0a84ff",
  },
  silver: {
    ring1: "#f2f4f6",
    ring2: "#9aa0a8",
    arc: "#a9afb7",
    arcActive: "#d4d9df",
    sep: "#7d838c",
    label: "#23262b",
    center: "#c9ccd2",
    centerEdge: "#f2f4f6",
    glyph: "#23262b",
    focus: "#0a84ff",
  },
  pink: {
    ring1: "#f7c3da",
    ring2: "#b44e82",
    arc: "#a34a7c",
    arcActive: "#c66a9c",
    sep: "#6e2c50",
    label: "#ffe3ee",
    center: "#e58bb4",
    centerEdge: "#f7c3da",
    glyph: "#3a1224",
    focus: "#0a84ff",
  },
  black: {
    ring1: "#5a5d66",
    ring2: "#17181c",
    arc: "#26272c",
    arcActive: "#41434b",
    sep: "#0c0d10",
    label: "#d6d8dd",
    center: "#33343a",
    centerEdge: "#5a5d66",
    glyph: "#f0f1f4",
    focus: "#0a84ff",
  },
};

const MP3W_CSS = [
  ".mp3w{position:relative;touch-action:none;user-select:none;-webkit-user-select:none;line-height:1}",
  ".mp3w svg{display:block;width:100%;height:100%}",
  ".mp3w-btn{position:absolute;background-color:transparent;border:0;padding:0;cursor:pointer;color:inherit;transition:opacity 80ms ease,transform 80ms ease}",
  ".mp3w-btn::-moz-focus-inner{border:0}",
  ".mp3w-btn:focus{outline:none}",
  ".mp3w-btn:focus-visible{outline:2px solid var(--mp3w-focus);outline-offset:2px}",
  ".mp3w-btn-center{border-radius:50%}",
  ".mp3w-btn:active{opacity:0.72}",
  ".mp3w[data-disabled=true] .mp3w-btn{cursor:default}",
  ".mp3w[data-disabled=true] .mp3w-btn:active{opacity:1}",
  ".mp3w[data-disabled=true] svg{opacity:0.55}",
  ".mp3w[data-vol-armed=true] .mp3w-vol-label{fill:var(--mp3w-focus)}",
  ".mp3w[data-motion=false] .mp3w-btn{transition:none}",
  "@media (prefers-reduced-motion:reduce){.mp3w-btn{transition:none}}",
].join("\n");

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function annularSector(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const o0 = polar(cx, cy, rOuter, a0);
  const o1 = polar(cx, cy, rOuter, a1);
  const i1 = polar(cx, cy, rInner, a1);
  const i0 = polar(cx, cy, rInner, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return (
    `M ${o0.x.toFixed(2)} ${o0.y.toFixed(2)}` +
    ` A ${rOuter} ${rOuter} 0 ${large} 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}` +
    ` L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}` +
    ` A ${rInner} ${rInner} 0 ${large} 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)} Z`
  );
}

interface HoldHandlers {
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onBlur: () => void;
}

function useHoldable(tap: () => void, hold: () => void, disabled: boolean): HoldHandlers {
  const tapRef = useRef(tap);
  tapRef.current = tap;
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const timer = useRef<number | null>(null);
  const skipClick = useRef(false);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const begin = useCallback(() => {
    if (disabledRef.current) return;
    skipClick.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!disabledRef.current) holdRef.current();
    }, HOLD_MS);
  }, []);
  const finish = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      if (!disabledRef.current) tapRef.current();
    }
  }, []);
  const abort = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const onClick = useCallback(() => {
    if (skipClick.current) {
      skipClick.current = false;
      return;
    }
    if (!disabledRef.current) tapRef.current();
  }, []);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.repeat) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        begin();
      }
    },
    [begin],
  );
  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        finish();
      }
    },
    [finish],
  );
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!e.isPrimary) return;
      begin();
    },
    [begin],
  );
  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!e.isPrimary) return;
      finish();
    },
    [finish],
  );
  const onBlur = useCallback(() => {
    skipClick.current = false;
  }, []);
  return {
    onClick,
    onKeyDown,
    onKeyUp,
    onPointerDown,
    onPointerUp,
    onPointerCancel: abort,
    onPointerLeave: abort,
    onBlur,
  };
}

export default function Mp3Wheel(props: Mp3WheelProps): React.JSX.Element {
  const {
    onPrev,
    onNext,
    onMenu,
    onVol,
    onPlayPause,
    onCenterHold,
    onMenuHold,
    disabled = false,
    variant = "purple",
    volArmed = false,
    playing = false,
    motion = true,
    size = 200,
  } = props;
  const gradientId = useId();
  const palette = VARIANT_COLORS[variant] ?? VARIANT_COLORS.purple;
  const [pressed, setPressed] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ last: number; acc: number; id: number } | null>(null);
  const nextRef = useRef(onNext);
  nextRef.current = onNext;
  const prevRef = useRef(onPrev);
  prevRef.current = onPrev;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const center = useHoldable(onPlayPause, onCenterHold, disabled);
  const menu = useHoldable(onMenu, onMenuHold, disabled);
  useEffect(
    () => () => {
      dragRef.current = null;
    },
    [],
  );
  const clearPressed = useCallback(() => setPressed(null), []);
  const ringPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabledRef.current || !e.isPrimary) return;
    const target = e.target as HTMLElement | null;
    if (target && typeof target.closest === "function" && target.closest("button")) return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const a = angleOf(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    );
    dragRef.current = { last: a, acc: 0, id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      dragRef.current = null;
    }
  }, []);
  const ringPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.id || disabledRef.current) return;
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const a = angleOf(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    );
    drag.acc += shortestDelta(drag.last, a);
    drag.last = a;
    const { steps, rest } = stepsForDelta(drag.acc);
    if (steps !== 0) {
      const { fire, carry } = clampWheelSteps(steps);
      drag.acc = rest + carry * WHEEL_STEP_DEG;
      if (fire > 0) {
        for (let i = 0; i < fire; i += 1) nextRef.current();
      } else {
        for (let i = 0; i < -fire; i += 1) prevRef.current();
      }
    }
  }, []);
  const ringPointerEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag && e.pointerId === drag.id) dragRef.current = null;
  }, []);
  const vars = {
    "--mp3w-ring1": palette.ring1,
    "--mp3w-ring2": palette.ring2,
    "--mp3w-arc": palette.arc,
    "--mp3w-arc-active": palette.arcActive,
    "--mp3w-sep": palette.sep,
    "--mp3w-label": palette.label,
    "--mp3w-center": palette.center,
    "--mp3w-center-edge": palette.centerEdge,
    "--mp3w-glyph": palette.glyph,
    "--mp3w-focus": palette.focus,
  } as CSSProperties;
  const arcFill = (zone: string): string =>
    pressed === zone ? "var(--mp3w-arc-active)" : "var(--mp3w-arc)";
  return (
    <div
      ref={boxRef}
      className="mp3w"
      role="group"
      aria-label="MP3 click wheel"
      data-variant={variant}
      data-disabled={disabled}
      data-vol-armed={volArmed}
      data-motion={motion}
      style={{ width: size, height: size, ...vars }}
      onPointerDown={ringPointerDown}
      onPointerMove={ringPointerMove}
      onPointerUp={ringPointerEnd}
      onPointerCancel={ringPointerEnd}
    >
      <style>{MP3W_CSS}</style>
      <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--mp3w-ring1)" />
            <stop offset="1" stopColor="var(--mp3w-ring2)" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="97" fill={`url(#${gradientId})`} />
        <path
          d={annularSector(100, 100, 94, 58, -40, 40)}
          fill={arcFill("menu")}
          stroke="var(--mp3w-sep)"
          strokeWidth="1"
        />
        <path
          d={annularSector(100, 100, 94, 58, 50, 130)}
          fill={arcFill("next")}
          stroke="var(--mp3w-sep)"
          strokeWidth="1"
        />
        <path
          d={annularSector(100, 100, 94, 58, 140, 220)}
          fill={arcFill("vol")}
          stroke="var(--mp3w-sep)"
          strokeWidth="1"
        />
        <path
          d={annularSector(100, 100, 94, 58, 230, 310)}
          fill={arcFill("prev")}
          stroke="var(--mp3w-sep)"
          strokeWidth="1"
        />
        <text
          x="100"
          y="28"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="13"
          fontWeight="700"
          letterSpacing="2"
          fill="var(--mp3w-label)"
          fontFamily="system-ui, sans-serif"
        >
          MENU
        </text>
        <text
          x="100"
          y="172"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="13"
          fontWeight="700"
          letterSpacing="2"
          fill="var(--mp3w-label)"
          fontFamily="system-ui, sans-serif"
          className="mp3w-vol-label"
        >
          VOL
        </text>
        <polygon points="20,93 20,107 28,107 28,100 20,100" fill="var(--mp3w-glyph)" />
        <polygon points="30,92 30,108 42,100" fill="var(--mp3w-glyph)" />
        <polygon points="170,92 170,108 158,100" fill="var(--mp3w-glyph)" />
        <polygon points="180,93 180,107 172,107 172,100 180,100" fill="var(--mp3w-glyph)" />
        <circle
          cx="100"
          cy="100"
          r="35"
          fill={pressed === "center" ? "var(--mp3w-arc-active)" : "var(--mp3w-center)"}
          stroke="var(--mp3w-center-edge)"
          strokeWidth="2"
        />
        {playing ? (
          <g fill="var(--mp3w-glyph)">
            <rect x="93" y="90" width="6" height="20" rx="1" />
            <rect x="102" y="90" width="6" height="20" rx="1" />
          </g>
        ) : (
          <polygon points="94,88 94,112 112,100" fill="var(--mp3w-glyph)" />
        )}
      </svg>
      <button
        type="button"
        className="mp3w-btn"
        style={{ left: "34%", top: "3%", width: "32%", height: "26%" }}
        aria-label="Menu, cycle display view, hold to lock"
        disabled={disabled}
        onClick={menu.onClick}
        onKeyDown={menu.onKeyDown}
        onKeyUp={menu.onKeyUp}
        onPointerDown={(e) => {
          setPressed("menu");
          menu.onPointerDown(e);
        }}
        onPointerUp={(e) => {
          clearPressed();
          menu.onPointerUp(e);
        }}
        onPointerCancel={() => {
          clearPressed();
          menu.onPointerCancel();
        }}
        onPointerLeave={() => {
          clearPressed();
          menu.onPointerLeave();
        }}
        onBlur={menu.onBlur}
      />
      <button
        type="button"
        className="mp3w-btn"
        style={{ left: "3%", top: "34%", width: "26%", height: "32%" }}
        aria-label="Previous track"
        disabled={disabled}
        onClick={onPrev}
        onPointerDown={() => setPressed("prev")}
        onPointerUp={clearPressed}
        onPointerCancel={clearPressed}
        onPointerLeave={clearPressed}
      />
      <button
        type="button"
        className="mp3w-btn"
        style={{ left: "71%", top: "34%", width: "26%", height: "32%" }}
        aria-label="Next track"
        disabled={disabled}
        onClick={onNext}
        onPointerDown={() => setPressed("next")}
        onPointerUp={clearPressed}
        onPointerCancel={clearPressed}
        onPointerLeave={clearPressed}
      />
      <button
        type="button"
        className="mp3w-btn"
        style={{ left: "34%", top: "71%", width: "32%", height: "26%" }}
        aria-label={volArmed ? "Volume, adjust with previous and next" : "Volume"}
        aria-pressed={volArmed}
        disabled={disabled}
        onClick={onVol}
        onPointerDown={() => setPressed("vol")}
        onPointerUp={clearPressed}
        onPointerCancel={clearPressed}
        onPointerLeave={clearPressed}
      />
      <button
        type="button"
        className="mp3w-btn mp3w-btn-center"
        style={{ left: "31%", top: "31%", width: "38%", height: "38%" }}
        aria-label={playing ? "Pause, hold to power off" : "Play, hold to power off"}
        disabled={disabled}
        onClick={center.onClick}
        onKeyDown={center.onKeyDown}
        onKeyUp={center.onKeyUp}
        onPointerDown={(e) => {
          setPressed("center");
          center.onPointerDown(e);
        }}
        onPointerUp={(e) => {
          clearPressed();
          center.onPointerUp(e);
        }}
        onPointerCancel={() => {
          clearPressed();
          center.onPointerCancel();
        }}
        onPointerLeave={() => {
          clearPressed();
          center.onPointerLeave();
        }}
        onBlur={center.onBlur}
      />
    </div>
  );
}
