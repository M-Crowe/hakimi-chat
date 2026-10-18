@echo off
chcp 65001 >nul
title 微信4.1后台隔离伴聊系统启动器

echo ===================================================
echo 🚀 正在启动 微信4.1 独立隔离桌面伴聊系统...
echo ===================================================

echo [*] 正在拉起 Python 微信后台守护服务 (WeChatBotDesktop 虚拟桌面)...
start "WeChat Service Daemon" cmd /k ".venv-wechat\Scripts\python.exe -u scripts\wechat-service.py"

echo [*] 等待 3 秒让微信服务完成初始化...
timeout /t 3 /nobreak >nul

echo [*] 正在拉起 Node.js 伴聊大脑网关 (Port 34567, 5120)...
start "Bridge Daemon" cmd /k "node --experimental-sqlite src\bridge-daemon.mjs"

echo ===================================================
echo ✅ 系统启动就绪！
echo • 微信 4.1 在后台物理隔离桌面静默收发，不抢前台鼠标键盘焦点
echo • 伴聊 Web 控制台: http://127.0.0.1:5120
echo • 微信守护 HTTP API: http://127.0.0.1:34568/health
echo ===================================================
pause
