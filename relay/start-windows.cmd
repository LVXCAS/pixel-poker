@echo off
rem PIXEL HOLD'EM relay launcher for Windows: runs start.sh in Git Bash. Keep this window open.
title PIXEL HOLD'EM relay
set "PATH=%ProgramFiles%\Git\bin;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\cloudflared;%ProgramFiles%\cloudflared;%ProgramFiles%\GitHub CLI;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
if not exist "%ProgramFiles%\Git\bin\bash.exe" (
  echo Git Bash not found. Run setup-windows.ps1 first.
  pause
  exit /b 1
)
"%ProgramFiles%\Git\bin\bash.exe" "%~dp0start.sh"
echo Relay stopped.
pause
