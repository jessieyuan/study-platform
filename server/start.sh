#!/bin/bash
# 学习工作台 — 启动脚本
cd "$(dirname "$0")/.."
echo "=== 个人学习平台 服务器启动 ==="
echo "地址: http://localhost:3000"
echo ""
node --experimental-sqlite server/server.js
