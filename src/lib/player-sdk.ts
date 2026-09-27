import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { shouldRegisterOverlayDevice } from "./devices";

declare global {
  interface Window {
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (arg?: unknown) => void): boolean;
  getCurrentState(): Promise<unknown>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

let player: SpotifyPlayer | null = null;
let deviceId: string | null = null;
let ready = false;

function clampGain(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 50;
  return Math.min(100, Math.max(0, p));
}

/** Perceptual parity: the Spotify apps render `volume_percent` through a
 *  logarithmic/top-heavy taper (community report: slider 50 sounds like ~25%
 *  perceived; raw curve ≈ power-law), while the Web Playback SDK `setVolume`
 *  gain is linear. A linear `percent / 100` therefore sounds substantially
 *  louder on the overlay than the same percent in the Spotify app.
 *  Squaring the fractional slider position (`(p/100)^2`) reproduces the
 *  native taper at the SDK boundary so equal percent = equal loudness.
 *  Boundaries are exact: 0 -> 0, 100 -> 1, mute (0) -> 0. */
export function percentToSdkGain(percent: number): number {
  const f = clampPercent(percent) / 100;
  return f * f;
}

/** Inverse of {@link percentToSdkGain} for diagnostics only. Runtime never
 *  reads SDK gain back into the slider (slider truth stays the cloud
 *  `volume_percent`); exported so tests can prove the round-trip. */
export function sdkGainToPercent(gain: number): number {
  const g = clampGain(gain);
  return Math.round(Math.sqrt(g) * 100);
}

/** Curve a 0-1 fractional slider position to the linear SDK gain that sounds
 *  like the same percent on a native Spotify app. `ensurePlayer` callers pass
 *  `(volume_percent ?? 50) / 100` and `volumeCb` passes `v / 100`, so both
 *  funnel through here and stay in parity with `api.volume(percent)`. */
function curveFraction(fraction: number): number {
  const f = clampGain(fraction);
  return f * f;
}

function loadScript(): Promise<void> {
  if (document.querySelector('script[data-spotify-sdk="1"]')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.dataset.spotifySdk = "1";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Spotify SDK script failed to load"));
    document.head.appendChild(s);
  });
}

function waitReady(): Promise<void> {
  if (window.Spotify?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    window.setTimeout(() => resolve(), 8000);
  });
}

async function freshToken(): Promise<string> {
  return invoke<string>("get_fresh_token");
}

/** Create/resume the player. Call inside a user gesture (autoplay policy).
 *  The local gain seeds from the caller's 0-1 fractional slider position,
 *  curved through {@link percentToSdkGain} parity so overlay playback starts
 *  at the loudness Spotify already shows, never a fixed blast. */
export async function ensurePlayer(initialVolume?: number): Promise<string | null> {
  if (ready && deviceId) return deviceId;
  try {
    await loadScript();
    await waitReady();
    if (!window.Spotify?.Player) {
      await emit("sdk-error", "Spotify SDK unavailable in this webview (EME/Widevine check needed).");
      return null;
    }
    if (!player) {
      player = new window.Spotify.Player({
        name: "Snapify Overlay",
        getOAuthToken: (cb) => {
          void freshToken()
            .then(cb)
            .catch(() => cb(""));
        },
        volume: curveFraction(initialVolume ?? 0.5),
      });
      player.addListener("ready", (e) => {
        const id = (e as { device_id?: string } | undefined)?.device_id ?? null;
        if (!id) return;
        deviceId = id;
        ready = true;
        // Never steal sound (R1): register the overlay as the active
        // device only when nothing is already playing elsewhere. A live
        // session on another device keeps the sound; an empty or paused
        // session lets the overlay become active. The ready signal emits
        // either way so the single overlay row still appears.
        void invoke<unknown>("get_player")
          .then((raw) => {
            if (!shouldRegisterOverlayDevice(raw)) return;
            return invoke("transfer_playback", { deviceId: id, playNow: false }).catch(() => {});
          })
          .catch(() => {})
          .finally(() => {
            void emit("sdk-device-ready", id);
          });
      });
      player.addListener("not_ready", () => {
        ready = false;
        deviceId = null;
        void emit("sdk-error", "Snapify Overlay device went offline.");
      });
      player.addListener("initialization_error", (e) =>
        emit("sdk-error", `Player init failed: ${JSON.stringify(e)}`),
      );
      player.addListener("authentication_error", (e) =>
        emit("sdk-error", `Player auth failed (Spotify SDK rejected the token): ${JSON.stringify(e)}`),
      );
      player.addListener("account_error", () =>
        emit("sdk-error", "account_error: Spotify Premium is required for headless playback."),
      );
      player.addListener("player_state_changed", () => {});
    }
    const ok = await player.connect();
    if (!ok) {
      await emit("sdk-error", "Player connect() returned false; Spotify app fallback remains.");
      return null;
    }
    return deviceId;
  } catch (e) {
    await emit("sdk-error", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Mirror the volume slider into the local player gain. `v` is the 0-1
 *  fractional slider position (callers pass `volume_percent / 100`); it is
 *  curved to perceptual parity so the room hears what the percent shows.
 *  The Web API volume call moves server-side state; this moves the air in
 *  the room. Safe to call any time: a missing player is a silent no-op. */
export function setSdkVolume(v: number): void {
  if (!player) return;
  try {
    void player.setVolume(curveFraction(v));
  } catch {
    // A half-torn-down player must never break the slider.
  }
}

export function teardownPlayer(): void {
  try {
    player?.disconnect();
  } catch {
    // Idempotent teardown.
  }
  player = null;
  deviceId = null;
  ready = false;
}

/** True once the headless player connected and registered its device id.
 *  Lets warm transport presses skip the full ensurePlayer path (Track B):
 *  a known live device plays at once, while a missing or stale device
 *  still runs SDK load, waitReady, connect, and transfer. */
export function isSdkReady(): boolean {
  return ready && deviceId !== null;
}

/** Local fast lane for play/pause (Track B probe). Resolves the audible
 *  state on the overlay device at once; callers still confirm through the
 *  cloud, so a local miss self-corrects on the next fetch. Rejects when
 *  the SDK player is not live. Next/previous stay cloud-only. */
export async function sdkResume(): Promise<void> {
  if (!player || !ready) throw new Error("SDK player not ready");
  await player.resume();
}

export async function sdkPause(): Promise<void> {
  if (!player || !ready) throw new Error("SDK player not ready");
  await player.pause();
}
