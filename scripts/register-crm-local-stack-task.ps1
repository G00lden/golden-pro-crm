param(
  [string]$TaskName = "Breexe Pro CRM Local Stack",
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000,
  [string]$CloudflaredConfig = "$env:USERPROFILE\.cloudflared\config-v2.yml",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"

$startScript = Join-Path $AppDir "scripts\start-crm-local-stack.ps1"
if (-not (Test-Path $startScript)) {
  throw "Startup script was not found: $startScript"
}

$args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$startScript`"",
  "-AppDir", "`"$AppDir`"",
  "-Port", "$Port",
  "-CloudflaredConfig", "`"$CloudflaredConfig`""
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Starts the local Breexe Pro CRM server and Cloudflare tunnel for crm.breexe-pro.com." `
    -Force | Out-Null

  if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
  }

  Write-Host "Registered scheduled task: $TaskName"
} catch {
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    throw
  }

  $launcher = Join-Path $startupDir "BreexeProCRM.cmd"
  $command = "@echo off`r`npowershell.exe $args`r`n"
  Set-Content -Path $launcher -Value $command -Encoding ASCII

  if ($StartNow) {
    & powershell.exe @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $startScript,
      "-AppDir", $AppDir,
      "-Port", "$Port",
      "-CloudflaredConfig", $CloudflaredConfig
    )
  }

  Write-Host "Scheduled task registration failed; created startup launcher instead: $launcher"
}
