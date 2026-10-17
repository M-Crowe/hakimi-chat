# Tomoko QQ Bridge 一键自检与启动脚本
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "     哈基米聊天系统 (Tomoko QQ Bridge) 一键启动" -ForegroundColor Cyan
Write-Host "     模式: Antigravity IDE Companion 伴聊大脑架构" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js
try {
    $nodeVer = node -v
    Write-Host "[✓] Node.js 环境正常: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[✗] 错误: 未找到 Node.js，请先安装 Node.js (推荐 v22+)" -ForegroundColor Red
    exit 1
}

# 2. 检查 SQLite 数据区
if (-not (Test-Path "data/state.db")) {
    Write-Host "[*] 正在初始化本地 SQLite 数据区..." -ForegroundColor Yellow
    node --experimental-sqlite test/test-db.mjs
} else {
    Write-Host "[✓] 本地 SQLite 数据区就绪" -ForegroundColor Green
}

# 3. 检查并清理端口占用 (34567, 5120)
$busyPorts = @(34567, 5120)
foreach ($p in $busyPorts) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $procId = $c.OwningProcess
        if ($procId -gt 0) {
            Write-Host "[*] 检测到端口 $p 已被 PID $procId 占用，正在释放并关闭旧守护进程..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
}

# 4. 启动守护进程
Write-Host "[*] 正在拉起网关守护进程并连接 SnowLuma..." -ForegroundColor Yellow
Write-Host "[*] Web 控制台: http://127.0.0.1:5120" -ForegroundColor Cyan
Write-Host "[*] 内部 IPC 网关: 127.0.0.1:34567" -ForegroundColor Cyan
Write-Host "[*] 提示: 守护进程启动后，在 Antigravity 聊天窗口发送「一键启动哈基米聊天系统」即可进入伴聊循环。" -ForegroundColor Magenta
Write-Host ""
node --experimental-sqlite src/bridge-daemon.mjs
