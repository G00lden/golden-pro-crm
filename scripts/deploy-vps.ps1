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

function Assert-NativeSuccess([string]$operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$operation failed with exit code $LASTEXITCODE."
  }
}

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "Running local production checks..."
npm run doctor:prod
Assert-NativeSuccess "Production doctor"
npm run lint
Assert-NativeSuccess "TypeScript lint"
npm run build
Assert-NativeSuccess "Production build"

$runtime = Join-Path $root ".runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$archiveRelative = ".runtime/golden-pro-crm-vps.tar.gz"
$archive = Join-Path $root $archiveRelative
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
  -czf $archiveRelative .
Assert-NativeSuccess "Deploy archive creation"

$sshTarget = "$User@$HostName"
$sshOptions = @()
if ($SshKey) {
  $sshOptions = @("-i", $SshKey)
}

if (-not $SkipBootstrap) {
  Write-Host "Uploading and running VPS bootstrap..."
  scp @sshOptions "deploy/bootstrap-vps.sh" "${sshTarget}:/tmp/golden-bootstrap-vps.sh"
  Assert-NativeSuccess "Bootstrap upload"
  ssh @sshOptions $sshTarget "sed -i 's/\r$//' /tmp/golden-bootstrap-vps.sh && APP_DIR='$AppDir' bash /tmp/golden-bootstrap-vps.sh"
  Assert-NativeSuccess "VPS bootstrap"
}

Write-Host "Uploading project archive..."
ssh @sshOptions $sshTarget "mkdir -p '$AppDir'"
Assert-NativeSuccess "Remote application directory preparation"
scp @sshOptions $archiveRelative "${sshTarget}:/tmp/golden-pro-crm-vps.tar.gz"
Assert-NativeSuccess "Project archive upload"
ssh @sshOptions $sshTarget "tar -xzf /tmp/golden-pro-crm-vps.tar.gz -C '$AppDir'"
Assert-NativeSuccess "Project archive extraction"
ssh @sshOptions $sshTarget "find '$AppDir/deploy' '$AppDir/scripts' -type f -name '*.sh' -exec sed -i 's/\r$//' {} +"
Assert-NativeSuccess "Linux script line-ending normalization"

Write-Host "Uploading .env.production separately..."
scp @sshOptions ".env.production" "${sshTarget}:${AppDir}/.env.production"
Assert-NativeSuccess "Production environment upload"
ssh @sshOptions $sshTarget "chmod 600 '$AppDir/.env.production'"
Assert-NativeSuccess "Production environment permissions"

Write-Host "Starting Docker Compose on VPS..."
ssh @sshOptions $sshTarget "cd '$AppDir' && CRM_DOMAIN='$Domain' bash deploy/remote-start.sh"
Assert-NativeSuccess "Remote Docker deployment"

if (-not $SkipDns) {
  $env:CLOUDFLARE_RECORD_NAME = "crm"
  $env:CLOUDFLARE_RECORD_TYPE = "A"
  $env:CLOUDFLARE_DNS_TARGET = $HostName
  $env:CLOUDFLARE_PROXIED = "true"
  if ($env:CLOUDFLARE_API_TOKEN) {
    Write-Host "Updating Cloudflare DNS record..."
    npm run cloudflare:dns
    Assert-NativeSuccess "Cloudflare DNS update"
  } else {
    Write-Host "CLOUDFLARE_API_TOKEN is not set. Add DNS manually:"
    Write-Host "Type=A, Name=crm, Value=$HostName, Proxy=ON"
  }
}

Write-Host "Deployment finished."
Write-Host "Check: https://$Domain/api/health"
