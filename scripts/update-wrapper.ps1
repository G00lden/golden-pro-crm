Set-Location 'C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2'
git pull origin main
npm install
npm run build
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop; Start-Sleep -Seconds 3 } catch {}
}
$env:NODE_ENV = 'production'
Start-Process npm -ArgumentList 'run','start' -WorkingDirectory 'C:\Users\owner\Documents\Codex\2026-04-25\files-mentioned-by-the-user-golden-2' -WindowStyle Hidden
