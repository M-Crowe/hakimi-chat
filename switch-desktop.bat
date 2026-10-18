@echo off
chcp 65001 >nul
title 微信虚拟桌面穿梭器
cd /d "%~dp0"
echo 正在启动桌面穿梭器...
.venv-wechat\Scripts\python.exe scripts\desktop-switcher.py
pause
