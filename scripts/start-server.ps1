Set-Location 'C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$process = Start-Process -FilePath $npm -ArgumentList 'run','start' -PassThru -WindowStyle Hidden
Write-Host "Server PID: $($process.Id)"
Start-Sleep 8
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
  Write-Host "Health: $($health.status)"
} catch {
  Write-Host "Health FAILED (may need more time)"
}
