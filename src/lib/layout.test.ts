import { describe, expect, it } from "vitest";
import {
  clampLayoutToArea,
  clampPaneToArea,
  clearDockRow,
  clearDockRowForWidth,
  clonePanes,
  DEFAULT_STREAM,
  defaultLayoutFor,
  defaultSceneLayout,
  defaultSceneLayoutFor,
  defaultScenes,
  deoverlapPanes,
  dockColumnFor,
  dockColumnForWidth,
  DOCK_CLEAR_Y,
  DOCK_MAX_W,
  effectiveArea,
  getCompactPaneMin,
  getPaneMin,
  healPanesForDock,
  healPanesForDockForWidth,
  isCompactPane,
  LAYOUT_UNDO_DEPTH,
  loadSceneLayout,
  loadNotchHover,
  loadStreamSettings,
  migrateV3ToV4,
  newPaneForType,
  NOTCH_HOVER_KEY,
  PANE_MIN,
  PLAYER_FULL_H,
  pushLayoutUndo,
  revealPaneType,
  saveSceneLayout,
  saveNotchHover,
  saveStreamSettings,
  SCENE_PRESETS,
  setActiveSlot,
  snapMove,
  snapSize,
  STREAM_HIDE_DELAY_MS,
  togglePaneCollapsed,
  togglePaneVisibility,
} from "./layout";
import type { LayoutState, LayoutUndoEntry, PaneState, PaneType, SceneLayout } from "./types";

function pane(over: Partial<PaneState> = {}): PaneState {
  return {
    id: "m",
    type: "player",
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    opacity: 0.92,
    visible: true,
    z: 1,
    ...over,
  };
}

function layout(panes: PaneState[]): LayoutState {
  return { version: 3, preset: "custom", panes };
}

describe("getPaneMin", () => {
  it("returns the per-type content floors", () => {
    expect(getPaneMin("player")).toEqual({ w: 280, h: 120 });
    expect(getPaneMin("lyrics")).toEqual({ w: 280, h: 200 });
    expect(getPaneMin("queue")).toEqual({ w: 260, h: 180 });
    expect(getPaneMin("visualizer")).toEqual({ w: 260, h: 170 });
    expect(getPaneMin("browse")).toEqual({ w: 300, h: 340 });
  });

  it("matches the exported PANE_MIN record", () => {
    expect(getPaneMin("browse")).toEqual(PANE_MIN.browse);
  });

  it("falls back to the global floor for unknown pane types", () => {
    expect(getPaneMin("nope" as PaneType)).toEqual({ w: 240, h: 120 });
  });
});

describe("compact helpers", () => {
  it("flags panes below 360px wide or below their content floor", () => {
    expect(isCompactPane(340, 196, "player")).toBe(true);
    expect(isCompactPane(400, 150, "player")).toBe(true);
    expect(isCompactPane(400, 200, "player")).toBe(false);
    expect(isCompactPane(400, 300, "browse")).toBe(true);
    expect(isCompactPane(400, 340, "browse")).toBe(false);
  });

  it("keeps the player mini/full swap at 190 while the drag floor is 120", () => {
    expect(PLAYER_FULL_H).toBe(190);
    expect(getPaneMin("player")).toMatchObject({ h: 120 });
    // 120-190 still reads compact (mini) with the same reach as before.
    expect(isCompactPane(400, 120, "player")).toBe(true);
    expect(isCompactPane(400, 189, "player")).toBe(true);
    expect(isCompactPane(400, 190, "player")).toBe(false);
  });

  it("clamps uiScale into 0.85–1.30 and divides the area", () => {
    expect(effectiveArea(400, 300, 1.3)).toMatchObject({ w: 400 / 1.3, h: 300 / 1.3 });
    expect(effectiveArea(400, 300, 99)).toMatchObject({ w: 400 / 1.3, h: 300 / 1.3 });
    expect(effectiveArea(400, 300, 0.1)).toMatchObject({ w: 400 / 0.85, h: 300 / 0.85 });
  });
});

describe("defaultLayoutFor", () => {
  it("docks lyrics top-right and player bottom-right on a 1920x1080 canvas", () => {
    const l = defaultLayoutFor(1920, 1080);
    expect(l.version).toBe(3);
    expect(l.panes).toHaveLength(2);
    expect(l.panes[0]).toMatchObject({
      id: "lyrics",
      type: "lyrics",
      x: 1476,
      y: 24,
      w: 420,
      h: 420,
    });
    expect(l.panes[1]).toMatchObject({
      id: "player",
      type: "player",
      x: 1536,
      y: 826,
      w: 360,
      h: 230,
    });
  });

  it("selects the compact preset below 640px instead of the full preset", () => {
    const l = defaultLayoutFor(400, 300);
    expect(l.preset).toBe("compact");
    expect(l.panes).toHaveLength(2);
    // Player on top, browse below, everything inside the 400x300 stage.
    expect(l.panes[0]).toMatchObject({ id: "player", x: 8, y: 8, w: 340, h: 136 });
    expect(l.panes[1]).toMatchObject({ id: "browse", x: 8, y: 152, w: 384, h: 140 });
    for (const pane of l.panes) {
      expect(pane.x + pane.w).toBeLessThanOrEqual(400);
      expect(pane.y + pane.h).toBeLessThanOrEqual(300);
    }
  });

  it("scales the canvas by uiScale before placing the full preset", () => {
    // 1280x800 at 1.3 => 984x615 logical: still the full preset, but
    // placed inside the logical stage instead of the CSS pixels.
    const l = defaultLayoutFor(1280, 800, 1.3);
    expect(l.preset).toBe("full");
    expect(l.panes[0]).toMatchObject({ x: 540, y: 24, w: 420, h: 420 });
    expect(l.panes[1]).toMatchObject({ x: 600, y: 361, w: 360, h: 230 });
  });

  it("shrinks the lyrics pane when the canvas is short", () => {
    const l = defaultLayoutFor(1920, 600);
    // H floors to 600, lyricsH = min(420, 600 - 48)
    expect(l.panes[0].h).toBe(420);
    const short = defaultLayoutFor(800, 600);
    expect(short.panes[0].h).toBe(420);
  });
});

describe("clampLayoutToArea", () => {
  it("shrinks an oversized off-screen pane into an 800x600 area", () => {
    const l = layout([
      pane({ id: "a", x: 2000, y: 1500, w: 2000, h: 1500 }),
    ]);
    const out = clampLayoutToArea(l, 800, 600);
    expect(out.panes[0]).toMatchObject({ x: 16, y: 16, w: 784, h: 584 });
  });

  it("leaves an in-bounds pane untouched", () => {
    const l = layout([pane({ x: 10, y: 10, w: 300, h: 200 })]);
    const out = clampLayoutToArea(l, 800, 600);
    expect(out.panes[0]).toMatchObject({ x: 10, y: 10, w: 300, h: 200 });
  });

  it("pulls a normal-size pane fully inside the east and south edges", () => {
    const l = layout([pane({ x: 1700, y: 900, w: 340, h: 230 })]);
    const out = clampLayoutToArea(l, 1920, 1040);
    expect(out.panes[0]).toMatchObject({ x: 1580, y: 810, w: 340, h: 230 });
  });

  it("yields to the compact floor instead of overflowing a tiny area", () => {
    const l = layout([pane({ x: 50, y: 50, w: 340, h: 230 })]);
    const out = clampLayoutToArea(l, 200, 600);
    expect(out.panes[0]).toMatchObject({ x: 16, w: 184 });
  });

  it("keeps a browse pane inside a 400x300 stage", () => {
    const l = layout([
      { ...pane({ x: 8, y: 8, w: 384, h: 140 }), id: "b", type: "browse" },
    ]);
    const out = clampLayoutToArea(l, 400, 300);
    expect(out.panes[0].x + out.panes[0].w).toBeLessThanOrEqual(400);
    expect(out.panes[0].y + out.panes[0].h).toBeLessThanOrEqual(300);
  });

  it("divides the area by uiScale before clamping", () => {
    const l = layout([
      pane({ id: "a", x: 2000, y: 1500, w: 2000, h: 1500 }),
    ]);
    const out = clampLayoutToArea(l, 1600, 1200, 2);
    expect(out.panes[0]).toMatchObject({ x: 16, y: 16, w: 784, h: 584 });
  });

  it("keeps a 420-wide profile pane inside a 1920 stage at 125% uiScale", () => {
    // Repro: x=1440 w=420 is legal at k=1 (right 1860) but the 1.25 zoom
    // wrapper paints x=1800 w=525 (right 2325, 405px clipped). Clamping in
    // logical px against the 1536-wide effective stage keeps the painted
    // right edge at the viewport edge.
    const l = layout([
      { ...pane({ x: 1440, y: 24, w: 420, h: 560 }), id: "profile", type: "profile" },
    ]);
    const out = clampLayoutToArea(l, 1920, 1080, 1.25);
    expect(out.panes[0]).toMatchObject({ x: 1116, y: 24, w: 420, h: 560 });
    for (const p of out.panes) {
      expect(p.x + p.w).toBeLessThanOrEqual(1920 / 1.25);
      expect((p.x + p.w) * 1.25).toBeLessThanOrEqual(1920);
    }
  });

  it("does not mutate the input layout", () => {
    const l = layout([
      pane({ id: "a", x: 2000, y: 1500, w: 2000, h: 1500 }),
    ]);
    clampLayoutToArea(l, 800, 600);
    expect(l.panes[0].x).toBe(2000);
  });
});

describe("snapMove", () => {
  it("snaps to the top-left screen corner within the edge threshold", () => {
    const r = snapMove(pane({ x: 2, y: 3, w: 200, h: 100 }), [], 1000, 800);
    expect(r).toEqual({ x: 0, y: 0, v: [0], h: [0] });
  });

  it("leaves a pane far from every guide untouched", () => {
    const r = snapMove(pane({ x: 100, y: 100, w: 200, h: 100 }), [], 1000, 800);
    expect(r).toEqual({ x: 100, y: 100, v: [], h: [] });
  });

  it("snaps the left edge to a sibling right edge", () => {
    const sib = pane({ id: "s", type: "queue", x: 500, y: 0, w: 200, h: 100 });
    const r = snapMove(pane({ x: 702, y: 250, w: 200, h: 100 }), [sib], 1000, 800);
    expect(r.x).toBe(700);
    expect(r.v).toEqual([700]);
    expect(r.y).toBe(250);
    expect(r.h).toEqual([]);
  });

  it("snaps to the right screen edge", () => {
    const r = snapMove(pane({ x: 796, y: 250, w: 200, h: 100 }), [], 1000, 800);
    expect(r.x).toBe(800);
    expect(r.v).toEqual([800]);
  });

  it("snaps to the horizontal center zone", () => {
    const r = snapMove(pane({ x: 405, y: 250, w: 200, h: 100 }), [], 1000, 800);
    expect(r.x).toBe(400);
    expect(r.v).toEqual([400]);
  });

  it("ignores hidden siblings", () => {
    const hidden = pane({ id: "s", x: 500, y: 0, w: 200, h: 100, visible: false });
    const r = snapMove(pane({ x: 702, y: 250, w: 200, h: 100 }), [hidden], 1000, 800);
    expect(r.x).toBe(702);
    expect(r.v).toEqual([]);
  });
});

describe("snapSize", () => {
  const noEdges = { east: false, south: false, west: false, north: false };

  it("snaps the east edge to the screen edge", () => {
    const r = snapSize(
      pane({ x: 0, y: 0, w: 796, h: 200 }),
      [],
      800,
      600,
      { ...noEdges, east: true },
    );
    expect(r.w).toBe(800);
    expect(r.gv).toEqual([800]);
  });

  it("leaves the east edge alone when far from any target", () => {
    const r = snapSize(
      pane({ x: 0, y: 0, w: 700, h: 200 }),
      [],
      800,
      600,
      { ...noEdges, east: true },
    );
    expect(r.w).toBe(700);
    expect(r.gv).toEqual([]);
  });

  it("snaps the south edge to the screen bottom", () => {
    const r = snapSize(
      pane({ x: 0, y: 0, w: 300, h: 596 }),
      [],
      800,
      600,
      { ...noEdges, south: true },
    );
    expect(r.h).toBe(600);
    expect(r.gh).toEqual([600]);
  });

  it("snaps the west edge to zero and keeps the right edge fixed", () => {
    const r = snapSize(
      pane({ x: 3, y: 50, w: 300, h: 200 }),
      [],
      800,
      600,
      { ...noEdges, west: true },
    );
    expect(r.x).toBe(0);
    expect(r.w).toBe(303);
    expect(r.gv).toEqual([0]);
  });

  it("snaps the north edge to zero and keeps the bottom fixed", () => {
    const r = snapSize(
      pane({ x: 50, y: 2, w: 300, h: 300 }),
      [],
      800,
      600,
      { ...noEdges, north: true },
    );
    expect(r.y).toBe(0);
    expect(r.h).toBe(302);
    expect(r.gh).toEqual([0]);
  });

  it("snaps the east edge to a sibling edge", () => {
    const sib = pane({ id: "s", x: 400, y: 0, w: 100, h: 100 });
    const r = snapSize(
      pane({ x: 0, y: 0, w: 497, h: 200 }),
      [sib],
      1000,
      800,
      { ...noEdges, east: true },
    );
    expect(r.w).toBe(500);
    expect(r.gv).toEqual([500]);
  });

  it("enforces the pane minimum when a west snap would collapse it", () => {
    const sib = pane({ id: "s", x: 500, y: 0, w: 100, h: 100 });
    const r = snapSize(
      pane({ x: 502, y: 0, w: 100, h: 200 }),
      [sib],
      1000,
      800,
      { ...noEdges, west: true },
    );
    // right = 602, min.w for player = 280 -> x = 602 - 280, w = 280
    expect(r.x).toBe(322);
    expect(r.w).toBe(280);
    expect(r.gv).toEqual([500]);
  });

  it("does nothing when no edges are dragged", () => {
    const r = snapSize(pane({ x: 2, y: 3, w: 300, h: 200 }), [], 800, 600, noEdges);
    expect(r).toEqual({ x: 2, y: 3, w: 300, h: 200, gv: [], gh: [] });
  });
});

describe("clonePanes", () => {
  it("deep-copies so snapshots never alias live panes", () => {
    const live = [pane({ id: "a", x: 10 })];
    const snap = clonePanes(live);
    live[0].x = 999;
    expect(snap[0].x).toBe(10);
  });
});

describe("pushLayoutUndo", () => {
  const entry = (id: string): LayoutUndoEntry => ({
    panes: [pane({ id })],
    preset: "custom",
  });

  it("appends entries in order", () => {
    const out = pushLayoutUndo(pushLayoutUndo([], entry("a")), entry("b"));
    expect(out.map((e) => e.panes[0].id)).toEqual(["a", "b"]);
  });

  it("caps the stack at LAYOUT_UNDO_DEPTH", () => {
    expect(LAYOUT_UNDO_DEPTH).toBe(20);
    let stack: LayoutUndoEntry[] = [];
    for (let i = 0; i < 25; i++) stack = pushLayoutUndo(stack, entry(`p${i}`));
    expect(stack).toHaveLength(20);
    // Oldest dropped, newest kept.
    expect(stack[0].panes[0].id).toBe("p5");
    expect(stack[19].panes[0].id).toBe("p24");
  });

  it("copies entry panes so later mutation cannot corrupt history", () => {
    const panes = [pane({ id: "a", x: 1 })];
    const stack = pushLayoutUndo([], { panes, preset: "custom" });
    panes[0].x = 777;
    expect(stack[0].panes[0].x).toBe(1);
  });

  it("does not mutate the input stack", () => {
    const base = pushLayoutUndo([], entry("a"));
    pushLayoutUndo(base, entry("b"));
    expect(base).toHaveLength(1);
  });
});

describe("togglePaneVisibility", () => {
  it("hides a visible pane without touching its geometry", () => {
    const l = [pane({ id: "a", x: 111, y: 222, w: 300, h: 200 })];
    const out = togglePaneVisibility(l, "player");
    expect(out[0]).toMatchObject({ x: 111, y: 222, w: 300, h: 200, visible: false });
  });

  it("restores the exact geometry when toggled back on", () => {
    const l = [pane({ id: "a", x: 111, y: 222, w: 300, h: 200 })];
    const off = togglePaneVisibility(l, "player");
    const on = togglePaneVisibility(off, "player");
    expect(on[0]).toMatchObject({ x: 111, y: 222, w: 300, h: 200, visible: true });
  });

  it("leaves sibling panes untouched", () => {
    const l = [
      pane({ id: "a", type: "player", x: 10, y: 10 }),
      pane({ id: "b", type: "queue", x: 400, y: 50, w: 300, h: 236 }),
    ];
    const out = togglePaneVisibility(l, "player");
    expect(out[1]).toEqual(l[1]);
    expect(out[0]).toMatchObject({ visible: false, x: 10, y: 10 });
  });

  it("appends a missing type with content-floor geometry", () => {
    const out = togglePaneVisibility([pane({ id: "a" })], "browse");
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ type: "browse", visible: true });
    expect(out[1].w).toBeGreaterThanOrEqual(PANE_MIN.browse.w);
    expect(out[1].h).toBeGreaterThanOrEqual(PANE_MIN.browse.h);
  });
});

describe("revealPaneType", () => {
  it("returns the input untouched when the pane is already visible", () => {
    const l = [pane({ id: "a", x: 77, y: 88 })];
    expect(revealPaneType(l, "player")).toBe(l);
  });

  it("reveals a hidden pane while preserving its geometry", () => {
    const l = [pane({ id: "a", x: 77, y: 88, w: 300, h: 200, visible: false })];
    const out = revealPaneType(l, "player");
    expect(out[0]).toMatchObject({ x: 77, y: 88, w: 300, h: 200, visible: true });
  });

  it("never moves siblings when revealing", () => {
    const l = [
      pane({ id: "a", type: "player", x: 10, y: 10 }),
      pane({ id: "b", type: "browse", x: 500, y: 60, w: 380, h: 480, visible: false }),
    ];
    const out = revealPaneType(l, "browse");
    expect(out[0]).toEqual(l[0]);
    expect(out[1]).toMatchObject({ x: 500, y: 60, visible: true });
  });

  it("appends the type when missing entirely", () => {
    const out = revealPaneType([pane({ id: "a" })], "browse");
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ type: "browse", visible: true });
  });
});

describe("newPaneForType", () => {
  it("cascades below existing panes and stacks z on top", () => {
    const l = [pane({ id: "a", z: 4 }), pane({ id: "b", z: 7 })];
    const n = newPaneForType(l, "queue", "queue-1");
    expect(n).toMatchObject({ id: "queue-1", type: "queue", x: 104, y: 104, z: 8, visible: true });
  });
});

describe("clampPaneToArea", () => {
  it("pins a keyboard-nudged pane fully inside the east and south edges", () => {
    // One 8px Alt+Arrow past the edge: the pane keeps its size, position pins.
    const out = clampPaneToArea(pane({ x: 1585, y: 815, w: 340, h: 230 }), 1920, 1040);
    expect(out).toMatchObject({ x: 1580, y: 810, w: 340, h: 230 });
  });

  it("pulls a normal-size pane inside instead of shrinking it", () => {
    const out = clampPaneToArea(pane({ x: 1600, y: 800, w: 400, h: 300 }), 1920, 1040);
    expect(out).toMatchObject({ x: 1520, y: 740, w: 400, h: 300 });
  });

  it("never shrinks below the per-type content floor", () => {
    const out = clampPaneToArea(pane({ x: 0, y: 0, w: 100, h: 50 }), 1920, 1040);
    expect(out).toMatchObject({ w: 280, h: 120 });
  });

  it("keeps a 120-tall player pane instead of forcing it back to 190", () => {
    const out = clampPaneToArea(pane({ x: 24, y: 100, w: 360, h: 120 }), 1280, 800);
    expect(out).toMatchObject({ w: 360, h: 120 });
  });

  it("does not mutate the input pane", () => {
    const p = pane({ x: 2000, y: 1500, w: 2000, h: 1500 });
    clampPaneToArea(p, 800, 600);
    expect(p.x).toBe(2000);
  });
});

describe("dock-column survey (desktop single-row pill)", () => {
  it("centers the capped dock column on the 1920 reference stage", () => {
    // DOCK_MAX_W must track the .dock max-width cap in App.css: the
    // 15-child dock measures ~927 px intrinsic, so the 1000 px cap holds
    // one row with slack while staying narrower than any >=1280 px stage.
    expect(DOCK_MAX_W).toBe(1000);
    expect(DOCK_CLEAR_Y).toBe(96);
    expect(dockColumnFor()).toEqual({ x: 460, w: 1000 });
  });
});

describe("clearDockRow", () => {
  it("pushes a stale center pane below the dock row, keeping its size", () => {
    const out = clearDockRow([pane({ id: "a", x: 600, y: 24, w: 360, h: 230 })]);
    expect(out[0]).toMatchObject({ x: 600, y: 96, w: 360, h: 230 });
  });

  it("leaves panes clear of the dock column byte-identical (deliberate placements)", () => {
    // Far-right lyrics, far-left minimal player, below-band and
    // on-the-line customs: none intersect the 460..1460 column above y96.
    const kept = [
      pane({ id: "lyr", type: "lyrics", x: 1476, y: 24, w: 420, h: 420 }),
      pane({ id: "min", x: 24, y: 24, w: 340, h: 236 }),
      pane({ id: "cus", x: 100, y: 150, w: 340, h: 230 }),
      pane({ id: "edge", type: "profile", x: 24, y: 96, w: 420, h: 560 }),
    ];
    expect(clearDockRow(kept)).toEqual(kept);
  });

  it("spares hidden panes so toggle-restore geometry survives", () => {
    const out = clearDockRow([
      pane({ id: "h", x: 600, y: 24, w: 360, h: 230, visible: false }),
    ]);
    expect(out[0]).toMatchObject({ x: 600, y: 24, w: 360, h: 230 });
  });

  it("does not mutate the input panes", () => {
    const l = [pane({ id: "a", x: 600, y: 24, w: 360, h: 230 })];
    clearDockRow(l);
    expect(l[0].y).toBe(24);
  });
});

describe("deoverlapPanes", () => {
  it("shifts only the later pane down, never resizing or moving x", () => {
    const out = deoverlapPanes([
      pane({ id: "a", x: 600, y: 96, w: 360, h: 230 }),
      pane({ id: "b", x: 700, y: 100, w: 360, h: 230 }),
    ]);
    expect(out[0]).toMatchObject({ x: 600, y: 96, w: 360, h: 230 });
    expect(out[1]).toMatchObject({ x: 700, y: 96 + 230 + 8, w: 360, h: 230 });
  });

  it("leaves non-overlapping and edge-touching panes alone", () => {
    // Focus factory adjacency: lyrics bottom 404, player top 416 — a
    // 12 px gap, not an overlap.
    const kept = [
      pane({ id: "lyr", type: "lyrics", x: 24, y: 24, w: 420, h: 380 }),
      pane({ id: "pl", x: 24, y: 416, w: 420, h: 190 }),
    ];
    expect(deoverlapPanes(kept)).toEqual(kept);
  });

  it("resolves a stack of three to a fixpoint", () => {
    const out = deoverlapPanes([
      pane({ id: "a", x: 600, y: 96, w: 360, h: 230 }),
      pane({ id: "b", x: 600, y: 96, w: 360, h: 230 }),
      pane({ id: "c", x: 600, y: 96, w: 360, h: 230 }),
    ]);
    expect(out.map((p) => p.y)).toEqual([96, 96 + 230 + 8, 96 + 2 * (230 + 8)]);
    for (const p of out) expect(p).toMatchObject({ x: 600, w: 360, h: 230 });
  });

  it("ignores hidden panes on both sides", () => {
    const out = deoverlapPanes([
      pane({ id: "a", x: 600, y: 96, w: 360, h: 230, visible: false }),
      pane({ id: "b", x: 600, y: 96, w: 360, h: 230 }),
    ]);
    expect(out[1]).toMatchObject({ y: 96 });
  });

  it("does not mutate the input panes", () => {
    const l = [
      pane({ id: "a", x: 600, y: 96, w: 360, h: 230 }),
      pane({ id: "b", x: 600, y: 96, w: 360, h: 230 }),
    ];
    deoverlapPanes(l);
    expect(l[1].y).toBe(96);
  });
});

describe("healPanesForDock", () => {
  it("clears the dock band first, then de-overlaps in one pass", () => {
    // Stale pair persisted under the old two-row pill, overlapping each
    // other as well as the dock.
    const out = healPanesForDock([
      pane({ id: "player", x: 600, y: 24, w: 360, h: 230 }),
      pane({ id: "queue", type: "queue", x: 700, y: 30, w: 360, h: 236 }),
    ]);
    expect(out[0]).toMatchObject({ x: 600, y: 96, w: 360, h: 230 });
    // Queue clears the dock (96) then the player (96+230+8 = 334).
    expect(out[1]).toMatchObject({ x: 700, y: 334, w: 360, h: 236 });
  });

  it("is idempotent: healing a healed doc is a no-op", () => {
    const seed = [
      pane({ id: "player", x: 600, y: 24, w: 360, h: 230 }),
      pane({ id: "queue", type: "queue", x: 700, y: 30, w: 360, h: 236 }),
      pane({ id: "lyr", type: "lyrics", x: 1476, y: 24, w: 420, h: 420 }),
    ];
    const once = healPanesForDock(seed);
    expect(healPanesForDock(once)).toEqual(once);
    expect(seed[0].y).toBe(24);
  });
});

describe("stale custom migration heals the dock band", () => {
  it("migrateV3ToV4 heals dock overlap for direct callers", () => {
    const v4 = migrateV3ToV4(
      layout([pane({ id: "a", x: 600, y: 24, w: 360, h: 230 })]),
    );
    for (const s of ["game", "focus", "stream"] as const) {
      expect(v4.scenes[s].panes[0]).toMatchObject({ x: 600, y: 96, w: 360, h: 230 });
    }
  });

  it("loadSceneLayout heals a stale v3 custom doc", () => {
    stubStorage({
      "snapify-layout-v3": JSON.stringify(
        layout([pane({ id: "a", x: 600, y: 24, w: 360, h: 230 })]),
      ),
    });
    const doc = loadSceneLayout();
    expect(doc?.scenes.game.panes[0]).toMatchObject({ x: 600, y: 96, w: 360, h: 230 });
    expect(doc?.scenes.stream.panes[0]).toMatchObject({ x: 600, y: 96 });
  });

  it("loadSceneLayout preserves a deliberate non-overlapping custom", () => {
    stubStorage({
      "snapify-layout-v3": JSON.stringify(
        layout([pane({ id: "a", x: 100, y: 150, w: 340, h: 230 })]),
      ),
    });
    const doc = loadSceneLayout();
    expect(doc?.scenes.game.panes[0]).toMatchObject({ x: 100, y: 150, w: 340, h: 230 });
  });
});

describe("migrateV3ToV4", () => {
  it("seeds every scene with the v3 arrangement and parks on game", () => {
    const v3 = layout([pane({ id: "a", x: 111, y: 222 })]);
    const v4 = migrateV3ToV4(v3);
    expect(v4.version).toBe(4);
    expect(v4.activeScene).toBe("game");
    for (const s of ["game", "focus", "stream"] as const) {
      expect(v4.scenes[s].preset).toBe("custom");
      expect(v4.scenes[s].panes).toHaveLength(1);
      expect(v4.scenes[s].panes[0]).toMatchObject({ id: "a", x: 111, y: 222 });
    }
  });

  it("deep-copies so later v3 mutation cannot corrupt the scenes", () => {
    const v3 = layout([pane({ id: "a", x: 1 })]);
    const v4 = migrateV3ToV4(v3);
    v3.panes[0].x = 777;
    expect(v4.scenes.game.panes[0].x).toBe(1);
  });

  it("carries the collapsed flag across the migration", () => {
    const v3 = layout([pane({ id: "a", collapsed: true })]);
    const v4 = migrateV3ToV4(v3);
    expect(v4.scenes.stream.panes[0].collapsed).toBe(true);
  });
});

describe("defaultScenes", () => {
  it("maps each scene to its factory preset", () => {
    expect(SCENE_PRESETS).toEqual({ game: "minimal", focus: "lyrics", stream: "full" });
    const scenes = defaultScenes();
    expect(scenes.game.preset).toBe("minimal");
    expect(scenes.game.panes.map((p) => p.type)).toEqual(["player"]);
    expect(scenes.focus.preset).toBe("lyrics");
    expect(scenes.focus.panes.map((p) => p.type).sort()).toEqual(["lyrics", "player"]);
    expect(scenes.stream.preset).toBe("full");
    expect(scenes.stream.panes.map((p) => p.type).sort()).toEqual(["player", "queue"]);
  });

  it("starts every pane expanded", () => {
    const scenes = defaultScenes();
    for (const s of ["game", "focus", "stream"] as const) {
      for (const p of scenes[s].panes) expect(p.collapsed).toBe(false);
    }
  });

  it("parks a fresh doc on the game scene", () => {
    const doc = defaultSceneLayout();
    expect(doc).toMatchObject({ version: 4, activeScene: "game" });
  });

  it("opens the first-run stage (lyrics + player) on game, factories elsewhere", () => {
    const doc = defaultSceneLayoutFor(1920, 1080);
    expect(doc.activeScene).toBe("game");
    expect(doc.scenes.game.panes.map((p) => p.type).sort()).toEqual(["lyrics", "player"]);
    expect(doc.scenes.focus.preset).toBe("lyrics");
    expect(doc.scenes.stream.preset).toBe("full");
    expect(doc.scenes.focus.panes.map((p) => p.type).sort()).toEqual(["lyrics", "player"]);
  });
});

describe("setActiveSlot", () => {
  it("replaces only the active scene and copies the panes", () => {
    const doc = defaultSceneLayout();
    const panes = [pane({ id: "solo", x: 5 })];
    const next = setActiveSlot(doc, panes, "custom");
    expect(next.scenes.game).toMatchObject({ preset: "custom" });
    expect(next.scenes.game.panes[0]).toMatchObject({ id: "solo", x: 5 });
    expect(next.scenes.focus.preset).toBe("lyrics");
    panes[0].x = 999;
    expect(next.scenes.game.panes[0].x).toBe(5);
    expect(doc.scenes.game.panes[0].id).toBe("player");
  });
});

describe("togglePaneCollapsed", () => {  it("flips one pane and leaves siblings untouched", () => {
    const l = [pane({ id: "a", x: 10 }), pane({ id: "b", x: 20 })];
    const out = togglePaneCollapsed(l, "a");
    expect(out[0]).toMatchObject({ collapsed: true, x: 10 });
    expect(out[1]).toEqual(l[1]);
    expect(togglePaneCollapsed(out, "a")[0].collapsed).toBe(false);
  });

  it("does not mutate the input panes", () => {
    const l = [pane({ id: "a" })];
    togglePaneCollapsed(l, "a");
    expect(l[0].collapsed).toBeUndefined();
  });
});

/** Node has no localStorage: a Map-backed fake for the storage tests. */
function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return store;
}

describe("loadSceneLayout", () => {
  it("loads a stored v3 doc through the migration", () => {
    const v3 = layout([pane({ id: "a", x: 100, y: 150, w: 340, h: 230 })]);
    stubStorage({ "snapify-layout-v3": JSON.stringify(v3) });
    const doc = loadSceneLayout();
    expect(doc?.version).toBe(4);
    expect(doc?.activeScene).toBe("game");
    expect(doc?.scenes.game.panes[0]).toMatchObject({ id: "a", x: 100, y: 150 });
    expect(doc?.scenes.stream.panes[0]).toMatchObject({ id: "a", x: 100, y: 150 });
  });

  it("round-trips a v4 doc with per-scene geometry", () => {
    stubStorage();
    const doc: SceneLayout = {
      ...defaultSceneLayout(),
      activeScene: "focus",
      scenes: {
        ...defaultSceneLayout().scenes,
        focus: { preset: "custom", panes: [pane({ id: "f", x: 7 })] },
      },
    };
    saveSceneLayout(doc);
    const back = loadSceneLayout();
    expect(back?.activeScene).toBe("focus");
    expect(back?.scenes.focus.panes[0]).toMatchObject({ id: "f", x: 7 });
    expect(back?.scenes.game.preset).toBe("minimal");
  });

  it("returns null when nothing is stored", () => {
    stubStorage();
    expect(loadSceneLayout()).toBeNull();
  });
});

describe("stream settings", () => {
  it("fixes the pause delay at 2.5 s and defaults to off/off", () => {
    expect(STREAM_HIDE_DELAY_MS).toBe(2500);
    expect(DEFAULT_STREAM).toEqual({ hideOnPause: false, dimInstead: false });
    stubStorage();
    expect(loadStreamSettings()).toEqual({ hideOnPause: false, dimInstead: false });
  });

  it("round-trips the toggles under the snapify-stream key", () => {
    const store = stubStorage();
    saveStreamSettings({ hideOnPause: true, dimInstead: true });
    expect(store.has("snapify-stream")).toBe(true);
    expect(store.has("snapify-layout-v3")).toBe(false);
    expect(loadStreamSettings()).toEqual({ hideOnPause: true, dimInstead: true });
  });
});

describe("notch hover setting", () => {
  it("defaults to autohide-on when nothing is stored", () => {
    stubStorage();
    expect(loadNotchHover()).toBe(true);
  });

  it("round-trips the toggle under the snapify-notch-hover key", () => {
    expect(NOTCH_HOVER_KEY).toBe("snapify-notch-hover");
    const store = stubStorage();
    saveNotchHover(false);
    expect(store.get("snapify-notch-hover")).toBe("0");
    expect(store.has("snapify-layout-v3")).toBe(false);
    expect(loadNotchHover()).toBe(false);
    saveNotchHover(true);
    expect(store.get("snapify-notch-hover")).toBe("1");
    expect(loadNotchHover()).toBe(true);
  });

  it("treats a missing key as on and only an explicit 0 as off", () => {
    stubStorage({ "snapify-notch-hover": "1" });
    expect(loadNotchHover()).toBe(true);
    stubStorage({ "snapify-notch-hover": "0" });
    expect(loadNotchHover()).toBe(false);
  });
});

describe("profile pane minimum (Batch 2c contract)", () => {
  it("pins the profile content floor", () => {
    // The tall profile pane (header + tiles + genres + grids + clocks +
    // recents) needs room for its own chrome: 320x420, compacting to
    // 220x140 on small stages.
    expect(PANE_MIN.profile).toEqual({ w: 320, h: 420 });
    expect(getPaneMin("profile")).toEqual({ w: 320, h: 420 });
    expect(getCompactPaneMin("profile")).toEqual({ w: 220, h: 140 });
  });

  it("clamps an undersized profile pane to its content floor instead of collapsing", () => {
    const out = clampPaneToArea(
      pane({ type: "profile", x: 0, y: 0, w: 10, h: 10 }),
      1920,
      1040,
    );
    expect(out).toMatchObject({ w: 320, h: 420 });
  });

  it("keeps a tall profile pane inside the area without shrinking it", () => {
    const out = clampPaneToArea(
      pane({ type: "profile", x: 24, y: 24, w: 420, h: 900 }),
      1280,
      1024,
    );
    expect(out).toMatchObject({ x: 24, y: 24, w: 420, h: 900 });
  });
});

describe("resolution matrix (2.10.0 placement follow-up)", () => {
  it("centers the live dock column per stage width", () => {
    // 1920 ref stays byte-identical; other widths shift with 94vw/1000 cap.
    expect(dockColumnForWidth(1920)).toEqual({ x: 460, w: 1000 });
    expect(dockColumnForWidth(1366)).toEqual({ x: (1366 - 1000) / 2, w: 1000 });
    expect(dockColumnForWidth(2560)).toEqual({ x: (2560 - 1000) / 2, w: 1000 });
    expect(dockColumnForWidth(3440)).toEqual({ x: (3440 - 1000) / 2, w: 1000 });
    expect(dockColumnForWidth(3840)).toEqual({ x: (3840 - 1000) / 2, w: 1000 });
    expect(dockColumnForWidth(1080)).toEqual({ x: (1080 - 1000) / 2, w: 1000 });
  });

  it("leaves a 1920-legal probe alone at 1920 but clears it at live widths", () => {
    // 1500,24 sits just right of the 1920 dock (460..1460): legal there,
    // under the live dock everywhere else.
    const probe = [pane({ id: "l", type: "lyrics", x: 1500, y: 24, w: 360, h: 230 })];
    expect(clearDockRowForWidth(probe, 1920)).toEqual(probe);
    expect(clearDockRowForWidth(probe, 2560)[0]).toMatchObject({ x: 1500, y: 96 });
    expect(clearDockRowForWidth(probe, 3440)[0]).toMatchObject({ x: 1500, y: 96 });
    expect(clearDockRowForWidth(probe, 3840)[0]).toMatchObject({ x: 1500, y: 96 });
  });

  it("clears a clamped probe that slides inside the live column at 1366", () => {
    // Clamp-then-heal order: 1500,24 clamps to 1006,24 at 1366, which is
    // inside the live 183..1183 column even though the unclamped x was not.
    const clamped = clampLayoutToArea(
      layout([pane({ id: "l", type: "lyrics", x: 1500, y: 24, w: 360, h: 230 })]),
      1366,
      768,
    );
    expect(clamped.panes[0]).toMatchObject({ x: 1006, y: 24 });
    const healed = healPanesForDockForWidth(clamped.panes, 1366);
    expect(healed[0]).toMatchObject({ x: 1006, y: 96 });
  });

  it("divides the live dock column by uiScale before comparing", () => {
    // At k=1.25 the CSS dock 460..1460 is 368..1168 logical: a logical
    // 1500,24 probe stays clear, a logical 600,24 probe still clears.
    const wide = [pane({ x: 1500, y: 24, w: 360, h: 230 })];
    expect(clearDockRowForWidth(wide, 1920, 1.25)).toEqual(wide);
    const stale = [pane({ x: 600, y: 24, w: 360, h: 230 })];
    expect(clearDockRowForWidth(stale, 1920, 1.25)[0]).toMatchObject({ y: 96 });
  });

  it("skips top clearance on narrow effective stages (bottom dock)", () => {
    const top = [pane({ x: 100, y: 24, w: 300, h: 200 })];
    // 400 CSS px at k=1 is narrow (<480): dock lives at the bottom.
    expect(clearDockRowForWidth(top, 400)).toEqual(top);
    expect(healPanesForDockForWidth(top, 400)).toEqual(top);
  });

  it("keeps the far-corner probe inside every matrix stage via clamp", () => {
    const seed = layout([pane({ id: "p", x: 1500, y: 800, w: 340, h: 236 })]);
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [3440, 1440],
      [1080, 1920],
    ] as const) {
      const out = clampLayoutToArea(seed, w, h);
      const p = out.panes[0];
      expect(p.x + p.w, `${w}x${h} east`).toBeLessThanOrEqual(w);
      expect(p.y + p.h, `${w}x${h} south`).toBeLessThanOrEqual(h);
      expect(p.x, `${w}x${h} west`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${w}x${h} north`).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the 420-wide profile inside every matrix stage at 125% uiScale", () => {
    const seed = layout([
      { ...pane({ x: 1440, y: 24, w: 420, h: 560 }), id: "profile", type: "profile" },
    ]);
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [3440, 1440],
      [1080, 1920],
    ] as const) {
      const out = clampLayoutToArea(seed, w, h, 1.25);
      for (const p of out.panes) {
        expect(p.x + p.w, `${w}x${h} logical east`).toBeLessThanOrEqual(w / 1.25 + 1e-9);
        expect((p.x + p.w) * 1.25, `${w}x${h} painted east`).toBeLessThanOrEqual(w + 1e-9);
      }
    }
  });

  it("places the full preset inside ultrawide and portrait stages", () => {
    for (const [w, h] of [
      [2560, 1440],
      [3840, 2160],
      [3440, 1440],
      [1080, 1920],
    ] as const) {
      const l = defaultLayoutFor(w, h);
      for (const p of l.panes) {
        expect(p.x + p.w, `${w}x${h} ${p.id} east`).toBeLessThanOrEqual(w);
        expect(p.y + p.h, `${w}x${h} ${p.id} south`).toBeLessThanOrEqual(h);
      }
    }
  });
});
