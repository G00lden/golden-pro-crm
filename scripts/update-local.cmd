@echo off
REM ============================================================
REM  BreeXe Pro CRM - تحديث بضغطة واحدة (One-click update)
REM  انقر عليه نقرًا مزدوجًا على جهاز الويندوز الذي يشغّل النظام.
REM  يسحب آخر كود من main، يبني الواجهة، ويعيد تشغيل السيرفر.
REM  ثم افتح crm.breexe-pro.com واضغط Ctrl+Shift+R مرة واحدة.
REM ============================================================
setlocal
cd /d "%~dp0\.."
echo === BreeXe Pro CRM: جاري التحديث... ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-local.ps1" -Force
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo === تم التحديث بنجاح. الان افتح الموقع واضغط Ctrl+Shift+R مرة واحدة. ===
) else (
  echo === حدث خطاء اثناء التحديث ^(رمز %RC%^). ارسل الصورة اعلاه للدعم. ===
)
echo.
pause
endlocal
