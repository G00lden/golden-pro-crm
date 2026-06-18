@echo off
REM ============================================
REM  Launch the Supervisor agent.
REM
REM  Usage:
REM    open-supervisor.cmd            (default: Claude Code)
REM    open-supervisor.cmd codex      (run via Codex)
REM    open-supervisor.cmd hermes     (run via Hermes)
REM    open-supervisor.cmd precheck   (run the pre-check script only)
REM ============================================
setlocal
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

REM First arg picks the agent.
if /i "%~1"=="codex" goto :codex
if /i "%~1"=="hermes" goto :hermes
if /i "%~1"=="precheck" goto :precheck
goto :claude

:claude
REM Use the working Claude Code binary at AppData\Roaming\Claude\claude-code\.
set "CLAUDE_BIN=%LOCALAPPDATA%\..\Roaming\Claude\claude-code\2.1.170\claude.exe"
if not exist "%CLAUDE_BIN%" (
  echo Claude Code binary not found at:
  echo   %CLAUDE_BIN%
  echo Reinstall: https://docs.anthropic.com/claude-code
  pause & exit /b 1
)
start "Supervisor (Claude Code) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && "%CLAUDE_BIN%""
echo Claude Code window opened. In the chat, paste:
echo.
echo   Operate in Supervisor mode. Read docs\supervisor-agent.md
echo   in full, run the operating loop, end with the 5-section summary.
echo.
exit /b 0

:codex
where codex >nul 2>&1
if errorlevel 1 (
  echo Codex CLI not on PATH. Install: npm install -g @openai/codex@latest
  pause & exit /b 1
)
start "Supervisor (Codex) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && codex exec --cwd "%PROJECT_DIR%" "Operate in Supervisor mode. Read docs/supervisor-agent.md in full, run the operating loop, end with the 5-section summary.""
exit /b 0

:hermes
where hermes >nul 2>&1
if errorlevel 1 (
  echo Hermes CLI not on PATH.
  pause & exit /b 1
)
start "Supervisor (Hermes) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && hermes chat -z "Operate in Supervisor mode. Read docs/supervisor-agent.md in full, run the operating loop, end with the 5-section summary.""
exit /b 0

:precheck
pushd "%PROJECT_DIR%"
call npm run supervisor:precheck
call npm run supervisor:checklist
popd
exit /b 0
