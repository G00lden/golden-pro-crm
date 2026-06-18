@echo off
REM ============================================
REM   Golden Pro CRM - Open all 3 agents in
REM   separate terminals, all rooted at this dir
REM ============================================
setlocal
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo.
echo Opening 3 agents on: %PROJECT_DIR%
echo   1) Claude Code
echo   2) Codex CLI
echo   3) Hermes
echo.

REM Sync first so all 3 start from the same baseline
pushd "%PROJECT_DIR%"
echo [git] fetching latest...
git fetch origin >nul 2>&1
git status --short
popd
echo.

REM ----- Claude Code -----
where claude >nul 2>&1
if %errorlevel%==0 (
  start "Claude Code - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && claude"
) else (
  start "Claude Code (missing)" cmd /k "echo Claude Code CLI not on PATH. Install: npm install -g @anthropic-ai/claude-code && pause"
)

REM ----- Codex CLI -----
where codex >nul 2>&1
if %errorlevel%==0 (
  start "Codex - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && codex"
) else (
  start "Codex (missing)" cmd /k "echo Codex CLI not on PATH. Install: npm install -g @openai/codex@latest && pause"
)

REM ----- Hermes -----
where hermes >nul 2>&1
if %errorlevel%==0 (
  start "Hermes - golden-pro-crm" cmd /k "cd /d "%PROJECT_DIR%" && hermes chat"
) else (
  start "Hermes (missing)" cmd /k "echo Hermes CLI not on PATH. See: https://hermes-agent.nousresearch.com && pause"
)

echo Done. Three terminal windows should now be open.
echo Each agent will auto-read AGENTS.md from this folder.
echo.
echo To stop the dev server (if running), close its window.
echo To start it: npm run dev
echo.
endlocal
exit /b 0
