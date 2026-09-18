import type { BrowseEntry, QueueContext, QueueItem } from "../lib/types";
import { formatMs } from "../lib/lrc";
import { RefreshIcon } from "./icons";

interface Props {
  current: QueueItem | null;
  upcoming: QueueItem[];
  loading: boolean;
  context: QueueContext | null;
  queuedCount?: number;
  onRefresh: () => void;
  onBrowse?: () => void;
  onOpenContext?: (entry: BrowseEntry) => void;
}

export default function QueuePane(p: Props) {
  const ctx = p.context;
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
          {p.upcoming.length > 0 && <span className="count"> {p.upcoming.length}</span>}
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
      {p.loading && p.upcoming.length === 0 ? (
        <div aria-label="Loading queue" role="status">
          <div className="skel skel-row" />
          <div className="skel skel-row" />
          <div className="skel skel-row" />
        </div>
      ) : p.upcoming.length === 0 ? (
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
        <ol className="queue">
          {p.upcoming.map((q, i) => (
            <li className="q" key={`${q.uri}-${i}`} title={q.uri}>
              <span className="q-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="q-name">
                {q.name}
                <small>{q.artists}</small>
              </span>
              <span className="q-time">{formatMs(q.durationMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
