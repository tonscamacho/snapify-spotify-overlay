import type { LayoutState, PaneState, PaneType } from "./types";

const KEY = "snapify-layout-v3";
const LEGACY_KEYS = ["snapify-layout-v2", "nebula-layout-v1"];
export const SNAP_EDGE = 8;
export const SNAP_ZONE = 16;
export const DEFAULT_OPACITY = 0.92;
/** Global fallback floor for unknown pane types. */
export const MIN_W = 240;
export const MIN_H = 120;

/** Content floors per pane type. One global minimum forced dead
 *  space in small panes and clipping in browse, so each pane gets
 *  the smallest size its own chrome can survive. */
export const PANE_MIN: Record<PaneType, { w: number; h: number }> = {
  player: { w: 280, h: 190 },
  lyrics: { w: 280, h: 200 },
  queue: { w: 260, h: 180 },
  visualizer: { w: 260, h: 170 },
  browse: { w: 300, h: 340 },
};

export function getPaneMin(type: PaneType): { w: number; h: number } {
  return PANE_MIN[type] ?? { w: MIN_W, h: MIN_H };
}

function pane(id: string, type: PaneType, x: number, y: number, w: number, h: number, z: number): PaneState {
  return { id, type, x, y, w, h, opacity: DEFAULT_OPACITY, visible: true, z };
}

export const PRESETS: Record<string, () => LayoutState> = {
  minimal: () => ({
    version: 3,
    preset: "minimal",
    panes: [pane("player", "player", 24, 24, 340, 196, 1)],
  }),
  full: () => ({
    version: 3,
    preset: "full",
    panes: [
      pane("player", "player", 24, 24, 340, 236, 1),
      pane("queue", "queue", 376, 24, 300, 236, 2),
    ],
  }),
  lyrics: () => ({
    version: 3,
    preset: "lyrics",
    panes: [
      pane("lyrics", "lyrics", 24, 24, 420, 380, 1),
      pane("player", "player", 24, 416, 420, 190, 2),
    ],
  }),
  spotlight: () => ({
    version: 3,
    preset: "spotlight",
    panes: [
      pane("player", "player", 24, 24, 340, 250, 1),
      pane("visualizer", "visualizer", 376, 24, 340, 250, 2),
      pane("lyrics", "lyrics", 24, 286, 692, 320, 3),
    ],
  }),
};

export function defaultLayout(): LayoutState {
  return PRESETS.full();
}

/**
 * First-run arrangement for a fullscreen canvas: lyrics top-right,
 * player bottom-right, the rest cascading top-left.
 */
export function defaultLayoutFor(areaW: number, areaH: number): LayoutState {
  const W = Math.max(800, Math.floor(areaW));
  const H = Math.max(600, Math.floor(areaH));
  const lyricsW = 420;
  const playerW = 360;
  const playerH = 230;
  const lyricsH = Math.min(420, H - 48);
  return {
    version: 3,
    preset: "full",
    panes: [
      {
        id: "lyrics",
        type: "lyrics",
        x: Math.max(0, W - lyricsW - 24),
        y: 24,
        w: lyricsW,
        h: lyricsH,
        opacity: DEFAULT_OPACITY,
        visible: true,
        z: 1,
      },
      {
        id: "player",
        type: "player",
        x: Math.max(0, W - playerW - 24),
        y: Math.max(0, H - playerH - 24),
        w: playerW,
        h: playerH,
        opacity: DEFAULT_OPACITY,
        visible: true,
        z: 2,
      },
    ],
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function coercePane(raw: Partial<PaneState>, z: number): PaneState | null {
  const types = ["player", "lyrics", "queue", "visualizer", "browse"];
  if (!raw || typeof raw.id !== "string" || !types.includes(raw.type as string)) return null;
  const min = getPaneMin(raw.type as PaneType);
  return {
    id: raw.id,
    type: raw.type as PaneState["type"],
    x: Math.max(0, Math.round(num(raw.x, 24))),
    y: Math.max(0, Math.round(num(raw.y, 24))),
    w: Math.max(min.w, Math.round(num(raw.w, 340))),
    h: Math.max(min.h, Math.round(num(raw.h, 220))),
    opacity: Math.min(1, Math.max(0.4, num(raw.opacity, DEFAULT_OPACITY))),
    visible: raw.visible !== false,
    z: num(raw.z, z),
  };
}

function coerceLayout(parsed: unknown): LayoutState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const l = parsed as Partial<LayoutState>;
  if (!Array.isArray(l.panes) || l.panes.length === 0) return null;
  const panes: PaneState[] = [];
  l.panes.forEach((p, i) => {
    const c = coercePane(p as Partial<PaneState>, i + 1);
    if (c) panes.push(c);
  });
  if (panes.length === 0) return null;
  return {
    version: 3,
    preset: typeof l.preset === "string" && l.preset ? l.preset : "custom",
    panes,
  };
}

export function loadLayout(): LayoutState | null {
  for (const k of [KEY, ...LEGACY_KEYS]) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const layout = coerceLayout(JSON.parse(raw) as unknown);
      if (layout) return layout;
    } catch {
      // Corrupt entry. Try the next key.
    }
  }
  return null;
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...layout, version: 3 }));
  } catch {
    // Storage full or blocked. Layout stays in memory.
  }
}

/** Clamp one pane fully inside an area, shrinking it first when the area
 *  itself is smaller. Position bounds use the pane's own clamped size, so
 *  a wide pane cannot strand its right edge off-screen. */
export function clampPaneToArea(
  p: PaneState,
  areaW: number,
  areaH: number,
): PaneState {
  const min = getPaneMin(p.type);
  const W = Math.floor(areaW);
  const H = Math.floor(areaH);
  const w = Math.min(Math.max(min.w, Math.round(p.w)), Math.max(min.w, W - 16));
  const h = Math.min(Math.max(min.h, Math.round(p.h)), Math.max(min.h, H - 16));
  return {
    ...p,
    w,
    h,
    x: Math.min(Math.max(0, Math.round(p.x)), Math.max(0, W - w)),
    y: Math.min(Math.max(0, Math.round(p.y)), Math.max(0, H - h)),
  };
}

/** Clamp a restored layout into the live window so panes never strand off-screen.
 *  Areas are divided by uiScale because the stage renders under a zoom
 *  wrapper while layout state stays in logical px. */
export function clampLayoutToArea(
  layout: LayoutState,
  areaW: number,
  areaH: number,
  uiScale = 1,
): LayoutState {
  const k = uiScale || 1;
  const panes = layout.panes.map((p) => clampPaneToArea(p, areaW / k, areaH / k));
  return { ...layout, panes };
}

export interface SnapResult {
  x: number;
  y: number;
  /** Vertical guide lines (x positions) where the snap landed. */
  v: number[];
  /** Horizontal guide lines (y positions) where the snap landed. */
  h: number[];
}

function snapValue(value: number, targets: { at: number }[], threshold: number): { at: number; line: number | null } {
  const v = Math.round(value);
  for (const t of targets) {
    if (Math.abs(v - t.at) <= threshold) return { at: t.at, line: t.at };
  }
  return { at: v, line: null };
}

/**
 * Magnet snap for a dragged pane. Snaps x/y to screen edges, screen
 * thirds/center, and sibling edges. Hold Shift to bypass (caller-owned).
 */
export function snapMove(
  moving: PaneState,
  siblings: PaneState[],
  areaW: number,
  areaH: number,
): SnapResult {
  const xs = [{ at: 0 }, { at: Math.max(0, Math.round(areaW - moving.w)) }];
  const ys = [{ at: 0 }, { at: Math.max(0, Math.round(areaH - moving.h)) }];
  for (const s of siblings) {
    if (!s.visible || s.id === moving.id) continue;
    xs.push({ at: Math.round(s.x) }, { at: Math.round(s.x + s.w) }, { at: Math.round(s.x - moving.w) }, {
      at: Math.round(s.x + s.w - moving.w),
    });
    ys.push({ at: Math.round(s.y) }, { at: Math.round(s.y + s.h) }, { at: Math.round(s.y - moving.h) }, {
      at: Math.round(s.y + s.h - moving.h),
    });
  }
  const sx = snapValue(moving.x, xs, SNAP_EDGE);
  let x = sx.at;
  const v: number[] = sx.line !== null ? [sx.line] : [];
  if (sx.line === null) {
    const zone = snapValue(moving.x, [
      { at: Math.round(areaW / 2 - moving.w / 2) },
      { at: Math.round(areaW / 3 - moving.w / 2) },
      { at: Math.round((2 * areaW) / 3 - moving.w / 2) },
    ], SNAP_ZONE);
    x = zone.at;
    if (zone.line !== null) v.push(zone.line);
  }
  const sy = snapValue(moving.y, ys, SNAP_EDGE);
  let y = sy.at;
  const h: number[] = sy.line !== null ? [sy.line] : [];
  if (sy.line === null) {
    const zone = snapValue(moving.y, [
      { at: Math.round(areaH / 2 - moving.h / 2) },
      { at: Math.round(areaH / 3 - moving.h / 2) },
    ], SNAP_ZONE);
    y = zone.at;
    if (zone.line !== null) h.push(zone.line);
  }
  return { x: Math.max(0, x), y: Math.max(0, y), v, h };
}

export interface ResizeSnap {
  x: number;
  y: number;
  w: number;
  h: number;
  gv: number[];
  gh: number[];
}

/**
 * Magnet snap for a resized pane. Snaps the dragged edge(s) to screen
 * edges and sibling edges so resizing docks as well as moving does.
 */
export function snapSize(
  moving: PaneState,
  siblings: PaneState[],
  areaW: number,
  areaH: number,
  edges: { east: boolean; south: boolean; west: boolean; north: boolean },
): ResizeSnap {
  const gv: number[] = [];
  const gh: number[] = [];
  let { x, y, w, h: hh } = moving;
  const min = getPaneMin(moving.type);
  const rightTargets = [{ at: Math.round(areaW) }];
  const bottomTargets = [{ at: Math.round(areaH) }];
  const leftTargets = [{ at: 0 }];
  const topTargets = [{ at: 0 }];
  for (const s of siblings) {
    if (!s.visible || s.id === moving.id) continue;
    rightTargets.push({ at: Math.round(s.x) }, { at: Math.round(s.x + s.w) });
    bottomTargets.push({ at: Math.round(s.y) }, { at: Math.round(s.y + s.h) });
    leftTargets.push({ at: Math.round(s.x) }, { at: Math.round(s.x + s.w) });
    topTargets.push({ at: Math.round(s.y) }, { at: Math.round(s.y + s.h) });
  }
  if (edges.east) {
    const s = snapValue(x + w, rightTargets, SNAP_EDGE);
    if (s.line !== null) {
      w = Math.max(min.w, s.at - x);
      gv.push(s.line);
    }
  }
  if (edges.south) {
    const s = snapValue(y + hh, bottomTargets, SNAP_EDGE);
    if (s.line !== null) {
      hh = Math.max(min.h, s.at - y);
      gh.push(s.line);
    }
  }
  if (edges.west) {
    const s = snapValue(x, leftTargets, SNAP_EDGE);
    if (s.line !== null) {
      const right = x + w;
      x = Math.min(s.at, right - min.w);
      w = right - x;
      gv.push(s.line);
    }
  }
  if (edges.north) {
    const s = snapValue(y, topTargets, SNAP_EDGE);
    if (s.line !== null) {
      const bottom = y + hh;
      y = Math.min(s.at, bottom - min.h);
      hh = bottom - y;
      gh.push(s.line);
    }
  }
  return { x, y, w, h: hh, gv, gh };
}
