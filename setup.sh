#!/bin/bash
# ETF Autopilot 一键安装脚本
set -e
cd "$(dirname "$0")"
echo "=== ETF Autopilot 安装 ==="

# 检查 Python
if ! command -v python3 &>/dev/null; then echo "❌ 需要Python 3.11+"; exit 1; fi
echo "✓ Python: $(python3 --version)"

# 检查 bun/node
if command -v bun &>/dev/null; then echo "✓ Bun: $(bun --version)"
elif command -v node &>/dev/null; then echo "✓ Node: $(node --version)"
else echo "❌ 需要 Bun 或 Node.js 20+"; exit 1; fi

# 1. 安装前端依赖
echo "=== [1/5] 安装前端依赖 ==="
bun install 2>/dev/null || npm install

# 2. 安装Python依赖
echo "=== [2/5] 安装Python data-service依赖 ==="
pip install -r mini-services/data-service/requirements.txt

# 3. 配置环境变量
echo "=== [3/5] 配置环境变量 ==="
if [ ! -f .env ]; then
  echo 'DATABASE_URL="file:/home/z/my-project/db/custom.db"' > .env
  echo 'TUSHARE_TOKEN=""' >> .env
  echo "✓ 已创建 .env"
fi

# 4. 初始化业务数据库
echo "=== [4/5] 初始化业务数据库 ==="
bun run db:push 2>/dev/null || npx prisma db push
bun run db:generate 2>/dev/null || npx prisma generate

# 5. 种子数据
echo "=== [5/5] 种子数据 ==="
if [ ! -f db/custom.db ] || [ $(python3 -c "import sqlite3; print(sqlite3.connect('db/custom.db').execute('SELECT count(*) FROM etf_config').fetchone()[0])" 2>/dev/null || echo 0) -eq 0 ]; then
  bun run prisma/seed.ts 2>/dev/null || npx tsx prisma/seed.ts
  echo "✓ 种子数据已插入"
else
  echo "✓ 业务数据库已有数据,跳过种子"
fi

echo ""
echo "🎉 安装完成! 运行 ./start.sh 启动系统"
