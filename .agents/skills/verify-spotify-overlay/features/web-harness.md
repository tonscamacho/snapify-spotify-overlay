# Web harness (mocked UI + shapes)

Sub-features: mocked UI runs (no account/token), live shape checks
(token-gated, skip-clean without), one screenshot per spec in
`verify/web/test-results/` (git-ignored).

How to get to it (user POV): no UI surface; this is the autonomous
default for agents. Humans run `npm run verify` (both suites, one
command) or the skill wrappers `scripts/web.ps1` (unit + mocked) and
`scripts/web-real.ps1` (live shapes, SKIPs without
`SPOTIFY_VERIFY_TOKEN`).

Driving it:

- `npm run test` — vitest, pure lib (`src/lib/*.test.ts`, 223 tests
  across 9 files: layout 65, player-sdk 13, devices 11, lrc 21, keybinds
  24, browse 52, spotify 22, pendingQueue 12, window-chrome 3 — same
  set as `npm run test:unit`).
- `npm run test:web` — Playwright + Chromium against `npm run dev`
  with the Tauri boundary stubbed (`verify/web/tauri-mock.ts`).
  20 spec files / 134 tests: 130 mocked across 19 files green, 4
  real-API specs skip without a token.
- `npm run verify` — both of the above, one command (`package.json`
  scripts: `test` = `vitest run`, `test:unit` = `vitest run src`,
  `test:web` = `playwright test -c playwright.config.ts`).

Mock contract (`verify/web/tauri-mock.ts` + `verify/web/fixtures.ts`):
stubs `window.__TAURI_INTERNALS__.invoke` for every command in
`src/lib/spotify.ts`, event listen/emit, `getCurrentWindow`,
`openUrl`, `getVersion`, updater `check`, and the Spotify SDK
(`window.Spotify.Player` fake + stubbed `sdk.scdn.co` that fires the
ready callback, so the product `loadScript` path resolves). Every
invoked command lands in `window.__INVOKED__` for assertions.
Fixtures mirror parser shapes (playing track, devices, queue,
synced cues, library/search). One screenshot per spec lands in
`verify/web/test-results/` (ignored by git).

Covered: player render/pause/play/next/progress (`player.spec.ts`),throttled play chip + flush and single-tap device rows with overlay memory
(`player.spec.ts`), no-autosteal arm plus volume 50%-parity
(`device-volume-parity.spec.ts`), lyrics highlight + click-to-seek + offset persist +
word timing + translation batching/replacement + romaji
(`lyrics.spec.ts`), queue rows + refresh + throttled chip/flush +
virtualized 25-item scroll + Enter-to-play (`queue.spec.ts`), preset
cycle + pane toggle + geometry restore + reload persist +
non-destructive queue Browse + preview Apply/Revert + close-restores-base
+ Reset + Ctrl+Z undo + labeled wrapping dock + coach pill show/dismiss +
Alt+Arrow move/resize + handle sliders (`layout.spec.ts`), settings
version + theme persist + media rows + re-entry warning + mute/seek/like
chords + lyrics display rows + usage counts + cache clear
   (`settings.spec.ts`), stale overlay rows collapse to one
   (`settings.spec.ts`), single-403 wall-then-Retry renders tracks with
   Play intact, persistent-403 wall keeps Play (header + wall) + Retry +
   Open in Spotify with Play firing `play_context`, owned path never
   walls (`walled-tracks.spec.ts`), volume slider gain + 50%-parity curve
  (`volume.spec.ts`, `device-volume-parity.spec.ts`), empty
/ populated / walled playlist + follow + detail Save reconcile + search
recents/paging + artist backfill + episode notes/resume/speed + heart
reconcile (`playlist-play.spec.ts`), boot clamp + east-edge drag
(`pane-edges.spec.ts`), empty-stage click-through + still panes +
coach-pill display + <10/s region rate + `toggle_visibility` routing +
boot marks + 130% zoom alignment (`overlay-passthrough.spec.ts`), queue
 context open-in-browse pointer + keyboard (`queue-context.spec.ts`),
 invalid-scope reconnect toast + plain sdk errors + free-tier drop
 (`sdk-scope.spec.ts`), sparkles/pastel select + persist + reload +
 unknown-value coerce to dark (`settings.spec.ts`:300-323 sparkles,
 :332-359 pastel), centered transport + 120px floors + PLAYER_FULL_H
 gate (`player-center.spec.ts`), scale 85-130% alignment
 (`player-scale.spec.ts`), compact mini card + collapsed header-only
 (`compact-player.spec.ts`, `collapse-spill-repro.spec.ts`), windowed /
 fullscreen roam + runtime-shrink clamp (`zomboid-windowed.spec.ts`),
 chrome-region repro probes (`chrome-repro.spec.ts`).

 Paths (keep honest): `playwright.config.ts` sets `testDir:
 "verify/web"`, `baseURL: "http://localhost:1420"` (Vite
 `strictPort: 1420` in `vite.config.ts`; Tauri dev + `verify`
 fixed port is `:1420`), per-run `outputDir:
 "verify/web/test-results"` and HTML report
 `"verify/web/playwright-report"` — both git-ignored (`.gitignore`
 lines 26-27). One screenshot per spec lands in `test-results/`
 (per-run, never committed). Committed visual evidence lives in
 `docs/bug-reports/<version>/` (e.g. `docs/bug-reports/2.5.3/`,
 `docs/bug-reports/chrome-*.png`). `drive.ps1` appends to
 `%TEMP%/opencode/verify-run/evidence.log` (survives cleanup);
 `dist/index.html` + `src-tauri/target/debug/snapify-overlay.exe`
 must exist before launch (`scripts/doctor.ps1` checks both).

Gotchas:

- Locator rule the suite learned: `getByRole(name)` is substring
  matching, so the dock chip "Player" collides with "Play". Scope to
  `section[data-pane="..."]` and use `exact: true`.
- Real shapes (`verify/web/real-spotify.spec.ts`, `npm run test:web-real`):
  needs `SPOTIFY_VERIFY_TOKEN` and skips without it. With a token it
  checks live `/v1/me`, `/v1/me/player` against `parsePlayer`, live
  search against `parseSearch`, and lrclib for one known track.
  Token rules: short-lived only (about 1 hour), environment variable
  only, never log/print/commit it. Mint it in the Spotify Web API
  Console (developer.spotify.com/console): sign in, copy the OAuth
  token, then `$env:SPOTIFY_VERIFY_TOKEN="<token>"` for one run.
  Do NOT send passwords or long-lived credentials to the agent; the
  app's own PKCE login in the Tauri window is the only login path.
