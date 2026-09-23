import { useCallback, useEffect, useRef, useState } from "react";
import { isThrottledError as isThrottleErrorTyped } from "./spotify";

export interface Page<T, C> {
  items: T[];
  /** Cursor for the next page, or null when exhausted. */
  next: C | null;
}

/** Cursor-generic infinite list. Offset paging adapts as
 *  cursor=number; keyset paging (followed artists) as cursor=string.
 *  One IntersectionObserver sentinel per list; renders only fire on
 *  threshold crossings and page arrivals, never per scroll pixel. */
/** Single routing point: all throttle detection goes through spotify.ts. */
function isThrottledError(m: unknown): boolean {
  return isThrottleErrorTyped(m);
}

const MAX_ITEMS_DEFAULT = 200;

export function usePagedList<T, C>(
  fetcher: (limit: number, cursor: C | null) => Promise<Page<T, C>>,
  opts: { pageSize?: number; resetKey: string; onError?: (m: string) => void; maxItems?: number },
) {
  const pageSize = opts.pageSize ?? 20;
  const maxItems = opts.maxItems ?? MAX_ITEMS_DEFAULT;
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [throttled, setThrottled] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<C | null>(null);
  const loadingRef = useRef(false);
  // Exhausted guard: once a page arrives with next:null the cursor stays
  // null, so a sentinel re-fire must not re-fetch the same page and append
  // duplicates. State alone is async; the ref gates synchronously.
  // exhaustedRef distinguishes a terminal next:null (retry is a no-op) from
  // a terminal error (manual retry re-arms one attempt).
  const hasMoreRef = useRef(true);
  const exhaustedRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const errorRef = useRef(opts.onError);
  errorRef.current = opts.onError;

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    if (!hasMoreRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await fetcherRef.current(pageSize, cursorRef.current);
      cursorRef.current = page.next;
      setItems((prev) => {
        const merged = [...prev, ...page.items];
        return merged.length > maxItems ? merged.slice(merged.length - maxItems) : merged;
      });
      const more = page.next !== null;
      hasMoreRef.current = more;
      exhaustedRef.current = !more;
      setHasMore(more);
      setThrottled(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (isThrottledError(m)) {
        setThrottled(m);
        hasMoreRef.current = true;
        exhaustedRef.current = false;
        setHasMore(true);
      } else {
        errorRef.current?.(m);
        hasMoreRef.current = false;
        exhaustedRef.current = false;
        setHasMore(false);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [pageSize, maxItems]);

  const retry = useCallback(() => {
    // Exhausted lists have nothing to retry; keep the guard shut so a
    // stray retry cannot re-fetch page one and duplicate keys.
    if (exhaustedRef.current) return;
    setThrottled(null);
    // Terminal errors park hasMore false; a manual retry re-arms one attempt.
    hasMoreRef.current = true;
    setHasMore(true);
    void loadMore();
  }, [loadMore]);

  useEffect(() => {
    cursorRef.current = null;
    hasMoreRef.current = true;
    exhaustedRef.current = false;
    setItems([]);
    setHasMore(true);
    setThrottled(null);
    void loadMore();
  }, [opts.resetKey, loadMore]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const setSentinel = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      sentinelRef.current = el;
      if (!el) return;
      const root = el.closest(".pane-body");
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((en) => en.isIntersecting)) void loadMore();
        },
        { root, rootMargin: "320px" },
      );
      io.observe(el);
      observerRef.current = io;
    },
    [loadMore],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { items, loading, hasMore, throttled, retry, sentinelRef: setSentinel };
}
