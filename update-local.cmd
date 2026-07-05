@echo off
REM ── تحديث crm.breexe-pro.com المحلي بضغطة واحدة (دبل-كليك) ──
REM يسحب آخر كود، يبني، ويعيد تشغيل السيرفر + نفق Cloudflare.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-local.ps1"
echo.
pause
