import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import PlayerPane from "./components/PlayerPane";
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
  ListIcon,
  LockIcon,
  NoteIcon,
  SlidersIcon,
  UnlockIcon,
  XIcon,
} from "./components/icons";
import { api, parsePlayer } from "./lib/spotify";
import { ensurePlayer } from "./lib/player-sdk";
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
  defaultLayoutFor,
  getPaneMin,
  loadLayout,
  saveLayout,
  snapMove,
  snapSize,
} from "./lib/layout";
import type {
  BrowseEntry,
  BrowseState,
  Density,
  DeviceInfo,
  LyricsState,
  PaneState,
  PaneType,
  PlayerSnapshot,
  QueueContext,
  QueueItem,
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
  const [autostart, setAutostart] = useState(false);
  const [keybinds, setKeybinds] = useState<KeybindMap>({ ...DEFAULT_KEYBINDS });
  const keybindsRef = useRef<KeybindMap>({ ...DEFAULT_KEYBINDS });
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

  const persist = useCallback((panes: PaneState[], name: string) => {
    saveLayout({ version: 3, preset: name, panes });
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
  const degradedRef = useRef(false);
  const isThrottledMsg = (m: string) => {
    const s = m.toLowerCase();
    return (
      s.includes("rate-limited") ||
      s.includes("quota-exceeded") ||
      s.includes("429") ||
      s.includes("cooling down") ||
      s.includes("retry after")
    );
  };
  const noteDegraded = useCallback(
    (m: string) => {
      if (degradedRef.current) return;
      degradedRef.current = true;
      const quota = /quota-exceeded/i.test(m);
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
      setQueue({ current: q.current, upcoming: q.upcoming });
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
    } catch {
      // Leave previous queue in place.
    } finally {
      setQueueLoading(false);
    }
  }, []);

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
  // to the game or window below. Interactive mode takes input for presses,
  // drags, and settings. Visibility (true hide/show) is a separate global
  // action that hides the window entirely.
  useEffect(() => {
    const shouldIgnore = loggedIn && !interactive && !settingsOpen;
    void getCurrentWindow().setIgnoreCursorEvents(shouldIgnore).catch(() => {});
    try {
      localStorage.setItem("snapify-interact", interactive ? "1" : "0");
      localStorage.setItem("snapify-edit", editing ? "1" : "0");
    } catch {
      // Private mode. Prefs last the session.
    }
  }, [loggedIn, interactive, settingsOpen, editing]);

  // In-app shortcuts. Global chords (play/pause, next, interact, edit,
  // visibility) arrive as Tauri events even while focused, so they are
  // handled only there to avoid double-firing. This listener keeps Esc plus
  // the focused-only chords, matched against the stored keybinds so remaps
  // keep working. Subscribed once; state flows through refs so layout
  // changes and drags never re-subscribe.
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
  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      opts?: {
        after?: () => void;
        transport?: "play" | "pause" | "next" | "prev" | "seek" | "other";
        optimistic?: () => void;
        needsRefresh?: boolean;
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
        flashErrThrottledAware(e instanceof Error ? e.message : String(e));
      } finally {
        if (isTransport) transportRef.current = false;
        setBusy(false);
        if (!transportRef.current && pendingSeekRef.current) {
          const queued = pendingSeekRef.current;
          pendingSeekRef.current = null;
          void run(queued, { transport: "seek" });
        }
      }
    },
    [fetchPlayer, flashErrThrottledAware, snap.deviceId, sdkDeviceId, fetchDevices, pushToast],
  );

  // Hoisted pane callbacks: stable across the 2Hz progress tick so memoized
  // panes skip re-renders. Deps stay on primitives, never the snap object.
  const playCb = useCallback(
    () =>
      void (async () => {
        const target = snap.deviceId ?? sdkDeviceId ?? (await ensurePlayer());
        if (target) setSdkDeviceId((cur) => cur ?? target);
        await run(() => api.play(target), {
          transport: "play",
          optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: true })),
        });
      })(),
    [snap.deviceId, sdkDeviceId, run],
  );
  const pauseCb = useCallback(
    () =>
      void run(() => api.pause(snap.deviceId ?? sdkDeviceId), {
        transport: "pause",
        optimistic: () => setSnap((prev) => ({ ...prev, isPlaying: false })),
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const nextCb = useCallback(
    () => void run(() => api.next(snap.deviceId ?? sdkDeviceId), { transport: "next" }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const prevCb = useCallback(
    () => void run(() => api.prev(snap.deviceId ?? sdkDeviceId), { transport: "prev" }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const seekCb = useCallback(
    (ms: number) =>
      void run(() => api.seek(ms, snap.deviceId ?? sdkDeviceId), {
        transport: "seek",
        optimistic: () => setSnap((prev) => ({ ...prev, progressMs: ms, fetchedAt: Date.now() })),
      }),
    [snap.deviceId, sdkDeviceId, run],
  );
  const volumeCb = useCallback(
    (v: number) => {
      setSnap((s) => ({ ...s, volume: v }));
      void run(() => api.volume(v, snap.deviceId ?? sdkDeviceId));
    },
    [snap.deviceId, sdkDeviceId, run],
  );
  const shuffleCb = useCallback(
    () => void run(() => api.shuffle(!snap.shuffle, snap.deviceId ?? sdkDeviceId)),
    [snap.shuffle, snap.deviceId, sdkDeviceId, run],
  );
  const repeatNextCb = useMemo(
    () => (snap.repeat === "off" ? "context" : snap.repeat === "context" ? "track" : "off"),
    [snap.repeat],
  );
  const repeatCb = useCallback(
    () => void run(() => api.repeat(repeatNextCb, snap.deviceId ?? sdkDeviceId)),
    [repeatNextCb, snap.deviceId, sdkDeviceId, run],
  );
  const transferCb = useCallback(
    (id: string) =>
      void run(() => api.transfer(id, false), {
        after: () => {
          void fetchDevices();
        },
        needsRefresh: true,
      }),
    [run, fetchDevices],
  );
  const lyricsRetryCb = useCallback(
    () => trackIdRef.current && void fetchLyrics(trackIdRef.current),
    [fetchLyrics],
  );
  const applyPresetRef = useRef<(name: string) => void>(() => {});
  const queueBrowseCb = useCallback(() => applyPresetRef.current("full"), []);
  const browsePlayContextCb = useCallback(
    (uri: string) => void run(() => api.playContext(uri, snap.deviceId ?? sdkDeviceId)),
    [snap.deviceId, sdkDeviceId, run],
  );
  const browsePlayUrisCb = useCallback(
    (uris: string[]) => void run(() => api.playUris(uris, snap.deviceId ?? sdkDeviceId)),
    [snap.deviceId, sdkDeviceId, run],
  );
  const browseQueueAddCb = useCallback(
    (uri: string) =>
      void run(() => api.queueAdd(uri, snap.deviceId ?? sdkDeviceId), {
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
    setPreset((cur) => {
      const i = PRESET_ORDER.indexOf(cur);
      const next = PRESET_ORDER[(i + 1 + PRESET_ORDER.length) % PRESET_ORDER.length];
      const nl = PRESETS[next]();
      setLayout(clampLayoutToArea(nl, window.innerWidth, window.innerHeight, uiScaleRef.current).panes);
      persist(nl.panes, next);
      return next;
    });
  }, [persist]);
  useEffect(() => {
    cyclePresetRef.current = cyclePreset;
  }, [cyclePreset]);

  const applyPreset = useCallback(
    (name: string) => {
      if (!PRESETS[name]) return;
      const nl = PRESETS[name]();
      const panes = clampLayoutToArea(nl, window.innerWidth, window.innerHeight, uiScaleRef.current).panes;
      setLayout(panes);
      setPreset(name);
      persist(panes, name);
    },
    [persist],
  );
  useEffect(() => {
    applyPresetRef.current = applyPreset;
  }, [applyPreset]);

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
      setLayout((l) => {
        const existing = l.find((x) => x.type === type);
        let panes: PaneState[];
        if (existing) {
          panes = l.map((x) => (x.type === type ? { ...x, visible: !x.visible } : x));
        } else {
          const z = l.reduce((m, x) => Math.max(m, x.z), 0) + 1;
          const n = l.length;
          const min = getPaneMin(type);
          panes = [
            ...l,
            {
              id: `${type}-${Date.now() % 100000}`,
              type,
              x: 40 + n * 32,
              y: 40 + n * 32,
              w: Math.max(min.w, type === "lyrics" ? 420 : type === "browse" ? 380 : 340),
              h: Math.max(min.h, type === "lyrics" ? 380 : type === "browse" ? 480 : 230),
              opacity: 0.92,
              visible: true,
              z,
            },
          ];
        }
        persist(panes, "custom");
        return panes;
      });
      setPreset("custom");
    },
    [persist],
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
    const all = [offPlay, offNext, offToggle, offEdit, offTrayEdit, offTrayPreset, offTraySettings, offVis, offSdk, offSdkErr];
    return () => {
      for (const off of all) void off.then((f) => f());
    };
  }, [run, cyclePreset, pushToast]);

  // Headless SDK: create/resume the player inside a user gesture (autoplay
  // policy). Armed once per login; a hidden or suspended webview stops
  // audio, so the view stays alive while logged in. Tauri uses WebView2
  // (Edge/Chromium) on Windows, which supplies EME/Widevine.
  useEffect(() => {
    if (!loggedIn) return;
    const arm = () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      void ensurePlayer().then((id) => {
        if (id) setSdkDeviceId(id);
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
      } else {
        let nx = d.origX;
        let ny = d.origY;
        let nw = d.origW;
        let nh = d.origH;
        if (d.kind.includes("e")) nw = Math.max(min.w, Math.round(d.origW + dx));
        if (d.kind.includes("s")) nh = Math.max(min.h, Math.round(d.origH + dy));
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
        data-density={density}
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
              onPlay={playCb}
              onPause={pauseCb}
              onNext={nextCb}
              onPrev={prevCb}
              onSeek={seekCb}
              onVolume={volumeCb}
              onShuffle={shuffleCb}
              onRepeat={repeatCb}
              onTransfer={transferCb}
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
              onRefresh={fetchQueue}
              onBrowse={queueBrowseCb}
              onOpenContext={openQueueContext}
            />
          )}
          {pane.type === "visualizer" && (
            <MemoVisualizerPane isPlaying={snap.isPlaying} seed={snap.track?.id ?? null} />
          )}
          {pane.type === "browse" && (
            <MemoBrowsePane
              state={browse}
              deviceId={snap.deviceId ?? sdkDeviceId}
              onChange={setBrowse}
              onPlayContext={browsePlayContextCb}
              onPlayUris={browsePlayUrisCb}
              onQueueAdd={browseQueueAddCb}
              onError={browseErrorCb}
            />
          )}
        </div>
        {editing &&
          HANDLES.map((hh) => (
            <div
              key={hh}
              className={`rz rz-${hh}`}
              onPointerDown={(e) => beginDrag(e, pane.id, hh)}
            />
          ))}
      </section>
    );
  };

  return (
    <div className="app" data-theme={theme}>
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
            aria-label="Show or hide window"
            aria-pressed={!visible}
          >
            {visible ? <LockIcon size={15} /> : <UnlockIcon size={15} />}
          </button>
          <button
            className="tbtn"
            onClick={() => setEditing((v) => !v)}
            title={`Edit lock (${keybinds.toggleEdit})`}
            aria-label="Toggle edit lock"
            aria-pressed={editing}
          >
            <ListIcon size={15} />
          </button>
          <button
            className="tbtn"
            onClick={() => setInteractive((v) => !v)}
            title={`Interact / Pass through (${keybinds.toggleInteract})`}
            aria-label="Toggle interact"
            aria-pressed={interactive}
          >
            <SlidersIcon size={15} />
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
            <SlidersIcon size={15} />
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
            <UnlockIcon size={15} />
          </button>
          <button
            className="tbtn"
            onClick={cyclePreset}
            title={`Cycle preset (${keybinds.cyclePreset})`}
            aria-label="Cycle preset"
          >
            <ListIcon size={15} />
          </button>
          <button
            className="tbtn"
            onClick={() => void getCurrentWindow().close()}
            title="Close"
            aria-label="Close"
          >
            <XIcon size={15} />
          </button>
        </div>
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
        autostart={autostart}
        interactive={interactive}
        clickToSeek={clickToSeek}
        wordKaraoke={wordKaraoke}
        transLang={transLang}
        onPreset={applyPreset}
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
          const fresh = defaultLayoutFor(window.innerWidth, window.innerHeight);
          setLayout(fresh.panes);
          setPreset(fresh.preset);
          persist(fresh.panes, fresh.preset);
        }}
        keybinds={keybinds}
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
