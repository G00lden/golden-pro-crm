#requires -Version 5
# ── تحديث النسخة المحلية من crm.breexe-pro.com بضغطة واحدة ──
# يسحب آخر كود من main، يبني الواجهة، يوقف السيرفر القديم، ويشغّل السيرفر
# الجديد + يتأكد أن نفق Cloudflare شغّال. شغّله عبر update-local.cmd (دبل-كليك).

param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
Set-Location $AppDir

Write-Host "== 1/5 سحب آخر كود من main ==" -ForegroundColor Cyan
git pull origin main

Write-Host "== 2/5 تثبيت الحزم (لو فيه جديد) ==" -ForegroundColor Cyan
npm install

Write-Host "== 3/5 بناء الواجهة ==" -ForegroundColor Cyan
npm run build

Write-Host "== 4/5 إيقاف السيرفر القديم على المنفذ $Port ==" -ForegroundColor Cyan
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  try {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
    Write-Host "   تم إيقاف العملية (PID $($conn.OwningProcess))."
    Start-Sleep -Seconds 2
  } catch {
    Write-Warning "   تعذّر إيقاف العملية تلقائيًا — أقفل نافذة السيرفر يدويًا ثم أعد المحاولة."
  }
} else {
  Write-Host "   لا يوجد سيرفر شغّال على المنفذ $Port."
}

Write-Host "== 5/5 تشغيل السيرفر + التأكد من نفق Cloudflare ==" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "start-crm-local-stack.ps1") -AppDir $AppDir -Port $Port

Write-Host ""
Write-Host "تم التحديث. افتح crm.breexe-pro.com واعمل Ctrl+Shift+R لتجاوز الكاش." -ForegroundColor Green
Write-Host "تحقّق الصحة: curl http://127.0.0.1:$Port/api/health"
