# Start Clay with the localhost Codex subscription connector, then launch the
# normal production preview. Double-click clay-codex.cmd to run this.
Set-Location $PSScriptRoot
if ($env:CLAY_CODEX_LAUNCHER_TEST -eq "1") {
  Write-Host "Clay Codex launcher self-test passed."
  exit 0
}
$connectorPort = 8788

$listening = Get-NetTCPConnection -LocalPort $connectorPort -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $logDir = Join-Path $env:LOCALAPPDATA "Clay"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logPath = Join-Path $logDir "codex-connector.log"
  Start-Process -WindowStyle Hidden cmd -ArgumentList "/c",
    "pnpm codex > `"$logPath`" 2>&1"
  $ready = $false
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -LocalPort $connectorPort -State Listen -ErrorAction SilentlyContinue) {
      $ready = $true; break
    }
  }
  if (-not $ready) {
    Write-Host "Codex connector did not start. Run codex logout, then codex login." -ForegroundColor Red
    Write-Host "Log: $logPath" -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
  }
} else {
  Write-Host "Codex connector already running on port $connectorPort."
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$connectorPort/healthz" -TimeoutSec 3
  if ($health.provider -ne "codex") {
    throw "Port $connectorPort is not a verified Clay Codex connector."
  }
} catch {
  Write-Host "Could not verify the Codex connector: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Codex connector is ready. Select Local Codex in Clay Settings." -ForegroundColor Green
& "$PSScriptRoot\clay.ps1"