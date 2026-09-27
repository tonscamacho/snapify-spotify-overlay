import { describe, expect, it } from "vitest";
import {
  mergeDeviceRows,
  shouldRegisterOverlayDevice,
  tapActionFor,
  type DeviceRow,
} from "./devices";
import type { DeviceInfo } from "./types";

function dev(id: string, name: string, isActive = false): DeviceInfo {
  return { id, name, kind: "Speaker", isActive, volume: 80 };
}

const LIVE_SDK = "sdk-live-1";
const SPEAKER = "dev-verify-1";

describe("mergeDeviceRows dedupe (R3)", () => {
  it("renders the overlay exactly once when the API mirrors the live SDK id", () => {
    const rows = mergeDeviceRows(
      [dev(LIVE_SDK, "Snapify Overlay", true), dev(SPEAKER, "Verify Speaker", false)],
      LIVE_SDK,
      SPEAKER,
    );
    expect(rows.filter((r) => r.isOverlay)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: LIVE_SDK, name: "Snapify Overlay", isOverlay: true });
    expect(rows.map((r) => r.name)).toEqual(["Snapify Overlay", "Verify Speaker"]);
  });

  it("drops repeated ids, empty ids, and stale same-named overlay entries", () => {
    const rows = mergeDeviceRows(
      [
        dev(SPEAKER, "Verify Speaker", true),
        dev(SPEAKER, "Verify Speaker", true), // reconnect double-entry
        { id: "", name: "Ghost", kind: "", isActive: false, volume: null },
        dev("stale-sdk-9", "Snapify Overlay"), // stale previous-session registration
        dev(LIVE_SDK, "Snapify Overlay"), // API mirror of the live id
      ],
      LIVE_SDK,
      LIVE_SDK,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: LIVE_SDK, isOverlay: true, isActive: true });
    expect(rows[1]).toMatchObject({ id: SPEAKER, isOverlay: false, isActive: true });
  });

  it("collapses same-named API entries to one overlay row while the SDK is unknown", () => {
    const rows = mergeDeviceRows(
      [dev("stale-sdk-9", "Snapify Overlay", true), dev("older-sdk-3", "Snapify Overlay"), dev(SPEAKER, "Verify Speaker")],
      null,
      "stale-sdk-9",
    );
    const overlay = rows.filter((r) => r.isOverlay);
    expect(overlay).toHaveLength(1);
    expect(overlay[0]).toMatchObject({ id: "stale-sdk-9", isActive: true });
    expect(rows.map((r) => r.id)).toEqual(["stale-sdk-9", SPEAKER]);
  });

  it("keeps the remembered Connect id addressable on the single list", () => {
    const rows = mergeDeviceRows([dev(SPEAKER, "Verify Speaker", true)], null, SPEAKER);
    expect(rows.some((r) => r.id === SPEAKER && !r.isOverlay)).toBe(true);
  });
});

describe("shouldRegisterOverlayDevice no-autosteal (R1)", () => {
  const live = (over: Record<string, unknown>) => ({
    is_playing: true,
    progress_ms: 1000,
    item: { id: "t1" },
    device: { id: "other-device", name: "TON" },
    ...over,
  });

  it("vetoes the claim while anything is playing elsewhere", () => {
    expect(shouldRegisterOverlayDevice(live({}))).toBe(false);
  });

  it("allows the claim when the session is paused", () => {
    expect(shouldRegisterOverlayDevice(live({ is_playing: false }))).toBe(true);
  });

  it("allows the claim when nothing has a session", () => {
    expect(shouldRegisterOverlayDevice({ empty: true })).toBe(true);
    expect(shouldRegisterOverlayDevice({ is_playing: false })).toBe(true);
  });

  it("stays put on unreadable reads instead of guessing", () => {
    expect(shouldRegisterOverlayDevice(null)).toBe(false);
    expect(shouldRegisterOverlayDevice(undefined)).toBe(false);
    expect(shouldRegisterOverlayDevice("nope")).toBe(false);
  });

  it("treats a session with no item as no session (mirrors parsePlayer)", () => {
    expect(shouldRegisterOverlayDevice({})).toBe(true);
  });
});

describe("tapActionFor single-tap transfer (R2)", () => {
  it("routes the overlay row through the ensure-player path", () => {
    const row: DeviceRow = { id: LIVE_SDK, name: "Snapify Overlay", isActive: false, isOverlay: true };
    expect(tapActionFor(row)).toEqual({ kind: "overlay" });
  });

  it("routes every other row straight at its stable device id", () => {
    const row: DeviceRow = { id: SPEAKER, name: "Verify Speaker", isActive: true, isOverlay: false };
    expect(tapActionFor(row)).toEqual({ kind: "connect", deviceId: SPEAKER });
  });
});
