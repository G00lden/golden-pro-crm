param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [string]$AppDir = "/opt/golden-pro-crm",
  [string]$Domain = "crm.breexe-pro.com",
  [string]$SshKey = "",
  [switch]$SkipBootstrap,
  [switch]$SkipDns,
  [switch]$AllowFirstDeployWithoutBackup
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
$release = Get-Content -LiteralPath "release.json" -Raw | ConvertFrom-Json
$releaseVersion = [string]$release.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "release.json does not contain a valid release version."
}

# Validate the two public/proxy build inputs before any remote write. Values are
# intentionally never printed because this parser also reads the secrets file.
$productionEnvPath = Join-Path $root ".env.production"
if (-not (Test-Path -LiteralPath $productionEnvPath -PathType Leaf)) {
  throw ".env.production is required for VPS deployment."
}
$productionEnv = @{}
foreach ($rawLine in Get-Content -LiteralPath $productionEnvPath) {
  $line = $rawLine.Trim()
  if (-not $line -or $line.StartsWith("#")) { continue }
  if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $productionEnv[$Matches[1]] = $value
  }
}
if ($productionEnv["TRUST_PROXY_HEADERS"] -cne "true") {
  throw "TRUST_PROXY_HEADERS must be true for the bundled trusted Caddy proxy."
}
$publicContactPhone = [string]$productionEnv["VITE_PUBLIC_CONTACT_PHONE"]
if ($publicContactPhone -notmatch '^\+[1-9][0-9]{7,14}$') {
  throw "VITE_PUBLIC_CONTACT_PHONE must be a valid E.164 number."
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

# Back up the currently running deployment before uploading or extracting any
# new source. A first deployment requires an explicit acknowledgement because
# there is no state to protect yet.
$deploymentState = @(
  ssh @sshOptions $sshTarget "if command -v docker >/dev/null 2>&1 && [ -f '$AppDir/scripts/vps-backup.sh' ] && [ -f '$AppDir/deploy/docker-compose.yml' ] && [ -f '$AppDir/.env.production' ] && docker compose --env-file '$AppDir/.env.production' -f '$AppDir/deploy/docker-compose.yml' ps -q crm 2>/dev/null | grep -q .; then printf running; else printf absent; fi"
)
Assert-NativeSuccess "Remote deployment state probe"
$deploymentStateText = ($deploymentState -join "").Trim()
$hasPreservedDeployment = $deploymentStateText -eq "running"
if ($deploymentStateText -eq "running") {
  Write-Host "Creating a fail-closed backup of the current VPS state..."
  ssh @sshOptions $sshTarget "cd '$AppDir' && APP_DIR='$AppDir' bash scripts/vps-backup.sh"
  Assert-NativeSuccess "Pre-deployment VPS backup"

  Write-Host "Preserving the exact running Compose, Caddy, environment, and image state..."
  scp @sshOptions "scripts/vps-preserve-deploy-state.sh" "${sshTarget}:/tmp/golden-preserve-deploy-state.sh"
  Assert-NativeSuccess "Deployment-state helper upload"
  scp @sshOptions "deploy/remote-rollback.sh" "${sshTarget}:/tmp/golden-remote-rollback.sh"
  Assert-NativeSuccess "Trusted rollback helper upload"
  ssh @sshOptions $sshTarget "sed -i 's/\r$//' /tmp/golden-preserve-deploy-state.sh /tmp/golden-remote-rollback.sh && chmod 700 /tmp/golden-remote-rollback.sh && APP_DIR='$AppDir' bash /tmp/golden-preserve-deploy-state.sh"
  Assert-NativeSuccess "Pre-extraction deployment-state preservation"
} elseif (-not $AllowFirstDeployWithoutBackup) {
  throw "No running CRM deployment was found to back up. Use -AllowFirstDeployWithoutBackup only for a verified first deployment."
}

try {
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
  ssh @sshOptions $sshTarget "cd '$AppDir' && EXPECTED_VERSION='$releaseVersion' EXPECTED_BUILD='$buildCommit' BUILD_COMMIT='$buildCommit' CRM_DOMAIN='$Domain' bash deploy/remote-start.sh"
  Assert-NativeSuccess "Remote Docker deployment"

  Write-Host "Verifying the public HTTPS release contract..."
  $health = Invoke-RestMethod -Uri "https://$Domain/api/health" -TimeoutSec 30
  if ($health.status -ne "ok" -or $health.release.version -ne $releaseVersion -or $health.commit -ne $buildCommit) {
    throw "Public health verification did not match the expected release."
  }
  $version = Invoke-RestMethod -Uri "https://$Domain/api/version" -TimeoutSec 30
  if ($version.version -ne $releaseVersion -or $version.commit -ne $buildCommit -or $version.runtime -ne "production") {
    throw "Public version verification did not match the deployed production release."
  }
} catch {
  $deploymentError = $_.Exception.Message
  if ($hasPreservedDeployment) {
    Write-Warning "Deployment verification or mutation failed; restoring the preserved deployment."
    ssh @sshOptions $sshTarget "APP_DIR='$AppDir' CRM_DOMAIN='$Domain' bash /tmp/golden-remote-rollback.sh"
    $rollbackExitCode = $LASTEXITCODE
    if ($rollbackExitCode -ne 0) {
      throw "Deployment failed and automatic rollback also failed (exit $rollbackExitCode). Original error: $deploymentError"
    }
    throw "Deployment failed; the previous deployment was restored. Original error: $deploymentError"
  }
  throw "First deployment failed and no previous deployment exists to restore. Original error: $deploymentError"
}

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
