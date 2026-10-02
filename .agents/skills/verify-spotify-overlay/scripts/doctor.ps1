# Doctor: read-only preflight. Exit 0 when the app is launchable.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
$fail = $false

foreach ($cmd in @("node", "cargo")) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) {
    echo "HAVE $cmd $((& $cmd --version 2>$null | Select-Object -First 1))"
  } else {
    echo "FAIL missing $cmd"; $fail = $true
  }
}

foreach ($rel in @("dist/index.html", "src-tauri/target/debug/snapify-overlay.exe")) {
  if (Test-Path -LiteralPath (Join-Path $root $rel)) { echo "HAVE $rel" }
  else { echo "FAIL missing $rel (build first)"; $fail = $true }
}

$owned = $false
try {
  $r = Invoke-WebRequest -Uri "http://localhost:1420/" -UseBasicParsing -TimeoutSec 3
  if ($r.StatusCode -eq 200) { $owned = $true }
} catch {}
if ($owned) { echo "WARN port 1420 owned, launch may collide" }
else { echo "HAVE port 1420 free" }

$stale = Get-Process -Name "snapify-overlay","spotify-overlay" -ErrorAction SilentlyContinue
if ($stale) { echo "WARN stale app pid=$(($stale | ForEach-Object { $_.Id }) -join ',')" } else { echo "HAVE no stale app" }

if ($fail) { exit 1 } else { echo "DOCTOR_OK"; exit 0 }
