import { describe, expect, it } from "vitest";
import {
  clampLayoutToArea,
  defaultLayoutFor,
  getPaneMin,
  PANE_MIN,
  snapMove,
  snapSize,
} from "./layout";
import type { LayoutState, PaneState, PaneType } from "./types";

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
