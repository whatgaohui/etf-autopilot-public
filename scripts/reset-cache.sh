#!/bin/bash
# 清空市场数据缓存(保留业务数据)
cd "$(dirname "$0")/.."
echo "=== 清空市场数据缓存 ==="
echo "⚠️  这将删除所有行情/质量评分/日志缓存,业务数据(持仓/规则)不受影响"
read -p "确认清空? (y/N): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then echo "已取消"; exit 0; fi

curl -s -X POST http://127.0.0.1:3031/api/admin/reset-cache | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('success'):
  for t in d.get('cleared',[]): print(f'  ✓ {t[\"table\"]}: 删除{t.get(\"deleted\",0)}行')
else: print('  ❌ 失败:', d.get('error'))
"
echo "完成"
