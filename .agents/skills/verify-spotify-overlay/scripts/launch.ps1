# Launch: start vite, wait for :1420, start the app, wait for its window.
$root = Split-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot)))
$rundir = Join-Path ([IO.Path]::GetTempPath()) "opencode/verify-run"
New-Item -ItemType Directory -Path $rundir -Force | Out-Null
$exe = Join-Path $root "src-tauri/target/debug/snapify-overlay.exe"
if (-not (Test-Path -LiteralPath $exe)) { echo "FAIL missing debug exe"; exit 1 }

function Test-DevHttp {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:1420/" -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch { return $false }
}
if (Test-DevHttp) { echo "FAIL port 1420 already owned (stale vite?). Free it, then retry."; exit 1 }
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory $root -WindowStyle Hidden
$viteReady = $false
while ($sw.Elapsed.TotalSeconds -lt 45) {
  if (Test-DevHttp) { $viteReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $viteReady) { echo "FAIL vite never answered :1420"; exit 1 }
echo "VITE_READY ms=$([int]$sw.Elapsed.TotalMilliseconds)"
$viteCmd = (Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*npm run dev*" } | Sort-Object CreationDate -Descending | Select-Object -First 1)

$app = Start-Process -FilePath $exe -WorkingDirectory (Join-Path $root "src-tauri") -PassThru
$title = ""
while ($sw.Elapsed.TotalSeconds -lt 90) {
  Start-Sleep -Seconds 1
  $p = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if (-not $p) { echo "FAIL app exited early"; exit 1 }
  if ($p.MainWindowTitle) { $title = $p.MainWindowTitle; break }
}
if (-not $title) { echo "FAIL no window title in 90s"; exit 1 }
echo "APP_READY title=`"$title`" pid=$($app.Id)"
@($viteCmd.ProcessId, $app.Id) | Set-Content (Join-Path $rundir "pids.txt")
echo "PIDS_SAVED $($viteCmd.ProcessId),$($app.Id)"
