# [Deprecated] This script is superseded by the unified cross-platform launcher: scripts/launcher.mjs
# Legacy full script has been archived to scripts/legacy/start.ps1
$OutputEncoding = [System.Text.Encoding]::UTF8

# 1. 确保 SQLite 数据区初始化 (src/db.mjs --init)
if (-not (Test-Path "data/state.db")) {
    node --experimental-sqlite src/db.mjs --init
}

# 2. 调用统一守护总管
node scripts/launcher.mjs $args
