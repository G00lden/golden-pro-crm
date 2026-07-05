#requires -Version 5
# ── تسجيل مهمة مجدولة للتحديث التلقائي ──
# تشغّل scripts/update-local.ps1 كل فترة (افتراضي 60 دقيقة) وعند تسجيل الدخول.
# لو فيه كود جديد على main تبنيه وتعيد التشغيل؛ غير كده تتأكد فقط أن الخدمة شغّالة.
# شغّلها مرة واحدة عبر register-auto-update.cmd (كمسؤول يُفضّل).

param(
  [string]$TaskName = "Breexe Pro CRM Auto Update",
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000,
  [int]$IntervalMinutes = 60,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$updateScript = Join-Path $AppDir "scripts\update-local.ps1"
if (-not (Test-Path $updateScript)) {
  throw "Update script was not found: $updateScript"
}

$args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$updateScript`"",
  "-AppDir", "`"$AppDir`"",
  "-Port", "$Port"
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args -WorkingDirectory $AppDir

# مشغّلان: عند تسجيل الدخول + كل $IntervalMinutes دقيقة بلا نهاية
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 2)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($triggerLogon, $triggerRepeat) `
    -Settings $settings `
    -Description "Pulls latest main and rebuilds/restarts the local CRM only when new code arrives; otherwise ensures the server + Cloudflare tunnel are up." `
    -Force | Out-Null

  if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
  }

  Write-Host "تم تسجيل المهمة المجدولة: $TaskName (كل $IntervalMinutes دقيقة + عند تسجيل الدخول)" -ForegroundColor Green
  Write-Host "لإلغائها لاحقًا: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
} catch {
  Write-Warning "فشل تسجيل المهمة المجدولة (قد تحتاج صلاحية مسؤول). التفاصيل: $($_.Exception.Message)"
  throw
}
