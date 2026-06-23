#!/bin/bash
# 一键启动 data-service + 前端
cd "$(dirname "$0")"
echo "=== 启动 ETF Autopilot ==="

# 停止已有进程
pkill -f "next dev" 2>/dev/null; pkill -f "main:app" 2>/dev/null; sleep 1

# 启动 data-service
echo "=== [1/2] 启动 data-service (端口3031) ==="
cd mini-services/data-service
nohup python3 -u main.py > /tmp/etf-data-service.log 2>&1 &
DPID=$!
cd ../..
echo "  PID: $DPID"

# 等待就绪
for i in $(seq 1 15); do
  curl -s -o /dev/null http://127.0.0.1:3031/api/health 2>/dev/null && { echo "  ✓ 就绪"; break; }; sleep 1
done

# 启动前端
echo "=== [2/2] 启动前端 (端口3000) ==="
nohup bun run dev > /tmp/etf-frontend.log 2>&1 &
FPID=$!
echo "  PID: $FPID"

for i in $(seq 1 20); do
  curl -s -o /dev/null http://127.0.0.1:3000/ 2>/dev/null && { echo "  ✓ 就绪"; break; }; sleep 1
done

echo ""
echo "🎉 系统已启动!"
echo "   前端: http://localhost:3000"
echo "   data-service: http://localhost:3031/api/health"
echo "   日志: /tmp/etf-data-service.log, /tmp/etf-frontend.log"
echo ""
echo "   停止: ./stop.sh"
echo "   状态: ./status.sh"
