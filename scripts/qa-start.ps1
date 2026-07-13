[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 4173,

  [string]$QaRoot = "",

  [ValidateRange(1, 2)]
  [int]$SeedPasses = 1,

  [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $QaRoot) {
  $QaRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("golden-pro-crm-qa-" + [guid]::NewGuid().ToString("N"))
}
$qaRootPath = [System.IO.Path]::GetFullPath($QaRoot)
$repoPrefix = $repoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if ($qaRootPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "QA root must be outside the repository: $qaRootPath"
}

if (Test-Path -LiteralPath $qaRootPath) {
  $existing = Get-ChildItem -LiteralPath $qaRootPath -Force -ErrorAction Stop | Select-Object -First 1
  if ($existing) {
    throw "QA root must be a new or empty directory: $qaRootPath"
  }
} else {
  New-Item -ItemType Directory -Path $qaRootPath -Force | Out-Null
}

# Fail before starting a child if another service already owns the requested
# loopback port. This prevents a healthy unrelated server from being mistaken
# for the isolated QA process.
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
  $portProbe.Start()
} catch {
  throw "Port $Port is already in use on 127.0.0.1. Choose another -Port value."
} finally {
  $portProbe.Stop()
}

function New-QaSecret([int]$ByteCount = 32) {
  $bytes = [byte[]]::new($ByteCount)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

$baseUrl = "http://127.0.0.1:$Port"
$dbPath = Join-Path $qaRootPath "qa.db"
$sallaStorePath = Join-Path $qaRootPath "salla-integrations.json"
$waSessionPath = Join-Path $qaRootPath "wa-session"
$stdoutPath = Join-Path $qaRootPath "server.out.log"
$stderrPath = Join-Path $qaRootPath "server.err.log"
$manifestPath = Join-Path $qaRootPath "manifest.json"
$localAuthSecret = New-QaSecret 48
$storeWebhookSecret = "qa-store-" + (New-QaSecret 32)

$sensitiveKeys = @(
  "NODE_OPTIONS",
  "DOTENV_CONFIG_PATH",
  "DOTENV_CONFIG_OVERRIDE",
  "DOTENV_CONFIG_DOTENV_KEY",
  "DOTENV_KEY",
  "CRM_BEARER_TOKEN",
  "SALLA_CLIENT_ID",
  "SALLA_CLIENT_SECRET",
  "SALLA_STATE_SECRET",
  "SALLA_ACCESS_TOKEN",
  "SALLA_REFRESH_TOKEN",
  "SALLA_REDIRECT_URI",
  "WHATSAPP_CLOUD_API_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_CLOUD_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_NAME",
  "WHATSAPP_APP_SECRET",
  "TAP_SECRET_KEY",
  "TAP_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "FIREBASE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "JWT_SECRET",
  "SESSION_SECRET",
  "UNIFONIC_APP_SID",
  "UNIFONIC_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "OUTBOUND_CONFIRM_CODE",
  "OUTBOUND_TEST_PHONE_ALLOWLIST",
  "VITE_GTM_ID",
  "VITE_GA4_ID",
  "VITE_META_PIXEL_ID",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY"
)

$safeEnvironment = [ordered]@{
  NODE_ENV = "test"
  ENABLE_VITE_DEV_SERVER = "true"
  ENV_FILE = (Join-Path $qaRootPath "intentionally-missing.env")
  HOST = "127.0.0.1"
  PORT = [string]$Port
  APP_URL = $baseUrl
  PUBLIC_APP_URL = $baseUrl
  PUBLIC_BASE_URL = $baseUrl
  APP_BASE_URL = $baseUrl
  APP_TIMEZONE = "Asia/Riyadh"
  TRUST_PROXY_HEADERS = "false"
  DATA_PROVIDER = "sqlite"
  DB_PROVIDER = "sqlite"
  VITE_DATA_PROVIDER = "sqlite"
  VITE_DB_PROVIDER = "sqlite"
  DB_PATH = $dbPath
  DB_MIGRATION_BACKUP_DIR = (Join-Path $qaRootPath "backups")
  ALLOW_LOCAL_AUTH = "true"
  VITE_LOCAL_AUTH = "true"
  LOCAL_AUTH_TOKEN = $localAuthSecret
  LOCAL_AUTH_SHARED_UID = "local-dev-owner"
  LOCAL_AUTH_ALLOWED_HOSTS = "localhost,127.0.0.1,::1"
  ADMIN_UIDS = "local-dev-owner"
  PUBLIC_LEADS_OWNER_UID = "local-dev-owner"
  OUTBOUND_MODE = "dry_run"
  OFFICIAL_LAUNCH_APPROVED = "false"
  DISABLE_OUTBOUND = "true"
  DISABLE_HMR = "true"
  DISABLE_VITE_ENV_FILES = "true"
  ENABLE_DAILY_CRON = "false"
  SALLA_SYNC_CRON_ENABLED = "false"
  COMMUNICATION_WORKER_ENABLED = "false"
  WHATSAPP_PROVIDER = "cloud_api"
  WHATSAPP_WEBHOOK_VERIFY_TOKEN = ("qa-wa-verify-" + (New-QaSecret 18))
  WHATSAPP_WEBHOOK_SECRET = ("qa-wa-webhook-" + (New-QaSecret 24))
  WA_SESSION_DIR = $waSessionPath
  SALLA_AUTH_MODE = "easy"
  SALLA_INTEGRATION_STORE_PATH = $sallaStorePath
  SALLA_APP_OWNER_UID = "local-dev-owner"
  SALLA_APP_WEBHOOK_SECRET = ("qa-salla-" + (New-QaSecret 24))
  STORE_WEBHOOK_OWNER_UID = "local-dev-owner"
  STORE_WEBHOOK_SECRET = $storeWebhookSecret
  STORE_WEBHOOK_CREATE_BOOKINGS = "true"
  TELEPHONY_WEBHOOK_SECRET = ("qa-telephony-" + (New-QaSecret 24))
  GATEWAY_TOKEN = ("qa-gateway-" + (New-QaSecret 24))
  INVOICE_SHARE_SECRET = (New-QaSecret 48)
  VITE_ENABLE_TRACKING = "false"
  API_RATE_LIMIT_MAX = "5000"
  WEBHOOK_RATE_LIMIT_MAX = "5000"
}

$keysToRestore = @($sensitiveKeys + $safeEnvironment.Keys) | Sort-Object -Unique
$originalEnvironment = @{}
foreach ($key in $keysToRestore) {
  $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

$serverProcess = $null
$seeded = $false
try {
  foreach ($key in $sensitiveKeys) {
    [Environment]::SetEnvironmentVariable($key, $null, "Process")
  }
  foreach ($entry in $safeEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, "Process")
  }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $serverProcess = Start-Process `
    -FilePath $node `
    -ArgumentList @("--import=tsx", "server.ts") `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  $healthy = $false
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    if ($serverProcess.HasExited) {
      $details = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { "" }
      throw "QA server exited before becoming healthy. $details"
    }
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
      if ($health.status -eq "ok") {
        $healthy = $true
        break
      }
    } catch {
      # Retry only while the known child process is alive.
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $healthy) {
    throw "QA server did not become healthy at $baseUrl within 30 seconds."
  }

  if (-not $SkipSeed) {
    for ($seedPass = 1; $seedPass -le $SeedPasses; $seedPass += 1) {
      & $node "scripts/qa-seed.mjs" "--base-url=$baseUrl" "--uid=local-dev-owner"
      if ($LASTEXITCODE -ne 0) {
        throw "QA seed pass $seedPass failed with exit code $LASTEXITCODE."
      }
    }
    $seeded = $true
  }

  $manifest = [ordered]@{
    qaRoot = $qaRootPath
    baseUrl = $baseUrl
    pid = $serverProcess.Id
    dbPath = $dbPath
    sallaStorePath = $sallaStorePath
    waSessionDir = $waSessionPath
    stdout = $stdoutPath
    stderr = $stderrPath
    seeded = $seeded
    seedPasses = if ($seeded) { $SeedPasses } else { 0 }
    startedAt = [DateTime]::UtcNow.ToString("o")
  }
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
  )

  [pscustomobject]$manifest
} catch {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  foreach ($key in $keysToRestore) {
    [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
  }
}
