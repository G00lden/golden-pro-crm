$appDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $appDir
$env:ENV_FILE = if ($env:ENV_FILE) { $env:ENV_FILE } else { ".env.production" }
$env:NODE_ENV = "production"
$env:ENABLE_VITE_DEV_SERVER = "false"
$env:PORT = "3000"
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
