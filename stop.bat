@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo     Hakimi One-Click Stop and Clean Manager
echo ===================================================
echo.
echo [*] Stopping all Hakimi companion services and ports...

where node >nul 2>&1
if %errorlevel% neq 0 goto :fallback_kill

node scripts\launcher.mjs --stop
goto :done

:fallback_kill
for %%p in (34567 5120 34568) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p" ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

:done
echo.
echo [*] Hakimi companion services and ports cleaned.
pause
