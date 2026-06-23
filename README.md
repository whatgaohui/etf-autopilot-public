# ETF Autopilot

> 个人 ETF 自动化监控与**资金调拨**辅助系统 —— **规则引擎算账，AI 只解释**

一个可审计、可解释、纪律化的个人 ETF 定投与再平衡资金调拨辅助系统。系统不预测短期涨跌，不做清仓择时，而是通过持仓识别 → 数据缓存 → 数据质量校验 → 目标缺口计算 → 买入规则 → 再平衡规则 → 现金水池管理 → AI 解释，每周输出一张可执行的**资金调拨执行单**。

## 核心理念

> **规则引擎算账，AI 只解释；不预测涨跌，只维护纪律。**
>
> - Python 规则引擎是唯一金额计算权威
> - LLM 只能解释规则引擎结果，不得修改任何金额
> - 前端不二次计算金额，API 聚合层不篡改 `final_amount`

## 系统输出：每周资金调拨执行单

系统每周回答四个问题：

1. 本周新增资金买什么？
2. 哪些标的暂停买入？
3. 哪些标的需要做再平衡？
4. 未使用资金和再平衡释放资金去哪？

执行单结构：

```
外部注入资金 → 内部释放资金 → 可用资金池
  → 买入清单 + 暂停清单 + 再平衡清单
  → 未投资金额 → 资金去向（华宝添益）
```

## 投资原则（策略文档摘要）

```
低估多买 / 合理正常买 / 高估少买 / 极高估不买
极高估且超配才卖，卖也只卖超配部分
美股少卖，A 股可周期再平衡
红利用股息率辅助判断
QDII 高溢价禁止买入，但可辅助卖出
现金统一回到华宝添益
```

## 文档体系（v4）

本仓库包含两份权威文档，位于 [`Doc/`](./Doc)：

| 文档 | 角色 | 内容 |
|---|---|---|
| [**PRD V4.2**](./Doc/PRD_v4.2_数据源管理与宏观温度计模块新增章节.md) | 产品需求权威（增量章节） | 设置页导航 / 数据采集服务控制 / 后台管理 / 宏观温度计 |
| [**PRD V4 / V4.1**](./Doc/个人ETF自动化监控与资金调拨辅助系统_PRD_v4.md) | 产品需求权威 | 页面、接口、数据库、规则引擎职责、AI 职责、验收标准 |
| [**投资策略说明书 V4**](./Doc/ETF定投助手_投资策略说明书_V4.md) | 投资规则权威 | 估值周期、买卖规则、再平衡阈值、QDII 处理、现金水池规则 |

> **关键约束**：PRD 只描述产品能力，具体投资规则以策略文档为准。代码中不硬编码策略，规则数据驱动并引用策略文档章节。

---

## 快速开始（一键部署）

### 前置要求

- **Python 3.11+**（用于 data-service 微服务）
- **Node.js 20+ 或 Bun**（用于 Next.js 前端，推荐 Bun）
- **4GB 内存**（推荐；行情刷新时内存峰值约 1.5GB）
- 网络可访问 akshare / efinance / eastmoney / csindex 等公开数据源
- 可选：[Tushare Token](https://tushare.pro/)（备用数据源，未配置时自动跳过）

### 一键部署（推荐）

```bash
git clone https://github.com/whatgaohui/etf-autopilot-public.git
cd etf-autopilot-public
chmod +x *.sh scripts/*.sh
./setup.sh    # 安装依赖 + 初始化数据库 + 种子数据
./start.sh    # 启动 data-service(3031) + 前端(3000)
```

启动后访问 **http://localhost:3000**

`./setup.sh` 会依次完成：
1. 检查 Python / Bun / Node 运行环境
2. 安装前端依赖（`bun install` 或 `npm install`）
3. 安装 data-service Python 依赖（`pip install -r requirements.txt`）
4. 创建 `.env` 配置文件（如不存在）
5. 推送 Prisma schema 并生成 Client（`bun run db:push` + `bun run db:generate`）
6. 检查并执行种子数据（仅当 `etf_config` 表为空时执行 `prisma/seed.ts`）

### 手动部署（分步骤）

如果想完全手动控制每个环节，按以下步骤操作。

#### 1. 克隆仓库

```bash
git clone https://github.com/whatgaohui/etf-autopilot-public.git
cd etf-autopilot-public
```

#### 2. 安装前端依赖

```bash
# 推荐使用 Bun（更快）
bun install
# 或使用 npm
npm install
```

#### 3. 安装 Python data-service 依赖

```bash
# 推荐使用虚拟环境
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate

pip install -r mini-services/data-service/requirements.txt
```

依赖包含：`fastapi` / `uvicorn` / `akshare` / `efinance` / `tushare` / `apscheduler` / `pydantic` 等。

#### 4. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env,确认 DATABASE_URL 路径正确,可选填 TUSHARE_TOKEN
```

`.env` 内容示例：

```ini
DATABASE_URL="file:/home/z/my-project/db/custom.db"
TUSHARE_TOKEN=""    # 可选,留空时自动跳过 tushare 备用源
```

#### 5. 初始化业务数据库（Prisma + SQLite）

```bash
bun run db:push       # 推送 schema 创建表 (或 npx prisma db push)
bun run db:generate   # 生成 Prisma Client (或 npx prisma generate)
```

业务库 `db/custom.db` 将自动创建，包含 6 张表（`etf_config` / `holding` / `rule_config` / `cash_pool` / `weekly_advice` / `audit_log`）。

#### 6. 插入种子数据

```bash
bun run prisma/seed.ts    # 或 npx tsx prisma/seed.ts
```

种子数据包含 6 只核心定投 ETF 配置 + 8 条默认投资规则 + 黑名单配置。重复执行不会重复插入。

#### 7. 启动 data-service（端口 3031）

```bash
cd mini-services/data-service
nohup python3 -u main.py > /tmp/etf-data-service.log 2>&1 &
# 等待 5~10 秒,验证健康
curl http://127.0.0.1:3031/api/health
# 返回 {"status":"ok",...} 即成功
cd ../..
```

#### 8. 启动前端（端口 3000）

```bash
# 回到项目根目录
bun run dev    # 或 npm run dev
# 等待编译完成,浏览器访问 http://localhost:3000
```

---

## 运维管理

### 服务管理脚本

| 脚本 | 功能 |
|---|---|
| `./start.sh` | 一键启动 data-service(3031) + 前端(3000) |
| `./stop.sh` | 停止两个服务 |
| `./status.sh` | 查看服务状态 + 数据库大小 + 进程列表 |
| `./scripts/backup-db.sh` | 备份业务库 + 市场库到 `backup/` 目录（保留最近 10 份） |
| `./scripts/reset-cache.sh` | 清空市场数据缓存（保留业务数据：持仓/规则/现金水池） |

> 服务运行日志：`/tmp/etf-data-service.log`、`/tmp/etf-frontend.log`

### 首次使用流程

1. **启动服务**：执行 `./start.sh`，等待两个 ✓ 就绪
2. **打开浏览器**：访问 http://localhost:3000
3. **刷新行情数据**：进入「设置 → 数据源管理」(顶部 sticky 导航) → 点击「刷新行情数据」按钮（约 1~3 分钟，因需多源拉取 6 只 ETF × 5 类指标 + 4 个市场指数 + 汇率）
4. **刷新宏观数据**：同一面板点击「刷新宏观数据」按钮（约 15 秒，4 个宏观指标：中债 / 美债 / USD-CNH / VIX）
5. **重新计算质量评分**：点击「重新计算质量评分」（约 5 秒）
6. **上传持仓**：进入「总览」页 → 上传券商 APP 持仓截图（VLM 自动识别）或手动录入
7. **生成本周建议**：点击「生成本周定投建议」→ 规则引擎计算 → AI 解释 → 展示资金调拨执行单

### 后期管理

- **数据备份**：定期运行 `./scripts/backup-db.sh`（建议每周刷新数据后执行）
- **缓存清理**：发现数据不准 / 行情过期时，运行 `./scripts/reset-cache.sh` 后重新刷新行情
- **服务状态**：`./status.sh` 查看服务运行情况、数据库大小、进程列表
- **查看日志**：`/tmp/etf-data-service.log`（Python 微服务）、`/tmp/etf-frontend.log`（Next.js）
- **设置页「后台管理」**：可视化查看两库（业务库 + 市场库）所有表行数 / 数据，一键清空缓存 / 导出业务数据 JSON / 查看服务状态（PID / 内存 / DB 大小）

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js 16 Frontend (port 3000)                            │
│  ├─ 总览页  资金调拨执行单（结论卡 + 红线审计卡 + 明细表）    │
│  ├─ 趋势页  多周期估值 / QDII 溢价 / 股息率 / 宏观温度计      │
│  └─ 设置页  目标比例 / 规则 / 数据源 / 数据质量 / 后台管理    │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTP API (Next.js Route Handler 代理)
┌───────────────▼─────────────────────────────────────────────┐
│  Next.js API Routes (/api/*)                                │
│  ├─ /api/calculate   转发到 data-service 生成完整执行单      │
│  ├─ /api/holding     持仓快照 CRUD                            │
│  ├─ /api/rule        规则配置 CRUD                            │
│  ├─ /api/ocr         VLM 识别券商持仓截图                     │
│  ├─ /api/advice      LLM 生成解释（带一致性校验）             │
│  ├─ /api/macro       宏观温度计（中债/美债/USD-CNH/VIX）      │
│  ├─ /api/data        行情数据刷新触发                         │
│  └─ /api/admin       后台管理（DB 统计/表数据/清空/导出）     │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTP
┌───────────────▼─────────────────────────────────────────────┐
│  Python FastAPI data-service (port 3031)                    │
│  规则引擎 6 大模块：                                          │
│  ├─ DataQualityEngine    数据质量判断                         │
│  ├─ ValuationEngine      多周期估值（1/3/5/10 年）            │
│  ├─ BuyAllocationEngine  目标缺口买入算法                     │
│  ├─ RebalanceEngine      再平衡算法（估值极端 + 超配双条件）   │
│  ├─ CashPoolEngine       现金水池流向                         │
│  └─ AuditEngine          审计字段 + calculation_log           │
│  + APScheduler 每日盘后自动刷新                              │
│  + 多源数据源管理（akshare / efinance / eastmoney / csindex / │
│    tushare，主备源 + 字段级路由 + 熔断降级）                  │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
   Akshare (主)    Tushare (备)  ← 主备源交叉校验
   + efinance / eastmoney / csindex 直接抓取（指标级路由）
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16 (App Router), React 19, TypeScript 5 |
| UI | Tailwind CSS 4 + shadcn/ui (New York) + Lucide |
| 状态 | Zustand (client) + TanStack Query (server) |
| 后端 | Next.js API Routes + Python FastAPI (微服务) |
| 数据库 | Prisma ORM + SQLite (业务数据), SQLite (市场缓存) |
| 数据源 | Akshare (主) + efinance / eastmoney / csindex 直接 + Tushare (备) + 主备源交叉校验 |
| AI | z-ai-web-dev-sdk (LLM 文本生成 + VLM 截图识别) |
| 调度 | APScheduler (Python 端定时任务) |

## 投资标的池

### 核心定投 ETF（6 只）

| 大类 | 基金名称 | 代码 | 目标占比 |
|---|---|---:|---:|
| 国内权益 | 中证A500ETF | 159338 | 18% |
| 国内权益 | 红利ETF | 510880 | 18% |
| 国内权益 | 沪深300ETF | 510330 | 12% |
| 国内权益 | 科创50ETF | 588000 | 12% |
| 海外权益 | 标普500ETF | 513500 | 24% |
| 海外权益 | 纳斯达克ETF | 513300 | 16% |

大类目标：**国内权益 60% / 海外权益 40%**。每周定投预算：**40,000 元**。

### 非定投资产

| 标的 | 代码 | 系统处理 |
|---|---:|---|
| 黄金ETF华安 | 518880 | 家庭分工处理，黑名单，不参与定投和再平衡 |
| 华宝添益ETF | 511990 | 现金水池，承接未投资金额和再平衡释放资金 |

## 规则引擎核心算法

### 买入侧：目标缺口驱动

```
预算后定投资产总额 = 当前定投资产总额 + 本周预算
某 ETF 目标市值 = 预算后总额 × 目标占比
目标缺口 = max(0, 目标市值 - 当前持仓市值)
基础可买 = 目标缺口
→ 经 否决 > 数据质量 > 减量 > 加量 优先级调整
```

### 再平衡侧：估值极端 + 超配 双条件触发

```
卖的是超配部分，不卖核心底仓
仅高估不超配 → 不卖，只暂停新增
仅超配不高估 → 不卖，用新增资金自然稀释
极高估 + 明显超配 → 卖出超额市值的 20%~50%
资金去向：华宝添益
```

### 估值周期分用途

| 周期 | 用途 | 是否参与强规则 |
|---|---|---|
| 近 1 年 | 短期情绪温度计 | 否 |
| 近 3 年 | 中期冷热辅助 | 辅助 |
| 近 5 年 | 买入侧主判断 | 是 |
| 近 10 年 / 全历史 | 再平衡侧主判断 | 是 |
| 样本不足 | 标记 | 否 |

详见 [投资策略说明书 V4](./Doc/ETF定投助手_投资策略说明书_V4.md) 第 3 章。

### 数据质量策略

- **双源校验**：关键字段（收盘价/净值/溢价/PE/PB/股息率）至少两源交叉验证，超阈值不自动生成强建议
- **数据血缘**：每条数据记录 source / raw_value / clean_value / is_valid / abnormal_reason / sample_days
- **异常值清洗**：缺失值用 null，禁止 99999999/-1/0 占位；PE≤0 或 ≥500 异常，PB≤0 或 ≥100 异常
- **缓存过期**：A股收盘价非最新交易日标红，QDII 净值超 2 个交易日标黄，股息率超 7 个交易日标黄

## 目录结构

```
etf-autopilot/
├── Doc/                                 # 权威文档
│   ├── 个人ETF自动化监控与资金调拨辅助系统_PRD_v4.md
│   ├── 个人ETF自动化监控与资金调拨辅助系统_PRD_v4.1_数据源管理增强版.md
│   ├── PRD_v4.2_数据源管理与宏观温度计模块新增章节.md
│   ├── ETF定投助手_投资策略说明书_V4.md
│   └── ETF定投助手_投资策略说明书_V4.1_数据源增强版.md
├── src/
│   ├── app/                             # Next.js App Router
│   │   ├── page.tsx                     # 唯一入口（三页 Tab 切换）
│   │   └── api/                         # API Routes（calculate/holding/rule/ocr/advice/macro/data/admin/...）
│   ├── components/                      # 业务组件
│   │   ├── overview.tsx                 # 总览页（资金调拨执行单）
│   │   ├── trends.tsx                   # 趋势页（多周期估值 + 宏观温度计）
│   │   ├── settings.tsx                 # 设置页（8 Section + 后台管理）
│   │   ├── weekly-conclusion-card.tsx   # 结论卡
│   │   ├── red-line-audit-card.tsx      # 红线审计卡
│   │   ├── cash-subaccount-flow-card.tsx# 现金子账户流向卡
│   │   ├── data-trust-card.tsx          # 数据可信度卡
│   │   └── ui/                          # shadcn/ui 组件库
│   ├── lib/                             # 工具库（api.ts / db.ts / data-service.ts / types.ts）
│   └── hooks/                           # 自定义 hooks
├── prisma/
│   ├── schema.prisma                    # 数据库 schema（v4 含 6 张表）
│   └── seed.ts                          # 种子数据（6 ETF + 8 规则）
├── db/
│   └── custom.db                        # 业务数据库（Prisma/SQLite，运行时生成）
├── mini-services/
│   └── data-service/                    # Python FastAPI 微服务
│       ├── main.py                      # 入口（FastAPI + APScheduler）
│       ├── config.py                    # 配置（DB 路径 / Token / 阈值）
│       ├── routers/                     # cached/refresh/calculate/data-source/data-quality/macro/health
│       ├── services/
│       │   ├── rule_engine.py           # 规则引擎统一入口
│       │   ├── data_clean_engine.py     # ETL 清洗（含 safe_num / clean_numeric）
│       │   ├── data_quality_score.py    # 质量评分
│       │   ├── data_source_manager.py   # 多源注册中心 + 字段级路由 + 熔断降级
│       │   ├── akshare_service.py       # 主源适配器
│       │   ├── tushare_service.py       # 备源适配器
│       │   ├── efinance_service.py      # efinance 适配器
│       │   ├── eastmoney_direct_service.py  # eastmoney 直接抓取
│       │   ├── csindex_direct_service.py    # 中证指数直接抓取
│       │   └── macro_service.py         # 宏观温度计（中债/美债/USD-CNH/VIX）
│       ├── scheduler/                   # APScheduler 定时任务
│       ├── models/                      # Pydantic schemas
│       ├── requirements.txt
│       └── db/
│           └── market_data.db           # 市场数据库（含 cache/raw/clean/quality/lineage 7 张表）
├── scripts/                             # 运维脚本
│   ├── backup-db.sh                     # 备份业务库 + 市场库
│   └── reset-cache.sh                   # 清空市场缓存（保留业务数据）
├── backup/                              # 备份目录（自动生成，运行时创建）
├── setup.sh                             # 一键安装（依赖 + DB + 种子）
├── start.sh                             # 一键启动两个服务
├── stop.sh                              # 停止服务
├── status.sh                            # 查看服务状态
├── .env.example                         # 环境变量模板
├── .env                                 # 本地环境变量（运行时创建，不提交）
└── package.json
```

## 常见问题（FAQ）

### Q: 页面打开空白？

A: 运行 `./status.sh` 检查两个服务是否运行：
- 前端（3000）已停止 → `./start.sh` 重启
- data-service（3031）已停止 → `./start.sh` 重启
- 两个都停止 → `./start.sh` 一键启动
- 若 status.sh 显示运行中但页面仍空白 → 查看 `/tmp/etf-frontend.log` 排查编译错误

### Q: 数据刷新很慢？

A: 行情刷新需 **1~3 分钟**（6 只 ETF × 5 类指标 + 4 个市场指数 + 汇率，多源拉取），属正常现象。
- 如需快速查看温度，先点击「刷新宏观数据」（约 15 秒）查看趋势页宏观温度计
- 行情刷新进度可在「设置 → 数据源管理 → 拉取日志」Tab 实时查看
- 长时间无响应 → `./stop.sh && ./start.sh` 重启后再试

### Q: 怎么重置数据？

A: 分两种情况：

**重置业务数据**（持仓/规则/现金水池）：
```bash
./scripts/backup-db.sh            # 先备份
bun run db:reset                  # 重置 Prisma DB (会提示确认)
bun run prisma/seed.ts            # 重新插入种子数据
./start.sh                        # 重启服务
```

**清空市场缓存**（保留业务数据，仅清空行情/质量评分/拉取日志）：
```bash
./scripts/reset-cache.sh          # 交互式确认后清空
# 然后在设置页重新点击「刷新行情数据」
```

### Q: Tushare Token 怎么配置？

A: 两种方式（任选其一）：
- **方式一（编辑配置文件）**：编辑 `.env` 文件，将 `TUSHARE_TOKEN=""` 改为你的 token
  ```ini
  TUSHARE_TOKEN="your-tushare-token-here"
  ```
  修改后需 `./stop.sh && ./start.sh` 重启服务生效
- **方式二（设置页配置）**：进入「设置 → 数据源管理 → 数据源列表」Tab，找到 Tushare 行，点击「配置 Token」按钮，输入 token 即可热生效

> 未配置 Tushare Token 时，系统自动跳过 tushare 备用源，仅使用主源（akshare）+ 直接抓取（efinance/eastmoney/csindex），不影响主流程。

### Q: 持仓截图识别不准？

A: VLM 截图识别准确率取决于截图清晰度。建议：
- 使用券商 APP 完整持仓页截图（包含代码 / 名称 / 持仓份额 / 成本 / 市值）
- 截图分辨率不低于 1080×1920
- 识别结果可在「总览页」持仓表格中手动修改
- 完全手动输入：点击「手动录入持仓」按钮

### Q: 怎么修改目标比例 / 定投预算？

A: 进入「设置 → 目标配置」Section，可直接修改：
- 6 只 ETF 的目标占比（系统会校验总和）
- 每周定投预算金额
- 修改后下次「生成本周定投建议」即生效

### Q: 服务被沙箱 / 系统回收了怎么办？

A: 长时间空闲时，dev server 可能被回收。运行 `./start.sh` 即可重启。建议：
- 长时间使用前先 `./status.sh` 确认状态
- 持续使用时不要关闭终端窗口（`nohup` 已后台运行，但进程仍依赖系统会话）
- 生产环境建议使用 `pm2` / `systemd` 守护进程

### Q: 升级到新版本后怎么处理？

A:
```bash
git pull origin main
./setup.sh                # 重新安装依赖 + 数据库迁移
./stop.sh && ./start.sh   # 重启服务
```

如果 schema 有变更，`./setup.sh` 会自动执行 `bun run db:push`，但已存在的业务数据会被保留（仅添加新字段/表）。

## 风险提示

本系统仅作为个人投资决策辅助工具，**不构成任何投资建议**。所有规则、阈值、目标比例均为个人设定，使用者需自行承担投资风险。AI 生成的解释文本受一致性校验约束，但仍可能存在偏差，请以规则引擎计算结果为准。

## License

MIT
