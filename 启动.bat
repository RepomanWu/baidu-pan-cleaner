@echo off
chcp 65001 >nul
title Baidu Pan Cleaner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ : https://nodejs.org
  start "" "https://nodejs.org/en/download"
  pause
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
