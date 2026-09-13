import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { parseDevices, parsePlayer, parseQueue } from "./spotify";

const fullTrack = {
  id: "t1",
  name: "Song",
  artists: [{ name: "A" }, { name: "B" }],
  album: { name: "Alb", images: [{ url: "http://img/x.jpg" }] },
  duration_ms: 200000,
  uri: "spotify:track:t1",
  explicit: true,
};

function fullPlayer() {
  return {
    is_playing: true,
    progress_ms: 12345,
    shuffle_state: true,
    repeat_state: "track",
    device: { id: "d1", name: "Phone", volume_percent: 80 },
    item: fullTrack,
  };
}

describe("parsePlayer", () => {
  it("marks null input as empty", () => {
    const s = parsePlayer(null);
    expect(s.empty).toBe(true);
    expect(s.track).toBeNull();
    expect(s.isPlaying).toBe(false);
    expect(s.progressMs).toBe(0);
    expect(s.deviceId).toBeNull();
    expect(s.deviceName).toBeNull();
    expect(s.volume).toBeNull();
    expect(s.shuffle).toBe(false);
    expect(s.repeat).toBe("off");
  });

  it("marks missing items as empty", () => {
    expect(parsePlayer({})).toMatchObject({ empty: true });
    expect(parsePlayer({ empty: true })).toMatchObject({ empty: true });
    expect(parsePlayer({ item: null })).toMatchObject({ empty: true });
    expect(parsePlayer("nope")).toMatchObject({ empty: true });
  });

  it("parses a full player payload", () => {
    const s = parsePlayer(fullPlayer());
    expect(s.empty).toBe(false);
    expect(s.isPlaying).toBe(true);
    expect(s.progressMs).toBe(12345);
    expect(s.shuffle).toBe(true);
    expect(s.repeat).toBe("track");
    expect(s.deviceId).toBe("d1");
    expect(s.deviceName).toBe("Phone");
    expect(s.volume).toBe(80);
    expect(s.track).toEqual({
      id: "t1",
      name: "Song",
      artists: "A, B",
      album: "Alb",
      image: "http://img/x.jpg",
      durationMs: 200000,
      uri: "spotify:track:t1",
      explicit: true,
    });
    expect(typeof s.fetchedAt).toBe("number");
  });

  it("nulls device fields when no device is present", () => {
    const s = parsePlayer({ is_playing: false, progress_ms: 10, item: fullTrack });
    expect(s.deviceId).toBeNull();
    expect(s.deviceName).toBeNull();
    expect(s.volume).toBeNull();
  });

  it("defaults repeat to off and progress to 0", () => {
    const s = parsePlayer({ item: fullTrack });
    expect(s.repeat).toBe("off");
    expect(s.progressMs).toBe(0);
    expect(s.isPlaying).toBe(false);
    expect(s.shuffle).toBe(false);
  });

  it("nulls the track when the item has no id", () => {
    const s = parsePlayer({ item: { name: "Nameless" } });
    expect(s.empty).toBe(false);
    expect(s.track).toBeNull();
  });

  it("nulls the image when the album has no images", () => {
    const s = parsePlayer({
      item: { ...fullTrack, album: { name: "Alb", images: [] } },
    });
    expect(s.track?.image).toBeNull();
    expect(s.track?.album).toBe("Alb");
  });
});

describe("parseQueue", () => {
  it("returns an empty queue for garbage input", () => {
    expect(parseQueue(null)).toEqual({ current: null, upcoming: [] });
    expect(parseQueue({})).toEqual({ current: null, upcoming: [] });
    expect(parseQueue("nope")).toEqual({ current: null, upcoming: [] });
  });

  it("parses the current track and upcoming list", () => {
    const q = parseQueue({
      currently_playing: {
        name: "Now",
        artists: [{ name: "A" }],
        duration_ms: 1000,
        uri: "u:now",
      },
      queue: [
        { name: "Up1", artists: [{ name: "B" }], duration_ms: 2000, uri: "u:1" },
        { name: "Up2", artists: [], duration_ms: 3000, uri: "u:2" },
      ],
    });
    expect(q.current).toEqual({
      name: "Now",
      artists: "A",
      durationMs: 1000,
      uri: "u:now",
    });
    expect(q.upcoming).toHaveLength(2);
    expect(q.upcoming[0]).toEqual({
      name: "Up1",
      artists: "B",
      durationMs: 2000,
      uri: "u:1",
    });
  });

  it("caps the upcoming list at 10", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      name: `T${i}`,
      artists: [],
      duration_ms: i,
      uri: `u:${i}`,
    }));
    const q = parseQueue({ queue: items });
    expect(q.upcoming).toHaveLength(10);
    expect(q.upcoming[0].name).toBe("T0");
    expect(q.upcoming[9].name).toBe("T9");
    expect(q.current).toBeNull();
  });
});

describe("parseDevices", () => {
  it("returns [] for garbage input", () => {
    expect(parseDevices(null)).toEqual([]);
    expect(parseDevices({})).toEqual([]);
    expect(parseDevices({ devices: "x" })).toEqual([]);
  });

  it("parses device fields with fallbacks", () => {
    const ds = parseDevices({
      devices: [
        {
          id: "d1",
          name: "Phone",
          type: "Smartphone",
          is_active: true,
          volume_percent: 50,
        },
        { name: "NoId" },
      ],
    });
    expect(ds).toHaveLength(2);
    expect(ds[0]).toEqual({
      id: "d1",
      name: "Phone",
      kind: "Smartphone",
      isActive: true,
      volume: 50,
    });
    expect(ds[1]).toEqual({
      id: "",
      name: "NoId",
      kind: "",
      isActive: false,
      volume: null,
    });
  });
});
