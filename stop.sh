#!/bin/bash
cd "$(dirname "$0")"
echo "=== 停止 ETF Autopilot ==="
pkill -f "next dev" 2>/dev/null && echo "✓ 前端已停止" || echo "  前端未运行"
pkill -f "main:app" 2>/dev/null && echo "✓ data-service已停止" || echo "  data-service未运行"
pkill -f "main.py" 2>/dev/null
echo "完成"
