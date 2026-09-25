import { describe, expect, it, vi } from "vitest";
import {
  ActionGate,
  PendingQueue,
  applyOptimisticTransport,
  flushDelayMs,
  shiftQueueForNext,
  transportSlot,
} from "./pendingQueue";
import type { PlayerSnapshot, QueueItem } from "./types";

describe("PendingQueue", () => {
  it("coalesces repeats of the same command (latest wins, fires once)", async () => {
    const q = new PendingQueue();
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    const r1 = q.enqueue("play", first, "Play");
    expect(r1.coalesced).toBe(false);
    expect(q.size()).toBe(1);
    const r2 = q.enqueue("play", second, "Play");
    expect(r2.coalesced).toBe(true);
    expect(q.size()).toBe(1);
    // Idempotency keys are unique per enqueue even when coalesced.
    expect(r1.entry.idempotencyKey).not.toBe(r2.entry.idempotencyKey);

    const results = await q.flush();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "play", ok: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
  });

  it("keeps distinct commands and fires each once", async () => {
    const q = new PendingQueue();
    const play = vi.fn(async () => null);
    const next = vi.fn(async () => null);
    q.enqueue("play", play);
    q.enqueue("next", next);
    expect(q.keys().sort()).toEqual(["next", "play"]);
    const results = await q.flush();
    expect(results).toHaveLength(2);
    expect(play).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    // Second flush is empty: never fires twice.
    expect(await q.flush()).toHaveLength(0);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("never fires twice under concurrent flush", async () => {
    const q = new PendingQueue();
    let calls = 0;
    q.enqueue("pause", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    // Exactly one flush owns the batch; the loser drains nothing.
    expect(a.length + b.length).toBe(1);
    expect(calls).toBe(1);
  });

  it("re-entrant enqueues during flush land in the next batch", async () => {
    const q = new PendingQueue();
    q.enqueue("play", async () => {
      q.enqueue("next", async () => null);
    });
    const first = await q.flush();
    expect(first.map((r) => r.key)).toEqual(["play"]);
    expect(q.has("next")).toBe(true);
    const second = await q.flush();
    expect(second.map((r) => r.key)).toEqual(["next"]);
  });

  it("records per-entry failures without dropping the rest", async () => {
    const q = new PendingQueue();
    q.enqueue("bad", async () => {
      throw new Error("boom");
    });
    q.enqueue("good", async () => "ok");
    const results = await q.flush();
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.key === "bad")).toMatchObject({ ok: false });
    expect(results.find((r) => r.key === "good")).toMatchObject({ ok: true });
    expect(q.size()).toBe(0);
  });

  it("clamps flush delays", () => {
    expect(flushDelayMs(2)).toBe(2000);
    expect(flushDelayMs(null)).toBe(2000);
    expect(flushDelayMs(null, 500)).toBe(500);
    expect(flushDelayMs(0)).toBe(250);
    expect(flushDelayMs(120)).toBe(30000);
  });
});

function snapFixture(over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    empty: false,
    isPlaying: true,
    progressMs: 65000,
    fetchedAt: 1000,
    track: null,
    deviceId: "dev-1",
    deviceName: "Speaker",
    volume: 50,
    shuffle: false,
    repeat: "off",
    ...over,
  };
}

function queueItem(name: string): QueueItem {
  return { name, artists: "Band", durationMs: 180000, uri: `spotify:track:${name}` };
}

describe("transportSlot", () => {
  it("shares one slot for the play/pause toggle, solo slots otherwise", () => {
    expect(transportSlot("play")).toBe("playPause");
    expect(transportSlot("pause")).toBe("playPause");
    expect(transportSlot("next")).toBe("next");
    expect(transportSlot("prev")).toBe("prev");
    expect(transportSlot("seek")).toBe("seek");
  });
});

describe("ActionGate", () => {
  it("single-flights one slot while others run free", () => {
    const g = new ActionGate();
    expect(g.enter("next")).toBe(true);
    expect(g.isInflight("next")).toBe(true);
    // Same slot busy; other slots unaffected.
    expect(g.enter("next")).toBe(false);
    expect(g.enter("prev")).toBe(true);
    expect(g.enter("playPause")).toBe(true);
    expect(g.release("next")).toBe(null);
    expect(g.isInflight("next")).toBe(false);
    expect(g.enter("next")).toBe(true);
  });

  it("coalesced next presses keep order: trailing fires once, latest wins", async () => {
    const g = new ActionGate();
    const order: string[] = [];
    expect(g.enter("next")).toBe(true);
    // Three rapid presses while one is in flight: the first two park, the
    // third replaces the second (latest wins) instead of queueing twice.
    expect(g.enter("next")).toBe(false);
    g.parkTrailing("next", async () => {
      order.push("second");
    });
    expect(g.hasTrailing("next")).toBe(true);
    g.parkTrailing("next", async () => {
      order.push("third");
    });
    order.push("first");
    const trailing = g.release("next");
    expect(trailing).not.toBe(null);
    await trailing!();
    // First ran, then exactly one trailing run in order.
    expect(order).toEqual(["first", "third"]);
    expect(g.hasTrailing("next")).toBe(false);
    // Releasing an idle slot yields nothing: never fires twice.
    expect(g.release("next")).toBe(null);
  });
});

describe("applyOptimisticTransport", () => {
  it("flips visual state synchronously, under 200 ms wall time", () => {
    const base = snapFixture();
    const t0 = performance.now();
    const paused = applyOptimisticTransport(base, "pause");
    const played = applyOptimisticTransport({ ...base, isPlaying: false }, "play");
    const nexted = applyOptimisticTransport(base, "next");
    const preved = applyOptimisticTransport(base, "prev");
    const seeked = applyOptimisticTransport(base, "seek", 12000);
    const wallMs = performance.now() - t0;
    // The visual update is a pure sync transform: five presses cost a
    // fraction of a frame, nowhere near the 200 ms budget.
    expect(wallMs).toBeLessThan(200);
    expect(paused.isPlaying).toBe(false);
    expect(played.isPlaying).toBe(true);
    // Next/previous reset progress at press time; the confirm fetch lands
    // the real track later.
    expect(nexted.progressMs).toBe(0);
    expect(preved.progressMs).toBe(0);
    expect(seeked.progressMs).toBe(12000);
    // Untouched fields survive the spread.
    expect(nexted.track).toBe(base.track);
    expect(nexted.deviceId).toBe("dev-1");
  });
});

describe("shiftQueueForNext", () => {
  it("bumps the track index optimistically", () => {
    const q = { current: queueItem("now"), upcoming: [queueItem("a"), queueItem("b")] };
    const shifted = shiftQueueForNext(q);
    expect(shifted.current?.name).toBe("a");
    expect(shifted.upcoming.map((t) => t.name)).toEqual(["b"]);
    // Input untouched (rollback-safe snapshot).
    expect(q.current?.name).toBe("now");
    expect(q.upcoming).toHaveLength(2);
  });

  it("leaves an empty upcoming list alone", () => {
    const q = { current: queueItem("now"), upcoming: [] };
    expect(shiftQueueForNext(q)).toBe(q);
  });
});
