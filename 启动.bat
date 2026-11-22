@echo off
chcp 65001 >nul
title Baidu Pan Cleaner
cd /d "%~dp0"

rem If node is not on PATH, try common install locations
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%USERPROFILE%\.trae-cn\sdks\versions\node\current\node.exe" set "PATH=%USERPROFILE%\.trae-cn\sdks\versions\node\current;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install Node.js 18+ from https://nodejs.org and run this file again.
  pause
  start "" "https://nodejs.org/en/download"
  exit /b 1
)

if not exist "node_modules\playwright-core" (
  echo First run: installing dependencies, please wait...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Please check network and run again.
    pause
    exit /b 1
  )
)

echo Starting local service: http://127.0.0.1:5178
node server.js

echo.
echo Service stopped. If startup failed, check the error above.
pause
