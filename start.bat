@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% equ 0 goto :run_node

echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v22+)。
pause
exit /b 1

:run_node
node scripts\launcher.mjs %*
