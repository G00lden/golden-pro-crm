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
Require-Command "git"

if ($HostName -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$') {
  throw "HostName contains unsupported characters."
}
if ($User -notmatch '^[A-Za-z_][A-Za-z0-9._-]*$') {
  throw "User contains unsupported characters."
}
if ($AppDir -notmatch '^/[A-Za-z0-9._/-]+$' -or ($AppDir -split '/') -contains '..') {
  throw "AppDir must be a safe absolute POSIX path without '..'."
}
if ($Domain -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$' -or $Domain -notmatch '\.') {
  throw "Domain contains unsupported characters or is not a fully qualified name."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$dirtyEntries = @(git status --porcelain=v1 --untracked-files=normal)
Assert-NativeSuccess "Git worktree check"
if ($dirtyEntries.Count -gt 0) {
  throw "Refusing to deploy a dirty worktree. Commit or remove every tracked and untracked change first."
}

$buildCommit = (& git rev-parse --short=12 HEAD).Trim()
Assert-NativeSuccess "Build commit detection"
if ($buildCommit -notmatch '^[0-9a-f]{7,40}$') {
  throw "Unable to determine a safe Git build commit."
}

Write-Host "Running local production checks..."
npm run doctor:prod
Assert-NativeSuccess "Production doctor"
npm run lint
Assert-NativeSuccess "TypeScript lint"
npm run build
Assert-NativeSuccess "Production build"

$postBuildDirtyEntries = @(git status --porcelain=v1 --untracked-files=normal)
Assert-NativeSuccess "Post-build Git worktree check"
if ($postBuildDirtyEntries.Count -gt 0) {
  throw "The production checks changed the worktree. Refusing to package content that does not match BUILD_COMMIT."
}

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
  --exclude="backups" `
  --exclude="./backups" `
  --exclude="data" `
  --exclude="*.db" `
  --exclude="*.db-shm" `
  --exclude="*.db-wal" `
  --exclude=".security-backup-*" `
  --exclude="service-account*.json" `
  --exclude="firebase-service-account*.json" `
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
ssh @sshOptions $sshTarget "cd '$AppDir' && BUILD_COMMIT='$buildCommit' CRM_DOMAIN='$Domain' bash deploy/remote-start.sh"
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
