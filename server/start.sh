#!/bin/bash
# 学习工作台 — 启动脚本
cd "$(dirname "$0")/.."
echo "=== Study Platform 服务器启动 ==="
echo "地址: http://localhost:3000"
echo ""
node server/server.js
