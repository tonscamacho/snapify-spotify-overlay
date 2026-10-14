import { describe, expect, it } from "vitest";
import {
  HISTORY_IMPORT_MAX_BYTES,
  HISTORY_MIN_MS,
  HISTORY_STORE_CAP,
  HISTORY_STORE_VERSION,
  mergeHistory,
  parseExtendedHistory,
  sliceStoreRange,
  syncAppend,
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

  it("pins the 50k store cap so the pane can never grow without bound", () => {
    expect(HISTORY_STORE_CAP).toBe(50_000);
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

  it("drops short, skipped, forward-button, and empty-uri rows into their own buckets", () => {
    const { plays, counts } = parseExtendedHistory(
      [
        endsong({ spotify_track_uri: "spotify:track:keep", ms_played: 200000, ts: "2024-07-01T01:00:00.000Z" }),
        endsong({ spotify_track_uri: "spotify:track:short", ms_played: 29999 }),
        endsong({ spotify_track_uri: "spotify:track:skipped", skipped: true }),
        endsong({ spotify_track_uri: "spotify:track:fwd", reason_end: "fwdbtn", skipped: false }),
        endsong({ spotify_track_uri: "" }),
        endsong({ spotify_track_uri: "spotify:track:exact", ms_played: 30000 }),
      ],
      NOW,
    );
    expect(counts).toEqual({
      total: 6,
      kept: 2,
      droppedShort: 1,
      droppedSkipped: 2,
      droppedNoUri: 1,
      droppedDuplicate: 0,
      droppedInvalid: 0,
    });
    expect(plays.map((p) => p.uri)).toEqual(["spotify:track:keep", "spotify:track:exact"]);
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

  it("trims to the store cap newest first, evicting the oldest rows", () => {
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
    expect(merged.plays).toHaveLength(HISTORY_STORE_CAP);
    // Newest survives, oldest evicted.
    expect(merged.plays[0].playedAt).toBe(T1 + (HISTORY_STORE_CAP + 499) * 1000);
    expect(merged.plays[merged.plays.length - 1].playedAt).toBe(T1 + 500 * 1000);
  });

  it("leaves small stores untouched", () => {
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

  it("refuses duplicates, short, skipped, missing-uri, future, and invalid listens", () => {
    const base = { version: 1 as const, plays: [listen()], importedRanges: [] };
    expect(syncAppend(base, listen(), NOW).event.reason).toBe("duplicate");
    expect(syncAppend(base, listen({ uri: "spotify:track:new", playedAt: T3, msPlayed: 10000, durationMs: 10000 }), NOW).event.reason).toBe("short");
    expect(syncAppend(base, listen({ uri: "spotify:track:new", playedAt: T3, skipped: true }), NOW).event.reason).toBe("skipped");
    expect(syncAppend(base, { ...listen(), uri: "" }, NOW).event.reason).toBe("no-uri");
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

  it("caps a full store: the oldest row evicts to admit the new listen", () => {
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
    expect(store.plays).toHaveLength(HISTORY_STORE_CAP);
    expect(store.plays[0].uri).toBe("spotify:track:newest");
    // The input store is untouched and the oldest row is gone.
    expect(base.plays).toHaveLength(HISTORY_STORE_CAP);
    expect(store.plays.some((p) => p.uri === "spotify:track:t0")).toBe(false);
  });
});
