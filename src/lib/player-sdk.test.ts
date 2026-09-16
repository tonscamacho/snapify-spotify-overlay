import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "get_fresh_token" ? "test-token" : null,
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));

import { ensurePlayer, setSdkVolume, teardownPlayer } from "./player-sdk";

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
  it("seeds the player from the caller instead of a fixed blast", async () => {
    await ensurePlayer(0.25);
    expect(FakePlayer.constructedWith).toBe(0.25);
  });

  it("falls back to a modest gain when the level is unknown", async () => {
    await ensurePlayer();
    expect(FakePlayer.constructedWith).toBe(0.5);
  });

  it("forwards slider moves clamped to 0-1", async () => {
    await ensurePlayer(0.5);
    setSdkVolume(0.3);
    setSdkVolume(9);
    setSdkVolume(-2);
    expect(lastPlayer().volumes).toEqual([0.3, 1, 0]);
  });

  it("ignores slider moves with no player alive", () => {
    expect(() => setSdkVolume(0.7)).not.toThrow();
  });
});
