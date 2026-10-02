# Verify: Spotify Overlay

Prove behavior on the real artifact: the Tauri window served by Vite.
Every claim needs the command run plus what was observed.

## Launch

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/launch.ps1
```

Starts `npm run dev` (waits for 127.0.0.1:1420) then
`snapify-overlay.exe` (cargo package name; the binary on disk is
`src-tauri/target/debug/snapify-overlay.exe`). Ready means both lines print:

```
VITE_READY=... (ms)
APP_READY title="Spotify Overlay" pid=...
```

PIDs go to `%TEMP%/opencode/verify-run/pids.txt`. Teardown:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/cleanup.ps1
```

Kills only the recorded PIDs. Logs stay in `%TEMP%/opencode/verify-run/`.

## Doctor

Read-only. Run first when anything looks off:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/doctor.ps1
```

Checks toolchain (node, cargo), `dist/index.html` and the debug exe exist,
port 1420 is free, and no stale `snapify-overlay` process is running.

## Drive

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/drive.ps1
```

Asserts without touching product code:

1. `http://localhost:1420/` serves the app shell (`id="root"` present).
2. A `snapify-overlay` process owns a responding window titled
   `*Spotify Overlay*` (matches `Snapify - Spotify Overlay`).
3. `cargo test` passes (Rust units: auth, keybinds, lyrics, overlay,
   spotify).

Playback, lyrics sync, and global shortcuts need a logged-in Spotify
session, so the script marks them `MANUAL:` with exact steps instead of
faking them. Appearance (solid default, glass/sharp opt-ins, light
contrast) is asserted in built CSS/JS by `drive.ps1`; visual parity stays
`MANUAL:`. See `features/` for one file per feature: how to get to it,
how to drive it, gotchas.

## Web harness (default for behavior)

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/web.ps1
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-spotify-overlay/scripts/web-real.ps1
```

`web.ps1` runs `npm run test` (vitest, 223 tests across 9 files under
`src/lib/`: layout 65, player-sdk 13, devices 11, lrc 21, keybinds
24, browse 52, spotify 22, pendingQueue 12, window-chrome 3 — same set
as `npm run test:unit`) plus `npm run test:web`
(Playwright + Chromium against `npm run dev` with the Tauri boundary
stubbed, 20 spec files / 134 tests: 130 mocked across 19 files green,
4 real-API specs skip without a token). `web-real.ps1` runs the live
shape checks and
SKIPs cleanly without a token (4 real-API specs skip via
`test.skip(!TOKEN, ...)`). Token rules: short-lived only, env var
`SPOTIFY_VERIFY_TOKEN` only, never committed. See
`features/web-harness.md` for the mock contract and coverage map.

## Evidence

`drive.ps1` prints `PASS:` / `FAIL:` / `MANUAL:` / `INCONCLUSIVE:` lines
and appends them to `%TEMP%/opencode/verify-run/evidence.log`.
`INCONCLUSIVE` means the owning 2.5.4 track spec has not landed yet —
never a failure. Quote those lines in the report
along with side effects checked (files written, processes started/killed).
Per-spec screenshots land in `verify/web/test-results/` (git-ignored,
per-run only); committed evidence lives in `docs/bug-reports/<version>/`.

## Cleanup

`cleanup.ps1` kills only recorded PIDs and removes `pids.txt`. Evidence log
survives. Confirm it still exists afterward.
