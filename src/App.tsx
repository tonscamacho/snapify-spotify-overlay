import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PlayerPane from "./components/PlayerPane";
import { writeDeviceChoice } from "./components/PlayerPane";
const MemoPlayerPane = memo(PlayerPane);
import LyricsPane from "./components/LyricsPane";
const MemoLyricsPane = memo(LyricsPane);
import QueuePane from "./components/QueuePane";
const MemoQueuePane = memo(QueuePane);
import VisualizerPane from "./components/VisualizerPane";
const MemoVisualizerPane = memo(VisualizerPane);
import BrowsePane from "./components/BrowsePane";
const MemoBrowsePane = memo(BrowsePane);
import SettingsModal from "./components/SettingsModal";
import {
  CursorIcon,
  EyeIcon,
  EyeOffIcon,
  GearIcon,
  GridIcon,
  NoteIcon,
  PencilIcon,
  ThroughIcon,
  UndoIcon,
  XIcon,
} from "./components/icons";
import { api, parsePlayer, toThrottleError } from "./lib/spotify";
import { PendingQueue, flushDelayMs } from "./lib/pendingQueue";
import { reportOverlayMode, reportOverlayRegions } from "./lib/overlay";
import { ensurePlayer, setSdkVolume } from "./lib/player-sdk";
import { initialBrowse } from "./lib/browse";
import type { TransLang } from "./lib/translate";
import {
  DEFAULT_KEYBINDS,
  acceleratorMatchesEvent,
  coerceKeybinds,
  type KeybindAction,
  type KeybindMap,
} from "./lib/keybinds";
import { updateError, type UpdateStatus } from "./lib/updater";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import {
  PRESETS,
  clampLayoutToArea,
  clampPaneToArea,
  clonePanes,
  defaultLayoutFor,
  getPaneMin,
  loadLayout,
  pushLayoutUndo,
  revealPaneType,
  saveLayout,
  snapMove,
  snapSize,
  togglePaneVisibility,
} from "./lib/layout";
import type {
  BrowseEntry,
  BrowseState,
  Corners,
  Density,
  DeviceInfo,
  LayoutUndoEntry,
  LyricsState,
  PaneState,
  PaneType,
  PlayerSnapshot,
  QueueContext,
  QueueItem,
  Surface,
} from "./lib/types";
import "./App.css";

const EMPTY_SNAP: PlayerSnapshot = {
  empty: true,
  isPlaying: false,
  progressMs: 0,
  fetchedAt: Date.now(),
  track: null,
  deviceId: null,
  deviceName: null,
  volume: null,
  shuffle: false,
  repeat: "off",
};

const PRESET_ORDER = ["minimal", "full", "lyrics", "spotlight"];
const PANE_TYPES: PaneType[] = ["player", "lyrics", "queue", "visualizer", "browse"];
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const PANE_TITLES: Record<PaneType, string> = {
  player: "Player",
  lyrics: "Lyrics",
  queue: "Queue",
  visualizer: "Visualizer",
  browse: "Browse",
};

const HANDLE_LABELS: Record<Handle, string> = {
  n: "top edge",
  s: "bottom edge",
  e: "right edge",
  w: "left edge",
  ne: "top right corner",
  nw: "top left corner",
  se: "bottom right corner",
  sw: "bottom left corner",
};

/** Arrow-key nudge step for keyboard move/resize, in logical px. */
const KB_STEP = 8;

/** Focused pane for keyboard geometry: the pane holding DOM focus, else
 *  the topmost visible pane so Alt+Arrows always has a target. */
function resolveKeyboardPane(panes: PaneState[]): PaneState | null {
  const vis = panes.filter((p) => p.visible);
  if (vis.length === 0) return null;
  const el = document.activeElement as HTMLElement | null;
  const id = el?.closest?.("section[data-pane-id]")?.getAttribute("data-pane-id");
  const hit = id ? vis.find((p) => p.id === id) : undefined;
  if (hit) return hit;
  return vis.reduce((a, b) => (b.z > a.z ? b : a));
}

/** Display name for a queue context. One lookup per context, silent on
 *  failure so a throttled name never breaks the queue itself. */
async function resolveQueueContextName(
  kind: QueueContext["kind"],
  id: string,
): Promise<string | null> {
  try {
    const raw =
      kind === "playlist"
        ? await api.playlist(id)
        : kind === "album"
          ? await api.album(id)
          : kind === "artist"
            ? await api.artist(id)
            : await api.show(id);
    const o = raw as Record<string, unknown> | null;
    return o && typeof o["name"] === "string" ? (o["name"] as string) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [awaitingAuth, setAwaitingAuth] = useState(false);
  const [snap, setSnap] = useState<PlayerSnapshot>(EMPTY_SNAP);
  const [now, setNow] = useState(Date.now());
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [queue, setQueue] = useState<{ current: QueueItem | null; upcoming: QueueItem[] }>({
    current: null,
    upcoming: [],
  });
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueContext, setQueueContext] = useState<QueueContext | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({ kind: "idle" });
  const [browse, setBrowse] = useState<BrowseState>(initialBrowse);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [layout, setLayout] = useState<PaneState[]>([]);
  const [preset, setPreset] = useState("full");
  // Bounded layout-undo stack (cap LAYOUT_UNDO_DEPTH). Snapshots are pushed
  // before geometry-changing ops; Ctrl+Z while editing pops the last.
  const [undoStack, setUndoStack] = useState<LayoutUndoEntry[]>([]);
  // Preset preview: selecting a preset in Settings only repaints. The
  // pre-preview arrangement waits in previewBaseRef until Apply persists it
  // or Revert (or closing Settings) restores it.
  const [previewing, setPreviewing] = useState(false);
  const [coachDismissed, setCoachDismissed] = useState(() => {
    try {
      return localStorage.getItem("snapify-coach-dismissed") === "1";
    } catch {
      return true;
    }
  });
  const [interactive, setInteractive] = useState(() => {
    try {
      return localStorage.getItem("snapify-interact") === "1";
    } catch {
      return false;
    }
  });
  const [editing, setEditing] = useState(() => {
    try {
      return localStorage.getItem("snapify-edit") === "1";
    } catch {
      return false;
    }
  });
  const [visible, setVisible] = useState(true);
  const [toasts, setToasts] = useState<Array<{ id: number; kind: "success" | "info" | "error"; text: string }>>([]);
  const [tier, setTier] = useState<"premium" | "free">("premium");
  const [sdkDeviceId, setSdkDeviceId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const settingsTimer = useRef(0);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [uiScale, setUiScale] = useState(1);
  const [clickToSeek, setClickToSeek] = useState(true);
  const [wordKaraoke, setWordKaraoke] = useState(() => {
    try {
      return localStorage.getItem("snapify-karaoke") !== "0";
    } catch {
      return true;
    }
  });
  const [transLang, setTransLang] = useState<TransLang>(() => {
    try {
      const v = localStorage.getItem("snapify-translang");
      return v === "es" || v === "fr" || v === "de" || v === "pt" || v === "ja"
        ? v
        : "off";
    } catch {
      return "off";
    }
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("snapify-theme") === "light" ||
        localStorage.getItem("nebula-theme") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });
  const [density, setDensity] = useState<Density>(() => {
    try {
      const v = localStorage.getItem("snapify-density");
      return v === "compact" || v === "spacious" ? v : "default";
    } catch {
      return "default";
    }
  });
  const [surface, setSurface] = useState<Surface>(() => {
    try {
      return localStorage.getItem("snapify-surface") === "glass" ? "glass" : "solid";
    } catch {
      return "solid";
    }
  });
  const [corners, setCorners] = useState<Corners>(() => {
    try {
      return localStorage.getItem("snapify-corners") === "sharp" ? "sharp" : "rounded";
    } catch {
      return "rounded";
    }
  });
  const [autostart, setAutostart] = useState(false);
  const [keybinds, setKeybinds] = useState<KeybindMap>({ ...DEFAULT_KEYBINDS });
  const keybindsRef = useRef<KeybindMap>({ ...DEFAULT_KEYBINDS });
  // Busy/conflicting global registrations from Rust startup, shown per-row
  // in Settings. Empty when every chord grabbed cleanly.
  const [keybindStartup, setKeybindStartup] = useState<string[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [update, setUpdate] = useState<UpdateStatus>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);
  // Synchronous re-entry guard: state updates do not propagate before the
  // next click, so rapid double-clicks would otherwise fire twice.
  const updateBusyRef = useRef(false);

  const trackIdRef = useRef<string | null>(null);
  const snapRef = useRef<PlayerSnapshot>(EMPTY_SNAP);
  const uiScaleRef = useRef(1);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    keybindsRef.current = keybinds;
  }, [keybinds]);
  useEffect(() => {
    uiScaleRef.current = uiScale;
  }, [uiScale]);

  useEffect(() => () => {
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
  }, []);

  // Opening cancels a pending close so a fast close-reopen keeps the modal.
  useEffect(() => {
    if (settingsOpen) {
      if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
      setSettingsClosing(false);
    }
  }, [settingsOpen]);

  const dragRef = useRef<{
    id: string;
    kind: "move" | Handle;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);
  const guidesTimer = useRef(0);
  // Keyboard-burst coalescing: the first Alt+Arrow snapshots for undo,
  // repeats within a second share that step so a held key stays one Ctrl+Z.
  const kbBurstRef = useRef(false);
  const kbBurstTimer = useRef(0);
  // Pre-mute level for the mute toggle; unmute restores it.
  const mutePrevRef = useRef<number | null>(null);
  // Resize-handle keyboard engagement: one undo snapshot per focus visit,
  // like one snapshot per pointer grab.
  const handleUndoElRef = useRef<unknown>(null);

  const persist = useCallback((panes: PaneState[], name: string) => {
    saveLayout({ version: 3, preset: name, panes });
  }, []);

  // Synchronous mirrors so geometry callbacks and the global key listener
  // read the live arrangement without re-subscribing. Refs update in the
  // same effects block as their state below.
  const layoutRef = useRef<PaneState[]>([]);
  const presetRef = useRef("full");
  const undoRef = useRef<LayoutUndoEntry[]>([]);
  const previewBaseRef = useRef<{ panes: PaneState[]; preset: string } | null>(null);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    presetRef.current = preset;
  }, [preset]);
  useEffect(() => {
    undoRef.current = undoStack;
  }, [undoStack]);

  /** Snapshot the current arrangement onto the bounded undo stack. Call
   *  before a geometry-changing op, never after. */
  const pushUndoSnapshot = useCallback(() => {
    const snap: LayoutUndoEntry = {
      panes: clonePanes(layoutRef.current),
      preset: presetRef.current,
    };
    setUndoStack((prev) => pushLayoutUndo(prev, snap));
  }, []);

  /** Restore the last undo entry and persist it. No-op on an empty stack. */
  const undoLayout = useCallback(() => {
    const stack = undoRef.current;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    const rest = stack.slice(0, -1);
    undoRef.current = rest;
    setUndoStack(rest);
    const panes = clonePanes(last.panes);
    setLayout(panes);
    setPreset(last.preset);
    persist(panes, last.preset);
    previewBaseRef.current = null;
    setPreviewing(false);
  }, [persist]);
  const undoLayoutRef = useRef(() => {});
  useEffect(() => {
    undoLayoutRef.current = undoLayout;
  }, [undoLayout]);

  /** Show snap guides briefly for keyboard geometry ops (no pointer-up). */
  const flashGuides = useCallback((v: number[], h: number[]) => {
    setGuides({ v, h });
    if (guidesTimer.current) window.clearTimeout(guidesTimer.current);
    guidesTimer.current = window.setTimeout(() => setGuides({ v: [], h: [] }), 600);
  }, []);

  /** Snapshot once per keyboard burst; repeats within a second coalesce. */
  const pushUndoBurst = useCallback(() => {
    if (!kbBurstRef.current) {
      kbBurstRef.current = true;
      pushUndoSnapshot();
    }
    if (kbBurstTimer.current) window.clearTimeout(kbBurstTimer.current);
    kbBurstTimer.current = window.setTimeout(() => {
      kbBurstRef.current = false;
    }, 1000);
  }, [pushUndoSnapshot]);

  /** Keyboard move/resize of the focused pane. Same snap, clamp, persist,
   *  and undo path as a pointer drag, anchored top-left for resize. */
  const keyboardGeometry = useCallback(
    (kind: "move" | "resize", key: string) => {
      const panes = layoutRef.current.map((x) => ({ ...x }));
      const m = resolveKeyboardPane(panes);
      if (!m) return;
      const k = uiScaleRef.current || 1;
      const areaW = window.innerWidth / k;
      const areaH = window.innerHeight / k;
      const min = getPaneMin(m.type);
      pushUndoBurst();
      if (kind === "move") {
        const dx = key === "ArrowLeft" ? -KB_STEP : key === "ArrowRight" ? KB_STEP : 0;
        const dy = key === "ArrowUp" ? -KB_STEP : key === "ArrowDown" ? KB_STEP : 0;
        const c = clampPaneToArea(
          {
            ...m,
            x: Math.round(m.x + dx),
            y: Math.round(m.y + dy),
          },
          areaW,
          areaH,
        );
        m.x = c.x;
        m.y = c.y;
        m.w = c.w;
        m.h = c.h;
        const s = snapMove(m, panes, areaW, areaH);
        m.x = s.x;
        m.y = s.y;
        // Snap only catches within its threshold; pin fully inside like a drag.
        m.x = Math.min(m.x, Math.max(0, Math.round(areaW - m.w)));
        m.y = Math.min(m.y, Math.max(0, Math.round(areaH - m.h)));
        flashGuides(s.v, s.h);
      } else {
        if (key === "ArrowRight") m.w += KB_STEP;
        else if (key === "ArrowLeft") m.w -= KB_STEP;
        else if (key === "ArrowDown") m.h += KB_STEP;
        else if (key === "ArrowUp") m.h -= KB_STEP;
        const c = clampPaneToArea(
          { ...m, w: Math.max(min.w, Math.round(m.w)), h: Math.max(min.h, Math.round(m.h)) },
          areaW,
          areaH,
        );
        m.x = c.x;
        m.y = c.y;
        m.w = c.w;
        m.h = c.h;
        const s = snapSize(
          m,
          panes,
          areaW,
          areaH,
          { east: true, south: true, west: false, north: false },
        );
        m.x = Math.round(s.x);
        m.y = Math.round(s.y);
        m.w = Math.round(s.w);
        m.h = Math.round(s.h);
        flashGuides(s.gv, s.gh);
      }
      setLayout(panes);
      persist(panes, presetRef.current);
    },
    [flashGuides, persist, pushUndoBurst],
  );
  const keyboardGeometryRef = useRef<(kind: "move" | "resize", key: string) => void>(() => {});
  useEffect(() => {
    keyboardGeometryRef.current = keyboardGeometry;
  }, [keyboardGeometry]);

  const dismissCoach = useCallback(() => {
    setCoachDismissed(true);
    try {
      localStorage.setItem("snapify-coach-dismissed", "1");
    } catch {
      // Private mode. Dismissal lasts the session.
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const pushToast = useCallback((kind: "success" | "info" | "error", text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 6500);
  }, []);

  const closeSettings = useCallback(() => {
    // Closing without Apply abandons the preview: the preview never
    // persisted, so restoring the base snapshot is a pure state switch.
    const base = previewBaseRef.current;
    previewBaseRef.current = null;
    if (base) {
      setLayout(clonePanes(base.panes));
      setPreset(base.preset);
      setPreviewing(false);
    }
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
    setSettingsOpen(false);
    setSettingsClosing(false);
  }, []);

  const flashErr = useCallback(
    (m: string) => {
      setErr(m);
      pushToast("error", m);
      window.setTimeout(() => setErr((e) => (e === m ? null : e)), 6000);
    },
    [pushToast],
  );

  // Throttled UX: stale content stays on screen; the live region hears one
  // degrade note and one recovery note per episode, never per retry.
  // All throttle routing goes through the typed helper in lib/spotify
  // (parsed Retry-After + quota vs rate kind); no local string matching.
  const degradedRef = useRef(false);
  // Render mirror of the throttle episode so panes can pin degraded UI
  // (queue keep-10 fallback, capped notice) until recovery.
  const [degradedUi, setDegradedUi] = useState(false);
  const isThrottledMsg = (m: unknown) => toThrottleError(m) !== null;
  const noteDegraded = useCallback(
    (m: string) => {
      if (degradedRef.current) return;
      degradedRef.current = true;
      setDegradedUi(true);
      const quota = toThrottleError(m)?.kind === "quota";
      pushToast(
        "info",
        quota
          ? "Spotify quota hit — cooling down. Showing last updated content."
          : "Spotify throttled — showing last updated content.",
      );
    },
    [pushToast],
  );
  const noteRecovered = useCallback(() => {
    if (!degradedRef.current) return;
    degradedRef.current = false;
    setDegradedUi(false);
    pushToast("info", "Spotify recovered — content is fresh.");
  }, [pushToast]);
  const flashErrThrottledAware = useCallback(
    (m: string) => {
      if (isThrottledMsg(m)) noteDegraded(m);
      else flashErr(m);
    },
    [flashErr, noteDegraded],
  );

  const refreshAuth = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setLoggedIn(s.logged_in);
      setAwaitingAuth(s.awaiting_callback);
      return s.logged_in;
    } catch {
      return false;
    }
  }, []);

  const fetchPlayer = useCallback(async () => {
    const seq = snapSeq.current;
    try {
      const raw = await invoke<unknown>("get_player");
      if (seq !== snapSeq.current) return true;
      setSnap(parsePlayer(raw));
      noteRecovered();
      return true;
    } catch (e) {
      // A rejected session surfaces here first: drop the gate open.
      const m = e instanceof Error ? e.message : String(e);
      if (/not logged in|session expired|invalid_grant|refresh failed/i.test(m)) {
        setLoggedIn(false);
      } else if (isThrottledMsg(m)) {
        noteDegraded(m);
      }
      return false;
    }
  }, [noteDegraded, noteRecovered]);

  const fetchQueue = useCallback(async () => {
    setQueueLoading(true);
    const seq = ++queueContextSeq.current;
    try {
      const q = await api.queue();
      // Degraded fallback: while throttled, pin to the first 10 instead of
      // swapping in a long list the endpoint may have truncated mid-page.
      const upcoming = degradedRef.current ? q.upcoming.slice(0, 10) : q.upcoming;
      setQueue({ current: q.current, upcoming });
      const c = q.context;
      if (!c) {
        queueContextCache.current = null;
        if (seq === queueContextSeq.current) setQueueContext(null);
        return;
      }
      const hit = queueContextCache.current;
      if (hit && hit.uri === c.uri) {
        if (seq === queueContextSeq.current) setQueueContext({ ...c, name: hit.name });
        return;
      }
      if (seq === queueContextSeq.current) setQueueContext({ ...c, name: null });
      const name = await resolveQueueContextName(c.kind, c.id);
      if (seq !== queueContextSeq.current) return;
      if (name) {
        queueContextCache.current = { uri: c.uri, name };
        setQueueContext({ ...c, name });
      } else {
        setQueueContext({ ...c, name: null });
      }
    } catch (e) {
      // A throttled queue read degrades instead of dropping: one note per
      // episode, and the visible list pins to the first 10.
      const m = e instanceof Error ? e.message : String(e);
      if (toThrottleError(m)) {
        noteDegraded(m);
        setQueue((prev) => ({ current: prev.current, upcoming: prev.upcoming.slice(0, 10) }));
      }
      // Otherwise leave the previous queue in place.
    } finally {
      setQueueLoading(false);
    }
  }, [noteDegraded]);

  const fetchDevices = useCallback(async () => {
    try {
      setDevices(await api.devices());
    } catch {
      // Leave previous list in place.
    }
  }, []);

  const fetchLyrics = useCallback(
    async (trackId: string) => {
      const t = snap.track;
      if (!t || t.id !== trackId) return;
      setLyrics({ kind: "loading" });
      try {
        const firstArtist = t.artists.split(",")[0]?.trim() || t.artists;
        const r = await api.lyrics({
          track_id: t.id,
          track_name: t.name,
          artist_name: firstArtist,
          album_name: t.album,
          duration_ms: t.durationMs,
        });
        setLyrics({
          kind: "ready",
          data: {
            trackId: r.trackId,
            synced: r.synced,
            instrumental: r.instrumental,
            cues: r.cues,
            plain: r.plain,
            cached: r.cached,
          },
        });
      } catch (e) {
        setLyrics({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [snap.track],
  );

  // Boot: layout, auth, listeners.
  useEffect(() => {
    const w = window.innerWidth || 1280;
    const hgt = window.innerHeight || 800;
    const saved = loadLayout();
    if (saved) {
      const clamped = clampLayoutToArea(saved, w, hgt, uiScaleRef.current);
      setLayout(clamped.panes);
      setPreset(saved.preset);
      if (clamped !== saved) persist(clamped.panes, saved.preset);
    } else {
      const fresh = defaultLayoutFor(w, hgt);
      setLayout(fresh.panes);
      setPreset(fresh.preset);
      persist(fresh.panes, fresh.preset);
    }
    invoke<boolean>("autostart_state").then(setAutostart).catch(() => {});
    invoke<unknown>("get_keybinds")
      .then((raw) => {
        const next = coerceKeybinds(raw);
        keybindsRef.current = next;
        setKeybinds(next);
      })
      .catch(() => {});
    // Busy/conflicting globals from Rust startup (mock returns null: ignore).
    invoke<unknown>("keybind_startup_errors")
      .then((v) => {
        if (Array.isArray(v)) setKeybindStartup(v.map(String));
      })
      .catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
    void refreshAuth().then((ok) => {
      if (ok) {
        void fetchPlayer().then((alive) => {
          if (!alive) return;
          void fetchDevices();
          void fetchQueue();
        });
      }
    });
    const off1 = listen("auth-changed", () => {
      void refreshAuth().then((ok) => {
        if (ok) {
          void fetchPlayer().then((alive) => {
            if (!alive) return;
            void fetchDevices();
            void fetchQueue();
          });
        } else {
          setSnap(EMPTY_SNAP);
          setLyrics({ kind: "idle" });
        }
      });
    });
    const off2 = listen("auth-error", (e) => flashErr(String(e.payload)));
    return () => {
      void off1.then((f) => f());
      void off2.then((f) => f());
    };
  }, [refreshAuth, fetchPlayer, fetchDevices, fetchQueue, flashErr, persist]);

  // Player poll while logged in: 5 s playing, 20 s paused, 30 s with no
  // device. Skipped while hidden; visibilitychange refetches on return.
  // Progress interpolates locally between polls from snap.progressMs.
  const snapSeq = useRef(0);
  const transportRef = useRef(false);
  const pendingSeekRef = useRef<(() => Promise<unknown>) | null>(null);
  // PR3 pending write queue: throttled writes park here, coalesced by key,
  // and flush once on cooldown end. Count drives the queued chip.
  const pendingQueueRef = useRef<PendingQueue | null>(null);
  if (!pendingQueueRef.current) pendingQueueRef.current = new PendingQueue();
  const [pendingCount, setPendingCount] = useState(0);
  const pendingFlushTimer = useRef(0);
  const queueVisibleRef = useRef(false);
  const queueContextSeq = useRef(0);
  const queueContextCache = useRef<{ uri: string; name: string } | null>(null);
  useEffect(() => {
    if (!loggedIn) return;
    const playing = snap.isPlaying && !snap.empty;
    const hasDevice = !!snap.deviceId;
    const delay = !hasDevice && snap.empty ? 30000 : playing ? 5000 : 20000;
    const t = window.setInterval(() => {
      if (!document.hidden) void fetchPlayer();
    }, delay);
    const onVis = () => {
      if (!document.hidden) void fetchPlayer();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loggedIn, snap.isPlaying, snap.empty, snap.deviceId, fetchPlayer]);

  // Interpolation tick for progress and lyric sync. Runs only while playing
  // and visible; paused/hidden costs nothing.
  useEffect(() => {
    if (!loggedIn || !snap.isPlaying) return;
    const t = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 500);
    return () => window.clearInterval(t);
  }, [loggedIn, snap.isPlaying]);

  useEffect(() => {
    queueVisibleRef.current = layout.some((p) => p.type === "queue" && p.visible);
  }, [layout]);

  // Track change drives lyrics always, queue only when the queue pane is
  // live. Lyrics fetch is non-Spotify and stays as-is.
  useEffect(() => {
    const id = snap.track?.id ?? null;
    if (id !== trackIdRef.current) {
      trackIdRef.current = id;
      if (id) {
        void fetchLyrics(id);
        if (queueVisibleRef.current) void fetchQueue();
      } else {
        setLyrics({ kind: "idle" });
      }
    }
  }, [snap.track, fetchLyrics, fetchQueue]);

  // Passive display mode stays visible on top but passes every mouse event
  // to the game or window below. Interactive mode takes input only on real
  // UI (panes, dock, dialog, toasts): the Rust poller keeps every other
  // pixel click-through by comparing the global cursor against reported
  // rects, so the game keeps focus and keeps moving on empty space.
  // Visibility (true hide/show) is a separate global action that hides the
  // window entirely.
  useEffect(() => {
    const passive = loggedIn && !interactive && !editing && !settingsOpen;
    void reportOverlayMode(!passive);
    if (passive) {
      void getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
    }
    try {
      localStorage.setItem("snapify-interact", interactive ? "1" : "0");
      localStorage.setItem("snapify-edit", editing ? "1" : "0");
    } catch {
      // Private mode. Prefs last the session.
    }
  }, [loggedIn, interactive, settingsOpen, editing]);

  // Hit regions follow the visible UI so empty stage pixels stay
  // click-through even while interactive. Debounced: pane drags update
  // layout at pointer rate, the Rust poller samples at 20 Hz anyway.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void reportOverlayRegions();
    }, 80);
    return () => window.clearTimeout(t);
  }, [layout, preset, interactive, editing, settingsOpen, toasts, loggedIn, uiScale, visible]);

  useEffect(() => {
    const onResize = () => {
      void reportOverlayRegions();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // In-app shortcuts. Global chords (play/pause, next, mute, like, seek,
  // interact, edit, visibility) arrive as Tauri events even while focused, so
  // they are handled only there to avoid double-firing. This listener keeps
  // Esc, Alt+Arrow keyboard move/resize, plus the focused-only chords,
  // matched against the stored keybinds so remaps keep working. Subscribed
  // once; state flows through refs so layout changes and drags never
  // re-subscribe.
  const settingsOpenRef = useRef(settingsOpen);
  const editingRef = useRef(editing);
  const interactiveRef = useRef(interactive);
  const cyclePresetRef = useRef<() => void>(() => {});
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bare Esc exits edit first, then settings: one exit rule.
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (settingsOpenRef.current) closeSettings();
        else if (editingRef.current) setEditing(false);
        else if (interactiveRef.current) setInteractive(false);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      // Keyboard move/resize: Alt+Arrows nudges the focused pane (snap,
      // guides, persist, undo — same path as a drag); Alt+Shift+Arrows
      // resizes it. Needs an unlocked overlay (edit or interact); a
      // pass-through window never has focus, so game keys are untouched.
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        if (settingsOpenRef.current) return;
        if (!editingRef.current && !interactiveRef.current) return;
        e.preventDefault();
        keyboardGeometryRef.current(e.shiftKey ? "resize" : "move", e.key);
        return;
      }
      // Layout undo: Ctrl+Z (or Cmd+Z) while editing restores the last
      // geometry snapshot. Guarded to edit mode so game-time chords pass.
      if (
        editingRef.current &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        undoLayoutRef.current();
        return;
      }
      const kb = keybindsRef.current;
      if (acceleratorMatchesEvent(kb.cyclePreset, e)) {
        e.preventDefault();
        cyclePresetRef.current();
        return;
      }
      if (acceleratorMatchesEvent(kb.legacyInteract, e)) {
        e.preventDefault();
        setInteractive((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serialized transport: one in-flight slot. A second next/prev while one
  // is pending is ignored; a seek queues the latest position only. The
  // trailing fetchPlayer was removed: the next scheduled poll confirms.
  // PR3: throttled writes park in the pending queue (coalesced by key) and
  // flush once on cooldown end. The flush runner lives after `run` and is
  // reached indirectly through this ref to avoid a callback cycle.
  const flushPendingRef = useRef<() => void>(() => {});
  const schedulePendingFlush = useCallback((retryAfterSec: number | null) => {
    if (pendingFlushTimer.current) window.clearTimeout(pendingFlushTimer.current);
    pendingFlushTimer.current = window.setTimeout(() => {
      pendingFlushTimer.current = 0;
      flushPendingRef.current();
    }, flushDelayMs(retryAfterSec));
  }, []);
  useEffect(
    () => () => {
      if (pendingFlushTimer.current) window.clearTimeout(pendingFlushTimer.current);
    },
    [],
  );
  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      opts?: {
        after?: () => void;
        transport?: "play" | "pause" | "next" | "prev" | "seek" | "other";
        optimistic?: () => void;
        needsRefresh?: boolean;
        queueKey?: string;
        queueLabel?: string;
      },
    ) => {
      const kind = opts?.transport ?? "other";
      if (kind === "seek" && transportRef.current) {
        pendingSeekRef.current = fn;
        return;
      }
      if (kind !== "seek" && kind !== "other" && transportRef.current) return;
      const isTransport = kind !== "other";
      if (isTransport) {
        transportRef.current = true;
        snapSeq.current += 1;
      }
      setBusy(true);
      opts?.optimistic?.();
      try {
        const res = await fn();
        opts?.after?.();
        if (opts?.needsRefresh) await fetchPlayer();
        if ((kind === "next" || kind === "prev") && !snap.deviceId && !sdkDeviceId) {
          const empty =
            !!res && typeof res === "object" && (res as Record<string, unknown>)["empty"] === true;
          if (empty) {
            void fetchDevices();
            pushToast("info", "No active Spotify device — choose one in the player.");
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const throttle = toThrottleError(msg);
        if (throttle) {
          // Throttled writes park instead of dropping: coalesced by key so
          // a double-pressed play flushes once after the cooldown.
          const q = pendingQueueRef.current;
          if (q) {
            const key = opts?.queueKey ?? kind;
            const label = opts?.queueLabel ?? key;
            const retryFn = fn;
            const retryAfter = opts?.after;
            const retryTransport = opts?.transport;
            const retryRefresh = opts?.needsRefresh;
            const retryKey = opts?.queueKey;
            const retryLabel = opts?.queueLabel;
            q.enqueue(
              key,
              () =>
                run(retryFn, {
                  after: retryAfter,
                  transport: retryTransport,
                  needsRefresh: retryRefresh,
                  queueKey: retryKey,
                  queueLabel: retryLabel,
                }),
              label,
            );
            setPendingCount(q.size());
            noteDegraded(msg);
            schedulePendingFlush(throttle.retryAfterSec);
          } else {
            flashErrThrottledAware(msg);
          }
        } else {
          flashErrThrottledAware(msg);
        }
      } finally {
        if (isTransport) transportRef.current = false;
        setBusy(false);
        if (!transportRef.current && pendingSeekRef.current) {
          const queued = pendingSeekRef.current;
          pendingSeekRef.current = null;
          void run(queued, { transport: "seek", queueKey: "seek", queueLabel: "seek" });
        }
      }
    },
    [
      fetchPlayer,
      flashErrThrottledAware,
      noteDegraded,
      schedulePendingFlush,
      snap.deviceId,
      sdkDeviceId,
      fetchDevices,
      pushToast,
    ],
  );

  // Flush parked writes once on cooldown end. The queue snapshot clears
  // before firing, so a timer re-fire cannot double-fire; a still-throttled
  // item re-parks through `run` for the next cooldown.
  const flushPending = useCallback(async () => {
    const q = pendingQueueRef.current;
    if (!q || q.size() === 0) {
      setPendingCount(0);
      return;
    }
    const results = await q.flush((entry) => entry.run());
    setPendingCount(q.size());
    if (results.some((r) => r.ok)) noteRecovered();
  }, [noteRecovered]);
  useEffect(() => {
    flushPendingRef.current = flushPending;
  }, [flushPending]);

  // Hoisted pane callbacks: stable across the 2Hz progress tick so memoized
  // panes skip re-renders. Deps stay on primitives, never the snap object.
  const playCb = useCallback(
    () =>
      void (async () => {
        const seed = (snapRef.current.volume ?? 50) / 100;
        const target = snap.deviceId ?? sdkDeviceId ?? (await ensurePlayer(seed));
        if (target) setSdkDeviceId((cur) => cur ?? target);
        setSdkVolume(seed);
        await run(() => api.play(target), {
          transport: "play",
          queueKey: "play",
          queueLabel: "Play",
          optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: true })),
        });
      })(),
    [snap.deviceId, sdkDeviceId, run],
  );
  const pauseCb = useCallback(
    () =>
      void run(() => api.pause(snap.deviceId ?? sdkDeviceId), {
        transport: "pause",
        queueKey: "pause",
        queueLabel: "Pause",
        optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: false })),
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const nextCb = useCallback(
    () =>
      void run(() => api.next(snap.deviceId ?? sdkDeviceId), {
        transport: "next",
        queueKey: "next",
        queueLabel: "Next",
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const prevCb = useCallback(
    () =>
      void run(() => api.prev(snap.deviceId ?? sdkDeviceId), {
        transport: "prev",
        queueKey: "prev",
        queueLabel: "Previous",
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const seekCb = useCallback(
    (ms: number) =>
      void run(() => api.seek(ms, snap.deviceId ?? sdkDeviceId), {
        transport: "seek",
        queueKey: "seek",
        queueLabel: "Seek",
        optimistic: () => setSnap((prev) => ({ ...prev, progressMs: ms, fetchedAt: Date.now() })),
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  // Remappable ±10 s seek for the global chords. Interpolates the base like
  // the progress tick so rapid presses walk forward instead of re-seeking
  // the last polled position.
  const seekByCb = useCallback(
    (deltaMs: number) => {
      const s = snapRef.current;
      if (!s.track) return;
      const base = s.isPlaying ? s.progressMs + (Date.now() - s.fetchedAt) : s.progressMs;
      const far = Math.round(base + deltaMs);
      const next =
        s.track.durationMs > 0 ? Math.min(Math.max(0, far), s.track.durationMs) : Math.max(0, far);
      seekCb(next);
    },
    [seekCb],
  );
  // Remappable like toggle. App-level library call: the PlayerPane heart
  // owns its own local state per track, so this path toasts instead.
  const toggleLikeCb = useCallback(async () => {
    const track = snapRef.current.track;
    if (!track) return;
    const shelf = track.uri.startsWith("spotify:episode:") ? "New Episodes" : "Liked Songs";
    try {
      const [saved] = await api.libraryContains([track.uri]);
      if (saved) {
        await api.libraryRemove([track.uri]);
        pushToast("success", `Removed from ${shelf}`);
      } else {
        await api.librarySave([track.uri]);
        pushToast("success", `Added to ${shelf}`);
      }
    } catch (e) {
      flashErrThrottledAware(e instanceof Error ? e.message : String(e));
    }
  }, [flashErrThrottledAware, pushToast]);
  const volumeCb = useCallback(
    (v: number) => {
      setSnap((s) => ({ ...s, volume: v }));
      setSdkVolume(v / 100);
      void run(() => api.volume(v, snap.deviceId ?? sdkDeviceId), {
        queueKey: "volume",
        queueLabel: "Volume",
      });
    },
    [snap.deviceId, sdkDeviceId, run],
  );
  // Remappable mute toggle: remembers the pre-mute level so unmute restores
  // it instead of guessing.
  const toggleMuteCb = useCallback(() => {
    const cur = snapRef.current.volume ?? 50;
    if (cur > 0) {
      mutePrevRef.current = cur;
      volumeCb(0);
    } else {
      volumeCb(mutePrevRef.current ?? 50);
    }
  }, [volumeCb]);
  const shuffleCb = useCallback(
    () =>
      void run(() => api.shuffle(!snap.shuffle, snap.deviceId ?? sdkDeviceId), {
        queueKey: "shuffle",
        queueLabel: "Shuffle",
      }),
    [snap.shuffle, snap.deviceId, sdkDeviceId, run],
  );
  const repeatNextCb = useMemo(
    () => (snap.repeat === "off" ? "context" : snap.repeat === "context" ? "track" : "off"),
    [snap.repeat],
  );
  const repeatCb = useCallback(
    () =>
      void run(() => api.repeat(repeatNextCb, snap.deviceId ?? sdkDeviceId), {
        queueKey: "repeat",
        queueLabel: "Repeat",
      }),
    [repeatNextCb, snap.deviceId, sdkDeviceId, run],
  );
  const transferCb = useCallback(
    (id: string) =>
      void run(() => api.transfer(id, false), {
        queueKey: `transfer:${id}`,
        queueLabel: "Transfer",
        after: () => {
          void fetchDevices();
          setSdkVolume((snapRef.current.volume ?? 50) / 100);
        },
        needsRefresh: true,
      }),
    [run, fetchDevices],
  );
  // Explicit "Play here": build the headless SDK player inside this user
  // gesture (autoplay policy), then move sound onto it, keeping the current
  // play state. Device priority stays SDK, then active device, then none.
  const playHereCb = useCallback(
    () =>
      void (async () => {
        const seed = (snapRef.current.volume ?? 50) / 100;
        const id = sdkDeviceId ?? (await ensurePlayer(seed));
        if (!id) {
          pushToast("error", "Built-in playback unavailable here — keeping your current device.");
          return;
        }
        setSdkDeviceId((cur) => cur ?? id);
        setSdkVolume(seed);
        writeDeviceChoice({ kind: "sdk" });
        await run(() => api.transfer(id, snapRef.current.isPlaying), {
          queueKey: "transfer:sdk",
          queueLabel: "Transfer",
          after: () => {
            void fetchDevices();
          },
          needsRefresh: true,
        });
      })(),
    [sdkDeviceId, run, fetchDevices, pushToast],
  );
  // Queue row play: one row plays now on the priority device.
  const queuePlayUriCb = useCallback(
    (uri: string) =>
      void run(() => api.playUris([uri], snap.deviceId ?? sdkDeviceId), {
        queueKey: `playQueue:${uri}`,
        queueLabel: "Play",
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const lyricsRetryCb = useCallback(
    () => trackIdRef.current && void fetchLyrics(trackIdRef.current),
    [fetchLyrics],
  );
  const browsePlayContextCb = useCallback(
    (uri: string) =>
      void run(() => api.playContext(uri, snap.deviceId ?? sdkDeviceId), {
        queueKey: `playContext:${uri}`,
        queueLabel: "Play",
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const browsePlayUrisCb = useCallback(
    (uris: string[]) =>
      void run(() => api.playUris(uris, snap.deviceId ?? sdkDeviceId), {
        queueKey: `playUris:${uris.join(",")}`,
        queueLabel: "Play",
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const browseQueueAddCb = useCallback(
    (uri: string) =>
      void run(() => api.queueAdd(uri, snap.deviceId ?? sdkDeviceId), {
        queueKey: `queueAdd:${uri}`,
        queueLabel: "Queue",
        after: () => {
          if (queueVisibleRef.current) void fetchQueue();
        },
      }),
    [snap.deviceId, sdkDeviceId, run, fetchQueue],
  );
  const browseErrorCb = useCallback((m: string) => flashErrThrottledAware(m), [flashErrThrottledAware]);

  const login = useCallback(async () => {
    try {
      const url = await api.startLogin();
      setAwaitingAuth(true);
      await openUrl(url);
    } catch (e) {
      flashErr(e instanceof Error ? e.message : String(e));
    }
  }, [flashErr]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (e) {
      flashErr(e instanceof Error ? e.message : String(e));
    }
  }, [flashErr]);

  const cyclePreset = useCallback(() => {
    // Explicit user action: snapshot for undo, persist, leave preview mode.
    pushUndoSnapshot();
    previewBaseRef.current = null;
    setPreviewing(false);
    setPreset((cur) => {
      const i = PRESET_ORDER.indexOf(cur);
      const next = PRESET_ORDER[(i + 1 + PRESET_ORDER.length) % PRESET_ORDER.length];
      const nl = PRESETS[next]();
      setLayout(clampLayoutToArea(nl, window.innerWidth, window.innerHeight, uiScaleRef.current).panes);
      persist(nl.panes, next);
      return next;
    });
  }, [persist, pushUndoSnapshot]);
  useEffect(() => {
    cyclePresetRef.current = cyclePreset;
  }, [cyclePreset]);

  // Preset preview without persist: selecting a preset repaints the stage
  // from the preset factory but writes nothing to snapify-layout-v3. The
  // first preview snapshots the live arrangement; switching between presets
  // keeps previewing from that same base until Apply or Revert.
  const previewPreset = useCallback((name: string) => {
    if (!PRESETS[name]) return;
    if (!previewBaseRef.current) {
      previewBaseRef.current = {
        panes: clonePanes(layoutRef.current),
        preset: presetRef.current,
      };
    }
    const nl = PRESETS[name]();
    const panes = clampLayoutToArea(
      nl,
      window.innerWidth,
      window.innerHeight,
      uiScaleRef.current,
    ).panes;
    setLayout(panes);
    setPreset(name);
    setPreviewing(true);
  }, []);

  // Explicit Apply: the pre-preview base becomes the undo step (one Ctrl+Z
  // returns to the custom arrangement), then the preview persists.
  const confirmPresetPreview = useCallback(() => {
    const base = previewBaseRef.current;
    previewBaseRef.current = null;
    setPreviewing(false);
    if (base) setUndoStack((prev) => pushLayoutUndo(prev, base));
    setLayout((l) => {
      persist(l, presetRef.current);
      return l;
    });
  }, [persist]);

  // Explicit Revert: drop the preview, restore the untouched base.
  const cancelPresetPreview = useCallback(() => {
    const base = previewBaseRef.current;
    previewBaseRef.current = null;
    setPreviewing(false);
    if (!base) return;
    setLayout(clonePanes(base.panes));
    setPreset(base.preset);
  }, []);

  // Opacity slider fires per tick: paint immediately, persist debounced.
  const opacityTimer = useRef(0);
  useEffect(
    () => () => {
      if (opacityTimer.current) window.clearTimeout(opacityTimer.current);
    },
    [],
  );
  const setPaneOpacity = useCallback(
    (id: string, opacity: number) => {
      setLayout((l) => l.map((x) => (x.id === id ? { ...x, opacity } : x)));
      if (opacityTimer.current) window.clearTimeout(opacityTimer.current);
      opacityTimer.current = window.setTimeout(() => {
        setLayout((l) => {
          persist(l, preset);
          return l;
        });
      }, 300);
    },
    [persist, preset],
  );

  const togglePaneType = useCallback(
    (type: PaneType) => {
      // Geometry op: snapshot first. The helper flips one pane's visible
      // flag (or appends it) and copies every other pane untouched, so
      // toggling off and on restores the exact geometry.
      pushUndoSnapshot();
      previewBaseRef.current = null;
      setPreviewing(false);
      setLayout((l) => {
        const panes = togglePaneVisibility(l, type);
        persist(panes, "custom");
        return panes;
      });
      setPreset("custom");
    },
    [persist, pushUndoSnapshot],
  );

  // Queue "Next from" navigation: reveal the browse pane when hidden, then
  // push the playing context so its detail loads through the normal path.
  const openQueueContext = useCallback(
    (entry: BrowseEntry) => {
      if (!layout.some((p) => p.type === "browse" && p.visible)) togglePaneType("browse");
      setBrowse((s) => ({ ...s, stack: [...s.stack, entry] }));
    },
    [layout, togglePaneType],
  );

  // Queue empty-state "Browse" button: non-destructive reveal of the browse
  // pane. The old path applied the full preset, wiping custom geometry;
  // this only flips/adds browse and leaves every other pane alone.
  const queueBrowseCb = useCallback(() => {
    if (layoutRef.current.some((p) => p.type === "browse" && p.visible)) return;
    pushUndoSnapshot();
    previewBaseRef.current = null;
    setPreviewing(false);
    setLayout((l) => {
      const panes = revealPaneType(l, "browse");
      if (panes === l) return l;
      persist(panes, "custom");
      return panes;
    });
    setPreset("custom");
  }, [persist, pushUndoSnapshot]);

  const changeKeybind = useCallback(
    async (action: KeybindAction, accelerator: string) => {
      try {
        const next = await invoke<Record<KeybindAction, string>>("set_keybind", {
          action,
          accelerator,
        });
        const coerced = coerceKeybinds(next);
        keybindsRef.current = coerced;
        setKeybinds(coerced);
      } catch (e) {
        flashErr(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [flashErr],
  );

  const resetKeybinds = useCallback(async () => {
    try {
      const next = await invoke<Record<KeybindAction, string>>("reset_keybinds");
      const coerced = coerceKeybinds(next);
      keybindsRef.current = coerced;
      setKeybinds(coerced);
    } catch (e) {
      flashErr(e instanceof Error ? e.message : String(e));
      try {
        const actual = await invoke<unknown>("get_keybinds");
        const coerced = coerceKeybinds(actual);
        keybindsRef.current = coerced;
        setKeybinds(coerced);
      } catch {
        // Keep previous state when the re-read also fails.
      }
    }
  }, [flashErr]);

  const checkUpdates = useCallback(async () => {
    if (updateBusyRef.current) return;
    updateBusyRef.current = true;
    setUpdate({ kind: "checking" });
    try {
      const found = await check({ timeout: 20000 });
      if (!found) {
        updateRef.current = null;
        setUpdate({ kind: "current" });
        return;
      }
      updateRef.current = found;
      setUpdate({ kind: "available", version: found.version, body: found.body ?? null });
    } catch (e) {
      updateRef.current = null;
      setUpdate({ kind: "error", message: updateError(e) });
    } finally {
      updateBusyRef.current = false;
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (updateBusyRef.current) return;
    const pending = updateRef.current;
    if (!pending) return;
    updateBusyRef.current = true;
    const version = pending.version;
    setUpdate({ kind: "downloading", version, progress: -1 });
    try {
      let received = 0;
      let total = 0;
      const onEvent = (event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        setUpdate({
          kind: "downloading",
          version,
          progress: total > 0 ? Math.min(1, received / total) : -1,
        });
      };
      await pending.downloadAndInstall(onEvent, { timeout: 300000 });
      updateRef.current = null;
      setUpdate({ kind: "ready", version });
    } catch (e) {
      updateRef.current = null;
      setUpdate({ kind: "error", message: updateError(e) });
    } finally {
      updateBusyRef.current = false;
    }
  }, []);

  const restartUpdate = useCallback(() => {
    void relaunch().catch((e) => {
      flashErr(e instanceof Error ? e.message : String(e));
    });
  }, [flashErr]);

  // Tray menu + global shortcuts arrive as events from Rust.
  useEffect(() => {
    const offPlay = listen("shortcut-playpause", () => {
      const s = snapRef.current;
      if (!s.track) return;
      if (s.isPlaying) {
        void run(() => api.pause(s.deviceId), {
          transport: "pause",
          optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: false })),
        });
      } else {
        void run(() => api.play(s.deviceId), {
          transport: "play",
          optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: true })),
        });
      }
    });
    const offNext = listen("shortcut-next", () => {
      const s = snapRef.current;
      if (!s.track) return;
      void run(() => api.next(s.deviceId), { transport: "next" });
    });
    const offMute = listen("shortcut-mute", () => toggleMuteCb());
    const offLike = listen("shortcut-like", () => {
      void toggleLikeCb();
    });
    const offSeekBack = listen("shortcut-seek-back", () => seekByCb(-10000));
    const offSeekFwd = listen("shortcut-seek-forward", () => seekByCb(10000));
    const offToggle = listen("overlay-toggle-active", () => setInteractive((v) => !v));
    const offEdit = listen("shortcut-edit", () => setEditing((v) => !v));
    const offTrayEdit = listen("tray-toggle-edit", () => setEditing((v) => !v));
    const offTrayPreset = listen("tray-cycle-preset", () => cyclePreset());
    const offTraySettings = listen("tray-open-settings", () => setSettingsOpen(true));
    const offVis = listen("overlay-visibility-changed", (e) => setVisible(Boolean(e.payload)));
    const offSdk = listen<string>("sdk-device-ready", (e) => setSdkDeviceId(String(e.payload)));
    const offSdkErr = listen<string>("sdk-error", (e) => {
      const m = String(e.payload);
      if (/account_error|premium/i.test(m)) setTier("free");
      if (/invalid token scopes/i.test(m)) {
        // Refresh never widens granted scopes, so the only recovery is a
        // fresh login. The "new permissions" phrasing earns the toast's
        // Reconnect button, which runs logout followed by login.
        pushToast(
          "error",
          "Spotify needs new permissions for built-in playback. Reconnect to grant them.",
        );
      } else {
        pushToast("error", m);
      }
    });
    const all = [offPlay, offNext, offMute, offLike, offSeekBack, offSeekFwd, offToggle, offEdit, offTrayEdit, offTrayPreset, offTraySettings, offVis, offSdk, offSdkErr];
    return () => {
      for (const off of all) void off.then((f) => f());
    };
  }, [run, cyclePreset, pushToast, toggleMuteCb, toggleLikeCb, seekByCb]);

  // Headless SDK: create/resume the player inside a user gesture (autoplay
  // policy). Armed once per login; a hidden or suspended webview stops
  // audio, so the view stays alive while logged in. Tauri uses WebView2
  // (Edge/Chromium) on Windows, which supplies EME/Widevine.
  useEffect(() => {
    if (!loggedIn) return;
    const arm = () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      const seed = (snapRef.current.volume ?? 50) / 100;
      void ensurePlayer(seed).then((id) => {
        if (id) {
          setSdkDeviceId(id);
          setSdkVolume(seed);
        }
      });
    };
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [loggedIn]);

  // Pane drag + 8-handle resize. Deltas are divided by uiScale because the
  // stage renders under a zoom wrapper while pointer events stay in screen px.
  const beginDrag = (e: React.PointerEvent, id: string, kind: "move" | Handle) => {
    if (!editing) return;
    e.stopPropagation();
    const pane = layout.find((x) => x.id === id);
    if (!pane) return;
    // One undo step per grab: the snapshot predates the whole gesture.
    pushUndoSnapshot();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Bring to front on grab.
    const top = layout.reduce((m, x) => Math.max(m, x.z), 0);
    dragRef.current = {
      id,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origX: pane.x,
      origY: pane.y,
      origW: pane.w,
      origH: pane.h,
    };
    if (pane.z < top) {
      setLayout((l) => {
        const panes = l.map((x) => (x.id === id ? { ...x, z: top + 1 } : x));
        return panes;
      });
    }
  };

  const dragRaf = useRef(0);
  const dragPending = useRef<{ x: number; y: number; shift: boolean; w: number; h: number } | null>(null);
  useEffect(
    () => () => {
      if (dragRaf.current) window.cancelAnimationFrame(dragRaf.current);
      if (guidesTimer.current) window.clearTimeout(guidesTimer.current);
      if (kbBurstTimer.current) window.clearTimeout(kbBurstTimer.current);
    },
    [],
  );

  const onStageMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const stage = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragPending.current = {
      x: e.clientX,
      y: e.clientY,
      shift: e.shiftKey,
      w: stage.width,
      h: stage.height,
    };
    if (dragRaf.current) return;
    dragRaf.current = window.requestAnimationFrame(() => {
      dragRaf.current = 0;
      const p = dragPending.current;
      dragPending.current = null;
      const dd = dragRef.current;
      if (!dd || !p) return;
      applyDrag(dd, p);
    });
  };

  const applyDrag = (
    d: NonNullable<typeof dragRef.current>,
    p: { x: number; y: number; shift: boolean; w: number; h: number },
  ) => {
    const k = uiScaleRef.current || 1;
    const dx = (p.x - d.startX) / k;
    const dy = (p.y - d.startY) / k;
    const areaW = p.w / k;
    const areaH = p.h / k;
    setLayout((l) => {
      const panes = l.map((x) => ({ ...x }));
      const m = panes.find((x) => x.id === d.id);
      if (!m) return l;
      const min = getPaneMin(m.type);
      if (d.kind === "move") {
        m.x = Math.max(0, Math.round(d.origX + dx));
        m.y = Math.max(0, Math.round(d.origY + dy));
        if (!p.shift) {
          const s = snapMove(m, panes, areaW, areaH);
          m.x = s.x;
          m.y = s.y;
          setGuides({ v: s.v, h: s.h });
        } else {
          setGuides({ v: [], h: [] });
        }
        // Snap only catches within its threshold; a fast drag sails past
        // the edge, so pin the pane fully inside the area here.
        m.x = Math.min(m.x, Math.max(0, Math.round(areaW - m.w)));
        m.y = Math.min(m.y, Math.max(0, Math.round(areaH - m.h)));
      } else {
        let nx = d.origX;
        let ny = d.origY;
        let nw = d.origW;
        let nh = d.origH;
        if (d.kind.includes("e")) {
          nw = Math.max(min.w, Math.round(d.origW + dx));
          // Resize has no snap threshold on the far side: cap the edge at
          // the area so the pane cannot grow off-screen.
          nw = Math.min(nw, Math.max(min.w, Math.round(areaW - m.x)));
        }
        if (d.kind.includes("s")) {
          nh = Math.max(min.h, Math.round(d.origH + dy));
          nh = Math.min(nh, Math.max(min.h, Math.round(areaH - m.y)));
        }
        if (d.kind.includes("w")) {
          nx = Math.round(d.origX + dx);
          nw = Math.round(d.origW - dx);
          if (nw < min.w) {
            nx -= min.w - nw;
            nw = min.w;
          }
          nx = Math.max(0, nx);
        }
        if (d.kind.includes("n")) {
          ny = Math.round(d.origY + dy);
          nh = Math.round(d.origH - dy);
          if (nh < min.h) {
            ny -= min.h - nh;
            nh = min.h;
          }
          ny = Math.max(0, ny);
        }
        m.x = nx;
        m.y = ny;
        m.w = nw;
        m.h = nh;
        if (!p.shift) {
          const s = snapSize(m, panes, areaW, areaH, {
            east: d.kind.includes("e"),
            south: d.kind.includes("s"),
            west: d.kind.includes("w"),
            north: d.kind.includes("n"),
          });
          m.x = Math.round(s.x);
          m.y = Math.round(s.y);
          m.w = Math.round(s.w);
          m.h = Math.round(s.h);
          setGuides({ v: s.gv, h: s.gh });
        } else {
          setGuides({ v: [], h: [] });
        }
      }
      return panes;
    });
  };

  const onStageUp = () => {
    if (dragPending.current) dragPending.current = null;
    if (dragRef.current) {
      dragRef.current = null;
      setGuides({ v: [], h: [] });
      setLayout((l) => {
        persist(l, preset);
        return l;
      });
    }
  };

  /** Keyboard resize for one resize handle. Arrows drive the handle's own
   *  edge(s) by KB_STEP with the same snap/clamp/persist path as a drag;
   *  one undo snapshot per focus engagement, like one per pointer grab. */
  const handleKeyResize = (e: React.KeyboardEvent, id: string, handle: Handle) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "ArrowUp" &&
      e.key !== "ArrowDown"
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (handleUndoElRef.current !== e.currentTarget) {
      handleUndoElRef.current = e.currentTarget;
      pushUndoSnapshot();
    }
    const panes = layoutRef.current.map((x) => ({ ...x }));
    const m = panes.find((x) => x.id === id);
    if (!m || !m.visible) return;
    const k = uiScaleRef.current || 1;
    const areaW = window.innerWidth / k;
    const areaH = window.innerHeight / k;
    const min = getPaneMin(m.type);
    const hasE = handle.includes("e");
    const hasW = handle.includes("w");
    const hasS = handle.includes("s");
    const hasN = handle.includes("n");
    const dw = e.key === "ArrowRight" ? KB_STEP : e.key === "ArrowLeft" ? -KB_STEP : 0;
    const dh = e.key === "ArrowDown" ? KB_STEP : e.key === "ArrowUp" ? -KB_STEP : 0;
    if (dw !== 0 && (hasE || hasW)) {
      if (hasE) {
        m.w += dw;
      } else {
        m.x += dw;
        m.w -= dw;
      }
    }
    if (dh !== 0 && (hasS || hasN)) {
      if (hasS) {
        m.h += dh;
      } else {
        m.y += dh;
        m.h -= dh;
      }
    }
    if (m.w < min.w) {
      if (hasW && !hasE) m.x -= min.w - m.w;
      m.w = min.w;
    }
    if (m.h < min.h) {
      if (hasN && !hasS) m.y -= min.h - m.h;
      m.h = min.h;
    }
    const c = clampPaneToArea(
      { ...m, x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h) },
      areaW,
      areaH,
    );
    m.x = c.x;
    m.y = c.y;
    m.w = c.w;
    m.h = c.h;
    const s = snapSize(m, panes, areaW, areaH, {
      east: hasE,
      south: hasS,
      west: hasW,
      north: hasN,
    });
    m.x = Math.round(s.x);
    m.y = Math.round(s.y);
    m.w = Math.round(s.w);
    m.h = Math.round(s.h);
    flashGuides(s.gv, s.gh);
    setLayout(panes);
    persist(panes, presetRef.current);
  };

  const handleBlurReset = (e: React.FocusEvent) => {
    if (handleUndoElRef.current === e.currentTarget) handleUndoElRef.current = null;
  };

  const progressMs = (() => {
    if (!snap.track) return 0;
    const base = snap.isPlaying ? snap.progressMs + (now - snap.fetchedAt) : snap.progressMs;
    return Math.min(Math.max(0, base), snap.track.durationMs);
  })();

  const renderPane = (pane: PaneState) => {
    if (!pane.visible) return null;
    return (
      <section
        key={`${preset}:${pane.id}`}
        className={`pane${editing ? " editing" : ""}`}
        data-pane={pane.type}
        data-pane-id={pane.id}
        data-density={density}
        tabIndex={-1}
        style={{ left: pane.x, top: pane.y, width: pane.w, height: pane.h, zIndex: pane.z, opacity: pane.opacity }}
        onPointerDown={(e) => {
          if (editing) e.stopPropagation();
        }}
      >
        <header className="pane-handle" onPointerDown={(e) => beginDrag(e, pane.id, "move")}>
          <h2 className="pane-title">{PANE_TITLES[pane.type]}</h2>
          {editing && (
            <>
              <input
                className="pane-op"
                type="range"
                min={40}
                max={100}
                value={Math.round(pane.opacity * 100)}
                aria-label={`${PANE_TITLES[pane.type]} opacity`}
                aria-valuetext={`${Math.round(pane.opacity * 100)} percent`}
                title="Pane opacity"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setPaneOpacity(pane.id, Number(e.target.value) / 100)}
              />
              <span className="grip" aria-hidden="true" />
            </>
          )}
        </header>
        <div className="pane-body">
          {pane.type === "player" && (
            <MemoPlayerPane
              snapshot={snap}
              devices={devices}
              progressMs={progressMs}
              busy={busy}
              tier={tier}
              sdkDeviceId={sdkDeviceId}
              queuedCount={pendingCount}
              onPlay={playCb}
              onPause={pauseCb}
              onNext={nextCb}
              onPrev={prevCb}
              onSeek={seekCb}
              onVolume={volumeCb}
              onShuffle={shuffleCb}
              onRepeat={repeatCb}
              onTransfer={transferCb}
              onPlayHere={playHereCb}
              onRefreshDevices={fetchDevices}
              onToast={pushToast}
            />
          )}
          {pane.type === "lyrics" && (
            <MemoLyricsPane
              lyrics={lyrics}
              positionMs={progressMs}
              clickToSeek={clickToSeek}
              wordKaraoke={wordKaraoke}
              transLang={transLang}
              onSeek={seekCb}
              onRetry={lyricsRetryCb}
            />
          )}
          {pane.type === "queue" && (
            <MemoQueuePane
              current={queue.current}
              upcoming={queue.upcoming}
              loading={queueLoading}
              context={queueContext}
              queuedCount={pendingCount}
              capped={degradedUi && queue.upcoming.length > 0}
              onRefresh={fetchQueue}
              onBrowse={queueBrowseCb}
              onOpenContext={openQueueContext}
              onPlayUri={queuePlayUriCb}
            />
          )}
          {pane.type === "visualizer" && (
            <MemoVisualizerPane isPlaying={snap.isPlaying} seed={snap.track?.id ?? null} />
          )}
          {pane.type === "browse" && (
            <MemoBrowsePane
              state={browse}
              deviceId={snap.deviceId ?? sdkDeviceId}
              queuedCount={pendingCount}
              onChange={setBrowse}
              onPlayContext={browsePlayContextCb}
              onPlayUris={browsePlayUrisCb}
              onQueueAdd={browseQueueAddCb}
              onError={browseErrorCb}
            />
          )}
        </div>
        {editing &&
          HANDLES.map((hh) => {
            const hmin = getPaneMin(pane.type);
            // Edges expose their own dimension; corners expose width while
            // the value text always announces both.
            const horizontal = hh.includes("e") || hh.includes("w");
            const edge = hh === "e" || hh === "w" || hh === "n" || hh === "s";
            const k = uiScale || 1;
            const vmax = Math.max(
              horizontal ? hmin.w : hmin.h,
              Math.round((horizontal ? window.innerWidth : window.innerHeight) / k),
            );
            return (
              <div
                key={hh}
                className={`rz rz-${hh}`}
                role="slider"
                tabIndex={0}
                aria-label={`${PANE_TITLES[pane.type]} resize ${HANDLE_LABELS[hh]}`}
                aria-valuemin={horizontal ? hmin.w : hmin.h}
                aria-valuemax={vmax}
                aria-valuenow={Math.round(horizontal ? pane.w : pane.h)}
                aria-valuetext={`${Math.round(pane.w)} by ${Math.round(pane.h)} pixels`}
                aria-orientation={edge ? (horizontal ? "horizontal" : "vertical") : undefined}
                onPointerDown={(e) => beginDrag(e, pane.id, hh)}
                onKeyDown={(e) => handleKeyResize(e, pane.id, hh)}
                onBlur={handleBlurReset}
              />
            );
          })}
      </section>
    );
  };

  return (
    <div className="app" data-theme={theme} data-surface={surface} data-corners={corners}>
      {!loggedIn ? (
        <div className="gate">
          <div className="pane gate-card">
            <div className="gate-icon">
              <NoteIcon size={26} />
            </div>
            <h1>Connect Spotify</h1>
            <p>Login opens your browser, then returns here. Premium unlocks control.</p>
            <button className="btn primary" onClick={() => void login()} disabled={awaitingAuth}>
              {awaitingAuth ? "Waiting for browser…" : "Login with Spotify"}
            </button>
            {awaitingAuth && <p className="dim">Port 3000 listens once for the callback.</p>}
          </div>
        </div>
      ) : (
        <div style={{ zoom: uiScale } as React.CSSProperties}>
          <div
            className="stage"
            onPointerMove={onStageMove}
            onPointerUp={onStageUp}
            onDoubleClick={(e) => {
              // Reachable only while editing: passive mode passes all
              // mouse events to the game below, so re-entry is via the
              // interact shortcut, edit shortcut, or the tray.
              if (e.target === e.currentTarget) {
                setEditing(false);
              }
            }}
          >
            {layout.map(renderPane)}
            {guides.v.map((x) => (
              <div key={`v${x}`} className="guide-v" style={{ left: x }} />
            ))}
            {guides.h.map((y) => (
              <div key={`h${y}`} className="guide-h" style={{ top: y }} />
            ))}
          </div>
        </div>
      )}

      {(editing || interactive) && loggedIn && (
        <div className="dock" role="toolbar" aria-label="Overlay editor">
          <button
            className="tbtn"
            onClick={() => {
              const win = getCurrentWindow();
              if (visible) void win.hide().then(() => setVisible(false));
              else void win.show().then(() => setVisible(true));
            }}
            title={`Show / Hide window (${keybinds.toggleVisibility})`}
            aria-label={visible ? "Hide window" : "Show window"}
            aria-pressed={!visible}
          >
            {visible ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
            <span className="dock-label">{visible ? "Hide" : "Show"}</span>
          </button>
          <button
            className="tbtn"
            onClick={() => setEditing((v) => !v)}
            title={`Edit lock (${keybinds.toggleEdit})`}
            aria-label="Toggle edit lock"
            aria-pressed={editing}
          >
            <PencilIcon size={15} />
            <span className="dock-label">{editing ? "Lock" : "Edit"}</span>
          </button>
          <button
            className="tbtn"
            onClick={() => setInteractive((v) => !v)}
            title={`Interact / Pass through (${keybinds.toggleInteract})`}
            aria-label="Toggle interact"
            aria-pressed={interactive}
          >
            <CursorIcon size={15} />
            <span className="dock-label">{interactive ? "Pass" : "Interact"}</span>
          </button>
          <button
            className="tbtn"
            onClick={() => undoLayout()}
            title="Undo layout change (Ctrl+Z in edit mode)"
            aria-label="Undo layout change"
            disabled={undoStack.length === 0}
          >
            <UndoIcon size={15} />
            <span className="dock-label">Undo</span>
          </button>
          <span className="dock-sep" aria-hidden="true" />
          {PANE_TYPES.map((t) => {
            const on = layout.some((p) => p.type === t && p.visible);
            return (
              <button
                key={t}
                className={`chip${on ? " chip-on" : ""}`}
                onClick={() => togglePaneType(t)}
                title={`Toggle ${PANE_TITLES[t]} pane`}
                aria-pressed={on}
              >
                {PANE_TITLES[t]}
              </button>
            );
          })}
          <span className="dock-sep" aria-hidden="true" />
          <button
            className="tbtn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <GearIcon size={15} />
            <span className="dock-label">Settings</span>
          </button>
          <button
            className="tbtn"
            onClick={() => {
              setInteractive(false);
              setEditing(false);
            }}
            title={`Pass through (${keybinds.toggleInteract}, Esc)`}
            aria-label="Pass through to game"
          >
            <ThroughIcon size={15} />
            <span className="dock-label">Done</span>
          </button>
          <button
            className="tbtn"
            onClick={cyclePreset}
            title={`Cycle preset (${keybinds.cyclePreset})`}
            aria-label="Cycle preset"
          >
            <GridIcon size={15} />
            <span className="dock-label">Preset</span>
          </button>
          <button
            className="tbtn"
            onClick={() => void getCurrentWindow().close()}
            title="Close"
            aria-label="Close"
          >
            <XIcon size={15} />
            <span className="dock-label">Close</span>
          </button>
        </div>
      )}

      {loggedIn && !coachDismissed && (
        <button
          className="hint-chip"
          onClick={dismissCoach}
          aria-label="Dismiss shortcut hint"
        >
          Shift+Tab to interact · Esc to pass through — click to dismiss
        </button>
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.slice(-1).map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
          >
            <span>{t.text}</span>
            <button
              className="btn sm"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
            >
              Dismiss
            </button>
            {/missing permission|new permissions/i.test(t.text) && (
              <button
                className="btn sm"
                onClick={() => {
                  dismissToast(t.id);
                  setErr(null);
                  void logout().finally(() => void login());
                }}
              >
                Reconnect
              </button>
            )}
            <button
              className="btn sm"
              onClick={() => void openUrl("https://open.spotify.com")}
            >
              Open Spotify
            </button>
          </div>
        ))}
      </div>

      {err && !toasts.length && (
        <div className="toast toast-error">
          <span>{err}</span>
          {/missing permission|new permissions/i.test(err) && (
            <button
              className="btn sm"
              onClick={() => {
                setErr(null);
                void logout().finally(() => void login());
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}

      {(settingsOpen || settingsClosing) && (
          <SettingsModal
            open={settingsOpen || settingsClosing}
        loggedIn={loggedIn}
        preset={preset}
        uiScale={uiScale}
        theme={theme}
        density={density}
        surface={surface}
        corners={corners}
        autostart={autostart}
        interactive={interactive}
        clickToSeek={clickToSeek}
        wordKaraoke={wordKaraoke}
        transLang={transLang}
        previewing={previewing}
        onPreset={previewPreset}
        onApplyPreset={confirmPresetPreview}
        onRevertPreset={cancelPresetPreview}
        onUiScale={setUiScale}
        onTheme={(v) => {
          setTheme(v);
          try {
            localStorage.setItem("snapify-theme", v);
          } catch {
            // Private mode. Theme lasts the session.
          }
        }}
        onDensity={(v) => {
          setDensity(v);
          try {
            localStorage.setItem("snapify-density", v);
          } catch {
            // Private mode. Density lasts the session.
          }
        }}
        onSurface={(v) => {
          setSurface(v);
          try {
            localStorage.setItem("snapify-surface", v);
          } catch {
            // Private mode. Surface lasts the session.
          }
        }}
        onCorners={(v) => {
          setCorners(v);
          try {
            localStorage.setItem("snapify-corners", v);
          } catch {
            // Private mode. Corners last the session.
          }
        }}
        onAutostart={(v) => {
          setAutostart(v);
          invoke("set_autostart", { enabled: v }).catch((e) => {
            setAutostart(!v);
            flashErr(e instanceof Error ? e.message : String(e));
          });
        }}
        onInteractToggle={() => setInteractive((v) => !v)}
        onEditToggle={() => setEditing((v) => !v)}
        onVisibilityToggle={() => {
          const win = getCurrentWindow();
          if (visible) void win.hide().then(() => setVisible(false));
          else void win.show().then(() => setVisible(true));
        }}
        editing={editing}
        visible={visible}
        onClickToSeek={setClickToSeek}
        onWordKaraoke={(v) => {
          setWordKaraoke(v);
          try {
            localStorage.setItem("snapify-karaoke", v ? "1" : "0");
          } catch {
            // Private mode. Choice lasts the session.
          }
        }}
        onTransLang={(v) => {
          setTransLang(v);
          try {
            localStorage.setItem("snapify-translang", v);
          } catch {
            // Private mode. Choice lasts the session.
          }
        }}
        onResetLayout={() => {
          pushUndoSnapshot();
          previewBaseRef.current = null;
          setPreviewing(false);
          const fresh = defaultLayoutFor(window.innerWidth, window.innerHeight);
          setLayout(fresh.panes);
          setPreset(fresh.preset);
          persist(fresh.panes, fresh.preset);
        }}
        keybinds={keybinds}
        startupErrors={keybindStartup}
        onKeybind={changeKeybind}
        onResetKeybinds={() => void resetKeybinds()}
        appVersion={appVersion}
        update={update}
        onCheckUpdate={() => void checkUpdates()}
        onDownloadUpdate={() => void downloadUpdate()}
        onRestartUpdate={restartUpdate}
        onLogout={() => void logout()}
        onClose={closeSettings}
      />
      )}
    </div>
  );
}
