param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000,
  [string]$CloudflaredConfig = "$env:USERPROFILE\.cloudflared\config-v2.yml"
)

$ErrorActionPreference = "Stop"

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Test-PortListening([int]$LocalPort) {
  $connection = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return $null -ne $connection
}

function Get-CloudflaredPath {
  $installed = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path $installed) {
    return $installed
  }
  $cmd = Get-Command cloudflared -ErrorAction Stop
  return $cmd.Source
}

function Test-CloudflaredRunning([string]$ConfigPath) {
  $normalized = $ConfigPath.Replace("/", "\")
  $processes = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $cmd = [string]$process.CommandLine
    if ($cmd.Replace("/", "\").Contains($normalized)) {
      return $true
    }
  }
  return $false
}

$runtimeDir = Join-Path $AppDir ".runtime"
Ensure-Directory $runtimeDir

if (-not (Test-PortListening $Port)) {
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Start-Process -FilePath $npm `
    -ArgumentList @("run", "start") `
    -WorkingDirectory $AppDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDir "crm-server.out.log") `
    -RedirectStandardError (Join-Path $runtimeDir "crm-server.err.log")
  Start-Sleep -Seconds 5
}

if (-not (Test-Path $CloudflaredConfig)) {
  throw "Cloudflared config was not found: $CloudflaredConfig"
}

if (-not (Test-CloudflaredRunning $CloudflaredConfig)) {
  $cloudflared = Get-CloudflaredPath
  Start-Process -FilePath $cloudflared `
    -ArgumentList @("tunnel", "--config", $CloudflaredConfig, "run") `
    -WorkingDirectory $AppDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDir "cloudflared-crm.out.log") `
    -RedirectStandardError (Join-Path $runtimeDir "cloudflared-crm.err.log")
}

