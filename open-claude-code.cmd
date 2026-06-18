@echo off
title Claude Code - Golden Pro CRM
cd /d "%~dp0"
echo ============================================
echo   Golden Pro CRM  -  Claude Code launcher
echo   Folder: %CD%
echo ============================================
echo.
where claude >nul 2>&1
if %errorlevel%==0 (
  echo Launching Claude Code...
  claude
) else (
  echo [!] Claude Code CLI not found on PATH.
  echo.
  echo Install it once with:
  echo     npm install -g @anthropic-ai/claude-code
  echo.
  echo Then double-click this file again.
  echo.
  pause
)
