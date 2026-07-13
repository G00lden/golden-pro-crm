param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "root",
  [string]$AppDir = "/opt/golden-pro-crm",
  [string]$ApprovedAppBase = "",
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
if ($AppDir.Contains("//") -or ($AppDir -split '/') -contains '.' -or $AppDir.EndsWith('/')) {
  throw "AppDir must be a canonical POSIX path."
}
if ($ApprovedAppBase) {
  if ($ApprovedAppBase -notmatch '^/[A-Za-z0-9._/-]+$' -or
      $ApprovedAppBase.Contains("//") -or
      ($ApprovedAppBase -split '/') -contains '..' -or
      ($ApprovedAppBase -split '/') -contains '.' -or
      $ApprovedAppBase.EndsWith('/')) {
    throw "ApprovedAppBase must be a safe canonical absolute POSIX path."
  }
}
if ($AppDir -ne "/opt/golden-pro-crm") {
  if (-not $ApprovedAppBase) {
    throw "A non-default AppDir requires -ApprovedAppBase."
  }
  if (-not $AppDir.StartsWith("$ApprovedAppBase/", [System.StringComparison]::Ordinal)) {
    throw "AppDir must be a child of ApprovedAppBase."
  }
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
$databasePath = [string]$productionEnv["DB_PATH"]
if ($databasePath -notin @(".runtime/golden-crm.db", "/app/.runtime/golden-crm.db")) {
  throw "DB_PATH must resolve to /app/.runtime/golden-crm.db so backup and restore target the live database."
}

Write-Host "Running local production checks..."
npm run doctor:prod
Assert-NativeSuccess "Production doctor"
npm run lint
Assert-NativeSuccess "TypeScript lint"
npm run test:unit
Assert-NativeSuccess "Unit test suite"
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

# Upload immutable inputs into a unique /tmp bundle. Uploading does not mutate
# APP_DIR. One subsequent SSH process owns the shared flock across backup,
# preservation, clean source swap, build, public health, and any rollback.
$remoteBundle = ""
$remoteBundleCreated = $false
$transactionStarted = $false
$allowFirst = if ($AllowFirstDeployWithoutBackup) { "true" } else { "false" }
$transactionResolved = $false

try {
  Write-Host "Uploading the immutable deployment bundle..."
  $remoteBundleOutput = @(ssh @sshOptions $sshTarget "umask 077; mktemp -d /tmp/golden-pro-crm-deploy.XXXXXXXXXX")
  Assert-NativeSuccess "Remote deployment bundle preparation"
  $remoteBundle = ($remoteBundleOutput -join "").Trim()
  if ($remoteBundle -notmatch '^/tmp/golden-pro-crm-deploy\.[A-Za-z0-9]+$') {
    throw "Remote deployment bundle returned an unsafe path."
  }
  $remoteBundleCreated = $true
  $remoteArchive = "$remoteBundle/release.tar.gz"
  $remoteEnv = "$remoteBundle/env.production"
  $remoteTransaction = "$remoteBundle/vps-deploy-transaction.sh"
  $remoteBackup = "$remoteBundle/vps-backup.sh"
  $remotePreserve = "$remoteBundle/vps-preserve-deploy-state.sh"
  $remoteRollback = "$remoteBundle/remote-rollback.sh"
  $remoteBootstrapFile = "$remoteBundle/bootstrap-vps.sh"
  $remoteBootstrap = if ($SkipBootstrap) { "" } else { $remoteBootstrapFile }
  scp @sshOptions $archiveRelative "${sshTarget}:$remoteArchive"
  Assert-NativeSuccess "Project archive upload"
  scp @sshOptions ".env.production" "${sshTarget}:$remoteEnv"
  Assert-NativeSuccess "Production environment bundle upload"
  scp @sshOptions "scripts/vps-deploy-transaction.sh" "${sshTarget}:$remoteTransaction"
  Assert-NativeSuccess "Deployment transaction helper upload"
  scp @sshOptions "scripts/vps-backup.sh" "${sshTarget}:$remoteBackup"
  Assert-NativeSuccess "Trusted backup helper upload"
  scp @sshOptions "scripts/vps-preserve-deploy-state.sh" "${sshTarget}:$remotePreserve"
  Assert-NativeSuccess "Trusted state-preservation helper upload"
  scp @sshOptions "deploy/remote-rollback.sh" "${sshTarget}:$remoteRollback"
  Assert-NativeSuccess "Trusted rollback helper upload"
  scp @sshOptions "deploy/bootstrap-vps.sh" "${sshTarget}:$remoteBootstrapFile"
  Assert-NativeSuccess "Bootstrap bundle upload"

  Write-Host "Running one locked backup, source swap, build, health, and rollback transaction..."
  $transactionStarted = $true
  ssh @sshOptions $sshTarget "sed -i 's/\r$//' '$remoteTransaction' '$remoteBackup' '$remotePreserve' '$remoteRollback' '$remoteBootstrapFile'; chmod 700 '$remoteTransaction' '$remoteBackup' '$remotePreserve' '$remoteRollback' '$remoteBootstrapFile'; APP_DIR='$AppDir' DEPLOY_APPROVED_APP_BASE='$ApprovedAppBase' CRM_DOMAIN='$Domain' DEPLOY_ARCHIVE='$remoteArchive' DEPLOY_ENV_FILE='$remoteEnv' DEPLOY_BACKUP_HELPER='$remoteBackup' DEPLOY_PRESERVE_HELPER='$remotePreserve' DEPLOY_ROLLBACK_HELPER='$remoteRollback' USE_EXISTING_ENV=false ALLOW_FIRST_DEPLOY='$allowFirst' DEPLOY_BOOTSTRAP='$remoteBootstrap' EXPECTED_VERSION='$releaseVersion' EXPECTED_BUILD='$buildCommit' bash '$remoteTransaction'"
  $transactionExit = $LASTEXITCODE
  if ($transactionExit -eq 0) {
    $transactionResolved = $true
  } elseif ($transactionExit -eq 1) {
    $transactionResolved = $true
    throw "The remote deployment failed and the previous source and runtime were restored."
  } elseif ($transactionExit -eq 2) {
    $transactionResolved = $true
    throw "The remote deployment and automatic recovery both failed. Inspect the retained transaction recovery artifacts before another deploy."
  } elseif ($transactionExit -eq 75) {
    $transactionResolved = $true
    throw "Another backup, restore, or deployment owns the shared lock; no deployment mutation was started."
  } else {
    throw "The remote outcome is ambiguous (exit $transactionExit). The unique remote bundle was retained for investigation; do not start another deploy until the shared lock state is checked."
  }
} finally {
  if ($remoteBundleCreated -and ((-not $transactionStarted) -or $transactionResolved)) {
    ssh @sshOptions $sshTarget "rm -rf -- '$remoteBundle'" 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Deployment bundle cleanup failed; remove the root-only bundle manually after inspection: $remoteBundle"
    }
  }
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
