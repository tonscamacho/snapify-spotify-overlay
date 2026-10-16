import { useState, type ReactElement } from "react";
import type { ClockBucket } from "../lib/types";

/** Clock chart kinds. Streams counts plays per hour; minutes sums
 *  listened minutes per hour. Both read the same 24 `ClockBucket`s. */
export type ClockKind = "streams" | "minutes";

const HOURS = 24;
const STEP_DEG = 360 / HOURS;
/** Half-gap between adjacent wedges so the ring reads as 24 ticks. */
const GAP_DEG = 0.7;

const CX = 100;
const CY = 100;
/** Outer radius at full scale; inner hole keeps the total legible. */
const R_OUT = 92;
const R_IN = 30;
/** Baseline lift so a zero hour still paints (and hovers) as a ring. */
const R_ZERO_LIFT = 1.5;

/** "19:00 - 20:00: 12,609 streams". Hour wraps past midnight; the
 *  value formats with thousands separators. Pure. */
export function formatClockTip(hour: number, value: number, unit: "streams" | "minutes"): string {
  const h = ((hour % HOURS) + HOURS) % HOURS;
  const next = (h + 1) % HOURS;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const n = value.toLocaleString("en-US");
  const word = unit === "streams" ? (value === 1 ? "stream" : "streams") : value === 1 ? "minute" : "minutes";
  return `${pad(h)}:00 - ${pad(next)}:00: ${n} ${word}`;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Annular sector path for one hour wedge. Radius scales linearly by
 *  value/max; a zero max (or zero value) rests on the baseline ring. */
function wedgePath(hour: number, value: number, max: number): string {
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const rOuter = R_IN + R_ZERO_LIFT + (R_OUT - R_IN - R_ZERO_LIFT) * frac;
  const rInner = R_IN;
  const a0 = -90 + hour * STEP_DEG + GAP_DEG;
  const a1 = -90 + (hour + 1) * STEP_DEG - GAP_DEG;
  const [x0, y0] = polar(CX, CY, rOuter, a0);
  const [x1, y1] = polar(CX, CY, rOuter, a1);
  const [x2, y2] = polar(CX, CY, rInner, a1);
  const [x3, y3] = polar(CX, CY, rInner, a0);
  const f = (n: number): string => n.toFixed(2);
  return `M ${f(x0)} ${f(y0)} A ${f(rOuter)} ${f(rOuter)} 0 0 1 ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)} A ${f(rInner)} ${f(rInner)} 0 0 0 ${f(x3)} ${f(y3)} Z`;
}

function valuesFor(buckets: ClockBucket[], kind: ClockKind): number[] {
  return buckets.map((b) => (kind === "streams" ? b.plays : b.minutes));
}

interface CoxChartProps {
  kind: ClockKind;
  buckets: ClockBucket[];
  /** Shared hover hour across both charts, or null when idle. */
  hover: number | null;
  onHover: (hour: number | null) => void;
}

/** One 24-wedge radial coxcomb: wedges sized by value/max, one tick
 *  spoke per hour, hover/focus tooltip per wedge. Static SVG; motion
 *  is an opacity-only hover transition (no keyframes). */
function CoxChart(props: CoxChartProps): ReactElement {
  const { kind, buckets, hover, onHover } = props;
  const values = valuesFor(buckets, kind);
  const unit = kind === "streams" ? "streams" : "minutes";
  const total = values.reduce((n, v) => n + v, 0);
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const caption = kind === "streams" ? "streams" : "minutes streamed";
  const ariaTotal = `${total.toLocaleString("en-US")} ${kind === "streams" ? "streams" : "minutes"}`;
  const spokes = Array.from({ length: HOURS }, (_, hour) => {
    const a = ((-90 + hour * STEP_DEG) * Math.PI) / 180;
    return {
      hour,
      x1: CX + (R_IN - 8) * Math.cos(a),
      y1: CY + (R_IN - 8) * Math.sin(a),
      x2: CX + R_OUT * Math.cos(a),
      y2: CY + R_OUT * Math.sin(a),
    };
  });
  return (
    <div className="cox-chart" data-clock={kind}>
      <svg viewBox="0 0 200 200" role="img" aria-label={`${caption} listening clock: ${ariaTotal}`}>
        {spokes.map((s) => (
          <line
            key={`spoke-${s.hour}`}
            className="cox-spoke"
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
          />
        ))}
        {values.map((value, hour) => {
          const tip = formatClockTip(hour, value, unit);
          return (
            <path
              key={`wedge-${hour}`}
              className="cox-wedge"
              d={wedgePath(hour, value, max)}
              data-hour={hour}
              tabIndex={0}
              aria-label={tip}
              onMouseEnter={() => onHover(hour)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(hour)}
              onBlur={() => onHover(null)}
            >
              <title>{tip}</title>
            </path>
          );
        })}
        <text className="cox-total" x={CX} y={CY + 6} textAnchor="middle" aria-hidden="true">
          {total.toLocaleString("en-US")}
        </text>
      </svg>
      {hover !== null && (
        <div className="cox-tip" role="tooltip">
          {formatClockTip(hover, values[hover] ?? 0, unit)}
        </div>
      )}
      <div className="cox-cap">{caption}</div>
    </div>
  );
}

/**
 * Stats.fm-style listening clocks: two 24-wedge radial coxcombs, one
 * for streams and one for minutes, sharing one hover hour. `buckets`
 * must hold all 24 hours (see `bucketListeningClocks` in lib/profile,
 * the single derivation site). Token colors only; readable at 320px;
 * clean in all four themes plus glass.
 */
export default function ListeningClocks({ buckets }: { buckets: ClockBucket[] }): ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const full: ClockBucket[] = Array.from({ length: HOURS }, (_, hour) => {
    const found = buckets.find((b) => b.hour === hour);
    return found ?? { hour, plays: 0, minutes: 0 };
  });
  return (
    <div className="listening-clocks">
      <CoxChart kind="streams" buckets={full} hover={hover} onHover={setHover} />
      <CoxChart kind="minutes" buckets={full} hover={hover} onHover={setHover} />
    </div>
  );
}
