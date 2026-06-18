param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [string]$AppDir = "/opt/golden-pro-crm",
  [string]$Domain = "crm.breexe-pro.com",
  [string]$SshKey = "",
  [switch]$SkipBootstrap,
  [switch]$SkipDns
)

$ErrorActionPreference = "Stop"

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name is required but was not found in PATH."
  }
}

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "Running local production checks..."
npm run doctor:prod
npm run lint
npm run build

$runtime = Join-Path $root ".runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$archive = Join-Path $runtime "golden-pro-crm-vps.tar.gz"
if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }

Write-Host "Creating deploy archive without secrets..."
tar `
  --exclude=".git" `
  --exclude="node_modules" `
  --exclude="dist" `
  --exclude=".runtime" `
  --exclude=".tools" `
  --exclude=".wa-session" `
  --exclude=".env" `
  --exclude=".env.*" `
  --exclude="*.log" `
  -czf $archive .

$sshTarget = "$User@$HostName"
$sshOptions = @()
if ($SshKey) {
  $sshOptions = @("-i", $SshKey)
}

if (-not $SkipBootstrap) {
  Write-Host "Uploading and running VPS bootstrap..."
  scp @sshOptions "deploy/bootstrap-vps.sh" "${sshTarget}:/tmp/golden-bootstrap-vps.sh"
  ssh @sshOptions $sshTarget "APP_DIR='$AppDir' bash /tmp/golden-bootstrap-vps.sh"
}

Write-Host "Uploading project archive..."
ssh @sshOptions $sshTarget "mkdir -p '$AppDir'"
scp @sshOptions $archive "${sshTarget}:/tmp/golden-pro-crm-vps.tar.gz"
ssh @sshOptions $sshTarget "tar -xzf /tmp/golden-pro-crm-vps.tar.gz -C '$AppDir'"

Write-Host "Uploading .env.production separately..."
scp @sshOptions ".env.production" "${sshTarget}:${AppDir}/.env.production"
ssh @sshOptions $sshTarget "chmod 600 '$AppDir/.env.production'"

Write-Host "Starting Docker Compose on VPS..."
ssh @sshOptions $sshTarget "cd '$AppDir' && CRM_DOMAIN='$Domain' bash deploy/remote-start.sh"

if (-not $SkipDns) {
  $env:CLOUDFLARE_RECORD_NAME = "crm"
  $env:CLOUDFLARE_RECORD_TYPE = "A"
  $env:CLOUDFLARE_DNS_TARGET = $HostName
  $env:CLOUDFLARE_PROXIED = "true"
  if ($env:CLOUDFLARE_API_TOKEN) {
    Write-Host "Updating Cloudflare DNS record..."
    npm run cloudflare:dns
  } else {
    Write-Host "CLOUDFLARE_API_TOKEN is not set. Add DNS manually:"
    Write-Host "Type=A, Name=crm, Value=$HostName, Proxy=ON"
  }
}

Write-Host "Deployment finished."
Write-Host "Check: https://$Domain/api/health"
