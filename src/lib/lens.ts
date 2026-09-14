/* Box-lens SDF map builder plus pointer field singleton.
   Ported from prototype-liquid-glass.html (throwaway): buildBoxMap,
   spring ramp, and pointer field only. Never animate blur radius or
   rebuild the map per frame; mutate scale and saturate per frame only. */

export type LensBucket = "sm" | "md" | "lg";

const MAP_SPECS: Record<LensBucket, { w: number; h: number; edge: number; depth: number }> = {
  sm: { w: 248, h: 180, edge: 24, depth: 60 },
  md: { w: 360, h: 420, edge: 30, depth: 60 },
  lg: { w: 480, h: 640, edge: 42, depth: 60 },
};

/** Rest displacement per bucket. Static lens holds 40-60; enter ramps 0 to rest. */
export const LENS_REST: Record<LensBucket, number> = { sm: 40, md: 42, lg: 48 };
export const LENS_CLAMP = 25;

export function getLensBucket(w: number, h: number): LensBucket {
  const m = Math.max(w, h);
  if (m < 320) return "sm";
  if (m < 700) return "md";
  return "lg";
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function buildBoxMap(w: number, h: number, edge: number, depth: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return "";
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rx = 128;
      let gy = 128;
      const k = (y * w + x) * 4;
      if (x < edge) {
        const t = 1 - x / edge;
        rx = 128 - smooth(t) * depth;
      } else if (x > w - edge) {
        const t2 = (x - (w - edge)) / edge;
        rx = 128 + smooth(t2) * depth;
      }
      if (y < edge) {
        const u = 1 - y / edge;
        gy = 128 - smooth(u) * depth;
      } else if (y > h - edge) {
        const u2 = (y - (h - edge)) / edge;
        gy = 128 + smooth(u2) * depth;
      }
      d[k] = rx;
      d[k + 1] = gy;
      d[k + 2] = 128;
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}

const mapCache = new Map<LensBucket, string>();

export function lensMapFor(bucket: LensBucket): string {
  const hit = mapCache.get(bucket);
  if (hit) return hit;
  const s = MAP_SPECS[bucket];
  const url = buildBoxMap(s.w, s.h, s.edge, s.depth);
  if (url) mapCache.set(bucket, url);
  return url;
}

/** Build each bucket map once, cache, encode async so mount never janks. */
export function ensureLensMaps(): void {
  const buckets: LensBucket[] = ["sm", "md", "lg"];
  const run = () => {
    for (const b of buckets) {
      const url = lensMapFor(b);
      if (!url) continue;
      const node = document.getElementById(`lgMap-${b}`);
      if (node && node.getAttribute("href") !== url) node.setAttribute("href", url);
    }
  };
  if (typeof requestIdleCallback !== "undefined") requestIdleCallback(run);
  else window.setTimeout(run, 0);
}

export function setLensScale(bucket: LensBucket, scale: number): void {
  const clamped = Math.max(0, Math.min(100, scale));
  const node = document.getElementById(`lgDisp-${bucket}`);
  if (node) node.setAttribute("scale", clamped.toFixed(1));
}

/** Ramp displacement 0 to rest without touching blur or the map. */
export function rampLens(bucket: LensBucket, motionOn: boolean): void {
  const target = LENS_REST[bucket];
  const node = document.getElementById(`lgDisp-${bucket}`);
  if (!node) return;
  if (!motionOn) {
    node.setAttribute("scale", String(target));
    return;
  }
  let cur = 0;
  node.setAttribute("scale", "0");
  let raf = 0;
  const tick = () => {
    raf = 0;
    cur += (target - cur) * 0.14;
    if (Math.abs(target - cur) < 0.1) cur = target;
    node.setAttribute("scale", cur.toFixed(1));
    if (cur !== target) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  void raf;
}

export function lensSupported(): boolean {
  try {
    return (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("backdrop-filter", "url(#lg-lens-md)")
    );
  } catch {
    return false;
  }
}

export function shouldForceEffects(): boolean {
  try {
    const root = document.querySelector(".app");
    if (root?.getAttribute("data-force-effects") === "1") return true;
    return localStorage.getItem("snapify-force-effects") === "1";
  } catch {
    return false;
  }
}

export function motionAllowed(force?: boolean): boolean {
  try {
    if (force ?? shouldForceEffects()) return true;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/** One coalesced pointermove rAF writes --lg-pointer-x/y and --lg-glow. */
export function initPointerField(root: HTMLElement): () => void {
  let raf = 0;
  let last: PointerEvent | null = null;
  const SELECTOR = ".pane, .dock, .modal, .toast";
  const onMove = (e: PointerEvent) => {
    if (document.hidden || !motionAllowed()) return;
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = last;
      last = null;
      if (!ev) return;
      const t = (ev.target as HTMLElement | null)?.closest?.(SELECTOR) as HTMLElement | null;
      root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
        if (el !== t && el.style.getPropertyValue("--lg-glow") !== "0") {
          el.style.setProperty("--lg-glow", "0");
        }
      });
      if (!t) return;
      const r = t.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const px = ((ev.clientX - r.left) / r.width) * 100;
      const py = ((ev.clientY - r.top) / r.height) * 100;
      t.style.setProperty("--lg-pointer-x", `${px.toFixed(1)}%`);
      t.style.setProperty("--lg-pointer-y", `${py.toFixed(1)}%`);
      const inside = px > -40 && px < 140 && py > -40 && py < 140;
      t.style.setProperty("--lg-glow", inside ? "1" : "0");
    });
  };
  root.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    root.removeEventListener("pointermove", onMove);
    if (raf) cancelAnimationFrame(raf);
  };
}
