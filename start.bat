@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ===================================================
echo     哈基米聊天系统 (Hakimi Chat System)
echo ===================================================

:: 1. 检查 Node.js 运行环境
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境！
    echo 请前往 https://nodejs.org 安装 Node.js (推荐 v22+)。
    echo.
    pause
    exit /b 1
)

:: 2. 检查并自动安装 Node.js 依赖 (解决 Cannot find package 'ws' 等问题)
if not exist "node_modules\" (
    echo [*] 检测到初次运行或缺少依赖，正在自动执行 npm install...
    echo [*] 依赖安装可能需要 1~2 分钟，请稍候...
    call npm install
    if %errorlevel% neq 0 (
        echo [警告] npm 默认源安装失败，尝试切换至国内镜像源重新安装...
        call npm install --registry=https://registry.npmmirror.com
    )
    if %errorlevel% neq 0 (
        echo [错误] npm 依赖安装失败，请检查网络连接后重试！
        pause
        exit /b 1
    )
    echo [*] Node.js 依赖安装完成！
    echo.
)

:: 3. 确保数据目录与数据库初始化
if not exist "data\state.db" (
    echo [*] 正在初始化本地持久化数据库 (data/state.db)...
    node --experimental-sqlite src\db.mjs --init >nul 2>&1
)

:: 4. 调用统一守护总管
node scripts\launcher.mjs %*

if %errorlevel% neq 0 (
    pause
)
