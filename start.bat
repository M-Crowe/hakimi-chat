@echo off
chcp 65001 >nul
title Tomoko QQ Bridge Daemon
cd /d "%~dp0"

echo ===================================================
echo     哈基米聊天系统 (Tomoko QQ Bridge) 一键启动
echo     模式: Antigravity IDE Companion 伴聊大脑架构
echo ===================================================
echo.

node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v22+)。
    pause
    exit /b
)

echo [*] 正在检查端口占用情况 (34567, 5120)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":34567" ^| findstr "LISTENING"') do (
    echo [*] 正在终止占用 34567 端口的旧进程 PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5120" ^| findstr "LISTENING"') do (
    echo [*] 正在终止占用 5120 端口的旧进程 PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)

:run_daemon
echo [*] 正在启动守护进程并连接 SnowLuma 网关...
echo [*] Web 控制台: http://127.0.0.1:5120
echo [*] 内部 IPC 网关: 127.0.0.1:34567
echo [*] 提示: 守护进程启动后，在 Antigravity 聊天窗口发送「一键启动哈基米聊天系统」即可进入伴聊循环。
echo.
node src/bridge-daemon.mjs

echo.
echo [*] 守护进程已停止。正在准备自动重启 (按 Ctrl+C 可彻底退出)...
timeout /t 2 /nobreak >nul
goto run_daemon
