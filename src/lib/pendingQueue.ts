/** Pending write queue for throttled transport commands (PR3).
 *
 *  When a write (play/pause/next/prev/seek/queue-add/…) hits a 429 the
 *  command is parked here instead of dropped. Repeats of the same command
 *  coalesce to the latest call so a double-pressed play never fires twice.
 *  Each parking gets an idempotency key for log correlation. The owner
 *  (App `run`) flushes on cooldown end by draining the snapshot and firing
 *  each entry once; the drain clears before firing so a concurrent flush or
 *  a re-entrant enqueue cannot double-fire.
 */

import type { PlayerSnapshot, QueueItem } from "./types";

export interface QueuedWrite {
  /** Coalescing key, e.g. "play", "pause", "seek", "queueAdd:spotify:track:x". */
  key: string;
  /** Short human label for the queued chip. */
  label: string;
  /** Unique per enqueue, for log correlation. */
  idempotencyKey: string;
  enqueuedAt: number;
  run: () => Promise<unknown>;
}

function newIdempotencyKey(key: string, counter: number): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as Crypto).randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${key}-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

export class PendingQueue {
  private entries = new Map<string, QueuedWrite>();
  private flushing = false;
  private counter = 0;
  private listeners = new Set<() => void>();

  size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Park a write. Same-key repeats replace the stored runner (latest wins)
   *  and report `coalesced: true`. Never duplicates the key. */
  enqueue(
    key: string,
    run: () => Promise<unknown>,
    label?: string,
  ): { entry: QueuedWrite; coalesced: boolean } {
    const coalesced = this.entries.has(key);
    this.counter += 1;
    const entry: QueuedWrite = {
      key,
      label: label ?? key,
      idempotencyKey: newIdempotencyKey(key, this.counter),
      enqueuedAt: Date.now(),
      run,
    };
    this.entries.set(key, entry);
    this.notify();
    return { entry, coalesced };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // Listener faults must not break queue bookkeeping.
      }
    }
  }

  /** Fire every parked write once. The snapshot is cleared before the first
   *  fire so a concurrent flush, a timer re-fire, or a re-entrant enqueue
   *  during firing cannot double-fire an entry. Re-entrant enqueues land in
   *  the fresh map for the next flush. Returns per-entry outcomes. */
  async flush(
    runner?: (entry: QueuedWrite) => Promise<unknown>,
  ): Promise<Array<{ key: string; ok: boolean; error?: string }>> {
    if (this.flushing) return [];
    if (this.entries.size === 0) return [];
    this.flushing = true;
    const batch = [...this.entries.values()];
    this.entries.clear();
    this.notify();
    const out: Array<{ key: string; ok: boolean; error?: string }> = [];
    try {
      for (const entry of batch) {
        try {
          await (runner ? runner(entry) : entry.run());
          out.push({ key: entry.key, ok: true });
        } catch (e) {
          out.push({
            key: entry.key,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      this.flushing = false;
    }
    return out;
  }
}

/** Cooldown delay for a flush timer. Uses the typed retryAfterSec when
 *  present, otherwise the caller fallback. Clamped to 0.25–30 s so a
 *  missing header still retries promptly and a quota backoff never sleeps
 *  the UI thread for minutes (the Rust gate holds the real cooldown). */
export function flushDelayMs(retryAfterSec: number | null, fallbackMs = 2000): number {
  if (typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(30000, Math.max(250, Math.round(retryAfterSec * 1000)));
  }
  return Math.min(30000, Math.max(250, fallbackMs));
}

/** Transport fast-feedback helpers (Track B: visual feedback under 200 ms,
 *  cloud confirmation later).
 *
 *  Play and pause share one single-flight slot because they are two faces
 *  of the same toggle; next, previous, and seek each fly alone. A press
 *  that lands while its own slot is in flight parks as trailing (latest
 *  wins) instead of the old silent drop. Different slots run concurrently,
 *  so a slow next never disables play/pause/previous.
 */
export type TransportSlot = "playPause" | "next" | "prev" | "seek";

export function transportSlot(
  action: "play" | "pause" | "next" | "prev" | "seek",
): TransportSlot {
  if (action === "play" || action === "pause") return "playPause";
  return action;
}

/** Per-action single-flight gate with latest-wins trailing. The owner
 *  (App `run`) enters before firing and releases after settling; the
 *  released trailing thunk, if any, fires next through the same path so
 *  order is preserved and no press is silently dropped. */
export class ActionGate {
  private inflight = new Set<TransportSlot>();
  private trailing = new Map<TransportSlot, () => Promise<unknown>>();

  isInflight(slot: TransportSlot): boolean {
    return this.inflight.has(slot);
  }

  hasTrailing(slot: TransportSlot): boolean {
    return this.trailing.has(slot);
  }

  /** True when the caller now owns the slot and must fire; false when a
   *  sibling press is already in flight (caller should parkTrailing). */
  enter(slot: TransportSlot): boolean {
    if (this.inflight.has(slot)) return false;
    this.inflight.add(slot);
    return true;
  }

  /** Park the latest press while one is in flight. Repeats replace the
   *  stored runner so a held-down next re-fires once, not once per press. */
  parkTrailing(slot: TransportSlot, run: () => Promise<unknown>): void {
    this.trailing.set(slot, run);
  }

  /** Release the slot and take the parked trailing press, if any. The
   *  trailing entry is removed before return so a concurrent release or a
   *  re-entrant park cannot double-fire it. */
  release(slot: TransportSlot): (() => Promise<unknown>) | null {
    this.inflight.delete(slot);
    const next = this.trailing.get(slot) ?? null;
    if (next) this.trailing.delete(slot);
    return next;
  }
}

/** Synchronous optimistic state for a transport press (Track B). Pure and
 *  immediate: the caller applies it before awaiting the cloud, so the icon
 *  or progress flips in the same frame as the press (well under 200 ms).
 *  The cloud confirm (~400 ms fast, ~1.5 s confirm) or a rollback on hard
 *  failure settles it afterwards. Next/previous cannot know the new track
 *  without a queue read, so they reset progress and rely on the pending
 *  mark plus the queue shift below. */
export function applyOptimisticTransport(
  prev: PlayerSnapshot,
  action: "play" | "pause" | "next" | "prev" | "seek",
  seekMs?: number,
): PlayerSnapshot {
  switch (action) {
    case "play":
      return { ...prev, isPlaying: true };
    case "pause":
      return { ...prev, isPlaying: false };
    case "next":
    case "prev":
      return { ...prev, progressMs: 0, fetchedAt: Date.now() };
    case "seek":
      return {
        ...prev,
        progressMs: seekMs ?? prev.progressMs,
        fetchedAt: Date.now(),
      };
  }
}

export interface QueueView {
  current: QueueItem | null;
  upcoming: QueueItem[];
}

/** Optimistic track-index bump for next (Track B): the head of the visible
 *  upcoming list becomes current at press time. The confirm fetch (or a
 *  rollback on hard failure) corrects it against the cloud. Previous has
 *  no knowable target, so it shows the pending mark only. Returns the input
 *  unchanged when there is nothing to advance to. */
export function shiftQueueForNext(q: QueueView): QueueView {
  if (q.upcoming.length === 0) return q;
  const [head, ...rest] = q.upcoming;
  return { current: head, upcoming: rest };
}
