#!/bin/bash
# 学习工作台 — 重启脚本（先停止旧实例，再后台启动新实例，日志追加到 log.txt）
# 用法: bash server/start.sh   （PORT 环境变量可改端口，默认 3000）
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-3000}"
LOG_FILE="$PWD/log.txt"
# 数据库备份目录（相对项目根）：服务每天 1:00 自动备份到这里，保留最近 14 份
BACKUP_DIR="${BACKUP_DIR:-server/backups}"
# 非交互环境（如 ssh 远程执行）PATH 里可能没有 node，补上常见安装路径
command -v node >/dev/null 2>&1 || PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# 获取本机内网 IP（macOS: en0/en1；Linux: hostname -I），取不到则回退 127.0.0.1
get_ip() {
  local ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    ip=$(ipconfig getifaddr en0 2>/dev/null)
    [ -z "$ip" ] && ip=$(ipconfig getifaddr en1 2>/dev/null)
  fi
  if [ -z "$ip" ]; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  echo "${ip:-127.0.0.1}"
}

echo "=== Study Platform 服务器重启 ==="

# ---- 1. 停止旧实例 ----
# 优先按端口找监听进程（覆盖所有启动方式），兜底按命令行匹配
find_pids() {
  local pids
  pids=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null)
  if [ -z "$pids" ]; then
    pids=$(pgrep -f "node .*server/server\.js" 2>/dev/null)
  fi
  echo "$pids"
}

PIDS=$(find_pids)
if [ -n "$PIDS" ]; then
  echo "停止旧实例 (PID: $(echo $PIDS | tr '\n' ' '))"
  kill $PIDS 2>/dev/null
  # 优雅退出最多等 5 秒
  i=0
  while [ $i -lt 50 ]; do
    PIDS=$(find_pids)
    [ -z "$PIDS" ] && break
    sleep 0.1
    i=$((i+1))
  done
  # 仍存活则强制杀掉
  if [ -n "$PIDS" ]; then
    echo "优雅停止超时，强制停止..."
    kill -9 $PIDS 2>/dev/null
    sleep 0.5
  fi
else
  echo "没有运行中的旧实例"
fi

IP=$(get_ip)
echo "本机访问:   http://localhost:$PORT"
echo "局域网访问: http://$IP:$PORT  （手机/平板用这个地址）"
echo "日志文件:   $LOG_FILE （tail -f 跟踪，重启脚本停止/启动服务）"

# ---- 2. 后台启动新实例，日志追加到 log.txt ----
BACKUP_DIR="$BACKUP_DIR" nohup node --experimental-sqlite server/server.js >> "$LOG_FILE" 2>&1 &
NODE_PID=$!
sleep 1
if kill -0 "$NODE_PID" 2>/dev/null; then
  echo "已后台启动 (PID: $NODE_PID)，终端可直接关闭"
else
  echo "启动失败，查看日志: tail -20 $LOG_FILE"
  exit 1
fi
