$AppDir = "C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2"
$TaskName = "Breexe Pro CRM Auto Update"

# Remove old task if exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Build the wrapper script with proper paths hardcoded
$WrapperPath = Join-Path $AppDir "scripts\update-wrapper.ps1"

$WrapperContent = @"
Set-Location '$AppDir'
git pull origin main
npm install
npm run build
`$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (`$conn) {
  try { Stop-Process -Id `$conn.OwningProcess -Force -ErrorAction Stop; Start-Sleep -Seconds 3 } catch {}
}
`$env:NODE_ENV = 'production'
Start-Process npm -ArgumentList 'run','start' -WorkingDirectory '$AppDir' -WindowStyle Hidden
"@

$WrapperContent | Out-File -FilePath $WrapperPath -Encoding ASCII -Force

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WrapperPath`"" `
  -WorkingDirectory $AppDir

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 60)

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 2)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Auto-update CRM from GitHub every 60 min" `
    -Force
  Write-Host "[OK] Task registered: $TaskName"
  Write-Host "Verify: Get-ScheduledTask -TaskName '$TaskName'"
} catch {
  Write-Host "[FALLBACK] Register-ScheduledTask failed (needs Admin): $($_.Exception.Message)"
  $StartupDir = [Environment]::GetFolderPath("Startup")
  $ShortcutPath = Join-Path $StartupDir "Breexe Pro CRM Update.lnk"
  $WScriptShell = New-Object -ComObject WScript.Shell
  $Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = "powershell.exe"
  $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WrapperPath`""
  $Shortcut.WorkingDirectory = $AppDir
  $Shortcut.Description = "Auto-update Breexe Pro CRM"
  $Shortcut.Save()
  Write-Host "[FALLBACK] Created startup shortcut: $ShortcutPath"
}
