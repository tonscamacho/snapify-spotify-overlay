import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { initialBrowse } from "../lib/browse";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

type Fetcher = (
  ...args: never[]
) => Promise<{ items: Array<{ id: string; name: string }>; next: number | string | null }>;

const { captured, apiStubs } = vi.hoisted(() => ({
  captured: [] as Array<{ fetcher: Fetcher; opts: { pageSize?: number; resetKey: string } }>,
  apiStubs: {
    myPlaylists: vi.fn(),
    savedAlbums: vi.fn(),
    savedTracks: vi.fn(),
    savedShows: vi.fn(),
    savedEpisodes: vi.fn(),
    savedAudiobooks: vi.fn(),
    followedArtists: vi.fn(),
    libraryContains: vi.fn(),
    searchRaw: vi.fn(),
  },
}));

vi.mock("../lib/usePagedList", () => ({
  usePagedList: (fetcher: Fetcher, opts: { pageSize?: number; resetKey: string }) => {
    captured.push({ fetcher, opts });
    return { items: [], loading: false, hasMore: false, throttled: null, retry: () => {}, sentinelRef: () => {} };
  },
}));

vi.mock("../lib/spotify", () => ({ api: apiStubs }));

import BrowsePane from "./BrowsePane";

function renderLibrary(): void {
  renderToString(
    createElement(BrowsePane, {
      state: { ...initialBrowse, view: "library" },
      deviceId: null,
      onChange: () => {},
      onPlayContext: () => {},
      onPlayUris: () => {},
      onQueueAdd: () => {},
      onError: () => {},
    }),
  );
}

function playlistRaw(total: number, n: number): unknown {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: `pl${i}`,
      name: `Playlist ${i}`,
      uri: `spotify:playlist:pl${i}`,
      owner: { display_name: "me" },
      images: [],
    })),
    total,
  };
}

describe("BrowsePane library page-20 cap", () => {
  it("wires the library shelf with pageSize 20", () => {
    renderLibrary();
    const lib = captured.filter((c) => c.opts.resetKey.includes(":lib:"));
    expect(lib.length).toBeGreaterThan(0);
    for (const c of lib) {
      expect(c.opts.pageSize).toBe(20);
    }
  });

  it("caps shelf requests and rows at 20 even when asked for more", async () => {
    renderLibrary();
    const lib = captured.find((c) => c.opts.resetKey.includes(":lib:"));
    expect(lib).toBeDefined();
    if (!lib) return;
    apiStubs.myPlaylists.mockResolvedValue(playlistRaw(87, 50));
    const page = await (lib.fetcher as (limit: number, cursor: number | null) => Promise<{ items: unknown[]; next: unknown }>)(50, 0);
    expect(apiStubs.myPlaylists).toHaveBeenCalledWith(20, 0);
    expect(page.items).toHaveLength(20);
    expect(page.next).toBe(50);
  });
});
