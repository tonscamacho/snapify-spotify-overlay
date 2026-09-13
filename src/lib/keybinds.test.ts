import { describe, expect, it } from "vitest";
import { coerceKeybinds, DEFAULT_KEYBINDS, parseAccelerator } from "./keybinds";

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
