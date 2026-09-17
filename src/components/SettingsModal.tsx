import { useEffect, useRef, useState } from "react";
import { TRANS_LANGS, type TransLang } from "../lib/translate";
import type { Density, Surface, Corners } from "../lib/types";
import {
  KEYBIND_LABELS,
  KEYBIND_ORDER,
  KEYBIND_SCOPES,
  eventToAccelerator,
  type KeybindAction,
  type KeybindMap,
} from "../lib/keybinds";
import type { UpdateStatus } from "../lib/updater";
import { XIcon } from "./icons";

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
  keybinds: KeybindMap;
  appVersion: string;
  update: UpdateStatus;
  onPreset: (name: string) => void;
  onApplyPreset: () => void;
  onRevertPreset: () => void;
  previewing: boolean;
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
  onResetLayout: () => void;
  onKeybind: (action: KeybindAction, accelerator: string) => Promise<void>;
  onResetKeybinds: () => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onRestartUpdate: () => void;
  onLogout: () => void;
  onClose: () => void;
}

function KeybindRow({
  action,
  current,
  onKeybind,
}: {
  action: KeybindAction;
  current: string;
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
      {error && <div className="key-err">{error}</div>}
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

export default function SettingsModal(p: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
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
