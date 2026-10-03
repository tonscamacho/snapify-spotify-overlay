export type OverlayMode = "classic" | "mp3";

export type Mp3Variant = "purple" | "silver" | "pink" | "black";

export type LcdView = "track" | "time" | "eq";

export interface Mp3Settings {
  version: 1;
  mode: OverlayMode;
  variant: Mp3Variant;
  lcd: LcdView;
  motion: boolean;
}

export const OVERLAY_MODE_KEY = "snapify-overlay-mode";

export const OVERLAY_MODE_VERSION = 1;

export const DEFAULT_OVERLAY_MODE: Mp3Settings = {
  version: 1,
  mode: "classic",
  variant: "purple",
  lcd: "track",
  motion: true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceMode(v: unknown): OverlayMode {
  return v === "mp3" ? "mp3" : "classic";
}

function coerceVariant(v: unknown): Mp3Variant {
  return v === "purple" || v === "silver" || v === "pink" || v === "black"
    ? v
    : "purple";
}

function coerceLcd(v: unknown): LcdView {
  return v === "track" || v === "time" || v === "eq" ? v : "track";
}

function coerceMotion(v: unknown): boolean {
  return typeof v === "boolean" ? v : true;
}

export function parseOverlayMode(v: unknown): Mp3Settings {
  try {
    if (!isRecord(v)) return { ...DEFAULT_OVERLAY_MODE };
    return {
      version: 1,
      mode: coerceMode(v["mode"]),
      variant: coerceVariant(v["variant"]),
      lcd: coerceLcd(v["lcd"]),
      motion: coerceMotion(v["motion"]),
    };
  } catch {
    return { ...DEFAULT_OVERLAY_MODE };
  }
}

const KNOWN_KEYS = ["version", "mode", "variant", "lcd", "motion"];

function readStoredExtras(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(OVERLAY_MODE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(parsed)) {
      if (!KNOWN_KEYS.includes(k)) out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

export function loadOverlayMode(): Mp3Settings {
  try {
    const raw = localStorage.getItem(OVERLAY_MODE_KEY);
    if (!raw) return { ...DEFAULT_OVERLAY_MODE };
    return parseOverlayMode(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_OVERLAY_MODE };
  }
}

export function saveOverlayMode(s: Mp3Settings): void {
  try {
    const clean = parseOverlayMode(s);
    const extras = readStoredExtras();
    localStorage.setItem(
      OVERLAY_MODE_KEY,
      JSON.stringify({ ...extras, ...clean, version: 1 }),
    );
  } catch {
    return;
  }
}
