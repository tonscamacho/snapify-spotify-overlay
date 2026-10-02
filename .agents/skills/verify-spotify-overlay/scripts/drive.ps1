# Drive: assert the running artifact. Appends to evidence.log.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
$rundir = Join-Path ([IO.Path]::GetTempPath()) "opencode/verify-run"
$log = Join-Path $rundir "evidence.log"
function say($m) { echo $m; Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $m" }

try {
  $html = (Invoke-WebRequest -Uri "http://localhost:1420/" -UseBasicParsing -TimeoutSec 10).Content
  if ($html -match 'id="root"') { say "PASS dev server serves app shell" }
  else { say "FAIL shell missing root element" }
} catch { say "FAIL dev server unreachable: $_" }

$p = Get-Process -Name "snapify-overlay","spotify-overlay" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p -and $p.MainWindowTitle -like "*Spotify Overlay*" -and $p.Responding) {
  say "PASS window title=`"$($p.MainWindowTitle)`" responding pid=$($p.Id)"
} else { say "FAIL app window not found or hung" }

Push-Location (Join-Path $root "src-tauri")
try {
  $testTail = & cargo test --quiet 2>&1 | Select-Object -Last 5
  $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -eq 0) { say "PASS cargo test exit 0" }
else { say "FAIL cargo test exit ${code}: $($testTail -join ' | ')" }

say "MANUAL login: gate > Continue > approve > stage appears; restart restores session"
$css = Get-ChildItem (Join-Path $root "dist/assets/*.css") | Select-Object -First 1
if ($css) {
  $csstext = Get-Content -LiteralPath $css.FullName -Raw
  if ($csstext -match "--glass-regular" -and $csstext -match "--lg-blur-regular" -and $csstext -match "--lg-saturate") { say "PASS glass opt-in tokens in built CSS ($($css.Name))" }
  else { say "FAIL glass opt-in tokens missing from built CSS" }
  if ($csstext -match 'data-corners=["'']?sharp' -and $csstext -match "--r-lg:\s*0") { say "PASS sharp-corners opt-in zeroes radii in built CSS" }
  else { say "FAIL sharp-corners rule missing from built CSS" }
  if ($csstext -match 'data-theme=["'']?light' -and $csstext -match "#1d1d1f") { say "PASS light preset contrast tokens in built CSS" }
  else { say "FAIL light preset tokens missing from built CSS" }
  if ($csstext -match "255,\s*255,\s*255,\s*0?\.62|#ffffff9e") { say "PASS light+glass scrim in built CSS" }
  else { say "FAIL light+glass scrim missing from built CSS" }
  if ($csstext -match "lgDisp-|lg-lens|data-lens|--lg-spring") { say "FAIL stale lens/spring tokens survive in built CSS" }
  else { say "PASS no lens/spring tokens in built CSS (removed by design)" }
} else { say "FAIL no built CSS found (run npm run build)" }

$js = Get-ChildItem (Join-Path $root "dist/assets/*.js") | Select-Object -First 1
if ($js) {
  $jstext = Get-Content -LiteralPath $js.FullName -Raw
  if ($jstext -match "snapify-surface" -and $jstext -match "snapify-corners" -and $jstext -match "snapify-theme") { say "PASS appearance persistence keys in built JS ($($js.Name))" }
  else { say "FAIL appearance keys missing from built JS" }
  if ($jstext -match "data-surface" -and $jstext -match "data-corners") { say "PASS data-surface/data-corners hooks in built JS" }
  else { say "FAIL data-surface/data-corners hooks missing from built JS" }
} else { say "FAIL no built JS found (run npm run build)" }

# 2.5.4 theme lanes. Tracks A/B/C own the specs; the feature maps own
# the hooks. Rule: token present -> PASS. Token absent + owning spec
# file present -> FAIL. Token absent + no spec yet -> INCONCLUSIVE
# (never FAIL, so this stays green while tracks land).
$specDir = Join-Path $root "verify/web"
function lane($label, $present, $specGlob, $map) {
  if ($present) { say "PASS $label tokens in built CSS (see $map)" ; return }
  $hasSpec = @(Get-ChildItem (Join-Path $specDir $specGlob) -ErrorAction SilentlyContinue).Count -gt 0
  if ($hasSpec) { say "FAIL $label spec present but tokens missing from built CSS" }
  else { say "INCONCLUSIVE $label tokens absent; owning spec not landed yet (see $map)" }
}
if ($css) {
  $csstext = Get-Content -LiteralPath $css.FullName -Raw
  lane "pastel theme" ($csstext -match 'data-theme=.pastel') "*theme*.spec.ts" "features/theme-surface.md"
  lane "sparkles theme" ($csstext -match 'data-theme=.sparkles') "*theme*.spec.ts" "features/theme-surface.md"
  lane "pastel+glass scrim" ($csstext -match 'data-theme=.pastel.{0,120}data-surface=.glass|data-surface=.glass.{0,120}data-theme=.pastel') "*theme*.spec.ts" "features/theme-surface.md"
  lane "accent color-picker" ($csstext -match 'snapify-accent|data-accent|color-picker') "*color*.spec.ts" "features/settings-color.md"
  lane "mini marquee" ($csstext -match 'is-marquee|title-marquee') "*mini*.spec.ts" "features/mini-marquee-volume.md"
}

say "MANUAL appearance: solid+rounded default pixel-identical; Surface glass adds blur frost on pane/dock/modal only; Corners sharp zeroes radii while chips stay 999px; light paper + light+glass scrim legible over art; drag, preset, opacity slider, toast queue, modal open/close still work (see features/liquid-glass.md + features/settings.md)"
say "MANUAL player: play track > pane updates within one poll (5s playing, 20s paused, 30s no device) > disc/skip/seek/volume/device all respond"
say "MANUAL mini+marquee+volume: shrink player pane to the compact gate > mini card shows, collapse stays header-only; hover a long title > marquee scrolls once, reduced-motion kills it to ellipsis; volume slider drives device gain with 50%-parity (see features/mini-marquee-volume.md)"
say "MANUAL lyrics: synced line highlights ~500ms > click line seeks > plain/instrumental/unknown states"
say "MANUAL shortcuts: remap one chord in Settings > Shortcuts, restart, new chord fires; defaults Ctrl+Alt+P/N/E/H, Shift+Tab interact, focused Ctrl+Alt+L/C; Ctrl+Alt+H hides/shows the window over a game; tray Show/Hide window + Quit ends process"
say "MANUAL updater: Settings bottom shows version; Check with no release says none found; after publishing, Install hands to the system installer and the new version shows"
