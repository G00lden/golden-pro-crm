@echo off
title Golden Pro CRM - تشغيل محلي
cd /d "%~dp0"
echo ============================================
echo   Golden Pro CRM  -  Local run
echo   %CD%
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [!] Node.js غير مثبت. ثبّت Node 20+ من https://nodejs.org ثم اعد المحاولة.
  pause
  exit /b 1
)

if not exist node_modules (
  echo تثبيت الحزم لأول مرة... قد ياخذ دقائق.
  call npm install
  if errorlevel 1 ( echo [!] فشل التثبيت. & pause & exit /b 1 )
)

echo.
echo تشغيل السيرفر على http://localhost:3000
echo الوضع: محلي بالكامل (بياناتك تُحفظ في المتصفح - لا يحتاج انترنت).
echo سيفتح المتصفح تلقائيا خلال 15 ثانية. اترك هذي النافذة مفتوحة.
echo اذا ظهرت صفحة خطأ في المتصفح، انتظر ثانيتين واضغط تحديث (F5).
echo لإيقاف البرنامج: اضغط Ctrl+C في هذي النافذة.
echo.

start "" cmd /c "timeout /t 15 >nul & start http://localhost:3000"
call npm run dev

echo.
echo توقف السيرفر.
pause
