#!/bin/bash
cd "$(dirname "$0")"
echo "=== ETF Autopilot 服务状态 ==="

# 前端
if curl -s -o /dev/null -m 2 http://127.0.0.1:3000/ 2>/dev/null; then
  echo "✅ 前端(3000): 运行中"
else
  echo "❌ 前端(3000): 已停止"
fi

# data-service
if curl -s -m 2 http://127.0.0.1:3031/api/health 2>/dev/null | grep -q "ok"; then
  echo "✅ data-service(3031): 运行中"
  # 服务详情
  curl -s http://127.0.0.1:3031/api/admin/service-status 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(f'   PID: {d.get(\"data_service\",{}).get(\"pid\",\"?\")}  内存: {d.get(\"data_service\",{}).get(\"memory_mb\",\"?\")}MB')
  for dbn, dbi in d.get('databases',{}).items():
    if dbi.get('exists'): print(f'   {dbn}DB: {dbi.get(\"size_mb\",\"?\")}MB')
except: pass
" 2>/dev/null
else
  echo "❌ data-service(3031): 已停止"
fi

# 数据库
echo ""
echo "=== 数据库 ==="
for db in "db/custom.db:业务DB" "mini-services/data-service/db/market_data.db:市场DB"; do
  path="${db%%:*}"; name="${db##*:}"
  if [ -f "$path" ]; then
    size=$(du -h "$path" | cut -f1)
    echo "✅ $name: $size ($path)"
  else
    echo "❌ $name: 不存在"
  fi
done

# 进程
echo ""
echo "=== 进程 ==="
ps -ef | grep -E "next dev|main.py" | grep -v grep | awk '{print "  PID",$2,$8,$9,$10}' || echo "  无相关进程"
