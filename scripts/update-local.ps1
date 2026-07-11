#requires -Version 5
# ── تحديث النسخة المحلية من crm.breexe-pro.com ──
# يسحب آخر كود من main. لو فيه جديد: يبني الواجهة، يوقف السيرفر القديم،
# ويشغّل الجديد + يتأكد أن نفق Cloudflare شغّال. لو مافيش جديد: يتأكد فقط
# أن السيرفر والنفق شغّالين (بدون إعادة تشغيل / بدون انقطاع).
# يُشغَّل يدويًا عبر update-local.cmd، أو تلقائيًا عبر مهمة مجدولة.

param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3000,
  [switch]$Force  # أعد البناء وإعادة التشغيل حتى لو مافيش كود جديد
)

$ErrorActionPreference = "Stop"
Set-Location $AppDir

if (git status --porcelain) {
  throw "Working tree has local changes. Back them up or commit them before updating production."
}

Write-Host "== سحب آخر كود من main ==" -ForegroundColor Cyan
$before = (git rev-parse HEAD).Trim()
git pull --ff-only origin main
$after = (git rev-parse HEAD).Trim()

$changed = ($before -ne $after) -or $Force

if (-not $changed) {
  Write-Host "لا يوجد تحديث جديد ($after). التأكد فقط أن السيرفر والنفق شغّالين..." -ForegroundColor DarkGray
  & (Join-Path $PSScriptRoot "start-crm-local-stack.ps1") -AppDir $AppDir -Port $Port
  Write-Host "جاهز." -ForegroundColor Green
  return
}

Write-Host "== تثبيت الحزم (لو فيه جديد) ==" -ForegroundColor Cyan
npm ci

Write-Host "== بناء الواجهة ==" -ForegroundColor Cyan
npm run build

Write-Host "== إيقاف السيرفر القديم على المنفذ $Port ==" -ForegroundColor Cyan
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

Write-Host "== تشغيل السيرفر + التأكد من نفق Cloudflare ==" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "start-crm-local-stack.ps1") -AppDir $AppDir -Port $Port

Write-Host ""
Write-Host "تم التحديث إلى $after. افتح crm.breexe-pro.com واعمل Ctrl+Shift+R." -ForegroundColor Green
Write-Host "تحقّق الصحة: curl http://127.0.0.1:$Port/api/health"
