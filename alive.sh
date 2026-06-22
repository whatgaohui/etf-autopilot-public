#!/bin/bash
# 持续保活脚本: 每5秒检查并重启掉线的服务
cd /home/z/my-project
while true; do
  # 检查 data-service
  if ! curl -s -o /dev/null --connect-timeout 2 http://127.0.0.1:3031/api/health 2>/dev/null; then
    setsid bash -c 'cd /home/z/my-project/mini-services/data-service && exec python3 -u main.py' >> /tmp/py.log 2>&1 < /dev/null &
    sleep 4
  fi
  # 检查 frontend
  if ! curl -s -o /dev/null --connect-timeout 2 http://127.0.0.1:3000/ 2>/dev/null; then
    setsid bash -c 'cd /home/z/my-project && exec bun run dev' >> /tmp/dev.log 2>&1 < /dev/null &
    sleep 6
  fi
  sleep 3
done
