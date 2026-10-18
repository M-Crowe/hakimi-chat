@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 goto :no_node

node scripts\launcher.mjs %*
if %errorlevel% neq 0 pause
exit /b %errorlevel%

:no_node
echo [ERROR] Node.js not detected. Please install Node.js v22+ from https://nodejs.org
pause
exit /b 1
