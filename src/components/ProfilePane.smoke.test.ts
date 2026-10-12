import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import ProfilePane from "./ProfilePane";

function renderRange(range: "fourWeeks" | "today"): string {
  return renderToString(
    createElement(ProfilePane, {
      range,
      onRange: () => {},
      queuedCount: 0,
      degraded: false,
      onPlayContext: () => {},
      onPlayUris: () => {},
      onQueueAdd: () => {},
      onError: () => {},
      onRetryPlayer: () => {},
    }),
  );
}

describe("ProfilePane smoke", () => {
  it("renders header, timeframe select, stats, clocks, and list sections", () => {
    const html = renderRange("fourWeeks");
    for (const needle of [
      "Timeframe",
      "fourWeeks",
      "Stats",
      "Listening clocks",
      "Top songs",
      "Top artists",
      "Top albums",
      "Recent streams",
    ]) {
      expect(html).toContain(needle);
    }
  });

  it("shows the verbatim honesty note for sliced ranges", () => {
    expect(renderRange("today")).toContain(
      "Sliced from long-term tops plus recent streams. Not a Spotify range.",
    );
  });
});
