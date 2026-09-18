import { describe, expect, it } from "vitest";
import {
  clampLayoutToArea,
  clampPaneToArea,
  clonePanes,
  defaultLayoutFor,
  getPaneMin,
  LAYOUT_UNDO_DEPTH,
  newPaneForType,
  PANE_MIN,
  pushLayoutUndo,
  revealPaneType,
  snapMove,
  snapSize,
  togglePaneVisibility,
} from "./layout";
import type { LayoutState, LayoutUndoEntry, PaneState, PaneType } from "./types";

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
    expect(getPaneMin("player")).toEqual({ w: 280, h: 190 });
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

  it("floors tiny areas to an 800x600 canvas", () => {
    const l = defaultLayoutFor(100, 100);
    expect(l.panes[0]).toMatchObject({ x: 356, y: 24, w: 420, h: 420 });
    expect(l.panes[1]).toMatchObject({ x: 416, y: 346, w: 360, h: 230 });
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

  it("anchors at zero when the area is narrower than the minimum", () => {
    const l = layout([pane({ x: 50, y: 50, w: 340, h: 230 })]);
    const out = clampLayoutToArea(l, 200, 600);
    expect(out.panes[0]).toMatchObject({ x: 0, w: 280 });
  });

  it("divides the area by uiScale before clamping", () => {
    const l = layout([
      pane({ id: "a", x: 2000, y: 1500, w: 2000, h: 1500 }),
    ]);
    const out = clampLayoutToArea(l, 1600, 1200, 2);
    expect(out.panes[0]).toMatchObject({ x: 16, y: 16, w: 784, h: 584 });
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
    expect(out).toMatchObject({ w: 280, h: 190 });
  });

  it("does not mutate the input pane", () => {
    const p = pane({ x: 2000, y: 1500, w: 2000, h: 1500 });
    clampPaneToArea(p, 800, 600);
    expect(p.x).toBe(2000);
  });
});
