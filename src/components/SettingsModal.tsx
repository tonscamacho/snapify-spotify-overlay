import { useEffect, useRef, useState } from "react";
import { TRANS_LANGS, type TransLang } from "../lib/translate";
import { api } from "../lib/spotify";
import type { Density, Surface, Corners, SceneName, DeviceInfo } from "../lib/types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readDeviceChoice, writeDeviceChoice, type DeviceChoice } from "./PlayerPane";
import {
  KEYBIND_LABELS,
  KEYBIND_ORDER,
  KEYBIND_SCOPES,
  eventToAccelerator,
  type KeybindAction,
  type KeybindMap,
} from "../lib/keybinds";
import type { UpdateStatus } from "../lib/updater";
import { SCENE_NAMES, SCENE_LABELS } from "../lib/layout";
import { XIcon, RefreshIcon, OpenIcon } from "./icons";

interface Props {
  open: boolean;
  loggedIn: boolean;
  preset: string;
  uiScale: number;
  theme: "dark" | "light";
  density: Density;
  surface: Surface;
  corners: Corners;
  autostart: boolean;
  interactive: boolean;
  editing?: boolean;
  visible?: boolean;
  clickToSeek: boolean;
  wordKaraoke: boolean;
  transLang: TransLang;
  lyricScale: number;
  dyslexia: boolean;
  keybinds: KeybindMap;
  startupErrors?: string[] | null;
  appVersion: string;
  update: UpdateStatus;
  onPreset: (name: string) => void;
  onApplyPreset: () => void;
  onRevertPreset: () => void;
  previewing: boolean;
  scene: SceneName;
  onScene: (name: SceneName) => void;
  onCyclePreset: () => void;
  streamHideOnPause: boolean;
  streamDimInstead: boolean;
  onToggleStreamHide: () => void;
  onToggleStreamDim: () => void;
  onUiScale: (v: number) => void;
  onTheme: (v: "dark" | "light") => void;
  onDensity: (v: Density) => void;
  onSurface: (v: Surface) => void;
  onCorners: (v: Corners) => void;
  onAutostart: (v: boolean) => void;
  onInteractToggle: () => void;
  onEditToggle?: () => void;
  onVisibilityToggle?: () => void;
  onClickToSeek: (v: boolean) => void;
  onWordKaraoke: (v: boolean) => void;
  onTransLang: (v: TransLang) => void;
  onLyricScale: (v: number) => void;
  onDyslexia: (v: boolean) => void;
  onResetLayout: () => void;
  onKeybind: (action: KeybindAction, accelerator: string) => Promise<void>;
  onResetKeybinds: () => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onRestartUpdate: () => void;
  onLogout: () => void;
  onToast?: (kind: "success" | "info" | "error", text: string) => void;
  onClose: () => void;
  devices: DeviceInfo[];
  sdkDeviceId?: string | null;
  activeDeviceId?: string | null;
  activeDeviceName?: string | null;
  onTransfer: (id: string) => void;
  /** Build the headless SDK player and move playback onto it. */
  onPlayHere: () => void;
  onRefreshDevices: () => void;
}

function KeybindRow({
  action,
  current,
  notice,
  onKeybind,
}: {
  action: KeybindAction;
  current: string;
  notice?: string | null;
  onKeybind: (action: KeybindAction, accelerator: string) => Promise<void>;
}) {
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (capturing) btnRef.current?.focus();
  }, [capturing]);

  const cancel = () => {
    setCapturing(false);
    setError(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      cancel();
      return;
    }
    const parsed = eventToAccelerator(e.nativeEvent);
    if (parsed === null) return;
    if (typeof parsed !== "string") {
      setError(parsed.error);
      return;
    }
    if (parsed === current) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    void onKeybind(action, parsed)
      .then(() => {
        setCapturing(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div>
      <span>
        {KEYBIND_LABELS[action]}
        <span className="scope">{KEYBIND_SCOPES[action] === "global" ? "global" : "focused"}</span>
        {action === "toggleInteract" && (
          <span
            className="scope"
            title="This is the re-entry key: with pass-through on, only a shortcut brings the overlay back"
          >
            re-entry
          </span>
        )}
      </span>
      <button
        ref={btnRef}
        className={`kbd kbd-btn${capturing ? " kbd-live" : ""}`}
        onClick={() => (capturing ? cancel() : (setError(null), setCapturing(true)))}
        onKeyDown={capturing ? onKeyDown : undefined}
        onBlur={capturing ? cancel : undefined}
        disabled={saving}
        title={capturing ? "Press the new shortcut, Esc to cancel" : "Click to remap"}
        aria-label={`Remap ${KEYBIND_LABELS[action]}`}
      >
        {saving ? "Saving…" : capturing ? "Press keys…" : current}
      </button>
      {action === "toggleInteract" && (
        <div className="hint" role="note">
          Warning: remapping this re-entry key can strand you in pass-through —
          only a shortcut brings the overlay back.
        </div>
      )}
      {error && <div className="key-err">{error}</div>}
      {!error && notice && <div className="key-err">{notice}</div>}
    </div>
  );
}

function updateHint(u: UpdateStatus): string {
  switch (u.kind) {
    case "idle":
      return "Checks your GitHub releases for a newer signed build.";
    case "checking":
      return "Contacting the release feed…";
    case "current":
      return "You are on the latest version.";
    case "available":
      return `Version ${u.version} is ready to install.`;
    case "downloading":
      return u.progress >= 0
        ? `Downloading… ${Math.round(u.progress * 100)}%.`
        : "Downloading…";
    case "ready":
      return `Version ${u.version} installed. Restart to switch over.`;
    case "error":
      return u.message;
  }
}

function DeviceSection(p: {
  devices: DeviceInfo[];
  sdkDeviceId?: string | null;
  activeDeviceId?: string | null;
  activeDeviceName?: string | null;
  onTransfer: (id: string) => void;
  onPlayHere: () => void;
  onRefreshDevices: () => void;
}) {
  const [choice, setChoice] = useState<DeviceChoice | null>(() => readDeviceChoice());
  const [selectedId, setSelectedId] = useState<string>("");

  // Restore the remembered destination as the selection when the device
  // list arrives. Selection only: no silent transfer on boot. Without a
  // memory, the active device is the starting selection so Keep there is
  // a one-click confirm.
  useEffect(() => {
    if (selectedId) return;
    if (
      choice?.kind === "connect" &&
      choice.deviceId &&
      p.devices.some((d) => d.id === choice.deviceId)
    ) {
      setSelectedId(choice.deviceId);
    } else if (p.activeDeviceId) {
      setSelectedId(p.activeDeviceId);
    } else if (p.sdkDeviceId) {
      setSelectedId(p.sdkDeviceId);
    }
  }, [p.devices, p.activeDeviceId, p.sdkDeviceId, choice, selectedId]);

  const activeName =
    p.activeDeviceName ??
    (p.sdkDeviceId && p.activeDeviceId === p.sdkDeviceId ? "Snapify Overlay" : null) ??
    (p.devices.length === 0 ? "No devices — open Spotify" : "Choose a device");

  const playHere = () => {
    const next: DeviceChoice = { kind: "sdk" };
    setChoice(next);
    writeDeviceChoice(next);
    p.onPlayHere();
  };

  const keepThere = () => {
    if (!selectedId) return;
    const next: DeviceChoice = { kind: "connect", deviceId: selectedId };
    setChoice(next);
    writeDeviceChoice(next);
    p.onTransfer(selectedId);
  };

  return (
    <div className="settings-device" role="group" aria-label="Playback device">
      <div className="row">
        <span>Playback device</span>
        <span className="dim">
          Sound plays on: <strong>{activeName}</strong>
          {choice?.kind === "sdk" && " (remembered: this overlay)"}
          {choice?.kind === "connect" && choice.deviceId && " (remembered)"}
        </span>
      </div>
      <div className="device-list">
        {p.sdkDeviceId && (
          <button
            className={`device-cell${p.sdkDeviceId === p.activeDeviceId ? " is-active" : ""}`}
            aria-pressed={selectedId === p.sdkDeviceId}
            onClick={() => setSelectedId(p.sdkDeviceId as string)}
            title="Snapify Overlay"
          >
            <i className="device-dot" aria-hidden="true" />
            <span>
              Snapify Overlay{p.sdkDeviceId === p.activeDeviceId ? " — active" : ""}
            </span>
          </button>
        )}
        {p.devices.map((d) => (
          <button
            key={d.id}
            className={`device-cell${d.isActive ? " is-active" : ""}`}
            aria-pressed={selectedId === d.id}
            onClick={() => setSelectedId(d.id)}
            title={d.name}
          >
            <i className="device-dot" aria-hidden="true" />
            <span>
              {d.name}
              {d.isActive ? " — active" : ""}
            </span>
          </button>
        ))}
        {!p.sdkDeviceId && p.devices.length === 0 && (
          <div className="device-empty">No devices — open Spotify</div>
        )}
      </div>
      <div className="device-pop-actions">
        <button
          className="btn sm primary"
          onClick={playHere}
          title="Play through this overlay (Spotify headless SDK)"
          aria-label="Play here via this overlay"
        >
          Play here
        </button>
        <button
          className="btn sm"
          onClick={keepThere}
          disabled={!selectedId}
          title="Keep playback on the chosen Spotify device (Connect)"
          aria-label="Keep playback there"
        >
          Keep there
        </button>
      </div>
      <div className="device-pop-foot">
        <button
          className="icon-btn sm"
          onClick={p.onRefreshDevices}
          title="Refresh devices"
          aria-label="Refresh devices"
        >
          <RefreshIcon size={14} />
        </button>
        <button
          className="icon-btn sm"
          onClick={() => void openUrl("https://open.spotify.com")}
          title="OPEN SPOTIFY"
          aria-label="Open in Spotify"
        >
          <OpenIcon size={14} />
        </button>
        <span className="dim">Play here: sound from this overlay. Keep there: stay on the chosen device.</span>
      </div>
    </div>
  );
}

export default function SettingsModal(p: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [usage, setUsage] = useState<{
    total: number;
    ok: number;
    rateLimited: number;
    quotaExceeded: number;
  } | null>(null);
  const [cooldownNote, setCooldownNote] = useState<string | null>(null);
  const [lyricsCache, setLyricsCache] = useState<{ entries: number; bytes: number } | null>(
    null,
  );
  const [clearingLyrics, setClearingLyrics] = useState(false);
  // The modal mounts transiently, so one fetch on open covers its lifetime.
  useEffect(() => {
    if (!p.open) return;
    let cancelled = false;
    void api
      .requestLogCounts()
      .then((raw) => {
        if (cancelled) return;
        const c = raw as Partial<Record<"total" | "ok" | "rate_limited" | "quota_exceeded", unknown>>;
        if (
          typeof c.total !== "number" ||
          typeof c.ok !== "number" ||
          typeof c.rate_limited !== "number" ||
          typeof c.quota_exceeded !== "number"
        )
          return;
        setUsage({ total: c.total, ok: c.ok, rateLimited: c.rate_limited, quotaExceeded: c.quota_exceeded });
      })
      .catch(() => {});
    void api
      .requestLogRecent(50)
      .then((raw) => {
        if (cancelled) return;
        const entries = raw as Array<{
          method?: unknown;
          path?: unknown;
          result?: unknown;
          retry_after?: unknown;
        }>;
        if (!Array.isArray(entries)) return;
        const hit = entries.find((e) => e.result === "429-rate" || e.result === "429-quota");
        if (!hit || typeof hit.method !== "string" || typeof hit.path !== "string") return;
        const wait =
          typeof hit.retry_after === "number" && Number.isFinite(hit.retry_after)
            ? ` waited ${hit.retry_after} s before retrying`
            : "";
        setCooldownNote(`Most recent cooldown: ${hit.method} ${hit.path}${wait}, cooling down rather than failing.`);
      })
      .catch(() => {});
    void api
      .lyricsCacheSize()
      .then((raw) => {
        if (cancelled) return;
        const c = raw as Partial<Record<"entries" | "bytes", unknown>>;
        if (typeof c.entries !== "number" || typeof c.bytes !== "number") return;
        setLyricsCache({ entries: c.entries, bytes: c.bytes });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [p.open]);
  useEffect(() => {
    if (!p.open) return;
    modalRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        p.onClose();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const els = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>("button, input, select, [tabindex]"),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [p.open, p.onClose]);
  // Confirm-free clear: no dialog, then refresh the size line in place
  // and toast the count so the press has a visible result.
  const onClearLyrics = () => {
    if (clearingLyrics) return;
    setClearingLyrics(true);
    void api
      .clearLyricsCache()
      .then((res) => {
        const n = typeof res.cleared === "number" ? res.cleared : 0;
        p.onToast?.("success", n === 1 ? "Cleared 1 cached track" : `Cleared ${n} cached tracks`);
        return api.lyricsCacheSize();
      })
      .then((raw) => {
        const c = raw as Partial<Record<"entries" | "bytes", unknown>>;
        if (typeof c.entries !== "number" || typeof c.bytes !== "number") return;
        setLyricsCache({ entries: c.entries, bytes: c.bytes });
      })
      .catch(() => {})
      .finally(() => {
        setClearingLyrics(false);
      });
  };
  if (!p.open) return null;
  return (
    <div className="modal-back" onClick={p.onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>Settings</span>
          <button className="icon-btn sm" onClick={p.onClose} aria-label="Close settings">
            <XIcon size={14} />
          </button>
        </div>
        <div className="row">
          <span>Spotify</span>
          {p.loggedIn ? (
            <button className="btn sm" onClick={p.onLogout}>
              Logout
            </button>
          ) : (
            <span className="dim">Logged out</span>
          )}
        </div>
        <DeviceSection
          devices={p.devices}
          sdkDeviceId={p.sdkDeviceId}
          activeDeviceId={p.activeDeviceId}
          activeDeviceName={p.activeDeviceName}
          onTransfer={p.onTransfer}
          onPlayHere={p.onPlayHere}
          onRefreshDevices={p.onRefreshDevices}
        />
        <div className="row">
          <span>Spotify usage</span>
          <span className="dim">
            {usage === null
              ? "…"
              : usage.total === 0
                ? "No requests recorded yet."
                : `${usage.total} total · ${usage.ok} ok · ${usage.rateLimited} on cooldown · ${usage.quotaExceeded} quota cooldown`}
          </span>
        </div>
        {cooldownNote !== null && usage !== null && usage.total > 0 && (
          <div className="hint">{cooldownNote}</div>
        )}
        <div className="row">
          <span className="dim">
            {lyricsCache === null
              ? "Lyrics cache: …"
              : `Lyrics cache: ${lyricsCache.entries} tracks, ${Math.round(lyricsCache.bytes / 1024)} KB`}
          </span>
          <button
            className="btn sm"
            onClick={onClearLyrics}
            disabled={clearingLyrics || lyricsCache === null || lyricsCache.entries === 0}
          >
            {clearingLyrics ? "Clearing…" : "Clear"}
          </button>
        </div>
        <div className="row">
          <span>Theme</span>
          <span className="seg" role="group" aria-label="Theme">
            {(["dark", "light"] as const).map((n) => (
              <button
                key={n}
                className={p.theme === n ? "seg-on" : ""}
                onClick={() => p.onTheme(n)}
                aria-pressed={p.theme === n}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        <div className="row">
          <span>Density</span>
          <span className="seg" role="group" aria-label="Density">
            {(["compact", "default", "spacious"] as const).map((n) => (
              <button
                key={n}
                className={p.density === n ? "seg-on" : ""}
                onClick={() => p.onDensity(n)}
                aria-pressed={p.density === n}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        <div className="row">
          <span>Surface</span>
          <span className="seg" role="group" aria-label="Surface">
            {(["solid", "glass"] as const).map((n) => (
              <button
                key={n}
                className={p.surface === n ? "seg-on" : ""}
                onClick={() => p.onSurface(n)}
                aria-pressed={p.surface === n}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        <div className="row">
          <span>Corners</span>
          <span className="seg" role="group" aria-label="Corners">
            {(["rounded", "sharp"] as const).map((n) => (
              <button
                key={n}
                className={p.corners === n ? "seg-on" : ""}
                onClick={() => p.onCorners(n)}
                aria-pressed={p.corners === n}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        <div className="row">
          <span>Preset</span>
          <span className="seg" role="group" aria-label="Preset">
            {(["minimal", "full", "lyrics", "spotlight"] as const).map((n) => (
              <button
                key={n}
                className={p.preset === n ? "seg-on" : ""}
                onClick={() => p.onPreset(n)}
                aria-pressed={p.preset === n}
              >
                {n}
              </button>
            ))}
          </span>
        </div>
        {/* Scene + preset-cycle + streaming-safe live here so the dock stays
          slim. Scene and cycle commit immediately, never as a preview. */}
        <div className="row">
          <span>Scene</span>
          <span className="seg" role="group" aria-label="Scene">
            {SCENE_NAMES.map((n) => (
              <button
                key={n}
                className={p.scene === n ? "seg-on" : ""}
                onClick={() => p.onScene(n)}
                aria-pressed={p.scene === n}
              >
                {SCENE_LABELS[n]}
              </button>
            ))}
          </span>
        </div>
        <div className="row">
          <span>Cycle preset ({p.keybinds.cyclePreset})</span>
          <button className="btn sm" onClick={p.onCyclePreset}>
            Next preset
          </button>
        </div>
        <div className="row">
          <span>Auto-hide on pause</span>
          <input
            type="checkbox"
            checked={p.streamHideOnPause}
            aria-label="Auto-hide on pause"
            onChange={() => p.onToggleStreamHide()}
          />
        </div>
        <div className="hint">
          Hides the overlay 2.5 s after pausing; resume restores it.
        </div>
        <div className="row">
          <span>Dim instead of hiding</span>
          <input
            type="checkbox"
            checked={p.streamDimInstead}
            aria-label="Dim instead of hiding"
            onChange={() => p.onToggleStreamDim()}
            disabled={!p.streamHideOnPause}
          />
        </div>
        {p.previewing && (
          <>
            <div className="row">
              <span>Previewing preset</span>
              <span style={{ display: "inline-flex", gap: 8 }}>
                <button className="btn sm primary" onClick={p.onApplyPreset}>
                  Apply
                </button>
                <button className="btn sm" onClick={p.onRevertPreset}>
                  Revert
                </button>
              </span>
            </div>
            <div className="hint">
              Selecting a preset only previews it — nothing is saved yet.
              Apply keeps the preview, Revert (or closing Settings) restores
              your previous arrangement.
            </div>
          </>
        )}
        <div className="row">
          <span>UI scale</span>
          <input
            type="range"
            min={85}
            max={130}
            value={Math.round(p.uiScale * 100)}
            aria-label="UI scale"
            aria-valuetext={`${Math.round(p.uiScale * 100)} percent`}
            onChange={(e) => p.onUiScale(Number(e.target.value) / 100)}
          />
        </div>
        <div className="row">
          <span>Lyrics text size</span>
          <input
            type="range"
            min={85}
            max={130}
            value={Math.round(p.lyricScale * 100)}
            aria-label="Lyrics text size"
            aria-valuetext={`${Math.round(p.lyricScale * 100)} percent`}
            onChange={(e) => p.onLyricScale(Number(e.target.value) / 100)}
          />
        </div>
        <div className="row">
          <span>Launch on login</span>
          <input
            type="checkbox"
            checked={p.autostart}
            aria-label="Launch on login"
            onChange={(e) => p.onAutostart(e.target.checked)}
          />
        </div>
        <div className="row">
          <span>Show / Hide window ({p.keybinds.toggleVisibility})</span>
          <button
            className="btn sm"
            onClick={() => p.onVisibilityToggle?.()}
            title={`Show / Hide window (${p.keybinds.toggleVisibility})`}
            aria-pressed={p.visible === false}
          >
            {p.visible === false ? "Show" : "Hide"}
          </button>
        </div>
        <div className="row">
          <span>Edit lock ({p.keybinds.toggleEdit})</span>
          <button
            className="btn sm"
            onClick={() => p.onEditToggle?.()}
            title={`Edit lock (${p.keybinds.toggleEdit})`}
            aria-pressed={!!p.editing}
          >
            {p.editing ? "Lock" : "Edit"}
          </button>
        </div>
        <div className="row">
          <span>{p.interactive ? "Mode: interactive" : "Mode: pass-through"} ({p.keybinds.toggleInteract})</span>
          <button
            className="btn sm"
            onClick={p.onInteractToggle}
            title={`Interact / Pass through (${p.keybinds.toggleInteract})`}
            aria-pressed={p.interactive}
          >
            {p.interactive ? "Pass through" : "Interact"}
          </button>
        </div>
        <div className="hint">
          Pass-through keeps the overlay visible on top while all mouse input
          goes to the game or window below. Press {p.keybinds.toggleInteract},{" "}
          {p.keybinds.toggleEdit}, {p.keybinds.toggleVisibility}, or use the tray to interact again. Mouse
          alone cannot re-enter while passing through.
        </div>
        <div className="row">
          <span>Click lyric to seek</span>
          <input
            type="checkbox"
            checked={p.clickToSeek}
            aria-label="Click lyric to seek"
            onChange={(e) => p.onClickToSeek(e.target.checked)}
          />
        </div>
        <div className="row">
          <span>Word-by-word karaoke</span>
          <input
            type="checkbox"
            checked={p.wordKaraoke}
            aria-label="Word-by-word karaoke"
            onChange={(e) => p.onWordKaraoke(e.target.checked)}
          />
        </div>
        <div className="row">
          <span>Dyslexia-friendly lyrics</span>
          <input
            type="checkbox"
            checked={p.dyslexia}
            aria-label="Dyslexia-friendly lyrics"
            onChange={(e) => p.onDyslexia(e.target.checked)}
          />
        </div>
        <div className="hint">
          Widens spacing and weight on lyric lines for easier reading.
        </div>
        <div className="row">
          <span>Lyric translation</span>
          <select
            className="device"
            style={{ flex: "none" }}
            value={p.transLang}
            aria-label="Lyric translation language"
            onChange={(e) => p.onTransLang(e.target.value as TransLang)}
          >
            {TRANS_LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="hint">
          Translations come from English via a free service, are cached per line, and
          stay silent when offline.
        </div>
        <div className="row">
          <span>Layout</span>
          <button className="btn sm" onClick={p.onResetLayout}>
            Reset
          </button>
        </div>
        <div className="hint">
          Each pane has its own opacity slider in its header while interactive
          ({p.keybinds.toggleInteract}, {p.keybinds.toggleEdit}, or the tray).
          Double-click empty canvas or Esc returns to pass-through. Esc also closes settings.
        </div>
        <div className="row">
          <span>Shortcuts</span>
          <button className="btn sm" onClick={p.onResetKeybinds}>
            Reset
          </button>
        </div>
        <div className="hint">
          Global shortcuts work everywhere, even over a game. Focused ones need
          the overlay focused. Click a binding, press the new keys, Esc cancels.
        </div>
        <div className="keys">
          {KEYBIND_ORDER.map((action) => (
            <KeybindRow
              key={action}
              action={action}
              current={p.keybinds[action]}
              notice={(p.startupErrors ?? []).find((m) => m.includes(action)) ?? null}
              onKeybind={p.onKeybind}
            />
          ))}
        </div>
        <div className="row">
          <span>App version</span>
          <span className="dim">{p.appVersion || "…"}</span>
        </div>
        <div className="row">
          <span>Software update</span>
          {p.update.kind === "available" ? (
            <button className="btn sm primary" onClick={p.onDownloadUpdate}>
              Install {p.update.version}
            </button>
          ) : p.update.kind === "ready" ? (
            <button className="btn sm primary" onClick={p.onRestartUpdate}>
              Restart now
            </button>
          ) : (
            <button
              className="btn sm"
              onClick={p.onCheckUpdate}
              disabled={p.update.kind === "checking" || p.update.kind === "downloading"}
            >
              {p.update.kind === "checking"
                ? "Checking…"
                : p.update.kind === "downloading"
                  ? "Downloading…"
                  : "Check for updates"}
            </button>
          )}
        </div>
        <div className="hint">{updateHint(p.update)}</div>
        {p.update.kind === "downloading" && (
          <progress
            className="update-progress"
            value={p.update.progress >= 0 ? Math.round(p.update.progress * 100) : undefined}
            max={100}
            aria-label={`Downloading update ${Math.round((p.update.progress >= 0 ? p.update.progress : 0) * 100)} percent`}
          />
        )}
        {p.update.kind === "available" && p.update.body && (
          <div className="hint">{p.update.body.slice(0, 400)}</div>
        )}
      </div>
    </div>
  );
}
