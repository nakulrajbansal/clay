# Clay launcher: build, serve on a FIXED port (stable origin -> your data
# persists between launches), open as a standalone app window.
# Double-click clay.cmd to run this.
# NOTE: no $ErrorActionPreference = "Stop" here - vite writes progress to
# stderr, which PowerShell 5.1 would turn into a fatal error. Exit codes
# are checked explicitly instead.
Set-Location $PSScriptRoot
$port = 4173

Write-Host "Building Clay..." -ForegroundColor Cyan
pnpm build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed - see output above." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

# Start the local server unless one is already running on the port
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -WindowStyle Hidden cmd -ArgumentList "/c",
    "pnpm --filter @clay/shell exec vite preview --port $port --strictPort"
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      $ready = $true; break
    }
  }
  if (-not $ready) {
    Write-Host "Server did not start on port $port." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
} else {
  Write-Host "Server already running on port $port - reusing it."
}

# Prefer an app-mode window (no tabs/URL bar); fall back to the default browser
$edgePaths = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  Start-Process $edge "--app=http://localhost:$port/"
} else {
  Start-Process "http://localhost:$port/"
}
Write-Host "Clay is running at http://localhost:$port/ (close this window freely)." -ForegroundColor Green
