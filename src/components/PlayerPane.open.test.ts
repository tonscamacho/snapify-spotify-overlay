import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { PlayerSnapshot } from "../lib/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import PlayerPane from "./PlayerPane";

const EMPTY: PlayerSnapshot = {
  empty: true,
  isPlaying: false,
  progressMs: 0,
  fetchedAt: 0,
  track: null,
  deviceId: null,
  deviceName: null,
  volume: null,
  shuffle: false,
  repeat: "off",
};

function renderEmpty(): string {
  return renderToString(
    createElement(PlayerPane, {
      snapshot: EMPTY,
      progressMs: 0,
      onPlay: () => {},
      onPause: () => {},
      onNext: () => {},
      onPrev: () => {},
      onSeek: () => {},
      onVolume: () => {},
      onShuffle: () => {},
      onRepeat: () => {},
    }),
  );
}

describe("PlayerPane empty-state Spotify wording", () => {
  it("names the empty state and points at Spotify", () => {
    const html = renderEmpty();
    expect(html).toContain("Nothing playing");
    expect(html).toContain("Start playback in Spotify and it shows here.");
  });

  it("labels the outbound button OPEN SPOTIFY", () => {
    const html = renderEmpty();
    expect(html).toContain("OPEN SPOTIFY");
    expect(html).toContain("btn sm primary");
  });
});
