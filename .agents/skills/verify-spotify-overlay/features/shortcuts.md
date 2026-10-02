# Shortcuts

Sub-features: eleven remappable chords. Global (work over a game):
Play/Pause (`Ctrl+Alt+P`), Next (`Ctrl+Alt+N`), Mute/Unmute
(`Ctrl+Alt+M`, restores the pre-mute level), Like/Unlike
(`Ctrl+Alt+K`), Seek back/forward 10 seconds (`Ctrl+Alt+B` /
`Ctrl+Alt+F`, from the live position), Interact/Pass through
(`Shift+Tab`), Edit lock (`Ctrl+Alt+E`), Show/Hide window
(`Ctrl+Alt+H`, true hide via `toggle_visibility`, never steals focus).
Focused (overlay must have focus): Cycle preset (`Ctrl+Alt+L`), legacy
interact toggle (`Ctrl+Alt+C`). Persisted in `keybinds.json` under the app
local-data dir; corrupt or duplicate entries fall back to defaults.
Backend commands: `get_keybinds`, `set_keybind`, `reset_keybinds`.
Keyboard geometry (no remap surface, always on): Alt+Arrows moves the
focused pane, Alt+Shift+Arrows resizes it, 8 px per press with the same
snap/clamp/persist/undo path as a drag; resize handles are
`role="slider"` controls with the same step. Boot-time conflicts only
log and surface as a per-row notice in Settings; remap to recover.

How to get to it: Settings > Shortcuts. Click a binding, press the new
chord, Esc cancels. Reset restores defaults. Global rows carry a
`global` scope tag, focused rows state the focus need; the Shift+Tab row
carries the re-entry warning.

Driving it: remap Next to `Ctrl+Alt+J`, press it over a game, track
skips. Remap Show/Hide to `Ctrl+Alt+H`, press it, the window truly hides
(`win.hide` in Rust), press again, it returns without stealing focus.
Emit `shortcut-mute`, volume drops to zero and back; emit
`shortcut-seek-back`/`shortcut-seek-forward`, position jumps ±10 s.
Alt+Arrow a focused pane, guides flash and the move persists and undoes.
Restart the app, remaps still fire. Reset, defaults fire again. See
`verify/web/settings.spec.ts` (media rows, mute, seek, like chords) and
`verify/web/layout.spec.ts` (Alt+Arrow move/resize, handle sliders).

Gotchas: global registration can fail if another app owns the chord; the
backend returns the error and keeps the old binding. Bare letters and bare
Esc are rejected (they would steal typing or trap edit mode); Shift alone
only works with Tab, F-keys, or Space. Focused chords do not fire while
typing in an input. A login granted before the Browse scopes existed 403s
with the missing scope named; the toast offers one-click Reconnect.
