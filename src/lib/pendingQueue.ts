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
