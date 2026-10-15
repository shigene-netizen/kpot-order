@echo off
REM ===========================================================================
REM  KPOT To Go - kitchen print agent launcher
REM ---------------------------------------------------------------------------
REM  Double-click this file. A window opens and stays open while the agent runs.
REM  Keep it open - closing the window stops printing.
REM
REM  If Windows says "node is not recognized", Node.js is not installed.
REM  Install the LTS version from https://nodejs.org and run this again.
REM ===========================================================================

title KPOT kitchen printer - leave this window open
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this PC.
  echo.
  echo   1. Go to https://nodejs.org
  echo   2. Download the big green "LTS" button
  echo   3. Install it, clicking Next through the defaults
  echo   4. Run this file again
  echo.
  pause
  exit /b 1
)

node agent.js

echo.
echo   The print agent has stopped.
echo   If that was not deliberate, run this file again.
echo.
pause
