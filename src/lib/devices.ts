import type { DeviceInfo } from "./types";

/** The fixed name the headless SDK registers under (see player-sdk.ts).
 *  Rows carrying this name are overlay registrations, never room speakers,
 *  so they collapse into the single overlay row instead of rendering
 *  alongside it. */
export const OVERLAY_DEVICE_NAME = "Snapify Overlay";

/** One rendered row in the Playback device section. The overlay appears as
 *  exactly one row (isOverlay), backed by the live SDK id when known or by
 *  the first same-named Connect entry otherwise. */
export interface DeviceRow {
  id: string;
  name: string;
  isActive: boolean;
  isOverlay: boolean;
}

/** Merge the live SDK registration with the Connect device list into the
 *  rows the Playback device section renders. Keyed by stable device id:
 *  empty ids never render (nothing transferable), repeated ids keep the
 *  first entry, the API mirror of the live SDK id is dropped, and stale
 *  same-named overlay registrations collapse into the single overlay row.
 *  The remembered-device feature reads/writes against these rows' ids. */
export function mergeDeviceRows(
  devices: DeviceInfo[],
  sdkDeviceId?: string | null,
  activeDeviceId?: string | null,
): DeviceRow[] {
  const seen = new Set<string>();
  const rest: DeviceRow[] = [];
  let apiOverlay: DeviceRow | null = null;
  for (const d of devices ?? []) {
    if (!d || typeof d.id !== "string" || !d.id) continue;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    if (d.name === OVERLAY_DEVICE_NAME) {
      if (sdkDeviceId) continue; // Stale same-name entry; the live SDK row wins.
      if (!apiOverlay) {
        apiOverlay = { id: d.id, name: d.name, isActive: d.isActive, isOverlay: true };
      }
      continue;
    }
    if (sdkDeviceId && d.id === sdkDeviceId) continue; // API mirror of the live SDK row.
    rest.push({ id: d.id, name: d.name, isActive: d.isActive, isOverlay: false });
  }
  const rows: DeviceRow[] = [];
  if (sdkDeviceId) {
    rows.push({
      id: sdkDeviceId,
      name: OVERLAY_DEVICE_NAME,
      isActive: activeDeviceId != null && activeDeviceId === sdkDeviceId,
      isOverlay: true,
    });
  } else if (apiOverlay) {
    rows.push(apiOverlay);
  }
  rows.push(...rest);
  return rows;
}

/** R1 guard: true only when the overlay may register itself as the active
 *  device. Anything already playing elsewhere (is_playing on a live
 *  session) vetoes the claim so opening the overlay never steals sound;
 *  an empty/paused session lets the overlay become active. Unknown shapes
 *  (failed or unparseable reads) stay put rather than guess. Mirrors the
 *  empty logic in parsePlayer: no item means no session. */
export function shouldRegisterOverlayDevice(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (o["empty"] === true) return true;
  if (!o["item"]) return true;
  return o["is_playing"] !== true;
}

export type DeviceTapAction = { kind: "overlay" } | { kind: "connect"; deviceId: string };

/** Single-tap contract (R2): the overlay row routes through the
 *  ensure-player + transfer path, every other row transfers directly to
 *  its stable device id. One tap is the whole choice — no confirm step. */
export function tapActionFor(row: DeviceRow): DeviceTapAction {
  if (row.isOverlay) return { kind: "overlay" };
  return { kind: "connect", deviceId: row.id };
}
