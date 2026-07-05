@echo off
REM ── تفعيل التحديث التلقائي (مرة واحدة) — دبل-كليك ──
REM يسجّل مهمة مجدولة تسحب آخر كود وتعيد التشغيل تلقائيًا عند وجود جديد.
REM يُفضّل تشغيله كمسؤول (كليك يمين > Run as administrator).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-update-task.ps1" -RunNow
echo.
pause
