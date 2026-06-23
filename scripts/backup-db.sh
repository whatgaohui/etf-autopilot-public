#!/bin/bash
# 备份数据库到 backup/ 目录
cd "$(dirname "$0")/.."
mkdir -p backup
TS=$(date +%Y%m%d_%H%M%S)
echo "=== 备份数据库 ==="
[ -f db/custom.db ] && cp db/custom.db "backup/custom_${TS}.db" && echo "✓ 业务DB已备份: backup/custom_${TS}.db"
[ -f mini-services/data-service/db/market_data.db ] && cp mini-services/data-service/db/market_data.db "backup/market_data_${TS}.db" && echo "✓ 市场DB已备份: backup/market_data_${TS}.db"
# 保留最近10个备份
ls -t backup/custom_*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null
ls -t backup/market_data_*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null
echo "完成"
