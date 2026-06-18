@echo off
REM ============================================
REM   Launch the Supervisor agent in the
REM   current agent of your choice (default: Claude Code).
REM
REM   Usage:
REM     open-supervisor.cmd            (defaults to claude)
REM     open-supervisor.cmd codex      (run via Codex)
REM     open-supervisor.cmd hermes     (run via Hermes)
REM ============================================
setlocal
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

set "ROLE_DOC=docs\supervisor-agent.md"
set "PROMPT=You are now operating in Supervisor mode. Read %ROLE_DOC% in full, then run the operating loop defined there. End with the 5-section summary."

if /i "%~1"=="codex" goto :codex
if /i "%~1"=="hermes" goto :hermes
goto :claude

:claude
where claude >nul 2>&1
if errorlevel 1 (
  echo Claude Code CLI not on PATH. Install: npm install -g @anthropic-ai/claude-code
  pause & exit /b 1
)
start "Supervisor (Claude Code) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && claude /agents run supervisor"
exit /b 0

:codex
where codex >nul 2>&1
if errorlevel 1 (
  echo Codex CLI not on PATH. Install: npm install -g @openai/codex@latest
  pause & exit /b 1
)
start "Supervisor (Codex) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && codex exec "%PROMPT%""
exit /b 0

:hermes
where hermes >nul 2>&1
if errorlevel 1 (
  echo Hermes CLI not on PATH.
  pause & exit /b 1
)
start "Supervisor (Hermes) - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && hermes chat -z "%PROMPT%""
exit /b 0
