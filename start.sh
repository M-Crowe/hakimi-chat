#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  Hakimi Chat System (SnowLuma x Antigravity) Launcher   "
echo "=========================================================="

# 1. 检查 Node.js 环境与版本
if ! command -v node >/dev/null 2>&1; then
    echo "❌ [环境错误] 未检测到 Node.js，请先安装 Node.js (>=22.5.0)！"
    exit 1
fi

NODE_VER=$(node -v | sed 's/^v//')
MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
MINOR=$(echo "$NODE_VER" | cut -d. -f2)

echo "[*] 检测到本地 Node.js 版本: v$NODE_VER"

if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
    echo "❌ [环境错误] Node.js 版本过低！本项目依赖内置 node:sqlite 原生模块，需要 Node.js >= 22.5.0。"
    echo "    当前版本: v$NODE_VER，请升级 Node.js 后重试。"
    exit 1
fi

# 2. 检查依赖包
if [ ! -d "node_modules" ]; then
    echo "[*] 未检测到 node_modules，正在执行 npm install..."
    npm install
fi

# 3. 检查端口占用 (34567 内部 IPC 网关, 5120 Web 控制台)
for PORT in 34567 5120; do
    PID=$(lsof -ti :$PORT 2>/dev/null || true)
    if [ -n "$PID" ]; then
        echo "[*] 正在释放端口 :$PORT 被占用的旧进程 (PID: $PID)..."
        kill -9 $PID 2>/dev/null || true
    fi
done

echo "[*] 启动哈基米聊天系统守护进程..."
echo "    • 内部 IPC 网关: 127.0.0.1:34567"
echo "    • Web 管理控制台: http://127.0.0.1:5120"
echo "=========================================================="

exec node --experimental-sqlite src/bridge-daemon.mjs
