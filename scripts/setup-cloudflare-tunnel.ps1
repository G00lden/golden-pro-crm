param(
  [string]$TunnelName = "golden-pro-crm",
  [string]$Hostname = "crm.breexe-pro.com",
  [string]$Service = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
  $cloudflared = "cloudflared"
}

$certPath = Join-Path $env:USERPROFILE ".cloudflared\cert.pem"
if (-not (Test-Path $certPath)) {
  throw "Cloudflare login is not complete. Run: cloudflared tunnel login, choose breexe-pro.com, then re-run this script."
}

$runtimeDir = Join-Path (Get-Location) ".runtime\cloudflared"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$tunnelsJson = & $cloudflared tunnel list --output json 2>$null
$tunnels = @()
if ($tunnelsJson) {
  $tunnels = @($tunnelsJson | ConvertFrom-Json)
}

$tunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1
if (-not $tunnel) {
  $created = & $cloudflared tunnel create $TunnelName 2>&1 | Out-String
  if ($created -notmatch "([0-9a-fA-F-]{36})") {
    throw "Could not parse tunnel id from cloudflared output: $created"
  }
  $tunnelId = $matches[1]
} else {
  $tunnelId = $tunnel.id
}

$credentials = Join-Path $env:USERPROFILE ".cloudflared\$tunnelId.json"
if (-not (Test-Path $credentials)) {
  throw "Tunnel credentials file was not found: $credentials"
}

$credentialsYaml = $credentials.Replace("\", "/")
$configPath = Join-Path $runtimeDir "config.yml"
$config = @"
tunnel: $tunnelId
credentials-file: "$credentialsYaml"

ingress:
  - hostname: $Hostname
    service: $Service
  - service: http_status:404
"@

Set-Content -Path $configPath -Value $config -Encoding UTF8

& $cloudflared tunnel route dns $TunnelName $Hostname | Out-Host

Write-Host "Cloudflare Tunnel is configured."
Write-Host "Config: $configPath"
Write-Host "Run:"
Write-Host "  cloudflared tunnel --config `"$configPath`" run"
