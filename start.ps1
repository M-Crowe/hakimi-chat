# 哈基米聊天系统 (Hakimi Chat System) PowerShell 启动脚本
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "    哈基米聊天系统 (Hakimi Chat System)" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. 检查 Node.js 环境
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Node.js 环境！请前往 https://nodejs.org 安装 Node.js (推荐 v22+)。" -ForegroundColor Red
    pause
    exit 1
}

# 2. 检查并自动安装 Node.js 依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "[*] 检测到初次运行或缺少依赖，正在自动执行 npm install..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[警告] npm 默认源安装失败，尝试切换至国内镜像源重新安装..." -ForegroundColor Yellow
        npm install --registry=https://registry.npmmirror.com
    }
}

# 3. 确保 SQLite 数据区初始化
if (-not (Test-Path "data/state.db")) {
    Write-Host "[*] 正在初始化本地持久化数据库 (data/state.db)..." -ForegroundColor Yellow
    node --experimental-sqlite src/db.mjs --init | Out-Null
}

# 4. 调用统一守护总管
node scripts/launcher.mjs $args
