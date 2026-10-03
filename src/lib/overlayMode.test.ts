import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_MODE,
  OVERLAY_MODE_KEY,
  OVERLAY_MODE_VERSION,
  loadOverlayMode,
  parseOverlayMode,
  saveOverlayMode,
} from "./overlayMode";
import type { Mp3Settings } from "./overlayMode";

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

function settings(over: Partial<Mp3Settings> = {}): Mp3Settings {
  return {
    version: 1,
    mode: "classic",
    variant: "purple",
    lcd: "track",
    motion: true,
    ...over,
  };
}

describe("overlay mode key and defaults", () => {
  it("uses the snapify-overlay-mode key at version 1", () => {
    expect(OVERLAY_MODE_KEY).toBe("snapify-overlay-mode");
    expect(OVERLAY_MODE_VERSION).toBe(1);
  });

  it("defaults to classic purple track with motion on", () => {
    expect(DEFAULT_OVERLAY_MODE).toEqual({
      version: 1,
      mode: "classic",
      variant: "purple",
      lcd: "track",
      motion: true,
    });
  });

  it("returns copies so callers cannot corrupt the default", () => {
    const a = parseOverlayMode(undefined);
    a.mode = "mp3";
    a.motion = false;
    expect(DEFAULT_OVERLAY_MODE).toMatchObject({ mode: "classic", motion: true });
    stubStorage();
    const b = loadOverlayMode();
    b.variant = "black";
    expect(DEFAULT_OVERLAY_MODE).toMatchObject({ variant: "purple" });
  });
});

describe("parseOverlayMode", () => {
  it("coerces absent and non-object input to defaults without throwing", () => {
    for (const v of [undefined, null, 0, 42, "", "mp3", true, [1, 2], []]) {
      expect(() => parseOverlayMode(v)).not.toThrow();
      expect(parseOverlayMode(v)).toEqual(DEFAULT_OVERLAY_MODE);
    }
  });

  it("coerces unknown enum values field-by-field and keeps valid fields", () => {
    expect(
      parseOverlayMode({
        version: 1,
        mode: "turbo",
        variant: "pink",
        lcd: "nope",
        motion: "yes",
      }),
    ).toEqual(settings({ mode: "classic", variant: "pink", lcd: "track", motion: true }));
  });

  it("accepts every legal enum value", () => {
    expect(parseOverlayMode(settings({ mode: "mp3" }))).toMatchObject({ mode: "mp3" });
    for (const variant of ["purple", "silver", "pink", "black"] as const) {
      expect(parseOverlayMode(settings({ variant }))).toMatchObject({ variant });
    }
    for (const lcd of ["track", "time", "eq"] as const) {
      expect(parseOverlayMode(settings({ lcd }))).toMatchObject({ lcd });
    }
  });

  it("keeps explicit motion false and coerces non-boolean motion to true", () => {
    expect(parseOverlayMode(settings({ motion: false }))).toMatchObject({ motion: false });
    for (const motion of [undefined, null, 0, 1, "", "false", {}, []] as const) {
      expect(parseOverlayMode({ ...settings(), motion })).toMatchObject({ motion: true });
    }
  });

  it("normalizes the version to 1", () => {
    expect(parseOverlayMode({ ...settings(), version: 2 })).toMatchObject({ version: 1 });
    expect(parseOverlayMode({ ...settings(), version: "1" })).toMatchObject({ version: 1 });
  });
});

describe("loadOverlayMode", () => {
  it("loads classic defaults when nothing is stored", () => {
    stubStorage();
    expect(loadOverlayMode()).toEqual(DEFAULT_OVERLAY_MODE);
  });

  it("coerces corrupt JSON to defaults without throwing", () => {
    stubStorage({ [OVERLAY_MODE_KEY]: "{not json" });
    expect(() => loadOverlayMode()).not.toThrow();
    expect(loadOverlayMode()).toEqual(DEFAULT_OVERLAY_MODE);
  });

  it("coerces non-object JSON to defaults", () => {
    for (const raw of ["42", '"mp3"', "[1,2]", "null", "true"]) {
      stubStorage({ [OVERLAY_MODE_KEY]: raw });
      expect(loadOverlayMode()).toEqual(DEFAULT_OVERLAY_MODE);
    }
  });

  it("coerces unknown fields and keeps the valid ones", () => {
    stubStorage({
      [OVERLAY_MODE_KEY]: JSON.stringify({
        version: 1,
        mode: "mp3",
        variant: "neon",
        lcd: "eq",
        motion: false,
      }),
    });
    expect(loadOverlayMode()).toEqual(
      settings({ mode: "mp3", variant: "purple", lcd: "eq", motion: false }),
    );
  });

  it("returns defaults when storage is unavailable", () => {
    (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
    expect(() => loadOverlayMode()).not.toThrow();
    expect(loadOverlayMode()).toEqual(DEFAULT_OVERLAY_MODE);
  });
});

describe("saveOverlayMode round-trip", () => {
  it("round-trips all four fields", () => {
    stubStorage();
    const doc = settings({ mode: "mp3", variant: "black", lcd: "eq", motion: false });
    saveOverlayMode(doc);
    expect(loadOverlayMode()).toEqual(doc);
  });

  it("keeps motion false across the round-trip", () => {
    stubStorage();
    saveOverlayMode(settings({ motion: false }));
    expect(loadOverlayMode()).toMatchObject({ motion: false });
  });

  it("loads a future version doc and preserves its extra field on save", () => {
    const store = stubStorage({
      [OVERLAY_MODE_KEY]: JSON.stringify({
        version: 2,
        mode: "mp3",
        variant: "pink",
        lcd: "eq",
        motion: false,
        future: "kept",
      }),
    });
    expect(loadOverlayMode()).toMatchObject({
      mode: "mp3",
      variant: "pink",
      lcd: "eq",
      motion: false,
    });
    saveOverlayMode(loadOverlayMode());
    const raw = store.get(OVERLAY_MODE_KEY) as string;
    const back = JSON.parse(raw) as Record<string, unknown>;
    expect(back["future"]).toBe("kept");
    expect(loadOverlayMode()).toMatchObject({ mode: "mp3", variant: "pink" });
  });

  it("does not throw when storage is unavailable", () => {
    (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
    expect(() => saveOverlayMode(settings({ mode: "mp3" }))).not.toThrow();
  });
});

describe("overlay mode shell purity", () => {
  it("never reads or writes the layout or stream keys", () => {
    const layoutRaw = JSON.stringify({ version: 3, preset: "full", panes: [] });
    const streamRaw = JSON.stringify({ hideOnPause: true, dimInstead: false });
    const store = stubStorage({
      "snapify-layout-v3": layoutRaw,
      "snapify-stream": streamRaw,
    });
    loadOverlayMode();
    saveOverlayMode(settings({ mode: "mp3", variant: "silver", lcd: "time", motion: false }));
    expect(store.get("snapify-layout-v3")).toBe(layoutRaw);
    expect(store.get("snapify-stream")).toBe(streamRaw);
    expect(store.has(OVERLAY_MODE_KEY)).toBe(true);
  });

  it("load leaves every stored entry untouched", () => {
    const seed = {
      "snapify-layout-v3": "L",
      "snapify-stream": "S",
      [OVERLAY_MODE_KEY]: JSON.stringify(settings({ mode: "mp3" })),
    };
    const store = stubStorage(seed);
    loadOverlayMode();
    expect(Object.fromEntries(store)).toEqual(seed);
  });
});
