#!/bin/bash
# data-service 保活脚本：进程挂了自动重启
cd /app/mini-services/data-service
VENV_PY="/app/mini-services/data-service/.venv/bin/python"
LOG="/var/log/data-service.log"
KA_LOG="/var/log/data-service-keepalive.log"

while true; do
  if ! curl -s --connect-timeout 2 http://localhost:3031/api/health > /dev/null 2>&1; then
    echo "[$(date '+%F %T')] data-service down, restarting..." >> "$KA_LOG"
    # 清理可能的残留进程（只杀自己启动的，避免误伤）
    pkill -f "data-service/.venv/bin/python main.py" 2>/dev/null
    sleep 1
    setsid nohup "$VENV_PY" main.py > "$LOG" 2>&1 < /dev/null &
    disown
    sleep 6
  fi
  sleep 5
done
