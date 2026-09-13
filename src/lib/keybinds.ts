export type KeybindAction =
  | "playpause"
  | "next"
  | "toggleInteract"
  | "toggleEdit"
  | "toggleVisibility"
  | "cyclePreset"
  | "legacyInteract";

export type KeybindMap = Record<KeybindAction, string>;

export const DEFAULT_KEYBINDS: KeybindMap = {
  playpause: "Ctrl+Alt+P",
  next: "Ctrl+Alt+N",
  toggleInteract: "Shift+Tab",
  toggleEdit: "Ctrl+Alt+E",
  toggleVisibility: "Ctrl+Alt+H",
  cyclePreset: "Ctrl+Alt+L",
  legacyInteract: "Ctrl+Alt+C",
};

export const KEYBIND_ORDER: KeybindAction[] = [
  "playpause",
  "next",
  "toggleInteract",
  "toggleEdit",
  "toggleVisibility",
  "cyclePreset",
  "legacyInteract",
];

export const KEYBIND_LABELS: Record<KeybindAction, string> = {
  playpause: "Play / Pause",
  next: "Next track",
  toggleInteract: "Interact / Pass through",
  toggleEdit: "Edit lock",
  toggleVisibility: "Show / Hide window",
  cyclePreset: "Cycle preset",
  legacyInteract: "Interact toggle, legacy",
};

export const KEYBIND_SCOPES: Record<KeybindAction, "global" | "focused"> = {
  playpause: "global",
  next: "global",
  toggleInteract: "global",
  toggleEdit: "global",
  toggleVisibility: "global",
  cyclePreset: "focused",
  legacyInteract: "focused",
};

function mainKeyName(e: KeyboardEvent): string | null {
  if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
    return null;
  }
  if (e.code.startsWith("Key") && e.code.length === 4) {
    return e.code.slice(3).toUpperCase();
  }
  if (e.code.startsWith("Digit") && e.code.length === 6) {
    return e.code.slice(5);
  }
  if (/^F\d{1,2}$/.test(e.code)) {
    return e.code.toUpperCase();
  }
  switch (e.key) {
    case " ":
    case "Spacebar":
      return "Space";
    case "Esc":
      return "Escape";
    case "Up":
      return "ArrowUp";
    case "Down":
      return "ArrowDown";
    case "Left":
      return "ArrowLeft";
    case "Right":
      return "ArrowRight";
    case "Del":
      return "Delete";
    case "`":
      return "Backquote";
    case "-":
      return "Minus";
    case "=":
      return "Equal";
    case "[":
      return "BracketLeft";
    case "]":
      return "BracketRight";
    case "\\":
      return "Backslash";
    case ";":
      return "Semicolon";
    case "'":
      return "Quote";
    case ",":
      return "Comma";
    case ".":
      return "Period";
    case "/":
      return "Slash";
    default:
      break;
  }
  if (e.key.length === 1) {
    return e.key.toUpperCase();
  }
  if (!e.key) return null;
  return e.key.length <= 12 ? e.key[0].toUpperCase() + e.key.slice(1) : null;
}

export function eventToAccelerator(e: KeyboardEvent): string | { error: string } | null {
  const key = mainKeyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  const lone = parts.length === 0;
  if (lone) {
    return { error: "Add Ctrl, Alt, or Win to a global shortcut. Bare keys would steal typing." };
  }
  const hasCtrlAltSuper = e.ctrlKey || e.altKey || e.metaKey;
  if (!hasCtrlAltSuper) {
    const okShiftCombo = e.shiftKey && /^(Tab|F\d{1,2}|Space)$/.test(key);
    if (!okShiftCombo) {
      return { error: "Shift alone only works with Tab, F-keys, or Space. Add Ctrl or Alt." };
    }
  }
  if (key === "Escape" && !hasCtrlAltSuper) {
    return { error: "Esc alone exits edit mode. Add Ctrl or Alt to remap it." };
  }
  return [...parts, key].join("+");
}

interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

function normalizeKeyToken(token: string): string {
  const t = token.trim();
  if (/^Key[A-Z]$/i.test(t)) return t.slice(-1).toUpperCase();
  if (/^Digit[0-9]$/i.test(t)) return t.slice(-1);
  if (/^F\d{1,2}$/i.test(t)) return t.toUpperCase();
  if (t === "`") return "Backquote";
  if (t.length === 1) return t.toUpperCase();
  const low = t.toLowerCase();
  if (low === "esc") return "Escape";
  if (low === "del") return "Delete";
  if (low === "up") return "ArrowUp";
  if (low === "down") return "ArrowDown";
  if (low === "left") return "ArrowLeft";
  if (low === "right") return "ArrowRight";
  if (low === "spacebar") return "Space";
  if (low === "ctrl" || low === "control") return "Ctrl";
  return t.length <= 12 ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
}

export function parseAccelerator(acc: string): ParsedChord | null {
  const tokens = acc.split("+").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const t = tokens[i].toLowerCase();
    if (t === "ctrl" || t === "control") ctrl = true;
    else if (t === "alt" || t === "option") alt = true;
    else if (t === "shift") shift = true;
    else if (t === "super" || t === "meta" || t === "win" || t === "cmd" || t === "command") meta = true;
    else return null;
  }
  const key = normalizeKeyToken(tokens[tokens.length - 1]);
  return { ctrl, alt, shift, meta, key };
}

export function acceleratorMatchesEvent(acc: string, e: KeyboardEvent): boolean {
  const p = parseAccelerator(acc);
  if (!p) return false;
  const key = mainKeyName(e);
  if (!key) return false;
  return (
    p.ctrl === e.ctrlKey &&
    p.alt === e.altKey &&
    p.shift === e.shiftKey &&
    p.meta === e.metaKey &&
    p.key.toLowerCase() === key.toLowerCase()
  );
}

export function coerceKeybinds(raw: unknown): KeybindMap {
  const out = { ...DEFAULT_KEYBINDS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<KeybindAction, unknown>>;
  const seen = new Set<string>();
  const fingerprint = (acc: string): string | null => {
    const p = parseAccelerator(acc);
    if (!p) return null;
    return `${p.ctrl ? 1 : 0}${p.alt ? 1 : 0}${p.shift ? 1 : 0}${p.meta ? 1 : 0}+${p.key.toLowerCase()}`;
  };
  for (const action of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
    seen.add(fingerprint(out[action]) ?? action);
  }
  (Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]).forEach((action) => {
    const v = r[action];
    if (typeof v === "string" && v.trim() && parseAccelerator(v.trim())) {
      const fp = fingerprint(v.trim());
      if (fp && !seen.has(fp)) {
        seen.add(fp);
        out[action] = v.trim();
      }
    }
  });
  return out;
}
