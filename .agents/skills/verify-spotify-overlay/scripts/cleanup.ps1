# Cleanup: kill only recorded PIDs. Evidence log survives.
$rundir = Join-Path ([IO.Path]::GetTempPath()) "opencode/verify-run"
$pidsFile = Join-Path $rundir "pids.txt"
if (Test-Path -LiteralPath $pidsFile) {
  $ids = Get-Content -LiteralPath $pidsFile
  foreach ($id in $ids) {
    if ($id -match '^\d+$') {
      # Direct node children of the recorded cmd (npm_cli).
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$id AND Name='node.exe'" |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; echo "KILLED child node $($_.ProcessId)" }
      Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue
      echo "KILLED $id"
    }
  }
  # Orphaned grandchildren (vite.js reparented after npm dies), scoped by
  # command line to this project's vite only.
  Start-Sleep -Seconds 2
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*Spotify Overlay*vite*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; echo "KILLED orphan vite $($_.ProcessId)" }
  Remove-Item -LiteralPath $pidsFile -Force
} else { echo "WARN no pids file, nothing started by launch" }
$log = Join-Path $rundir "evidence.log"
if (Test-Path -LiteralPath $log) { echo "EVIDENCE_KEPT $log" } else { echo "WARN no evidence log" }
