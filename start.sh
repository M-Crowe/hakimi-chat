#!/usr/bin/env bash
set -e

# 1. 检查 Node.js 环境
if ! command -v node >/dev/null 2>&1; then
    echo "❌ [环境错误] 未检测到 Node.js，请先安装 Node.js (推荐 v22+)。"
    exit 1
fi

NODE_VER=$(node -v | sed 's/^v//')
MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
MINOR=$(echo "$NODE_VER" | cut -d. -f2)

if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
    echo "⚠️ [环境提示] 本项目依赖内置 node:sqlite 原生模块，推荐 Node.js >= 22.5.0。"
    echo "   当前版本: v$NODE_VER"
fi

# 2. 检查依赖
if [ ! -d "node_modules" ]; then
    echo "[*] 未检测到 node_modules，正在执行 npm install..."
    npm install
fi

# 3. 运行统一进程守护总管
exec node scripts/launcher.mjs "$@"
