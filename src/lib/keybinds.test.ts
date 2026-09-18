import { describe, expect, it } from "vitest";
import {
  acceleratorMatchesEvent,
  coerceKeybinds,
  DEFAULT_KEYBINDS,
  KEYBIND_LABELS,
  KEYBIND_ORDER,
  KEYBIND_SCOPES,
  parseAccelerator,
} from "./keybinds";

describe("parseAccelerator", () => {
  it("parses Ctrl+Alt+P into its chord parts", () => {
    expect(parseAccelerator("Ctrl+Alt+P")).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
      meta: false,
      key: "P",
    });
  });

  it("parses a Shift-only combo with Tab", () => {
    expect(parseAccelerator("Shift+Tab")).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
      key: "Tab",
    });
  });

  it("is case-insensitive for modifiers and normalizes the key", () => {
    expect(parseAccelerator("ctrl+alt+p")).toEqual(parseAccelerator("Ctrl+Alt+P"));
  });

  it("treats Super as the meta modifier", () => {
    expect(parseAccelerator("Super+X")).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: true,
      key: "X",
    });
  });

  it("parses multi-modifier function keys", () => {
    expect(parseAccelerator("Ctrl+Shift+F5")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: "F5",
    });
  });

  it("normalizes esc to Escape", () => {
    expect(parseAccelerator("Ctrl+esc")).toEqual({
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      key: "Escape",
    });
  });

  it("returns null for an empty string", () => {
    expect(parseAccelerator("")).toBeNull();
  });

  it("returns null when a non-modifier sits in a modifier slot", () => {
    expect(parseAccelerator("Ctrl+Foo+P")).toBeNull();
    expect(parseAccelerator("Ctrl+X+Q")).toBeNull();
  });
});

describe("coerceKeybinds", () => {
  it("returns defaults for garbage input", () => {
    expect(coerceKeybinds(null)).toEqual(DEFAULT_KEYBINDS);
    expect(coerceKeybinds(undefined)).toEqual(DEFAULT_KEYBINDS);
    expect(coerceKeybinds("garbage")).toEqual(DEFAULT_KEYBINDS);
    expect(coerceKeybinds(42)).toEqual(DEFAULT_KEYBINDS);
    expect(coerceKeybinds({})).toEqual(DEFAULT_KEYBINDS);
  });

  it("keeps the default when a value is not a string", () => {
    expect(coerceKeybinds({ playpause: 123 }).playpause).toBe("Ctrl+Alt+P");
  });

  it("keeps the default when a value is blank", () => {
    expect(coerceKeybinds({ playpause: "   " }).playpause).toBe("Ctrl+Alt+P");
  });

  it("keeps the default when a value fails to parse", () => {
    expect(coerceKeybinds({ playpause: "Ctrl+Foo+P" }).playpause).toBe("Ctrl+Alt+P");
  });

  it("accepts a valid override", () => {
    const out = coerceKeybinds({ playpause: "Ctrl+Alt+X" });
    expect(out.playpause).toBe("Ctrl+Alt+X");
    expect(out.next).toBe("Ctrl+Alt+N");
  });

  it("trims whitespace around an override", () => {
    expect(coerceKeybinds({ playpause: "  Ctrl+Alt+X  " }).playpause).toBe("Ctrl+Alt+X");
  });

  it("rejects a duplicate chord and keeps the loser's default", () => {
    const out = coerceKeybinds({ playpause: "Ctrl+Alt+X", next: "Ctrl+Alt+X" });
    expect(out.playpause).toBe("Ctrl+Alt+X");
    expect(out.next).toBe("Ctrl+Alt+N");
  });

  it("rejects an override that collides with another action's default", () => {
    expect(coerceKeybinds({ playpause: "Ctrl+Alt+N" }).playpause).toBe("Ctrl+Alt+P");
  });

  it("treats duplicates case-insensitively", () => {
    expect(coerceKeybinds({ playpause: "ctrl+alt+p" }).playpause).toBe("Ctrl+Alt+P");
  });

  it("ignores unknown actions", () => {
    const out = coerceKeybinds({ nope: "Ctrl+Alt+X" });
    expect(out).toEqual(DEFAULT_KEYBINDS);
  });
});

describe("media keybinds", () => {
  it("ships mute, like, and ±10s seek defaults on free chords", () => {
    expect(DEFAULT_KEYBINDS.mute).toBe("Ctrl+Alt+M");
    expect(DEFAULT_KEYBINDS.toggleLike).toBe("Ctrl+Alt+K");
    expect(DEFAULT_KEYBINDS.seekBack10).toBe("Ctrl+Alt+B");
    expect(DEFAULT_KEYBINDS.seekForward10).toBe("Ctrl+Alt+F");
  });

  it("lists every action exactly once in render order", () => {
    expect(KEYBIND_ORDER).toHaveLength(11);
    expect(new Set(KEYBIND_ORDER).size).toBe(11);
    for (const action of Object.keys(DEFAULT_KEYBINDS)) {
      expect(KEYBIND_ORDER).toContain(action);
    }
  });

  it("scopes the media actions globally and keeps presets focused", () => {
    expect(KEYBIND_SCOPES.mute).toBe("global");
    expect(KEYBIND_SCOPES.toggleLike).toBe("global");
    expect(KEYBIND_SCOPES.seekBack10).toBe("global");
    expect(KEYBIND_SCOPES.seekForward10).toBe("global");
    expect(KEYBIND_SCOPES.cyclePreset).toBe("focused");
    expect(KEYBIND_SCOPES.legacyInteract).toBe("focused");
  });

  it("states the overlay-focus requirement on focused-only labels", () => {
    expect(KEYBIND_LABELS.cyclePreset).toMatch(/focus/i);
    expect(KEYBIND_LABELS.legacyInteract).toMatch(/focus/i);
    expect(KEYBIND_LABELS.toggleInteract).not.toMatch(/focus/i);
  });

  it("accepts overrides for the new actions and still rejects collisions", () => {
    const out = coerceKeybinds({ mute: "Ctrl+Alt+X", toggleLike: "Ctrl+Alt+Y" });
    expect(out.mute).toBe("Ctrl+Alt+X");
    expect(out.toggleLike).toBe("Ctrl+Alt+Y");
    const clash = coerceKeybinds({ mute: "Ctrl+Alt+P" });
    expect(clash.mute).toBe("Ctrl+Alt+M");
  });

  it("matches a synthetic key event against the mute default", () => {
    // No DOM in this suite: mainKeyName only reads key/code/modifiers.
    const e = {
      key: "m",
      code: "KeyM",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent;
    expect(acceleratorMatchesEvent(DEFAULT_KEYBINDS.mute, e)).toBe(true);
    expect(acceleratorMatchesEvent(DEFAULT_KEYBINDS.seekBack10, e)).toBe(false);
  });
});
