import { describe, expect, it } from "vitest";
import {
  HISTORY_IMPORT_MAX_BYTES,
  HISTORY_MIN_MS,
  HISTORY_PAGE_SIZE,
  HISTORY_STORE_CAP,
  HISTORY_STORE_VERSION,
  buildHistoryIndex,
  isTrackUri,
  mergeHistory,
  pageHistoryPlays,
  parseExtendedHistory,
  sliceStoreRange,
  syncAppend,
  syncAppendWithIndex,
  trimStoreToCap,
} from "./history";
import type { HistoryPlay } from "./history";

const T1 = 1719792000000; // 2024-07-01T00:00:00.000Z
const T2 = 1719795600000; // 2024-07-01T01:00:00.000Z
const T3 = 1719799200000; // 2024-07-01T02:00:00.000Z
const NOW = 1719802800000; // 2024-07-01T03:00:00.000Z

function endsong(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2024-07-01T00:00:00.000Z",
    ms_played: 200000,
    master_metadata_track_name: "Song One",
    master_metadata_album_artist_name: "Band A",
    master_metadata_album_album_name: "Album A",
    spotify_track_uri: "spotify:track:aaa",
    reason_start: "trackdone",
    reason_end: "trackdone",
    skipped: false,
    ...over,
  };
}

describe("history constants", () => {
  it("pins the 30s floor and the v1 store version", () => {
    expect(HISTORY_MIN_MS).toBe(30000);
    expect(HISTORY_STORE_VERSION).toBe(1);
  });

  it("pins the 25MB single-file import cap", () => {
    expect(HISTORY_IMPORT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("keeps the legacy 50k cap export but never trims (paging bounds the UI)", () => {
    expect(HISTORY_STORE_CAP).toBe(50_000);
    expect(HISTORY_PAGE_SIZE).toBe(100);
  });

  it("gates countable URIs to spotify:track: (podcasts drop as no-uri)", () => {
    expect(isTrackUri("spotify:track:abc")).toBe(true);
    expect(isTrackUri("spotify:episode:abc")).toBe(false);
    expect(isTrackUri("spotify:show:abc")).toBe(false);
    expect(isTrackUri("")).toBe(false);
  });
});

describe("parseExtendedHistory", () => {
  it("parses a full endsong row with literal fields", () => {
    const { plays, counts } = parseExtendedHistory([endsong()], NOW);
    expect(counts).toEqual({
      total: 1,
      kept: 1,
      droppedShort: 0,
      droppedSkipped: 0,
      droppedNoUri: 0,
      droppedDuplicate: 0,
      droppedInvalid: 0,
    });
    expect(plays).toEqual([
      {
        trackId: "aaa",
        trackName: "Song One",
        artists: "Band A",
        playedAt: T1,
        image: null,
        uri: "spotify:track:aaa",
        durationMs: 200000,
        msPlayed: 200000,
        skipped: false,
        albumName: "Album A",
        source: "imported",
      },
    ]);
  });

  it("parses a Streaming_History_Audio minimal row", () => {
    const { plays, counts } = parseExtendedHistory(
      [
        {
          ts: "2024-07-01T01:00:00.000Z",
          ms_played: 180000,
          master_metadata_track_name: "Song Two",
          master_metadata_album_artist_name: "Band B",
          spotify_track_uri: "spotify:track:bbb",
        },
      ],
      NOW,
    );
    expect(counts.kept).toBe(1);
    expect(counts.total).toBe(1);
    expect(plays[0]).toMatchObject({
      trackId: "bbb",
      trackName: "Song Two",
      artists: "Band B",
      playedAt: T2,
      uri: "spotify:track:bbb",
      durationMs: 180000,
      source: "imported",
    });
  });

  it("keeps skipped-long/fwdbtn-long and drops only short/podcast/no-uri", () => {
    const { plays, counts } = parseExtendedHistory(
      [
        endsong({ spotify_track_uri: "spotify:track:keep", ms_played: 200000, ts: "2024-07-01T01:00:00.000Z" }),
        endsong({ spotify_track_uri: "spotify:track:short", ms_played: 29999 }),
        endsong({ spotify_track_uri: "spotify:track:skipped-long", skipped: true, ms_played: 200000 }),
        endsong({ spotify_track_uri: "spotify:track:fwd-long", reason_end: "fwdbtn", skipped: false, ms_played: 200000, ts: "2024-07-01T01:00:01.000Z" }),
        endsong({ spotify_track_uri: "spotify:track:skipped-short", skipped: true, ms_played: 10000 }),
        endsong({ spotify_track_uri: "" }),
        endsong({ spotify_track_uri: "spotify:episode:pod1", ms_played: 200000 }),
        endsong({ spotify_track_uri: "spotify:track:exact", ms_played: 30000 }),
      ],
      NOW,
    );
    expect(counts).toEqual({
      total: 8,
      kept: 4,
      droppedShort: 2,
      droppedSkipped: 0,
      droppedNoUri: 2,
      droppedDuplicate: 0,
      droppedInvalid: 0,
    });
    expect(plays.map((p) => p.uri).sort()).toEqual(
      ["spotify:track:exact", "spotify:track:fwd-long", "spotify:track:keep", "spotify:track:skipped-long"].sort(),
    );
    expect(plays.find((p) => p.uri === "spotify:track:skipped-long")?.skipped).toBe(true);
  });

  it("counts skipped-long rows (stats.fm parity) and drops skipped-short as short", () => {
    const long = parseExtendedHistory([endsong({ spotify_track_uri: "spotify:track:sl", skipped: true, ms_played: 200000 })], NOW);
    expect(long.counts.kept).toBe(1);
    expect(long.counts.droppedSkipped).toBe(0);
    expect(long.plays[0].skipped).toBe(true);
    const short = parseExtendedHistory([endsong({ spotify_track_uri: "spotify:track:ss", skipped: true, ms_played: 5000 })], NOW);
    expect(short.counts.kept).toBe(0);
    expect(short.counts.droppedShort).toBe(1);
  });

  it("drops podcast/episode URIs as no-uri", () => {
    const { counts, plays } = parseExtendedHistory([endsong({ spotify_track_uri: "spotify:episode:xyz", ms_played: 200000 })], NOW);
    expect(counts.droppedNoUri).toBe(1);
    expect(plays).toEqual([]);
  });

  it("keeps the import message math honest on stats.fm-scale proportions", () => {
    // Synthetic 341182-row shape mirroring the wild report:
    // old rule kept 191047; new rule keeps 191047 + 40561 skipped-long.
    // Build a 1000-row miniature with the same bucket ratios and assert
    // kept + dropped* == total plus the kept lift equals skipped-long.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 560; i++) rows.push(endsong({ spotify_track_uri: `spotify:track:keep-${i}`, ts: new Date(T1 + i * 1000).toISOString(), ms_played: 200000 }));
    for (let i = 0; i < 319; i++) rows.push(endsong({ spotify_track_uri: `spotify:track:short-${i}`, ts: new Date(T1 + i * 1000).toISOString(), ms_played: 10000 }));
    for (let i = 0; i < 119; i++) rows.push(endsong({ spotify_track_uri: `spotify:track:skip-${i}`, ts: new Date(T1 + (560 + i) * 1000).toISOString(), ms_played: 200000, skipped: true }));
    rows.push(endsong({ spotify_track_uri: "" }));
    rows.push(endsong({ spotify_track_uri: "spotify:track:keep-0", ts: new Date(T1).toISOString(), ms_played: 200000 }));
    const { counts } = parseExtendedHistory(rows, NOW);
    expect(counts.total).toBe(1000);
    expect(counts.kept + counts.droppedShort + counts.droppedSkipped + counts.droppedNoUri + counts.droppedDuplicate + counts.droppedInvalid).toBe(1000);
    expect(counts.kept).toBe(560 + 119);
    expect(counts.droppedDuplicate).toBe(1);
    expect(counts.droppedSkipped).toBe(0);
  });

  it("counts garbage rows as invalid and never throws", () => {
    const { plays, counts } = parseExtendedHistory(
      [null, 42, {}, { ts: "not-a-date", ms_played: 200000, spotify_track_uri: "spotify:track:x" }],
      NOW,
    );
    expect(plays).toEqual([]);
    expect(counts).toEqual({
      total: 4,
      kept: 0,
      droppedShort: 0,
      droppedSkipped: 0,
      droppedNoUri: 0,
      droppedDuplicate: 0,
      droppedInvalid: 4,
    });
    expect(parseExtendedHistory(null, NOW).plays).toEqual([]);
    expect(parseExtendedHistory("nope", NOW).counts.total).toBe(0);
  });

  it("dedupes repeat uri@playedAt rows and keeps the count honest", () => {
    const row = endsong();
    const { plays, counts } = parseExtendedHistory([row, { ...row }, endsong({ ts: "2024-07-01T01:00:00.000Z" })], NOW);
    expect(counts).toEqual({
      total: 3,
      kept: 2,
      droppedShort: 0,
      droppedSkipped: 0,
      droppedNoUri: 0,
      droppedDuplicate: 1,
      droppedInvalid: 0,
    });
    expect(plays).toHaveLength(2);
  });

  it("drops future stamps as invalid", () => {
    const { plays, counts } = parseExtendedHistory([endsong({ ts: "2024-07-01T05:00:00.000Z" })], NOW);
    expect(plays).toEqual([]);
    expect(counts.droppedInvalid).toBe(1);
  });

  it("sorts newest first", () => {
    const { plays } = parseExtendedHistory(
      [
        endsong({ ts: "2024-07-01T00:00:00.000Z", spotify_track_uri: "spotify:track:old" }),
        endsong({ ts: "2024-07-01T02:00:00.000Z", spotify_track_uri: "spotify:track:new" }),
      ],
      NOW,
    );
    expect(plays.map((p) => p.uri)).toEqual(["spotify:track:new", "spotify:track:old"]);
    expect(plays[0].playedAt).toBe(T3);
  });
});

describe("multi-file import merge", () => {
  it("dedupes the same uri@playedAt across files in one combined parse", () => {
    const shared = endsong({ spotify_track_uri: "spotify:track:shared" });
    const fileA = [shared, endsong({ spotify_track_uri: "spotify:track:only-a", ts: "2024-07-01T01:00:00.000Z" })];
    const fileB = [{ ...shared }, endsong({ spotify_track_uri: "spotify:track:only-b", ts: "2024-07-01T02:00:00.000Z" })];
    const combined = [...fileA, ...fileB];
    const { plays, counts } = parseExtendedHistory(combined, NOW);
    expect(counts.total).toBe(4);
    expect(counts.kept).toBe(3);
    expect(counts.droppedDuplicate).toBe(1);
    expect(plays.map((p) => p.uri).sort()).toEqual(
      ["spotify:track:only-a", "spotify:track:only-b", "spotify:track:shared"].sort(),
    );
  });

  it("merges per-file parses idempotently, so repeat imports stay stable", () => {
    const a = parseExtendedHistory([endsong({ spotify_track_uri: "spotify:track:a" })], NOW);
    const b = parseExtendedHistory(
      [endsong({ spotify_track_uri: "spotify:track:a" }), endsong({ spotify_track_uri: "spotify:track:b", ts: "2024-07-01T01:00:00.000Z" })],
      NOW,
    );
    const once = mergeHistory(a.plays, b.plays);
    expect(once.plays.map((p) => p.uri).sort()).toEqual(["spotify:track:a", "spotify:track:b"].sort());
    const twice = mergeHistory(once, b.plays);
    expect(twice.plays).toEqual(once.plays);
  });

  it("tolerates a partial failure: one bad file still leaves the good rows countable", () => {
    const good = [endsong({ spotify_track_uri: "spotify:track:good" })];
    const bad: unknown[] = [null, { ts: "not-a-date", ms_played: 200, spotify_track_uri: "spotify:track:x" }];
    // The frontend skips unparseable files with a per-file note and
    // imports the rest in one transaction; model that as good rows plus
    // the bad file's rows tallied separately.
    const merged = parseExtendedHistory(good, NOW);
    const failed = parseExtendedHistory(bad, NOW);
    expect(merged.counts.kept).toBe(1);
    expect(failed.counts.droppedInvalid).toBe(2);
    const store = mergeHistory(merged.plays, []);
    expect(store.plays).toHaveLength(1);
  });
});

describe("mergeHistory", () => {
  function play(uri: string, playedAt: number): HistoryPlay {
    return {
      trackId: uri.split(":")[2] ?? uri,
      trackName: uri,
      artists: "A",
      playedAt,
      image: null,
      uri,
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "imported",
    };
  }

  it("merges two lists newest first and drops cross-list duplicates", () => {
    const store = mergeHistory([play("spotify:track:a", T1)], [play("spotify:track:a", T1), play("spotify:track:b", T2)]);
    expect(store.version).toBe(1);
    expect(store.plays.map((p) => p.uri)).toEqual(["spotify:track:b", "spotify:track:a"]);
    expect(store.importedRanges).toEqual([]);
  });

  it("stays idempotent on repeat merges", () => {
    const once = mergeHistory([], [play("spotify:track:a", T1), play("spotify:track:b", T2)]);
    const twice = mergeHistory(once, [play("spotify:track:a", T1), play("spotify:track:b", T2)]);
    expect(twice.plays).toEqual(once.plays);
  });

  it("accepts stores and unions imported ranges", () => {
    const a = { version: 1 as const, plays: [play("spotify:track:a", T1)], importedRanges: ["endsong_0"] };
    const b = { version: 1 as const, plays: [play("spotify:track:b", T2)], importedRanges: ["endsong_1"] };
    const merged = mergeHistory(a, b);
    expect(merged.importedRanges).toEqual(["endsong_0", "endsong_1"]);
    expect(merged.plays).toHaveLength(2);
  });

  it("treats unknown sides as empty and never throws", () => {
    expect(mergeHistory(null, undefined).plays).toEqual([]);
    expect(mergeHistory("nope", 42).version).toBe(1);
  });

  it("grows trim-free newest first (cap removed, paging bounds the UI)", () => {
    const plays: HistoryPlay[] = Array.from({ length: HISTORY_STORE_CAP + 500 }, (_, i) => ({
      trackId: `t${i}`,
      trackName: `Song ${i}`,
      artists: "A",
      playedAt: T1 + i * 1000,
      image: null,
      uri: `spotify:track:t${i}`,
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "imported" as const,
    }));
    const merged = mergeHistory([], plays);
    expect(merged.plays).toHaveLength(HISTORY_STORE_CAP + 500);
    expect(merged.plays[0].playedAt).toBe(T1 + (HISTORY_STORE_CAP + 499) * 1000);
    expect(merged.plays[merged.plays.length - 1].playedAt).toBe(T1);
  });

  it("leaves small stores untouched and trim is identity", () => {
    const plays: HistoryPlay[] = [
      {
        trackId: "a",
        trackName: "A",
        artists: "A",
        playedAt: T1,
        image: null,
        uri: "spotify:track:a",
        durationMs: 200000,
        msPlayed: 200000,
        skipped: false,
        source: "imported",
      },
    ];
    expect(trimStoreToCap(plays)).toHaveLength(1);
    expect(trimStoreToCap(Array.from({ length: HISTORY_STORE_CAP + 10 }, (_, i) => ({ ...plays[0], uri: `spotify:track:t${i}`, playedAt: T1 + i })))).toHaveLength(HISTORY_STORE_CAP + 10);
    expect(mergeHistory([], plays).plays).toHaveLength(1);
  });
});

describe("sliceStoreRange", () => {
  function play(uri: string, playedAt: number): HistoryPlay {
    return {
      trackId: uri.split(":")[2] ?? uri,
      trackName: uri,
      artists: "A",
      playedAt,
      image: null,
      uri,
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "imported",
    };
  }

  const store = {
    version: 1 as const,
    plays: [play("spotify:track:c", T3), play("spotify:track:b", T2), play("spotify:track:a", T1)],
    importedRanges: [] as string[],
  };

  it("keeps both bounds inclusive", () => {
    const out = sliceStoreRange(store, { start: T1, now: T2 });
    expect(out.map((p) => p.uri)).toEqual(["spotify:track:b", "spotify:track:a"]);
  });

  it("passes lifetime through with a null start", () => {
    expect(sliceStoreRange(store, { start: null, now: NOW })).toHaveLength(3);
  });

  it("drops future stamps as clock skew", () => {
    const withFuture = {
      ...store,
      plays: [...store.plays, play("spotify:track:future", NOW + 1000)],
    };
    const out = sliceStoreRange(withFuture, { start: null, now: NOW });
    expect(out.map((p) => p.uri)).not.toContain("spotify:track:future");
    expect(out).toHaveLength(3);
  });

  it("returns [] for unknown stores or args", () => {
    expect(sliceStoreRange(null, { start: null, now: NOW })).toEqual([]);
    expect(sliceStoreRange(store, null)).toEqual([]);
    expect(sliceStoreRange(store, { start: "soon" })).toEqual([]);
  });
});

describe("syncAppend", () => {
  function listen(over: Partial<HistoryPlay> = {}): HistoryPlay {
    return {
      trackId: "aaa",
      trackName: "Song One",
      artists: "Band A",
      playedAt: T2,
      image: null,
      uri: "spotify:track:aaa",
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "api",
      ...over,
    };
  }

  it("appends a fresh listen newest first", () => {
    const { store, event } = syncAppend({ version: 1 as const, plays: [], importedRanges: [] }, listen(), NOW);
    expect(event).toEqual({ reason: "appended", play: listen() });
    expect(store.plays).toHaveLength(1);
    expect(store.version).toBe(1);
  });

  it("appends skipped-long, refuses short/podcast/missing-uri/future/invalid", () => {
    const base = { version: 1 as const, plays: [listen()], importedRanges: [] };
    expect(syncAppend(base, listen(), NOW).event.reason).toBe("duplicate");
    expect(syncAppend(base, listen({ uri: "spotify:track:new", playedAt: T3, msPlayed: 10000, durationMs: 10000 }), NOW).event.reason).toBe("short");
    expect(syncAppend(base, listen({ uri: "spotify:track:new", playedAt: T3, skipped: true, msPlayed: 200000, durationMs: 200000 }), NOW).event.reason).toBe("appended");
    expect(syncAppend(base, listen({ uri: "spotify:track:short-skip", playedAt: T3, skipped: true, msPlayed: 5000, durationMs: 5000 }), NOW).event.reason).toBe("short");
    expect(syncAppend(base, { ...listen(), uri: "" }, NOW).event.reason).toBe("no-uri");
    expect(syncAppend(base, listen({ uri: "spotify:episode:pod1", playedAt: T3 }), NOW).event.reason).toBe("no-uri");
    expect(syncAppend(base, listen({ uri: "spotify:track:new", playedAt: NOW + 5000 }), NOW).event.reason).toBe("future");
    expect(syncAppend(base, null, NOW).event.reason).toBe("invalid");
    expect(syncAppend(base, listen(), NOW).store.plays).toHaveLength(1);
  });

  it("never mutates the input store", () => {
    const plays: HistoryPlay[] = [];
    const base = { version: 1 as const, plays, importedRanges: [] };
    syncAppend(base, listen(), NOW);
    expect(plays).toEqual([]);
  });

  it("grows a full store without evicting (cap removed)", () => {
    const plays: HistoryPlay[] = Array.from({ length: HISTORY_STORE_CAP }, (_, i) => ({
      trackId: `t${i}`,
      trackName: `Song ${i}`,
      artists: "A",
      playedAt: NOW - (HISTORY_STORE_CAP - i) * 1000,
      image: null,
      uri: `spotify:track:t${i}`,
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "imported" as const,
    }));
    const base = { version: 1 as const, plays, importedRanges: [] };
    const fresh = listen({ uri: "spotify:track:newest", trackId: "newest", playedAt: NOW });
    const { store, event } = syncAppend(base, fresh, NOW);
    expect(event.reason).toBe("appended");
    expect(store.plays).toHaveLength(HISTORY_STORE_CAP + 1);
    expect(store.plays[0].uri).toBe("spotify:track:newest");
    expect(base.plays).toHaveLength(HISTORY_STORE_CAP);
    expect(store.plays.some((p) => p.uri === "spotify:track:t0")).toBe(true);
  });

  it("probes an index set for O(1)-ish dedupe without rescanning", () => {
    const base = { version: 1 as const, plays: [{ trackId: "aaa", trackName: "Song One", artists: "Band A", playedAt: T2, image: null, uri: "spotify:track:aaa", durationMs: 200000, msPlayed: 200000, skipped: false, source: "api" as const }], importedRanges: [] as string[] };
    const index = buildHistoryIndex(base.plays);
    expect(index.has("spotify:track:aaa@" + String(T2))).toBe(true);
    const dup = { trackId: "aaa", trackName: "Song One", artists: "Band A", playedAt: T2, image: null, uri: "spotify:track:aaa", durationMs: 200000, msPlayed: 200000, skipped: false, source: "api" as const };
    expect(syncAppendWithIndex(base, dup, index, NOW).event.reason).toBe("duplicate");
    const fresh = { trackId: "new", trackName: "New", artists: "Band A", playedAt: T3, image: null, uri: "spotify:track:new", durationMs: 200000, msPlayed: 200000, skipped: false, source: "api" as const };
    const res = syncAppendWithIndex(base, fresh, index, NOW);
    expect(res.event.reason).toBe("appended");
    expect(index.has("spotify:track:new@" + String(T3))).toBe(true);
  });
});

describe("pageHistoryPlays", () => {
  function play(uri: string, playedAt: number): HistoryPlay {
    return {
      trackId: uri.split(":")[2] ?? uri,
      trackName: uri,
      artists: "A",
      playedAt,
      image: null,
      uri,
      durationMs: 200000,
      msPlayed: 200000,
      skipped: false,
      source: "imported",
    };
  }

  it("pages 100-row windows with cursor and honest total (memory bounded)", () => {
    const plays: HistoryPlay[] = Array.from({ length: 250 }, (_, i) => play(`spotify:track:t${i}`, T1 + i * 1000)).sort((a, b) => b.playedAt - a.playedAt);
    const p1 = pageHistoryPlays(plays, {});
    expect(p1.total).toBe(250);
    expect(p1.items).toHaveLength(100);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = pageHistoryPlays(plays, { cursor: p1.nextCursor, limit: 100 });
    expect(p2.items).toHaveLength(100);
    const p3 = pageHistoryPlays(plays, { cursor: p2.nextCursor, limit: 100 });
    expect(p3.items).toHaveLength(50);
    expect(p3.nextCursor).toBeNull();
    const keys = [...p1.items, ...p2.items, ...p3.items].map((p) => `${p.uri}@${p.playedAt}`);
    expect(new Set(keys).size).toBe(250);
  });
});
