#!/bin/bash
# 保活脚本:确保 dev server (3000) 和 data-service (3031) 始终运行。
# 解决沙箱环境回收后台进程导致"页面无法加载"的问题。
cd /home/z/my-project
LOG=/home/z/my-project/keepalive.log

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

log "=== keepalive 启动 (PID $$) ==="

while true; do
  # data-service (3031)
  if ! curl -s --connect-timeout 2 http://127.0.0.1:3031/api/health -o /dev/null 2>/dev/null; then
    log "data-service 宕机,重启中..."
    setsid bash -c 'cd /home/z/my-project/mini-services/data-service && exec python3 -u main.py' >> /home/z/my-project/data-service.log 2>&1 < /dev/null &
    disown
    sleep 5
  fi

  # Next.js dev server (3000)
  if ! curl -s --connect-timeout 2 http://127.0.0.1:3000/ -o /dev/null 2>/dev/null; then
    log "dev server 宕机,重启中..."
    setsid bash -c 'cd /home/z/my-project && exec bun run dev' >> /home/z/my-project/dev-stdout.log 2>&1 < /dev/null &
    disown
    sleep 8
  fi

  sleep 5
done
