import type {
  LayoutState,
  LayoutUndoEntry,
  PaneState,
  PaneType,
  SceneLayout,
  SceneName,
  SceneSlot,
} from "./types";

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
  return { id, type, x, y, w, h, opacity: DEFAULT_OPACITY, visible: true, collapsed: false, z };
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

/** Maximum layout-undo steps kept. Ctrl+Z in edit mode pops the last. */
export const LAYOUT_UNDO_DEPTH = 20;

/** Deep copy so undo snapshots never alias live pane objects. */
export function clonePanes(panes: PaneState[]): PaneState[] {
  return panes.map((p) => ({ ...p }));
}

/** Push a snapshot, dropping the oldest entries past the cap. Pure: the
 *  input stack and entry panes are copied, never mutated or aliased. */
export function pushLayoutUndo(
  stack: LayoutUndoEntry[],
  entry: LayoutUndoEntry,
  cap: number = LAYOUT_UNDO_DEPTH,
): LayoutUndoEntry[] {
  const next = [...stack, { panes: clonePanes(entry.panes), preset: entry.preset }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Default geometry for a newly added pane of a type. Matches the cascade
 *  the editor used historically so toggles keep their old placement. */
export function newPaneForType(panes: PaneState[], type: PaneType, id?: string): PaneState {
  const z = panes.reduce((m, x) => Math.max(m, x.z), 0) + 1;
  const n = panes.length;
  const min = getPaneMin(type);
  // Browse defaults to 400 px wide so a fresh pane lands above the 380 px
  // tab-collapse breakpoint (content 398 > 380): the seven tabs stay
  // clickable until the user narrows the pane into the select fallback.
  const defaultW = type === "browse" ? 400 : Math.max(min.w, type === "lyrics" ? 420 : 340);
  return {
    id: id ?? `${type}-${Date.now() % 100000}`,
    type,
    x: 40 + n * 32,
    y: 40 + n * 32,
    w: defaultW,
    h: Math.max(min.h, type === "lyrics" ? 380 : type === "browse" ? 480 : 230),
    opacity: DEFAULT_OPACITY,
    visible: true,
    collapsed: false,
    z,
  };
}

/** Flip one pane type visible/hidden, appending it when missing. Every other
 *  pane keeps its exact geometry, so toggle off/on always restores. Pure. */
export function togglePaneVisibility(
  panes: PaneState[],
  type: PaneType,
  id?: string,
): PaneState[] {
  const existing = panes.find((x) => x.type === type);
  if (existing) {
    return panes.map((x) =>
      x.type === type ? { ...x, visible: !x.visible } : { ...x },
    );
  }
  return [...panes.map((p) => ({ ...p })), newPaneForType(panes, type, id)];
}

/** Non-destructive reveal: make one pane type visible without touching any
 *  other pane's geometry. Returns the input array untouched when the pane
 *  is already visible so callers can skip persist/setState. Pure. */
export function revealPaneType(
  panes: PaneState[],
  type: PaneType,
  id?: string,
): PaneState[] {
  const existing = panes.find((x) => x.type === type);
  if (existing) {
    if (existing.visible) return panes;
    return panes.map((x) =>
      x.type === type ? { ...x, visible: true } : { ...x },
    );
  }
  return [...panes.map((p) => ({ ...p })), newPaneForType(panes, type, id)];
}

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
    collapsed: raw.collapsed === true,
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

/* ---------- PR8 scenes (schema v4), collapse, stream-safe ---------- */

export const SCENE_NAMES: SceneName[] = ["game", "focus", "stream"];

export const SCENE_LABELS: Record<SceneName, string> = {
  game: "Game",
  focus: "Focus",
  stream: "Stream",
};

/** Fresh-install factory preset per scene. Game stays glance-only
 *  (player), Focus pairs lyrics with the player, Stream keeps the
 *  player plus the queue for chat-driven picks. */
export const SCENE_PRESETS: Record<SceneName, string> = {
  game: "minimal",
  focus: "lyrics",
  stream: "full",
};

/** Pause-to-hide delay for streaming-safe mode. Fixed at 2.5 s per
 *  the PR8 spec (on/off + dim are the only settings). */
export const STREAM_HIDE_DELAY_MS = 2500;

/** Collapsed player floor: the 64 px mini row (art + title + play). */
export const COLLAPSED_PLAYER_H = 64;

/** Player container breakpoint for the mini row (see the 280 px
 *  container query in App.css). The App renders the mini row when the
 *  pane box is at most this plus the 2 px pane border, so the React
 *  gate and the CSS switch agree with no dead zone. */
export const MINI_PLAYER_W = 280;

function isSceneName(v: unknown): v is SceneName {
  return v === "game" || v === "focus" || v === "stream";
}

function coerceSceneSlot(raw: unknown): SceneSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { preset?: unknown; panes?: unknown };
  if (!Array.isArray(s.panes) || s.panes.length === 0) return null;
  const panes: PaneState[] = [];
  s.panes.forEach((p, i) => {
    const c = coercePane(p as Partial<PaneState>, i + 1);
    if (c) panes.push(c);
  });
  if (panes.length === 0) return null;
  return {
    preset: typeof s.preset === "string" && s.preset ? s.preset : "custom",
    panes,
  };
}

/** Fresh per-scene arrangements from the scene factories. Pure. */
export function defaultScenes(): Record<SceneName, SceneSlot> {
  const take = (name: SceneName): SceneSlot => {
    const factory = PRESETS[SCENE_PRESETS[name]] ?? PRESETS.minimal;
    const l = factory();
    return { preset: l.preset, panes: clonePanes(l.panes) };
  };
  return { game: take("game"), focus: take("focus"), stream: take("stream") };
}

export function defaultSceneLayout(): SceneLayout {
  return { version: 4, activeScene: "game", scenes: defaultScenes() };
}

/** First-run doc for a known canvas: the game scene opens the historic
 *  first-run stage (lyrics + player from defaultLayoutFor, kept under
 *  its legacy "full" label) so fresh installs land on the familiar
 *  arrangement with lyrics visible; focus/stream start from their
 *  factories and diverge from there. Pure. */
export function defaultSceneLayoutFor(areaW: number, areaH: number): SceneLayout {
  const first = defaultLayoutFor(areaW, areaH);
  const factories = defaultScenes();
  return {
    version: 4,
    activeScene: "game",
    scenes: {
      game: { preset: first.preset, panes: clonePanes(first.panes) },
      focus: factories.focus,
      stream: factories.stream,
    },
  };
}

/** v3 → v4 migration: the stored v3 arrangement seeds every scene so a
 *  pre-v4 custom layout survives the upgrade on all three scenes, then
 *  each scene diverges as the user arranges it. Pure. */
export function migrateV3ToV4(v3: LayoutState): SceneLayout {
  const slot = (preset: string, panes: PaneState[]): SceneSlot => ({
    preset,
    panes: clonePanes(panes),
  });
  return {
    version: 4,
    activeScene: "game",
    scenes: {
      game: slot(v3.preset, v3.panes),
      focus: slot(v3.preset, v3.panes),
      stream: slot(v3.preset, v3.panes),
    },
  };
}

function coerceSceneLayout(parsed: unknown): SceneLayout | null {
  if (!parsed || typeof parsed !== "object") return null;
  const d = parsed as Partial<SceneLayout> & Partial<LayoutState>;
  if (d.version === 4 && d.scenes && typeof d.scenes === "object") {
    const scenes = d.scenes as Record<string, unknown>;
    const game = coerceSceneSlot(scenes["game"]);
    const focus = coerceSceneSlot(scenes["focus"]);
    const stream = coerceSceneSlot(scenes["stream"]);
    // A v4 doc with no usable scene is corrupt; fall through to null so
    // the caller falls back to defaults instead of an empty stage.
    if (!game && !focus && !stream) return null;
    const fallback = defaultScenes();
    return {
      version: 4,
      activeScene: isSceneName(d.activeScene) ? d.activeScene : "game",
      scenes: {
        game: game ?? fallback.game,
        focus: focus ?? fallback.focus,
        stream: stream ?? fallback.stream,
      },
    };
  }
  // v3 read fallback: any v3-shaped doc migrates in place.
  const v3 = coerceLayout(parsed);
  return v3 ? migrateV3ToV4(v3) : null;
}

/** Load the v4 scene doc, migrating v3/legacy keys in place. A stored v3
 *  arrangement loads (migrated); only a missing or corrupt entry yields
 *  null so the caller can seed factory scenes. */
export function loadSceneLayout(): SceneLayout | null {
  for (const k of [KEY, ...LEGACY_KEYS]) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const doc = coerceSceneLayout(JSON.parse(raw) as unknown);
      if (doc) return doc;
    } catch {
      // Corrupt entry. Try the next key.
    }
  }
  return null;
}

export function saveSceneLayout(doc: SceneLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...doc, version: 4 }));
  } catch {
    // Storage full or blocked. Scenes stay in memory.
  }
}

/** Read one scene slot out of a doc. Pure. */
export function getSceneSlot(
  doc: SceneLayout,
  name: SceneName,
): SceneSlot {
  return doc.scenes[name];
}

/** Replace the active scene's slot, returning a new doc. Pure: inputs
 *  are copied, never aliased. */
export function setActiveSlot(
  doc: SceneLayout,
  panes: PaneState[],
  preset: string,
): SceneLayout {
  return {
    version: 4,
    activeScene: doc.activeScene,
    scenes: {
      ...doc.scenes,
      [doc.activeScene]: { preset, panes: clonePanes(panes) },
    },
  };
}

/** Flip one pane's collapsed flag by id, copying every other pane
 *  untouched (geometry, z, visibility all preserved). Pure. */
export function togglePaneCollapsed(panes: PaneState[], id: string): PaneState[] {
  return panes.map((x) =>
    x.id === id ? { ...x, collapsed: !(x.collapsed === true) } : { ...x },
  );
}

/** Streaming-safe settings, persisted under their own key so toggling
 *  them never rewrites scene geometry. Full browser-source export is
 *  deferred (PR8); see the OBS notes for the window-capture path. */
export const STREAM_KEY = "snapify-stream";

export interface StreamSettings {
  /** Pause-delay auto-hide (fixed 2.5 s). Off by default so upgrades
   *  never surprise a running overlay. */
  hideOnPause: boolean;
  /** Dim to a ghost instead of hiding fully. */
  dimInstead: boolean;
}

export const DEFAULT_STREAM: StreamSettings = {
  hideOnPause: false,
  dimInstead: false,
};

export function loadStreamSettings(): StreamSettings {
  try {
    const raw = localStorage.getItem(STREAM_KEY);
    if (!raw) return { ...DEFAULT_STREAM };
    const v = JSON.parse(raw) as Partial<StreamSettings>;
    return {
      hideOnPause: v.hideOnPause === true,
      dimInstead: v.dimInstead === true,
    };
  } catch {
    return { ...DEFAULT_STREAM };
  }
}

export function saveStreamSettings(s: StreamSettings): void {
  try {
    localStorage.setItem(
      STREAM_KEY,
      JSON.stringify({ hideOnPause: s.hideOnPause === true, dimInstead: s.dimInstead === true }),
    );
  } catch {
    // Private mode. Settings last the session.
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
