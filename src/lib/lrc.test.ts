import { describe, expect, it } from "vitest";
import { activeCueIndex, activeWordIndex, formatMs, parseLrc } from "./lrc";
import type { LyricCue } from "./types";

const cues: LyricCue[] = [
  { t: 0, text: "line one" },
  { t: 1000, text: "line two" },
  { t: 2000, text: "line three" },
];

describe("activeCueIndex", () => {
  it("returns -1 for an empty cue list", () => {
    expect(activeCueIndex([], 1500)).toBe(-1);
  });

  it("returns -1 when now is before the first cue", () => {
    expect(activeCueIndex(cues, -1)).toBe(-1);
    expect(activeCueIndex([{ t: 500, text: "late" }], 0)).toBe(-1);
  });

  it("returns the exact cue on an exact timestamp hit", () => {
    expect(activeCueIndex(cues, 0)).toBe(0);
    expect(activeCueIndex(cues, 1000)).toBe(1);
    expect(activeCueIndex(cues, 2000)).toBe(2);
  });

  it("returns the last elapsed cue when between cues", () => {
    expect(activeCueIndex(cues, 1500)).toBe(1);
    expect(activeCueIndex(cues, 999)).toBe(0);
    expect(activeCueIndex(cues, 1999)).toBe(1);
  });

  it("sticks to the last cue after the final timestamp", () => {
    expect(activeCueIndex(cues, 9999)).toBe(2);
  });

  it("handles a single cue", () => {
    const one: LyricCue[] = [{ t: 500, text: "solo" }];
    expect(activeCueIndex(one, 499)).toBe(-1);
    expect(activeCueIndex(one, 500)).toBe(0);
    expect(activeCueIndex(one, 501)).toBe(0);
  });
});

describe("formatMs", () => {
  it("formats 90000 as 1:30", () => {
    expect(formatMs(90000)).toBe("1:30");
  });

  it("formats 0 as 0:00", () => {
    expect(formatMs(0)).toBe("0:00");
  });

  it("clamps negative input to 0:00", () => {
    expect(formatMs(-1)).toBe("0:00");
    expect(formatMs(-90000)).toBe("0:00");
  });

  it("clamps NaN to 0:00", () => {
    expect(formatMs(NaN)).toBe("0:00");
  });

  it("clamps Infinity to 0:00", () => {
    expect(formatMs(Infinity)).toBe("0:00");
    expect(formatMs(-Infinity)).toBe("0:00");
  });

  it("pads single-digit seconds", () => {
    expect(formatMs(5000)).toBe("0:05");
    expect(formatMs(61000)).toBe("1:01");
  });

  it("floors sub-second remainders", () => {
    expect(formatMs(59999)).toBe("0:59");
  });

  it("rolls hours into minutes", () => {
    expect(formatMs(3600000)).toBe("60:00");
  });
});

describe("parseLrc", () => {
  it("parses basic lines in time order", () => {
    const cues = parseLrc("[00:12.00]first\n[00:05.50]second\n");
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ t: 5500, text: "second" });
    expect(cues[1]).toMatchObject({ t: 12000, text: "first" });
    expect(cues[0].words).toBeUndefined();
  });

  it("expands multi-tag lines and applies the global offset", () => {
    const cues = parseLrc("[offset:+500]\n[00:10.00][00:20.000]chorus\n");
    expect(cues).toHaveLength(2);
    expect(cues[0].t).toBe(10500);
    expect(cues[1].t).toBe(20500);
    expect(cues[1].text).toBe("chorus");
  });

  it("drops ID tags and malformed lines", () => {
    const cues = parseLrc("[ti:Title]\n[ar:Artist]\nno tags here\n[99]bad\n[00:01.00]ok\n");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("ok");
  });

  it("extracts inline word tags and strips them from the line text", () => {
    const cues = parseLrc("[00:10.00]<00:10.00>hello <00:10.40>world\n");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("hello world");
    expect(cues[0].words).toEqual([
      { t: 10000, text: "hello" },
      { t: 10400, text: "world" },
    ]);
  });

  it("shifts word times by the global offset", () => {
    const cues = parseLrc("[offset:-200]\n[00:10.00]<00:10.00>hi <00:10.50>there\n");
    expect(cues[0].t).toBe(9800);
    expect(cues[0].words).toEqual([
      { t: 9800, text: "hi" },
      { t: 10300, text: "there" },
    ]);
  });

  it("leaves words undefined for plain lines (interpolation fallback)", () => {
    const cues = parseLrc("[00:01.00]plain line\n");
    expect(cues).toHaveLength(1);
    expect(cues[0].words).toBeUndefined();
  });
});

describe("activeWordIndex", () => {
  it("tracks word boundaries like cue boundaries", () => {
    const words = [
      { t: 10000, text: "hello" },
      { t: 10400, text: "world" },
    ];
    expect(activeWordIndex(words, 9999)).toBe(-1);
    expect(activeWordIndex(words, 10000)).toBe(0);
    expect(activeWordIndex(words, 10399)).toBe(0);
    expect(activeWordIndex(words, 10400)).toBe(1);
    expect(activeWordIndex([], 1500)).toBe(-1);
  });
});
