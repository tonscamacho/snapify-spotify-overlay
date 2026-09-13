import { describe, expect, it } from "vitest";
import { activeCueIndex, formatMs } from "./lrc";
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
