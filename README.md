# Snapify - Spotify Overlay

A lightweight, always-on-top Spotify overlay for Windows. Solid panes you can drag, snap, and lock: player, synced lyrics, queue, and visualizer. Built with Tauri v2, React, and Rust.

![Status](https://img.shields.io/badge/status-v1.0.0-blue) ![Tauri](https://img.shields.io/badge/tauri-v2-orange) ![License](https://img.shields.io/badge/license-MIT-green)

## What it does

- **Player pane** — cover art, now playing, progress with click-to-seek, play/pause/next/previous, volume, shuffle, repeat, and device picker.
- **Lyrics pane** — line-synced lyrics with karaoke highlight, word-by-word singing progress on the active line, click a line to seek, auto-scroll, cached offline, plus optional per-line translations (ES/FR/DE/PT/JA, cached, silent when offline). Plain-lyrics, instrumental, and no-match states included.
- **Queue pane** — up-next list with refresh, plus the playing collection ("Next from") that opens in browse.
- **Visualizer pane** — ambient motion signature seeded by the track. The Spotify Web API exposes no audio stream, so bars advance while the track plays and freeze on pause. Still under reduced-motion.
- **Snappable layout** — drag panes by their header in edit mode, magnet snap to edges and other panes (Shift bypasses), corner resize, four presets (minimal, full, lyrics, spotlight), geometry persists across restarts (v1 layouts migrate forward untouched).
- **Settings** — preset switch, pane opacity, UI scale, dark/light theme, album-art tint, word karaoke, lyric translation language, launch-on-login, click-through-when-locked, click-lyric-to-seek, shortcuts reference.

## Stack

| Layer    | Choice                              |
| -------- | ----------------------------------- |
| Shell    | Tauri v2 (single `WebviewWindow`)   |
| UI       | React 19 + TypeScript + Vite, custom CSS solid theme |
| Auth     | Spotify Authorization Code + PKCE, no client secret in the app |
| Lyrics   | LRCLIB (`lrclib.net`), LRC parsed in Rust, cached locally |
| Secrets  | OS keychain via the `keyring` crate |

## Prerequisites

- Node 20+, Rust stable, [Spotify developer app](https://developer.spotify.com/dashboard).
- Spotify **Premium** for playback control. Free accounts get read-only state.
- In your Spotify app settings, allowlist this redirect URI exactly:

  ```
  http://127.0.0.1:3000
  ```

## Quickstart

```powershell
npm install
npm run tauri dev
```

Press **Login with Spotify**, approve in the browser, and play something. The overlay polls player state every 3 s and interpolates progress locally.

### Build a release binary

```powershell
npm run tauri build
```

Windows NSIS installers require the [WiX toolset](https://wixtoolset.org) on the build machine.

### Updates

The app updates itself from GitHub releases. Settings shows the running
version and a **Check for updates** button: when a newer signed release
exists it downloads in the background and hands off to the installer
(Windows exits into the installer, which relaunches the app). No login,
layout, or keybind data is touched.

To ship an update:

1. Bump the version in all three places: `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
2. Commit, then tag and push: `git tag v1.1.0; git push origin v1.1.0`.
3. The `Publish` workflow builds, signs, and opens a **draft** release.
   Review it, press Publish, and installed apps will offer the update.

One-time setup: generate the signing key with
`npx tauri signer generate -w ~/.tauri/snapify-update.key` (keep the
password with the key file, never commit either), put the public key in
`tauri.conf.json` under `plugins.updater.pubkey`, and store the private
key plus password as the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets.

## Configuration

- `src-tauri/src/auth.rs` — `CLIENT_ID` and `REDIRECT_URI` constants. Replace the client ID with your own Spotify app's ID.
- Scopes requested: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`.

## Project structure

```
src-tauri/src/
  lib.rs      # commands, plugins, session restore
  auth.rs     # PKCE login, 127.0.0.1:3000 callback, token refresh, keychain
  spotify.rs  # Web API proxy: player, queue, devices
  lyrics.rs   # LRCLIB lookup, LRC parser, 500-track file cache
src/
  App.tsx            # fullscreen chromeless shell, polling, drag/resize/snap, shortcuts, edit dock
  lib/spotify.ts     # response parsers + command wrappers
  lib/lrc.ts         # active-line binary search, time format
  lib/translate.ts   # per-line translations, localStorage cache (cap 200)
  lib/layout.ts      # presets, move/resize snap engine with guides, localStorage persistence (v3, per-pane opacity)
  lib/types.ts       # Pane, PlayerSnapshot, LyricsData, QueueItem
  components/        # PlayerPane, LyricsPane, QueuePane, VisualizerPane, SettingsModal
```

## Memory budget

Release target is 40–70 MB. What keeps it there:

- Player polling (3 s) and the 500 ms progress tick pause while the window is hidden and resume on show.
- The visualizer runs one rAF loop only while its pane is mounted, freezes on pause, and stops under reduced-motion.
- Lyrics file cache caps at 500 tracks and translation cache at 200 lines.
- Icon and bundle assets ship from `icon pack/` (`src-tauri/icons`, `public/snapify-icon.*`).

## Shortcuts

Global — work over games and fullscreen apps:

| Keys       | Action              |
| ---------- | ------------------- |
| Ctrl+Alt+P | Play / Pause        |
| Ctrl+Alt+N | Next track          |
| Shift+Tab  | Show / Hide overlay |
| Ctrl+Alt+E | Toggle edit lock    |

In-window — the overlay must be focused:

| Keys       | Action              |
| ---------- | ------------------- |
| Ctrl+Alt+L | Cycle preset        |
| Ctrl+Alt+C | Toggle click-through |

The tray icon (left-click toggles, right-click opens Show/Hide, edit lock, preset, settings, quit) is the way back when the window is hidden.

Click-through passes mouse events to windows below. Refocus the overlay from the taskbar and press Ctrl+Alt+C to exit it.

## Security notes

- Never commit a Spotify **Client Secret**. This app uses PKCE and needs none.
- Refresh tokens live in the OS credential store, never in `localStorage` or the bundle.
- If a secret or token is ever pasted into chat or committed, rotate it in the Spotify dashboard immediately.

## Roadmap

- v0.2 — tray icon, global hotkeys, installer, copy pass. Shipped.
- v0.3 — album-art ambient tint, light preset, launch-on-login, release memory budget. Shipped.
- v1.0 — visualizer pane, word-by-word karaoke, translations. Shipped.

## Contributing

Issues and PRs welcome. Keep panes glanceable, keep the bundle light, and prove behavior changes with commands run plus before/after observations. MIT licensed.
