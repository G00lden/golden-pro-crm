param(
  [string]$ConfigPath = ".runtime\cloudflared\config.yml"
)

$ErrorActionPreference = "Stop"

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
  $cloudflared = "cloudflared"
}

if (-not (Test-Path $ConfigPath)) {
  throw "Tunnel config was not found. Run scripts\setup-cloudflare-tunnel.ps1 first."
}

& $cloudflared tunnel --config $ConfigPath run
