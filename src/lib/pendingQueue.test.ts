import { describe, expect, it, vi } from "vitest";
import { PendingQueue, flushDelayMs } from "./pendingQueue";

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
