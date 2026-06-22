# 个人ETF自动化监控与资金调拨辅助系统 PRD v4

> 产品名称：个人ETF自动化监控与资金调拨辅助系统  
> 文档类型：产品需求文档 PRD  
> 当前版本：v4  
> 适用对象：AI开发系统、产品设计、前端开发、后端开发、规则引擎开发、测试Agent  
> 重要说明：本 PRD 只描述产品能力、页面交互、接口、数据结构和验收标准；具体投资决策规则、估值周期、数据源优先级、买入/暂停/再平衡策略，统一以《ETF定投助手投资策略说明书 V4》为准。

---

## 1. 版本更新说明

相较于旧版 PRD，本版本重点升级：

1. 产品从“定投建议系统”升级为“资金调拨辅助系统”。
2. 增加“再平衡模块”，不再只输出买入建议。
3. 投资策略独立为《ETF定投助手投资策略说明书 V4》，PRD 不再重复硬编码完整策略。
4. 增加多周期估值分位能力：1年、3年、5年、10年/全历史。
5. 增加数据源管理、主备源校验、数据质量评分。
6. 增加数据血缘、数据清洗、异常值处理要求。
7. 增加现金水池规则，未投资资金和再平衡释放资金默认转入华宝添益。
8. 增加完整计算审计字段和 calculation_log。
9. 增加 AI 输出一致性校验，防止 LLM 修改金额。
10. 总览页从“买入建议表”升级为“每周资金调拨执行单”。

---

## 2. 产品定位

本系统旨在解决个人投资者在 ETF 长期投资中遇到的四类问题：

1. 监控指标繁杂，人工判断成本高。
2. 容易受情绪和短期涨跌影响。
3. 定投只解决买入问题，缺少退出/再平衡机制。
4. 数据源不一致、估值周期不清晰，导致决策不可信。

产品定位：

```text
一个可审计、可解释、纪律化的个人ETF定投与再平衡资金调拨辅助系统
```

系统不预测短期涨跌，不做清仓择时，而是通过：

```text
持仓识别
数据缓存
数据质量校验
目标缺口计算
买入规则判断
再平衡规则判断
现金水池管理
AI解释
```

输出一张每周可执行的：

```text
资金调拨执行单
```

---

## 3. 核心原则

### 3.1 规则引擎算账，AI只解释

系统必须遵守：

```text
Python规则引擎是唯一金额计算权威
LLM只能解释规则引擎结果
LLM不得修改、重算、调整任何金额
前端不得根据目标比例二次计算金额
Next.js API聚合层不得篡改final_amount
```

### 3.2 策略文档是投资规则权威

本 PRD 中涉及投资策略的地方只描述产品能力。

具体规则以以下文档为准：

```text
《ETF定投助手投资策略说明书 V4》
```

包括但不限于：

1. 估值周期选择。
2. 买入规则。
3. 一票否决规则。
4. 减量/加量规则。
5. 再平衡规则。
6. QDII溢价处理。
7. 红利ETF股息率规则。
8. 数据源优先级。
9. 数据质量策略。
10. 现金水池规则。

---

## 4. 投资标的与配置

### 4.1 定投标的池

| 大类 | 基金名称 | 代码 | 目标占比 |
|---|---|---:|---:|
| 国内权益 | 中证A500ETF | 159338 | 18% |
| 国内权益 | 红利ETF | 510880 | 18% |
| 国内权益 | 沪深300ETF | 510330 | 12% |
| 国内权益 | 科创50ETF | 588000 | 12% |
| 海外权益 | 标普500ETF | 513500 | 24% |
| 海外权益 | 纳斯达克ETF | 513300 | 16% |

大类目标：

```text
国内权益 60%
海外权益 40%
```

### 4.2 非定投资产

| 基金名称 | 代码 | 定位 | 系统处理 |
|---|---:|---|---|
| 黄金ETF华安 | 518880 | 家庭分工，由配偶投资 | 黑名单，不参与定投和再平衡 |
| 华宝添益ETF | 511990 | 现金水池 | 承接未投资金额和再平衡释放资金 |

### 4.3 定投额度

默认每周新增预算：

```text
40,000 元
```

可在设置页调整。

---

## 5. 核心业务闭环

### 5.1 每周使用流程

```text
用户进入总览页
→ 上传持仓截图 / 手动录入
→ OCR识别与人工校准
→ 保存本周持仓快照
→ 系统读取市场数据缓存
→ 执行数据质量检查
→ Python规则引擎计算买入建议
→ Python规则引擎计算再平衡建议
→ 生成资金调拨执行单
→ LLM生成解释文案
→ 程序校验AI文案一致性
→ 用户线下执行
```

### 5.2 系统输出从“买入建议”升级为“资金调拨执行单”

每周执行单必须包含：

```text
外部注入资金
内部释放资金
可用资金池
建议买入清单
暂停买入清单
再平衡建议清单
未投资金额
资金去向
规则命中原因
数据质量说明
计算批次ID
```

---

## 6. 页面结构

系统仍然保留三个主Tab：

| 页面 | 定位 | 核心交互 |
|---|---|---|
| 总览 | 每周操作入口 | 更新持仓、生成资金调拨执行单、查看风险与再平衡 |
| 趋势 | 估值与数据分析 | 查看多周期估值、溢价、股息率、数据质量 |
| 设置 | 系统配置 | 目标比例、预算、规则参数、数据源、现金水池 |

---

## 7. 总览页需求

### 7.1 页面结构

总览页采用三段式：

```text
第一段：本周资金调拨结论卡
第二段：风险红线与再平衡审计卡
第三段：持仓与计算明细折叠表
```

### 7.2 持仓上传区

支持：

1. 上传持仓截图。
2. OCR识别。
3. 人工校准。
4. 手动录入。
5. 保存本周持仓快照。
6. 显示上次校准时间。
7. 显示持仓数据质量检查结果。

OCR识别字段：

```text
基金名称
基金代码
持仓份额
成本价
市值
盈亏
可用份额
```

必须提供人工校准，校准后再参与计算。

### 7.3 本周资金调拨结论卡

结论卡展示：

```text
本周新增预算
建议买入金额
建议再平衡金额
未投资金额
华宝添益流入金额
本周总动作摘要
计算批次ID
数据更新时间
```

示例：

```text
本周资金调拨建议

外部注入：+40,000 元
内部释放：+12,500 元
建议买入：40,000 元
建议再平衡：12,500 元
未投资金额：0 元
华宝添益流入：12,500 元

本周动作：
- 买入沪深300ETF、红利ETF
- 暂停买入标普500ETF、纳斯达克ETF
- 科创50ETF触发一级再平衡
```

### 7.4 风险红线与再平衡审计卡

展示三类信息：

#### A. 一票否决

```text
标的
触发规则
实际值
阈值
结果
```

#### B. 暂停买入

```text
标的
原因
买入金额
释放预算去向
```

#### C. 再平衡建议

```text
标的
当前占比
目标占比
偏离度
估值分位
超额市值
建议卖出比例
建议卖出金额
资金去向
```

### 7.5 持仓与计算明细折叠表

主表字段：

| 字段 | 说明 |
|---|---|
| 代码 | ETF代码 |
| 名称 | ETF名称 |
| 当前市值 | OCR/手动校准后的市值 |
| 当前占比 | 定投资产口径 |
| 目标占比 | 设置页目标 |
| 偏离度 | 当前占比 - 目标占比 |
| 数据状态 | 通过/异常/不足 |
| 买入建议 | final_buy_amount |
| 再平衡建议 | final_rebalance_amount |
| 规则状态 | 正常/减量/加量/否决/再平衡 |

展开后展示：

```text
当前市值
当前占比
目标占比
预算后目标市值
目标缺口
多周期估值分位
QDII溢价
股息率分位
命中规则
规则优先级
倍率
目标缺口封顶
最终买入金额
超额市值
再平衡金额
数据源对比
数据质量字段
AI解释
```

### 7.6 资产配置图

必须支持两个口径切换：

```text
总资产口径：6只ETF + 黄金ETF + 华宝添益
定投资产口径：仅6只定投ETF
```

图表要求：

1. 有图例。
2. 悬浮展示市值、占比、是否参与定投。
3. 黑名单和现金水池资产使用弱化样式。
4. 支持“当前占比 vs 目标占比”横向对比图。

---

## 8. 趋势页需求

### 8.1 ETF选择器

支持查看6只定投ETF：

```text
159338 中证A500ETF
510880 红利ETF
510330 沪深300ETF
588000 科创50ETF
513500 标普500ETF
513300 纳斯达克ETF
```

### 8.2 多周期估值面板

每只ETF展示：

```text
近1年分位
近3年分位
近5年分位
近10年/最长历史分位
样本天数
是否参与强规则
数据源
更新时间
```

展示规则：

1. 近1年分位只做情绪参考。
2. 近5年分位用于买入侧。
3. 近10年/最长历史分位用于再平衡侧。
4. 样本不足时标记，不触发强规则。

### 8.3 国内ETF指标

对中证A500、沪深300、科创50展示：

```text
PE值
PE多周期分位
PB值
PB多周期分位
估值趋势图
规则影响说明
```

A500需特殊展示：

```text
自身历史样本不足时，提示“样本不足”
显示代理指数参考，例如沪深300 / 中证800 / 全A宽基
```

### 8.4 红利ETF指标

红利ETF展示：

```text
股息率
股息率多周期分位
PE/PB辅助指标
股息率趋势图
规则影响说明
```

规则影响说明示例：

```text
当前股息率分位较低，代表红利ETF价格相对偏贵。
若同时出现明显超配，可能触发再平衡。
```

### 8.5 QDII ETF指标

对标普500、纳斯达克展示：

```text
PE值
PE多周期分位
当日溢价率
近3日溢价率均值
近7日溢价率均值
近20日/30日溢价率趋势
2%预警线
3%买入红线
5%再平衡辅助线
规则影响说明
```

说明：

```text
QDII高溢价对买入是负面因素；
如果已满足再平衡条件，高溢价可作为卖出辅助窗口。
```

### 8.6 数据质量展示

趋势页每个图表必须显示：

```text
数据源
更新时间
样本天数
数据质量状态
是否参与规则计算
```

当数据不足时：

```text
显示空状态，不渲染错误图表
```

禁止图表出现：

```text
99999999
NaN
Inf
异常大数
```

---

## 9. 设置页需求

### 9.1 目标配置

支持配置：

```text
6只ETF目标占比
国内权益合计
海外权益合计
每周新增预算
```

校验：

```text
6只ETF目标占比合计必须等于100%
默认国内60%，海外40%
```

### 9.2 规则配置

设置页只展示规则配置入口和人话表达，具体规则由策略文档定义。

要求：

1. 规则分组：买入规则、暂停规则、再平衡规则、数据质量规则、现金水池规则。
2. 支持启用/停用。
3. 支持编辑阈值。
4. 支持新增自定义规则。
5. 支持恢复默认规则。
6. 开关必须显示“已启用/已停用”。

展示示例：

| 技术参数 | 前端展示 |
|---|---|
| premium_rate > 3 | 溢价率 > 3% |
| pe_percentile_5y > 80 | 5年PE分位 > 80% |
| pe_percentile_10y > 95 | 10年PE分位 > 95% |
| deviation > 5pp | 当前占比超过目标5个百分点 |
| dividend_yield_percentile < 15 | 股息率分位 < 15% |

### 9.3 数据源配置

新增数据源配置模块。

功能：

1. 配置主数据源。
2. 配置备份数据源。
3. 配置API Token。
4. 查看最近一次拉取状态。
5. 查看主备源差异。
6. 设置差异容忍阈值。
7. 手动刷新数据。
8. 测试数据源连通性。

数据源分组：

```text
行情价格源
基金净值源
指数估值源
QDII溢价源
股息率源
```

### 9.4 数据质量规则配置

支持配置：

```text
样本天数阈值
缓存过期阈值
主备源差异阈值
异常值过滤阈值
关键数据缺失处理方式
```

关键数据缺失策略默认：

```text
保守：不自动买入，不自动再平衡，提示人工确认
```

可选未来策略：

```text
中性：忽略该规则，仅提示风险
```

MVP默认只实现保守策略。

### 9.5 现金水池配置

现金水池默认：

```text
华宝添益ETF 511990
```

支持配置：

1. 现金水池标的。
2. 未投资资金是否自动转入现金水池。
3. 再平衡释放资金是否自动转入现金水池。
4. 现金占比提醒阈值。

默认：

```text
未投资资金 → 华宝添益
再平衡释放资金 → 华宝添益
现金占比 > 20% 提醒
现金占比 > 30% 强提醒
```

---

## 10. 规则引擎需求

### 10.1 规则引擎职责

Python规则引擎负责：

```text
目标缺口计算
买入建议计算
暂停买入判断
再平衡建议计算
现金水池流向计算
数据质量判断
规则命中审计
金额取整
结果输出
```

禁止LLM和前端承担金额计算职责。

### 10.2 计算模块

规则引擎拆成以下模块：

```text
DataQualityEngine
ValuationEngine
BuyAllocationEngine
RebalanceEngine
CashPoolEngine
AuditEngine
```

### 10.3 买入算法

买入算法使用：

```text
目标缺口驱动算法
```

具体规则参考：

```text
《ETF定投助手投资策略说明书 V4》第6章
```

### 10.4 再平衡算法

再平衡算法使用：

```text
估值极端 + 明显超配 双条件触发
```

具体规则参考：

```text
《ETF定投助手投资策略说明书 V4》第7章
```

---

## 11. API需求

### 11.1 Python微服务接口

| 接口 | 功能 |
|---|---|
| GET /api/health | 微服务健康检查、数据更新时间、规则引擎版本 |
| POST /api/refresh | 手动刷新市场数据并执行ETL清洗 |
| GET /api/cached/valuation | 获取估值数据、多周期分位、数据质量 |
| GET /api/cached/premium | 获取QDII溢价数据、3/7/30日均值 |
| GET /api/cached/nav | 获取ETF净值 |
| GET /api/cached/dividend | 获取股息率数据 |
| POST /api/calculate | 生成完整资金调拨执行单 |
| GET /api/data-source/status | 查看数据源状态 |
| POST /api/data-source/test | 测试数据源连通性 |

### 11.2 /api/calculate 输入

```json
{
  "holding_snapshot_id": "holding-20260617",
  "weekly_budget": 40000,
  "target_config": {},
  "rule_config_version": "rules-v4",
  "strategy_version": "strategy-v4",
  "allocation_mode": "conservative"
}
```

### 11.3 /api/calculate 输出

必须返回：

```json
{
  "calculation_id": "20260617-220000-a1b2c3",
  "engine_version": "target-gap-rebalance-v4",
  "strategy_version": "strategy-v4",
  "calculated_at": "2026-06-17T22:00:00+08:00",
  "total_budget": 40000,
  "external_inflow": 40000,
  "internal_release": 12500,
  "total_buy_amount": 40000,
  "total_rebalance_amount": 12500,
  "total_unallocated": 0,
  "cash_pool_inflow": 12500,
  "cash_destination": "511990",
  "data_snapshot": {
    "holding_snapshot_id": "holding-20260617",
    "market_data_cache_time": "2026-06-17 15:30:00",
    "rules_config_version": "rules-v4",
    "strategy_version": "strategy-v4"
  },
  "buy_suggestions": [],
  "pause_suggestions": [],
  "rebalance_suggestions": [],
  "cash_pool_suggestions": [],
  "data_quality_summary": {},
  "rules_hit_summary": {}
}
```

---

## 12. 数据库需求

### 12.1 etf_config

记录ETF基础配置：

```sql
code TEXT PRIMARY KEY,
name TEXT,
asset_class TEXT,
target_ratio REAL,
is_dca_target BOOLEAN,
is_blacklisted BOOLEAN,
role TEXT,
created_at TEXT,
updated_at TEXT
```

### 12.2 holding_snapshot

记录持仓快照：

```sql
id TEXT PRIMARY KEY,
snapshot_date TEXT,
code TEXT,
name TEXT,
shares REAL,
cost_price REAL,
market_value REAL,
source TEXT,
ocr_confidence REAL,
is_manual_corrected BOOLEAN,
created_at TEXT
```

### 12.3 market_data_cache

记录清洗后的市场数据：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
code TEXT,
trade_date TEXT,
data_type TEXT,
raw_value TEXT,
clean_value REAL,
source TEXT,
source_api TEXT,
is_valid BOOLEAN,
abnormal_reason TEXT,
sample_days INTEGER,
percentile_window TEXT,
percentile REAL,
updated_at TEXT,
UNIQUE(code, trade_date, data_type, source)
```

### 12.4 data_source_status

记录数据源状态：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source_name TEXT,
source_type TEXT,
last_fetch_time TEXT,
last_success_time TEXT,
status TEXT,
error_message TEXT,
latency_ms INTEGER,
created_at TEXT
```

### 12.5 rule_config

记录规则配置：

```sql
id TEXT PRIMARY KEY,
enabled BOOLEAN,
rule_group TEXT,
rule_type TEXT,
rule_name TEXT,
condition_metric TEXT,
percentile_window TEXT,
operator TEXT,
threshold_min REAL,
threshold_max REAL,
applies_to TEXT,
priority INTEGER,
effect TEXT,
display_text TEXT,
strategy_doc_ref TEXT,
updated_at TEXT
```

### 12.6 calculation_log

记录每次计算结果：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
calculation_id TEXT UNIQUE,
engine_version TEXT,
strategy_version TEXT,
holding_snapshot_id TEXT,
rules_config_version TEXT,
market_data_snapshot_time TEXT,
input_json TEXT,
output_json TEXT,
ai_explanation_json TEXT,
ai_check_result TEXT,
created_at TEXT
```

---

## 13. AI解释需求

### 13.1 LLM职责

LLM只负责：

```text
解释本周为什么买
解释为什么暂停
解释为什么再平衡
解释数据质量风险
解释资金去向
```

LLM不得：

```text
修改金额
重新计算金额
新增规则
基于宏观新闻调整金额
将final_amount=0改写成少量买入
```

### 13.2 LLM输入

LLM只能接收：

```text
规则引擎输出JSON
命中规则明细
数据质量明细
市场数据快照
宏观环境摘要
```

### 13.3 一致性校验

展示AI文案前必须校验：

1. AI文案中的金额是否等于规则引擎金额。
2. AI是否提到未命中的规则。
3. AI是否说“因宏观环境调整金额”。
4. final_amount=0的标的是否被AI说成“少量买入”。

若不一致：

```text
拒绝展示AI文案
改用模板解释
记录ai_check_result
```

---

## 14. 数据清洗与图表安全

### 14.1 后端清洗

所有外部数据入库前必须：

1. 转换为numeric。
2. 将NaN、Inf转为null。
3. 将99999999、-99999999等异常占位转为null。
4. 设置is_valid=false。
5. 记录abnormal_reason。
6. 不允许异常值进入规则引擎。

### 14.2 前端图表保护

前端图表渲染前二次过滤：

```typescript
const validPoints = points.filter(p =>
  p.value !== null &&
  Number.isFinite(p.value) &&
  Math.abs(p.value) < 999999
)
```

有效点不足时：

```text
当前历史数据不足，暂不展示图表
```

---

## 15. 验收标准

### 15.1 策略正确性验收

| 场景 | 期望 |
|---|---|
| ETF已超配 | 买入金额为0或显著降低 |
| PE分位>80% | 买入侧暂停或否决 |
| QDII溢价>3% | QDII买入金额为0 |
| PE/PB极高且明显超配 | 输出再平衡建议 |
| 美股PE高但未超配 | 不卖，只暂停新增 |
| QDII高溢价且明显超配 | 可输出情绪溢价再平衡建议 |
| 数据不足 | 不自动买入/再平衡，提示人工确认 |
| 未分配资金 | 进入华宝添益 |

### 15.2 数据准确性验收

| 场景 | 期望 |
|---|---|
| 主备源价格差异超过阈值 | 标记源不一致 |
| ETF净值超过2个交易日未更新 | 标黄 |
| QDII溢价缺失 | 不自动买入 |
| 99999999进入数据 | clean_value=null，不进入图表 |
| 样本不足 | 展示但不触发强规则 |
| 缓存过期 | 页面提示数据可能过期 |

### 15.3 页面验收

总览页：

- [ ] 有资金调拨结论卡。
- [ ] 有风险红线与再平衡审计卡。
- [ ] 有持仓与计算明细折叠表。
- [ ] 展示买入、暂停、再平衡、现金水池流向。
- [ ] 展示calculation_id和数据更新时间。
- [ ] 展示数据质量状态。

趋势页：

- [ ] 展示多周期估值分位。
- [ ] 展示样本天数。
- [ ] 展示数据源和更新时间。
- [ ] 展示QDII溢价3/7/30日数据。
- [ ] 展示红利ETF股息率分位。
- [ ] 图表无异常大数。

设置页：

- [ ] 可配置目标比例。
- [ ] 可配置每周预算。
- [ ] 可配置规则阈值。
- [ ] 可配置数据源。
- [ ] 可配置数据质量阈值。
- [ ] 可配置现金水池。
- [ ] 规则参数用自然语言展示。

---

## 16. 迭代优先级

### P0：先修可信度

1. target-gap买入算法。
2. 再平衡引擎。
3. 数据质量引擎。
4. 主备源校验。
5. calculation_log。
6. AI一致性校验。

### P1：完善页面闭环

1. 总览页资金调拨执行单。
2. 风险红线与再平衡卡。
3. 趋势页多周期估值。
4. 设置页数据源配置。
5. 现金水池展示。

### P2：增强专业能力

1. 数据源自动切换。
2. 历史建议回溯。
3. 规则回测。
4. 现金水池高级策略。
5. 微信/邮件推送。

---

## 17. 最终交付目标

用户每周只需要：

```text
1. 更新持仓。
2. 点击生成执行单。
3. 查看本周资金调拨结论。
4. 查看红线和再平衡原因。
5. 必要时展开明细。
6. 线下执行。
```

系统必须让用户清楚知道：

```text
本周买什么
为什么买
为什么不买
为什么再平衡
卖出的是不是超配部分
未投资的钱去哪
数据是否可信
AI有没有改金额
```

最终产品形态：

```text
一个可审计、可解释、纪律化的ETF资金调拨辅助系统
```
