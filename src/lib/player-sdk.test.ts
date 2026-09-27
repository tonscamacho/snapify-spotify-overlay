import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "get_fresh_token" ? "test-token" : null,
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { ensurePlayer, percentToSdkGain, sdkGainToPercent, setSdkVolume, teardownPlayer } from "./player-sdk";

class FakePlayer {
  static constructedWith: number | undefined;
  static reset() {
    FakePlayer.constructedWith = undefined;
  }
  volumes: number[] = [];
  listeners = new Map<string, (arg?: unknown) => void>();
  constructor(opts: { volume?: number }) {
    FakePlayer.constructedWith = opts.volume;
  }
  addListener(event: string, cb: (arg?: unknown) => void): boolean {
    this.listeners.set(event, cb);
    return true;
  }
  connect(): Promise<boolean> {
    return Promise.resolve(true);
  }
  disconnect(): void {}
  getCurrentState(): Promise<unknown> {
    return Promise.resolve(null);
  }
  setVolume(v: number): Promise<void> {
    this.volumes.push(v);
    return Promise.resolve();
  }
  pause(): Promise<void> {
    return Promise.resolve();
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

function lastPlayer(): FakePlayer {
  const w = window as unknown as { __lastFake?: FakePlayer };
  if (!w.__lastFake) throw new Error("no player constructed");
  return w.__lastFake;
}

beforeEach(() => {
  teardownPlayer();
  FakePlayer.reset();
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g["window"]) g["window"] = g;
  const w = globalThis as unknown as {
    Spotify?: unknown;
    __lastFake?: FakePlayer;
  };
  w.Spotify = {
    Player: class extends FakePlayer {
      constructor(opts: { volume?: number }) {
        super(opts);
        w.__lastFake = this as FakePlayer;
      }
    },
  };
  delete w.__lastFake;
  const doc = globalThis as unknown as {
    document?: { querySelector: () => unknown };
  };
  doc.document = { querySelector: () => ({}) };
});

describe("sdk local gain", () => {
  it("seeds the player curved to perceptual parity, not linear", async () => {
    await ensurePlayer(0.25);
    expect(FakePlayer.constructedWith).toBeCloseTo(0.0625, 10);
  });

  it("falls back to a modest curved gain when the level is unknown", async () => {
    await ensurePlayer();
    // Fractional fallback 0.5 -> curved 0.25, matching native 50%.
    expect(FakePlayer.constructedWith).toBeCloseTo(0.25, 10);
  });

  it("forwards slider moves curved and clamped to 0-1", async () => {
    await ensurePlayer(0.5);
    setSdkVolume(0.3);
    setSdkVolume(9);
    setSdkVolume(-2);
    const vols = lastPlayer().volumes;
    expect(vols).toHaveLength(3);
    expect(vols[0]).toBeCloseTo(0.09, 10);
    expect(vols[1]).toBe(1);
    expect(vols[2]).toBe(0);
  });

  it("ignores slider moves with no player alive", () => {
    expect(() => setSdkVolume(0.7)).not.toThrow();
  });
});

describe("volume parity (same percent = same loudness)", () => {
  it("proves the old linear bug: 50 percent linear is twice the native loudness", () => {
    const linear = 50 / 100; // old code handed this straight to the SDK
    const curved = percentToSdkGain(50); // native 50 renders ~0.25 power
    expect(linear).toBe(0.5);
    expect(curved).toBeCloseTo(0.25, 10);
    expect(curved).toBeLessThan(linear);
  });

  it("maps percent to the SDK gain through the native taper", () => {
    expect(percentToSdkGain(0)).toBe(0);
    expect(percentToSdkGain(25)).toBeCloseTo(0.0625, 10);
    expect(percentToSdkGain(50)).toBeCloseTo(0.25, 10);
    expect(percentToSdkGain(75)).toBeCloseTo(0.5625, 10);
    expect(percentToSdkGain(100)).toBe(1);
  });

  it("keeps boundaries and mute exact", () => {
    expect(percentToSdkGain(0)).toBe(0);
    expect(percentToSdkGain(100)).toBe(1);
    // Mute is volume 0 through the same path; unmute restores via volumeCb.
    expect(percentToSdkGain(0)).toBe(0);
  });

  it("clamps out-of-range and non-finite percent", () => {
    expect(percentToSdkGain(-20)).toBe(0);
    expect(percentToSdkGain(999)).toBe(1);
    expect(percentToSdkGain(Number.NaN)).toBeCloseTo(0.25, 10);
  });

  it("round-trips through the inverse within a percent", () => {
    for (const p of [0, 25, 50, 75, 100]) {
      expect(sdkGainToPercent(percentToSdkGain(p))).toBe(p);
    }
  });

  it("drives the SDK end to end from a fractional slider position", async () => {
    await ensurePlayer(0.5);
    expect(FakePlayer.constructedWith).toBeCloseTo(0.25, 10);
    setSdkVolume(0.5);
    expect(lastPlayer().volumes).toHaveLength(1);
    expect(lastPlayer().volumes[0]).toBeCloseTo(0.25, 10);
  });
});

describe("ready registration never steals playback (R1)", () => {
  const invokeMock = vi.mocked(invoke);
  const emitMock = vi.mocked(emit);

  function playingElsewhere() {
    return {
      is_playing: true,
      progress_ms: 1000,
      item: { id: "t1" },
      device: { id: "other-device", name: "TON" },
    };
  }

  /** Build the player, answer get_player with `raw`, then fire the SDK
   *  ready event the way connect() would. Resolves once the ready signal
   *  emits so the guard has fully settled. */
  async function fireReady(raw: unknown | Error): Promise<void> {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_fresh_token") return "test-token";
      if (cmd === "get_player") {
        if (raw instanceof Error) throw raw;
        return raw;
      }
      return null;
    });
    emitMock.mockClear();
    invokeMock.mockClear();
    await ensurePlayer(0.5);
    lastPlayer().listeners.get("ready")?.({ device_id: "sdk-live-1" });
    await vi.waitFor(() => {
      expect(emitMock).toHaveBeenCalledWith("sdk-device-ready", "sdk-live-1");
    });
  }

  function transferCalls(): Array<Record<string, unknown>> {
    return invokeMock.mock.calls
      .filter(([cmd]) => cmd === "transfer_playback")
      .map(([, args]) => (args ?? {}) as Record<string, unknown>);
  }

  it("skips the transfer while another device is playing", async () => {
    await fireReady(playingElsewhere());
    expect(transferCalls()).toEqual([]);
  });

  it("registers with play:false when nothing is playing", async () => {
    await fireReady({ empty: true });
    expect(transferCalls()).toEqual([{ deviceId: "sdk-live-1", playNow: false }]);
  });

  it("stays put when the player read fails", async () => {
    await fireReady(new Error("offline"));
    expect(transferCalls()).toEqual([]);
  });
});
