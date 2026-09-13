import { useCallback, useEffect, useRef, useState } from "react";

export interface Page<T, C> {
  items: T[];
  /** Cursor for the next page, or null when exhausted. */
  next: C | null;
}

/** Cursor-generic infinite list. Offset paging adapts as
 *  cursor=number; keyset paging (followed artists) as cursor=string.
 *  One IntersectionObserver sentinel per list; renders only fire on
 *  threshold crossings and page arrivals, never per scroll pixel. */
export function isThrottledError(m: string): boolean {
  const s = m.toLowerCase();
  return (
    s.includes("rate-limited") ||
    s.includes("quota-exceeded") ||
    s.includes("429") ||
    s.includes("cooling down") ||
    s.includes("retry after")
  );
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
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const errorRef = useRef(opts.onError);
  errorRef.current = opts.onError;

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await fetcherRef.current(pageSize, cursorRef.current);
      cursorRef.current = page.next;
      setItems((prev) => {
        const merged = [...prev, ...page.items];
        return merged.length > maxItems ? merged.slice(merged.length - maxItems) : merged;
      });
      setHasMore(page.next !== null);
      setThrottled(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (isThrottledError(m)) {
        setThrottled(m);
        setHasMore(true);
      } else {
        errorRef.current?.(m);
        setHasMore(false);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [pageSize, maxItems]);

  const retry = useCallback(() => {
    setThrottled(null);
    void loadMore();
  }, [loadMore]);

  useEffect(() => {
    cursorRef.current = null;
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
