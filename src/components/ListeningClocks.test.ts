import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import ListeningClocks, { formatClockTip } from "./ListeningClocks";
import type { ClockBucket } from "../lib/types";

function buckets(plays: number[], minutes?: number[]): ClockBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    plays: plays[hour] ?? 0,
    minutes: minutes?.[hour] ?? 0,
  }));
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("formatClockTip", () => {
  it("formats the stats.fm tooltip copy with thousands separators", () => {
    expect(formatClockTip(19, 12609, "streams")).toBe("19:00 - 20:00: 12,609 streams");
    expect(formatClockTip(0, 0, "streams")).toBe("00:00 - 01:00: 0 streams");
    expect(formatClockTip(9, 45, "minutes")).toBe("09:00 - 10:00: 45 minutes");
  });

  it("wraps midnight and singularizes one stream and one minute", () => {
    expect(formatClockTip(23, 7, "streams")).toBe("23:00 - 00:00: 7 streams");
    expect(formatClockTip(23, 1, "streams")).toBe("23:00 - 00:00: 1 stream");
    expect(formatClockTip(5, 1, "minutes")).toBe("05:00 - 06:00: 1 minute");
  });
});

describe("ListeningClocks", () => {
  it("renders two 24-wedge coxcombs with captions", () => {
    const plays = Array.from({ length: 24 }, (_, h) => (h === 19 ? 12609 : h));
    const html = renderToString(
      createElement(ListeningClocks, { buckets: buckets(plays, plays) }),
    );
    expect(countOccurrences(html, "data-hour=")).toBe(48);
    expect(countOccurrences(html, 'data-clock="streams"')).toBe(1);
    expect(countOccurrences(html, 'data-clock="minutes"')).toBe(1);
    expect(html).toContain(">streams</div>");
    expect(html).toContain("minutes streamed");
  });

  it("labels every wedge for hover and focus readers", () => {
    const html = renderToString(
      createElement(ListeningClocks, { buckets: buckets([7]) }),
    );
    expect(html).toContain('aria-label="00:00 - 01:00: 7 streams"');
    expect(html).toContain('aria-label="streams listening clock: 7 streams"');
    expect(html).toContain('aria-label="minutes streamed listening clock: 0 minutes"');
    expect(countOccurrences(html, "<title>")).toBe(48);
  });

  it("renders all 24 wedges per chart when nothing played", () => {
    const html = renderToString(
      createElement(ListeningClocks, { buckets: buckets([]) }),
    );
    expect(countOccurrences(html, "data-hour=")).toBe(48);
    expect(html).toContain('aria-label="streams listening clock: 0 streams"');
  });

  it("fills sparse buckets to a full 24 hours", () => {
    const html = renderToString(
      createElement(ListeningClocks, {
        buckets: [{ hour: 19, plays: 3, minutes: 5 }],
      }),
    );
    expect(countOccurrences(html, "data-hour=")).toBe(48);
    expect(html).toContain('aria-label="19:00 - 20:00: 3 streams"');
  });
});
