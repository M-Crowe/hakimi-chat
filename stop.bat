@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ===================================================
echo     哈基米聊天系统 (Hakimi) 一键安全停止总管
echo ===================================================
echo.
echo [*] 正在扫描并安全停止哈基米所有子服务并释放端口...

where node >nul 2>&1
if %errorlevel% equ 0 (
    node scripts\launcher.mjs --stop
) else (
    for %%p in (34567 5120 34568) do (
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p" ^| findstr "LISTENING"') do (
            taskkill /F /PID %%a >nul 2>&1
        )
    )
    echo [*] 端口强制释放完成。
)

echo.
echo ===================================================
echo ✅ 所有伴聊子服务与网络端口已全部安全释放！
echo ===================================================
echo.
pause
