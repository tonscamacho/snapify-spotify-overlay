import { useEffect, useRef, useState } from "react";
import type { BrowseEntry, QueueContext, QueueItem } from "../lib/types";
import { formatMs } from "../lib/lrc";
import { RefreshIcon } from "./icons";

interface Props {
  current: QueueItem | null;
  upcoming: QueueItem[];
  loading: boolean;
  context: QueueContext | null;
  queuedCount?: number;
  /** True while the list is pinned to the degraded 10-item fallback. */
  capped?: boolean;
  onRefresh: () => void;
  onBrowse?: () => void;
  onOpenContext?: (entry: BrowseEntry) => void;
  /** Play one queue row now (Enter/click). Kept as a button so keyboard works. */
  onPlayUri?: (uri: string) => void;
}

/** Windowing constants. ROW_H is only the first guess: the real row height
 *  is measured from the first rendered row (density setting changes padding)
 *  so rows never overlap. OVERSCAN renders a few rows past the viewport so
 *  fast scrolls never flash blank. No dependency, no CSS changes. */
const ROW_GUESS = 64;
const OVERSCAN = 4;
const VIEW_MAX_H = 320;

export default function QueuePane(p: Props) {
  const ctx = p.context;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(VIEW_MAX_H);
  const [rowH, setRowH] = useState(ROW_GUESS);

  const total = p.upcoming.length;

  // Measure one real row so the window math tracks density/font scale.
  // The row carries an inline height:rowH pin, so offsetHeight on the li
  // itself just reads the pin back (ROW_GUESS forever, never converging).
  // Measure the unpinned inner content (.q-hit) plus the li's own vertical
  // chrome instead: that converges on the natural row height, so the
  // virtual grid (ol height, window slice, scrollbar) matches what paints.
  useEffect(() => {
    const el = listRef.current?.querySelector("li.q") as HTMLElement | null;
    const hit = el?.querySelector(".q-hit") as HTMLElement | null;
    if (!el || !hit) return;
    const cs = getComputedStyle(el);
    const h =
      hit.offsetHeight +
      (parseFloat(cs.paddingTop) || 0) +
      (parseFloat(cs.paddingBottom) || 0) +
      (parseFloat(cs.borderTopWidth) || 0) +
      (parseFloat(cs.borderBottomWidth) || 0);
    if (h >= 24 && h <= 220 && h !== rowH) setRowH(h);
  });

  // A fresh short queue (refresh, track change) rewinds to the top.
  useEffect(() => {
    setScrollTop(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [total === 0]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (el.clientHeight > 0 && el.clientHeight !== viewH) setViewH(el.clientHeight);
  };

  const start = Math.max(0, Math.min(total, Math.floor(scrollTop / rowH) - OVERSCAN));
  const count = Math.ceil(viewH / rowH) + OVERSCAN * 2;
  const end = Math.min(total, start + Math.max(count, OVERSCAN * 2 + 1));
  const windowed = total > 0 ? p.upcoming.slice(start, end) : [];

  return (
    <>
      {p.queuedCount != null && p.queuedCount > 0 && (
        <div className="throttled-note" role="status">
          <span>
            Queued — will send after cooldown{p.queuedCount > 1 ? ` (${p.queuedCount})` : ""}.
          </span>
        </div>
      )}
      <div className="pane-subhead">
        <span>
          Up next
          {total > 0 && <span className="count"> {total}</span>}
        </span>
        <button
          className="icon-btn sm"
          onClick={p.onRefresh}
          title="Refresh queue"
          aria-label="Refresh queue"
        >
          <RefreshIcon size={14} />
        </button>
      </div>
      {p.capped && total > 0 && (
        <div className="throttled-note" role="status">
          <span>Showing first 10 — Spotify throttled the full queue.</span>
        </div>
      )}
      {ctx?.name && (
        <button
          className="queue-context"
          onClick={() =>
            p.onOpenContext?.({ kind: ctx.kind, id: ctx.id, name: ctx.name ?? undefined })
          }
          title={`Open ${ctx.name}`}
          aria-label={`Open ${ctx.name}`}
        >
          <span className="queue-context-label">Next from:</span>
          <span className="queue-context-name">{ctx.name}</span>
        </button>
      )}
      {p.loading && total === 0 ? (
        <div aria-label="Loading queue" role="status">
          <div className="skel skel-row" />
          <div className="skel skel-row" />
          <div className="skel skel-row" />
        </div>
      ) : total === 0 ? (
        <div className="empty">
          <div className="empty-title">Queue is empty</div>
          <div className="empty-sub">Spotify builds it as you listen.</div>
          <button className="btn sm" onClick={p.onRefresh}>
            Refresh
          </button>{" "}
          {p.onBrowse && (
            <button className="btn sm" onClick={p.onBrowse}>
              Browse
            </button>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="queue-scroll queue-fill"
          role="list"
          aria-label="Upcoming queue"
          tabIndex={0}
          onScroll={onScroll}
        >
          <ol
            ref={listRef}
            className="queue"
            data-virtualized="true"
            data-total={total}
            style={{ position: "relative", height: total * rowH }}
          >
            {windowed.map((q, i) => {
              const idx = start + i;
              return (
                <li
                  className="q"
                  key={`${q.uri}-${idx}`}
                  title={q.uri}
                  style={{
                    position: "absolute",
                    top: idx * rowH,
                    left: 0,
                    right: 0,
                    height: rowH,
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    className="q-hit"
                    onClick={() => p.onPlayUri?.(q.uri)}
                    aria-label={`Play ${q.name} by ${q.artists || "unknown artist"}`}
                    title={`Play ${q.name}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "baseline",
                      gap: 10,
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "inherit",
                      font: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <span className="q-index">{String(idx + 1).padStart(2, "0")}</span>
                    <span className="q-name">
                      {q.name}
                      <small>{q.artists}</small>
                    </span>
                    <span className="q-time">{formatMs(q.durationMs)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </>
  );
}
