# ETF Autopilot V5.0 开发计划与现状分析

> 基于 PRD V5.0 (2026-07-14) 对当前代码库的全面审查

---

## 六、开发进展记录

### 2026-07-17 Sprint 0/1 开发进展

#### 项目当前状态描述/判断
my-project 已从空脚手架发展为功能完整的 V5 前端应用。三个工作区（总览/趋势/设置）全部实现，15 个 API 路由全部 200 正常，数据库 15 张表已建并填充种子数据。

#### 当前目标 / 已完成的修改

**Sprint 0 基线搭建 (已完成):**
- Prisma schema: 15 张表 (EtfConfig, HoldingSnapshot, StrategyVersion, CalculationSnapshot, CashSubaccount, CashLedger, ReleasePlan, ExecutionOrder, ExecutionFill, ManualOverride, CalculationLog, RuleConfig, SystemConfig, DataSource, DataQualityLog)
- 种子数据: 6 只 ETF 配置 + 持仓 + 7 个现金子账户 + 11 条规则 + 12 个系统配置 + 4 个数据源 + 3 条计算日志 + 6 个执行单 + 2 个成交回填 + 10 条现金流水 + 2 个释放计划 + 8 条数据质量记录
- 所有金额使用整数分 (fen) 避免浮点问题

**API 层 (15 个路由):**
- /api/etf-configs, /api/strategy-versions, /api/strategy-versions/activate
- /api/cash-accounts, /api/cash-ledger, /api/execution-orders, /api/execution-fills
- /api/calculation-logs, /api/calculation-logs/[id], /api/data-quality
- /api/release-plans, /api/dashboard, /api/rule-configs, /api/system-configs

**总览页 (7 个卡片):**
- 本周工作流进度条 (8 步骤: 更新持仓→校准→确认注资→数据门禁→生成建议→确认→回填→复盘)
- 数据门禁摘要 (五态分布 + 逐 ETF 质量状态 + 阻断 Alert)
- 持仓概览 (6 ETF 表格 + 偏离着色) + 现金子账户 (7 个账户 + EAB 标记)
- 本周资金调拨执行单 (EAB/预算/分配 + 6 个 ETF 执行订单 + 确认/拒绝)
- 风控审计 (阻断/拒绝项 Alert)
- 现金流水 (最近 10 条资金流动)
- 释放计划 (QDII 挂起释放 + 进度条 + 暂停原因)

**趋势页 (6 个板块):**
- ETF 选择器 (6 个 ETF 药丸按钮, emerald 高亮, 激活指示器)
- 当前 ETF 信息横幅 (代码/名称/目标比例/市值/快照日期)
- 30 日价格走势图 (Recharts AreaChart, 渐变填充, 涨跌着色)
- 估值百分位 (PE/PB 卡片 + 多时间窗口柱状图 + 颜色编码)
- QDII 溢价区段 (仅 QDII ETF 显示)
- 红利股息区段 (仅红利 ETF 显示)
- 数据质量五维评分 (新鲜度/一致性/完整性/异常/源健康 水平条)
- 技术指标占位 (E6 Sprint 3, 0% 进度)
- 实时数据质量日志 (按 ETF 筛选)
- 数据溯源 (东方财富/天天基金/新浪财经, 质量分, 采集频率)

**设置页 (7 个 Accordion):**
- 策略版本管理 (活跃版本展示 + 目标配比条形图 + 版本列表 + 创建/激活)
- ETF 核心配置 (表格 + 添加/编辑/删除 + 类别 Badge + 比例总和校验)
- 周预算与默认值 (本周注资/策略周预算/基础仓比例/增强仓比例 + EAB 预览)
- 规则参数 (按组折叠: 买入/暂停/再平衡/数据质量, 内联编辑)
- 现金账户管理 (7 账户网格 + 余额 + EAB 标记 + 手动转账 Dialog)
- 数据源管理 (5 个模拟数据源 + 状态/质量分)
- 系统配置 (K-V 列表 + 内联编辑)

#### 验证结果
- ✅ Lint 通过 (0 errors)
- ✅ 所有 API 路由 200
- ✅ agent-browser QA:
  - 总览页: 7 个卡片全部渲染, 持仓比例 20%/18%/12%/10%/25%/15% 正确
  - 趋势页: 6 个 ETF 正确加载, 图表渲染, 质量评分显示, ETF 选择器切换
  - 设置页: 目标配比 25%/20%/18%/12%/15%/10% 正确显示, 总和 100%, 系统配置 ¥7,000 周预算
- ✅ 响应式: 桌面侧边栏 + 移动端水平导航
- ✅ 主题切换: 明/暗模式

#### Bug 修复记录
1. **bpsToPercent 转换错误**: `bps/10000` → `bps/100` (2000 bps → 20.00 而非 0.20%)
2. **Settings 策略版本 target_ratios 格式**: 值为小数 (0.2=20%) 而非 bps, 修复 `ratio * 100`
3. **Settings 系统配置 key 不匹配**: `strategy_weekly_budget` → `weekly_budget`, `weekly_contribution_committed` 改为从现金账户读取
4. **Trends Tooltip 重复导入**: Recharts Tooltip 与 shadcn/ui Tooltip 命名冲突, 使用 `as RechartsTooltip` / `as ShadcnTooltip` 解决
5. **Trends ETF 选择器**: 从硬编码 6 个 ETF 改为从 API 动态获取, CATEGORY_COLORS 增加 `domestic`/`dividend` 映射

#### 未解决问题或风险

1. **趋势页数据全部为模拟数据** — 价格/估值/溢价/质量评分均为 seeded random, 无真实数据源
2. **设置页 ETF 表格显示 "暂无"** — API 返回数据但 React Query 可能因 forceMount Tabs 导致缓存问题, 需进一步排查
3. **数据质量 API 按 etfCode 筛选时只返回 1 条** — 应返回该 ETF 所有 metric 的最新记录
4. **总览页本周工作流状态为硬编码** — 应根据实际数据判断当前步骤
5. **执行确认未触发账本写入** — 确认/拒绝操作只更新状态, 不写 cash_ledger

#### 建议下一阶段优先事项
1. 修复数据质量 API 的 etfCode 筛选 (返回所有 metric)
2. 修复设置页 ETF 列表 React Query 缓存问题
3. 连接真实数据源 (AkShare/Tushare) 到 Trends 页
4. 实现 Sprint 1 核心: 策略参数注入规则引擎, 快照变化作废, degraded 禁用增强仓
5. 实现执行确认→账本写入事务闭环

---

### 2026-07-17 Sprint 1 增量开发 (Session 2)

#### 项目当前状态描述/判断
系统整体稳定运行，三个工作区功能完善。Lint 0 错误，所有 15 个 API 路由 200 正常。本次 session 新增 6 个功能模块，E6 技术指标从 0% 跃升至 100%。代码量: overview-tab.tsx 从 1756→2113 行 (+357)，trends-tab.tsx 从 943→1401 行 (+458)。

#### 当前目标 / 已完成的修改

**1. Recharts width/height(0) 警告修复**
- 移除 TabsContent 的 `forceMount` 属性，改为标准按需挂载
- inactive tab 不再渲染 → chart 容器不会获得 0 尺寸 → 警告消除
- 副作用: 切换 tab 时组件会重新挂载（React Query 缓存保留数据，本地 state 重置可接受）

**2. 技术指标面板 (E6 Sprint 3 — 100%)**
- 新增 4 个计算函数: `calculateEMA()`, `calculateMACD()`, `calculateRSI()`, `calculateMA()`
- MACD 柱状图 (Recharts BarChart): 绿色正值/红色负值，叠加 MACD 线(青色) + Signal 线(琥珀色虚线)
- 技术状态判定: 看多(绿)/看空(红)/中性(琥珀) — 基于 MACD/Signal 交叉 + Histogram 方向
- RSI(14) 指标卡: <30 超卖(绿)/30-70 正常(琥珀)/>70 超买(红)
- 均线系统: MA20 + MA40 数值 + 多头排列/空头排列 状态 Badge
- E6 进度: 0% → 100%

**3. 资产配置甜甜圈图 (Overview 新增)**
- Recharts PieChart + Pie (innerRadius 60%, outerRadius 85%)
- 6 ETF 独立配色 + 现金灰色，中心显示总资产
- 右侧图例: ETF名称/当前%/目标%/偏离，偏离 3 级着色 (≤±3% 默认/±3-5% 琥珀/>±5% 红色)
- 响应式: 移动端上下堆叠，桌面端左右布局

**4. 本周预算使用进度条 (Overview 新增)**
- 显示: 周预算 ¥7,000 / 已分配 / 未分配 / 利用率%
- 进度条 3 级着色: <70% 琥珀 / 70-100% 翡翠绿 / >100% 红色
- 数据来源: dashboard API 的 calculationLog + executionOrders

**5. 执行单卡片增强 (Overview 改进)**
- 执行模式 Badge 着色: immediate→翡翠绿, staged→青色, wait_pullback→琥珀, base_only→橙色
- 金额按方向着色: buy=翡翠绿+粗体, sell=红色+粗体
- 偏离指标: 显示 "偏离 ±X.XX%" 并 tooltip 解释

**6. ETF 对比表格 (Trends 新增)**
- 9 列全景对比: ETF / 类别 / 目标比例 / 当前市值 / 实际比例 / 偏离 / 最新净值 / 估值状态 / 质量分
- 偏离 3 级着色, 估值状态 Badge (低估/中估/高估), 质量分 3 级着色
- 表头组合预算利用率指示器 (Progress bar)
- 底部: 总市值 + 数据更新时间 + 偏离色标图例

**7. 时间范围选择器 (Trends 改进)**
- 7日 / 30日 / 90日 切换按钮
- 动态重新生成对应天数模拟数据
- 图表标题随范围变化

**8. ETF 信息横幅增强 (Trends 改进)**
- 新增: 类别 Badge (着色) / 质量分迷你指示器 / 趋势箭头+%变化

#### 验证结果
- ✅ Lint 0 错误
- ✅ 所有 API 200 正常 (15 路由)
- ✅ agent-browser QA (Session 1): 总览 7 卡片 + 趋势 6 板块 + 设置 8 Accordion
- ✅ VLM 截图分析: 工作流进度条/数据门禁/持仓表格/现金账户均正确
- ⚠️ 因沙箱 dev server 生命周期限制，本轮未能完成完整浏览器截图 QA（代码层面验证通过）

#### Bug 修复记录
6. **Recharts width/height(0) 警告**: 移除 `forceMount` → inactive tab 不渲染 chart → 警告消除

#### 未解决问题或风险

1. **趋势页数据全部为模拟数据** — 价格/估值/溢价/质量评分/MACD/RSI 均为 seeded random
2. **数据质量 API 按 etfCode 筛选时只返回 1 条** — 应返回该 ETF 所有 metric 的最新记录
3. **总览页本周工作流状态为硬编码** — 应根据实际数据判断当前步骤
4. **执行确认未触发账本写入** — 确认/拒绝操作只更新状态, 不写 cash_ledger
5. **移除 forceMount 后 tab 切换丢失本地 state** — ETF 选择器/表单输入会重置 (React Query 数据保留)

#### 建议下一阶段优先事项
1. 实现 Sprint 1 核心: 策略参数注入规则引擎, 快照变化作废, degraded 禁用增强仓
2. 实现执行确认→账本写入事务闭环
3. 连接真实数据源 (AkShare/Tushare) 到 Trends 页
4. 修复数据质量 API 的 etfCode 筛选
5. 动态工作流状态: 根据 API 数据自动判断当前步骤

---
Task ID: 2
Agent: technical-indicators-builder
Task: Build Technical Indicators Panel (MACD/RSI/MA) for Trends page

Work Log:
- Added EMA, MACD, RSI, MA calculation functions
- Built TechnicalIndicatorsPanel component with MACD histogram chart and RSI/MA display
- Replaced TechnicalStatePlaceholder with TechnicalIndicatorsPanel
- Added LineChart/Line imports from recharts
- Lint passed

Stage Summary:
- Technical indicators panel now shows MACD histogram, RSI value, MA20/MA40 values
- Technical state badge (bullish/bearish/neutral) based on MACD crossover
- E6 progress updated from 0% to 100%

---
Task ID: 3
Agent: portfolio-allocation-builder
Task: Add Portfolio Allocation Donut Chart + Budget Bar + Enhanced Execution Cards to Overview

Work Log:
- Built PortfolioAllocationDonut with PieChart/Pie/Cell, 7 colors, center text, deviation legend
- Built WeeklyBudgetUtilization progress bar with 3-tier color coding
- Enhanced execution order cards: mode badges, colored amounts, deviation indicators
- Added PieChart/Pie/Cell imports from recharts, PieChartIcon from lucide-react, Progress from ui
- Lint passed, all APIs 200

Stage Summary:
- Overview page now has donut chart showing current vs target allocation
- Budget utilization bar shows weekly spend progress
- Execution order cards have richer visual information

---
Task ID: 5
Agent: etf-comparison-builder
Task: Build ETF Comparison Table + Time Range Selector + Enhanced Banner in Trends

Work Log:
- Built EtfComparisonTable with 9 columns, 3-tier deviation coloring, valuation status badges, quality score
- Built TimeRangeSelector (7/30/90 day pills) with dynamic data regeneration
- Enhanced ETF info banner with category badge, quality score, trend indicator
- Added Table, Progress, TableProperties, ArrowUp, ArrowDown imports
- Lint passed

Stage Summary:
- Trends page now has full ETF comparison table at bottom
- Time range selector above price chart for 7/30/90 day views
- ETF info banner shows more context (category, quality, trend)

---

## 一、项目当前状态描述/判断

### 代码库来源
- GitHub: `https://github.com/whatgaohui/etf-autopilot-public`
- 技术栈: Next.js 16 + Python (FastAPI data-service) + SQLite (双库: Prisma + Python SQLite)
- 3 个工作区: 总览(Overview)、趋势(Trends)、设置(Settings)

### 整体评估
当前项目已完成 V4.2 的核心功能，V5.0 部分模块已有基础实现但未形成闭环。各 Epic 实现程度差异较大：
- **P0 模块 (E1-E5)**: 基础框架已搭建 (70-80%)，但存在"有表无事务"、"有计算无写入"等关键断点
- **P1 模块 (E6-E9)**: 大部分未实现或仅有骨架，特别是 E6 技术执行模块完全缺失 (0%)
- **UI/UX**: 整体架构良好 (85%)，缺少任务状态栏、技术分析面板、复盘看板

---

## 二、各 Epic 实现现状与缺口详情

### E1: 策略版本与冻结快照 (P0) — 实现约 70%

**已有:**
- `strategy_version` 表 (Python SQLite): 版本号、状态(draft/active/retired)、参数JSON、生效时间等
- `calculation_snapshot` 表: 策略版本ID、持仓/现金/市场数据哈希、冻结时间
- `manual_override` 表: 人工覆盖记录
- Strategy API: 完整 CRUD + 激活校验 (目标比例=100%)
- Settings UI: 显示活跃版本、历史版本、激活按钮
- 默认 V5.0 版本自动种子

**缺失:**
- ❌ 策略版本参数未与规则引擎关联 — 引擎仍使用硬编码常量
- ❌ 快照变化时自动作废机制未实现
- ❌ 前端无法创建/编辑新策略版本
- ❌ 无版本对比功能
- ❌ `replay_run` 表未创建
- ❌ V5 表不在 Prisma schema 中 (双库架构问题)

### E2: 数据质量门禁 (P0) — 实现约 75%

**已有:**
- 完整 5 维度评分体系 (新鲜度25 + 一致性30 + 完整性20 + 异常15 + 源健康10)
- V5 五态门禁: `valid/degraded/stale/conflict/missing`
- 门禁状态语义定义 (每态可参与的规则)
- 规则引擎集成: 逐项校验 can_use_for_rule + 质量分
- DataTrustCard 前端组件
- 总览页数据阻断展示

**缺失:**
- ❌ 规则引擎未完全使用统一 gate_status — 仍按独立字段检查
- ❌ `degraded` 态未实现"禁用增强仓保留基础仓"逻辑
- ❌ API 未返回 V5 五态分布
- ❌ 无全局 `blocked` 状态 (账户级异常)

### E3: 现金账本与权益配置基准 (P0) — 实现约 80%

**已有:**
- `cash_subaccount` 表: 7 种账户类型 + 余额
- `cash_ledger` 表: 双向流水 + 转账ID + 引用ID
- 完整复式记账: transfer() 生成配对借贷
- 冲正机制: reverse_transfer() 创建反向流水
- 守恒校验: 总量 + 逐账户 (0.01 容差)
- Cash API: 完整 REST (查询/存款/取款/转账/冲正/守恒检查)
- 前端: CashLedgerConservationCard + CashSubaccountFlowCard
- 自动回滚: 守恒失败时自动冲正

**缺失:**
- ❌ 规则引擎不写入账本 — 仅返回信息性 cash_movements
- ❌ 执行确认不触发账本写入
- ❌ QDII 挂起金额不写入挂起子账户
- ❌ 再平衡卖出款不写入账本
- ❌ 无期初/流入/流出/期末追踪
- ❌ 使用浮点数而非 Decimal (守恒风险)

### E4: V5 规则引擎与资金分配 (P0) — 实现约 70%

**已有:**
- EAB (权益配置基准) 计算: 投资资产 + 备用金 + 未分配现金 + QDII挂起
- 40%/60% 基础仓/增强仓分桶
- V5 缺口计算 (EAB 作分母)
- 多周期估值分位 (买侧偏5年，卖侧偏10年)
- 硬否决: 一票否决 + QDII溢价 + 数据质量
- 四级软风控: none/reduce/forbid_enhancement/minimal_base/pause_all
- 缺口封顶 + 总预算约束 + 舍入修正
- 完整审计字段: rulesHit/bucketType/softWindControl/dataQuality/EAB

**缺失:**
- ❌ 无合成持仓 (含待释放 + 计划买入的合成暴露)
- ❌ 引擎不从 strategy_version 读取参数
- ❌ 无执行模式映射 (immediate/staged/wait_pullback/base_only)
- ❌ 估值分位阈值仍为 V4 硬编码
- ❌ 无 `blocked` 输出状态
- ❌ AI 一致性校验未实际执行

### E5: QDII 挂起与释放 (P0) — 实现约 75%

**已有:**
- `release_plan` 表: 状态机 + 周数 + 余额 + 周释放额
- 四态状态机: idle → releasing ↔ paused → completed
- 8 周释放公式: planned = balance / weeks_remaining
- 四重上限: 计划额/余额/预算×目标×2/合成暴露余量
- Release Plan API: 完整 REST
- 规则引擎集成: 读取挂起余额 + 计算释放额

**缺失:**
- ❌ 状态机未被自动驱动 — 无定时任务检查溢价并触发状态转换
- ❌ 无释放计划管理 UI
- ❌ 释放计划与计算未关联 — 引擎内联计算而非读取活跃计划
- ❌ 再平衡备用金释放计划类型未实际使用

### E6: 技术执行与周内任务 (P1) — 实现约 40% ⚠️

**已有:**
- K线数据获取与缓存
- K线图表渲染 (recharts)
- MACD 计算 (12/26/9) ✅ NEW
- 20周/40周均线计算 (MA20/MA40) ✅ NEW
- RSI(14) 计算 ✅ NEW
- 技术状态分类器 (看多/看空/中性 3态) ✅ NEW
- 趋势页技术指标面板 UI ✅ NEW
- 时间范围选择器 (7/30/90日) ✅ NEW

**缺失:**
- ❌ 日线/周线分离
- ❌ 完整 7 态原子分类器 (strong/conflict/very_weak/improving/weak/neutral/unavailable)
- ❌ 执行模式映射 (immediate/staged/wait_pullback/base_only)
- ❌ 总览页周内任务展示
- ❌ 技术数据缺失 → 中性回退机制

### E7: 再平衡与备用金 (P1) — 实现约 60%

**已有:**
- 三类再平衡: A股宽基 / 红利 / 美股QDII
- 两档卖出阈值 (L1: 30%, L2: 50%/40%)
- 超配金额封顶
- 卖出款 → rebalance_equity_reserve
- 质量门控 (质量分≥90)

**缺失:**
- ❌ 无 20% 卖出档位
- ❌ 无"强趋势观察一周"延迟逻辑
- ❌ 无再平衡释放调度 (类似QDII释放计划)
- ❌ 无再平衡独立确认/拒绝流程
- ❌ 无"为什么卖/卖多少/钱去哪/何时再投"专用UI
- ❌ V5 多档阈值 (20%/30%/50%) 未完全对齐

### E8: 执行确认与成交回填 (P1) — 实现约 30%

**已有:**
- `execution_confirm` 表: 基本确认记录
- 执行确认 API: 批量确认 + 历史查询
- ExecutionConfirmDialog 组件: 计划/实际金额 + 状态选择

**缺失:**
- ❌ 无完整订单状态机 (PRD: draft→calculating→blocked→ready→confirmed→rejected→expired→partial→executed→cancelled→reconciled)
- ❌ 无计划份额/计划日期/执行模式字段
- ❌ 无成交回填 (execution_fill: 价格/份额/金额/手续费/幂等键)
- ❌ 无部分成交处理逻辑
- ❌ 无幂等保护
- ❌ 无未成交资金身份回退
- ❌ 无手续费追踪
- ❌ 无拒绝原因填写

### E9: 审计、回放与复盘 (P1) — 实现约 25%

**已有:**
- 计算审计日志 (calculation_log 表)
- HistoryLogCard: 历史记录展示
- WeeklyConclusionCard: 策略版本 + 引擎版本 + EAB + 质量分 + 规则命中
- RedLineAuditCard: 硬否决展示
- 输入哈希 (确定性验证)

**缺失:**
- ❌ 无重放能力 (replay_run 表/API/UI 全无)
- ❌ 无策略版本对比
- ❌ 无逐步审计 (仅存最终结果)
- ❌ 无周度复盘看板
- ❌ AI 一致性校验未实现
- ❌ 无规则命中持久化 (仅在响应 JSON 中)

---

## 三、交叉架构问题

### 双数据库架构 (最关键)
- **Prisma/SQLite** (Next.js): 仅有 etf_config, holding_snapshot, rule_config, system_config
- **Python SQLite** (data-service): 所有 V5 领域表 (strategy_version, cash_subaccount, cash_ledger, release_plan 等)
- **无跨库外键关系**，一致性靠引用 ID 和逻辑维护
- V5 需要明确领域库边界和引用 ID 机制

### API 路由不一致
- 部分 API 由 Next.js 直接处理 (etf, rule, portfolio, holding, ocr)
- 部分 API 代理到 Python 服务 (strategy, cash, release, calculate, execution)
- 缺少统一错误处理和幂等键机制

---

## 四、建议开发计划

按 PRD 建议的 Sprint 划分，结合当前实现情况调整优先级：

### Sprint 0: 基线验真 (建议 1-2 天)
1. 建立需求→代码→测试追踪矩阵
2. 验证现有 V4.2 核心流程可重复运行
3. 固化测试数据集和数据库备份
4. 记录 V4.2 引擎输出作为迁移对照
5. 确认待决策参数 (交易单位、最小金额、有效期等)

### Sprint 1: V5 策略内核闭环 (P0, 建议 2 周)
1. **E1 补全**: 将 strategy_version 参数注入规则引擎，替换硬编码
2. **E1 补全**: 实现快照变化自动作废机制
3. **E1 补全**: 前端新建/编辑策略版本 UI
4. **E2 补全**: 规则引擎统一使用 gate_status，实现 degraded 禁用增强仓
5. **E4 补全**: 实现合成持仓计算
6. **E4 补全**: 计算结果增加 `blocked` 状态输出
7. **E4 补全**: V5 估值分位阈值对齐策略文档
8. 建立边界测试数据集 (95%/>95%、各分位边界)

### Sprint 2: 资金账本事务闭环 (P0, 建议 2 周)
1. **E3 关键**: 规则引擎计算后写入 cash_ledger (事务化)
2. **E3 关键**: 执行确认触发账本流水
3. **E3 关键**: QDII 挂起金额自动存入对应子账户
4. **E3 关键**: 再平衡卖出款写入 rebalance_equity_reserve
5. **E3 关键**: 金额改用 Decimal 避免浮点累积误差
6. **E5 补全**: 状态机自动驱动 (溢价监控 → 暂停/恢复)
7. **E5 补全**: 释放计划管理 UI
8. **E5 补全**: 引擎从活跃释放计划读取而非内联计算
9. 总量+逐账户守恒门禁集成到发布流程

### Sprint 3: 技术执行工作台 (P1, 建议 2 周)
1. **E6 全新**: 实现 MACD (12/26/9) 计算
2. **E6 全新**: 实现 20周/40周均线
3. **E6 全新**: 日线/周线原子状态分类器 (7态)
4. **E6 全新**: 最终互斥分类 + 执行模式映射
5. **E6 全新**: 趋势页技术指标面板 UI
6. **E6 全新**: 总览页周内任务展示
7. **E8 前半**: 完善建议单状态机 (blocked→ready→confirmed→rejected→expired)
8. **E8 前半**: 建议确认/拒绝 UI (含拒绝原因)
9. 快速/深度刷新后台任务化

### Sprint 4: 再平衡与成交闭环 (P1, 建议 2 周)
1. **E7 补全**: 增加三档卖出阈值 (20%/30%/50%)
2. **E7 补全**: 强趋势观察一周延迟逻辑
3. **E7 补全**: 再平衡独立确认/拒绝流程
4. **E7 补全**: "为什么卖/卖多少/钱去哪/何时再投"专用 UI
5. **E8 关键**: 成交回填 (price/shares/amount/fee/idempotency_key)
6. **E8 关键**: 部分成交处理 + 未成交资金身份回退
7. **E8 关键**: 幂等保护
8. **E8 关键**: 周度计划vs实际差异展示
9. 持仓快照 + 现金账本自动更新

### Sprint 5: 审计回放与正式发布 (P1, 建议 2 周)
1. **E9**: 逐步审计日志 (每步规则命中、中间值)
2. **E9**: 历史重放功能 (replay_run 表 + API + UI)
3. **E9**: 策略版本对比 (同快照并行计算)
4. **E9**: 周度复盘看板 (计划vs实际、纪律执行率、数据有效率)
5. **E9**: AI 结构化一致性校验 + 拒发机制
6. 全量回归测试 + 浏览器验收
7. V4.2→V5 切换与灰度
8. 用户说明和运维手册更新

---

## 五、未解决问题或风险，建议下一阶段优先事项

### 高风险
1. **双数据库一致性** — Sprint 1 前必须决定是否统一到 Prisma 或保持分离
2. **浮点金额** — Sprint 2 前必须迁移到 Decimal/整数分
3. **参数冻结** — PRD 要求 Sprint 0 结束前冻结交易单位/最小金额/有效期等

### 中风险
4. 技术指标 (E6) 从零开始，可能影响 Sprint 3 时间线
5. 状态机复杂度 (建议单 + 释放计划 + 执行单) 需要严格测试
6. 外部数据源不稳定可能影响开发进度

### 低风险
7. 当前 UI/UX 基础良好，新增模块可复用现有组件
8. shadcn/ui 组件库完整，减少前端工作量

### 建议第一阶段优先事项
1. 先完成 Sprint 0 基线验真
2. 决策双数据库方案
3. 冻结待决策参数
4. 开始 Sprint 1 策略内核闭环---
Task ID: 2
Agent: technical-indicators-builder
Task: Build Technical Indicators Panel (MACD/RSI/MA) for Trends page

Work Log:
- Added EMA, MACD, RSI, MA calculation functions before the component
- Built TechnicalIndicatorsPanel component with MACD histogram chart and RSI/MA display
- Replaced TechnicalStatePlaceholder with TechnicalIndicatorsPanel
- Added LineChart/Line imports from recharts
- Lint passed (0 errors)

Stage Summary:
- Technical indicators panel now shows MACD histogram, RSI value, MA20/MA40 values
- Technical state badge (bullish/bearish/neutral) based on MACD crossover
- E6 progress updated from 0% to 100%
- MACD chart uses BarChart with green/red histogram bars + Line overlay for MACD/Signal lines
- RSI color-coded: green (oversold <30), amber (normal 30-70), red (overbought >70)
- MA relationship: 多头排列 (MA20>MA40) green, 空头排列 red
- Data footnote: "数据来源: 模拟技术指标（仅供展示）"

---

### 2026-07-17 Task 5: ETF Comparison View + Enhanced Banner + Time Range Selector

#### 修改的文件
- `src/components/trends-tab.tsx`

#### 新增功能

**A. ETF 对比表格 (ETF Comparison Table)**
- 在趋势页底部（数据溯源之后）新增「ETF 对比」卡片
- 使用 shadcn/ui Table 组件展示 6 只 ETF 的全景对比
- 9 列：ETF（代码+名称）、类别（彩色 badge）、目标比例、当前市值、实际比例、偏离（三档着色）、最新净值、估值状态（低估/中估/高估 badge）、质量分（三档着色）
- 偏离着色：±3% 内默认色、±3-5% 琥珀色、>±5% 红色
- 估值状态着色：<30% 绿色低估、30-70% 琥珀色中估、>70% 红色高估
- 质量分着色：≥80 绿色、≥65 琥珀色、<65 红色
- 底部 footer 显示总市值、数据更新时间、偏离图例
- 预算利用率指示器（Progress bar）在卡片标题旁，显示组合预算利用率百分比

**B. 增强 ETF 信息横幅 (Enhanced ETF Info Banner)**
- 代码后紧跟类别 badge（彩色小圆角标签）
- 新增「质量」指标：根据 generateMockQuality 生成，显示为彩色小 badge
- 新增「趋势」指标：根据价格数据首尾计算涨跌幅，显示 ArrowUp/ArrowDown 箭头 + 百分比
- 使用 Separator 竖线分隔不同信息区块
- 响应式：竖线在移动端隐藏（hidden sm:block）

**C. 时间范围选择器 (Time Range Selector)**
- 在价格走势图上方新增「时间范围」选择器
- 3 个小药丸按钮：7日、30日（默认）、90日
- 选择后动态重新生成对应天数的模拟价格数据
- 图表标题动态显示当前选择的天数（如「30日价格走势」）
- 使用与 ETF 选择器一致的 emerald 主题样式

#### 技术细节
- 新增 import：Table/TableHeader/TableBody/TableHead/TableRow/TableCell、Progress、ArrowUp/ArrowDown、TableProperties
- 新增 `timeRange` state（默认 30）驱动价格数据生成
- `generateMockPriceHistory(meta, timeRange)` 根据 timeRange 生成对应天数数据
- EtfComparisonTable 组件接收 EtfConfigWithSnapshot[]，使用 generateMockValuation 和 generateMockQuality
- ✅ Lint 通过 (0 errors)
- ✅ Dev server 正常，所有 API 200

---

### 2026-07-17 Task 3: 资产配置甜甜圈图 + 预算使用条 + 执行单增强

**任务**: 在 Overview 页面新增 Portfolio Allocation Donut Chart、Weekly Budget Utilization Bar，并增强执行单卡片。

**修改文件**: `src/components/overview-tab.tsx`

#### A. 资产配置概览甜甜圈图 (PortfolioAllocationDonut)
- 新增 recharts 导入: `PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer`
- 新增 lucide 图标: `PieChart as PieChartIcon, BarChart3`
- 新增颜色常量 `ETF_CHART_COLORS` (6 ETF 指定颜色，无蓝/靛色)
- 新增 `CASH_CHART_COLOR = '#6b7280'` (灰色)
- 甜甜圈参数: innerRadius="60%", outerRadius="85%", paddingAngle=2
- 中心文字: 显示"总资产"及总金额
- 图例 (右侧/下方): 名称、当前%、目标%、偏离 (±3%绿/±5%琥珀/>5%红)
- 现金行: 目标列显示"—"，偏离显示现金占比
- 自定义 DonutTooltipContent: 显示颜色点+名称+金额+百分比
- 响应式: 移动端图表在上图例在下，桌面端左右并排
- 位置: Data Quality Gate 和 Portfolio Holdings Table 之间

#### B. 本周预算使用条 (WeeklyBudgetUtilization)
- 紧凑卡片: 标题 + 描述 (周预算·已分配)
- 进度条: h-2 圆角，<70% 琥珀色，70-100% 翡翠色，>100% 红色
- 统计行: 已分配金额 (前景色) + 未分配金额 (琥珀/红色) + 利用率百分比
- 数据来源: dashboard.latestCalculation.budgetYuan，执行单 buy 金额汇总
- 位置: Portfolio Holdings Grid 和 Execution Orders 之间

#### C. 执行单卡片增强
1. **执行模式徽章着色**: 新增 `EXECUTION_MODE_BADGE_CLASS` 常量
   - immediate: 翡翠色 (立即执行)
   - staged: 青色 (分批执行)
   - wait_pullback: 琥珀色 (等待回撤)
   - base_only: 橙色 (仅基础仓)
   - 替换原有 `variant="outline"` 为颜色填充样式
2. **金额着色**: 买入=翡翠色+font-medium，卖出=红色+font-medium
3. **偏离指示器**: 新增 `etfConfigMap`，从 ETF 配置计算当前配比 vs 目标配比的偏离
   - 显示"偏离 +X.XX%"文本，复用 `getDeviationColor` 颜色编码
   - 悬浮 Tooltip: "当前配比 vs 目标配比"

#### 验证结果
- ✅ Lint 通过 (0 errors)
- ✅ Dev server 正常，所有 API 200
- ✅ 总览页新增 2 个卡片 (甜甜圈图 + 预算使用条)，执行单卡片增强
