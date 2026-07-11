#!/bin/bash
# V5.1: 同时启动 data-service + next dev, 确保数据服务持续运行
cd /home/z/my-project

# 启动 data-service (后台持续运行)
echo "[dev-with-data] Starting data-service..."
/home/z/.venv/bin/python3 -u mini-services/data-service/main.py > /tmp/py.log 2>&1 &
DATA_PID=$!
echo "[dev-with-data] data-service PID: $DATA_PID"

# 等待 data-service 就绪
for i in $(seq 1 15); do
  if curl -s -o /dev/null http://127.0.0.1:3031/api/health 2>/dev/null; then
    echo "[dev-with-data] data-service ready"
    break
  fi
  sleep 1
done

# 启动 Next.js dev server (前台运行, 保持进程存活)
echo "[dev-with-data] Starting Next.js dev server..."
exec next dev -p 3000 2>&1 | tee dev.log
