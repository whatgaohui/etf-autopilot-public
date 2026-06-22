# 个人ETF自动化监控与资金调拨辅助系统 PRD v4.1（数据源管理增强版）

> 产品名称：个人ETF自动化监控与资金调拨辅助系统  
> 文档类型：产品需求文档 PRD  
> 当前版本：v4.1  
> 适用对象：AI开发系统、产品设计、前端开发、后端开发、规则引擎开发、测试Agent  
> 重要说明：本 PRD 只描述产品能力、页面交互、接口、数据结构和验收标准；具体投资决策规则、估值周期、买入/暂停/再平衡策略，以《ETF定投助手投资策略说明书 V4.1》为准。  
> 本版本重点新增：**数据源管理模块**，用于解决单一数据源不稳定、数据口径不一致、异常值污染规则引擎、数据无法追溯等问题。

---

## 1. 版本更新说明

相较于 PRD v4，本版本重点升级：

1. 产品继续定位为“ETF资金调拨辅助系统”，输出每周资金调拨执行单。
2. 增强数据源管理能力，从“简单配置数据源”升级为“数据源治理模块”。
3. 新增数据源注册中心 DataSource Registry。
4. 新增数据源适配器 DataSource Adapter。
5. 新增主源、备源、校验源的指标级配置能力。
6. 新增数据拉取日志、原始数据存储、清洗数据存储。
7. 新增主备源交叉校验 Cross Source Validator。
8. 新增数据质量评分 Data Quality Score。
9. 新增数据源健康检查、备源切换、异常熔断。
10. 新增总览页“数据可信度卡”。
11. 新增趋势页指标级数据血缘展示。
12. 新增设置页“数据源管理”完整模块。
13. 新增数据源相关 API 与数据库表。
14. 明确规则引擎只能读取 clean_value 与 can_use_for_rule，不得直接读取外部接口原始值。
15. 明确当数据不可信时，系统宁可不出自动建议，也不能用脏数据生成买入/再平衡建议。

---

## 2. 产品定位

本系统旨在解决个人投资者在 ETF 长期投资中的四类问题：

1. 监控指标繁杂，人工判断成本高。
2. 容易受情绪和短期涨跌影响。
3. 定投只解决买入问题，缺少退出/再平衡机制。
4. 数据源不稳定、口径不一致、估值周期不清晰，导致决策不可信。

产品定位：

```text
一个可审计、可解释、纪律化的个人ETF定投与再平衡资金调拨辅助系统
```

系统不预测短期涨跌，不做清仓择时，而是通过：

```text
持仓识别
数据源管理
数据缓存
数据清洗
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

### 3.2 数据可信优先

新增核心原则：

```text
数据不可信，宁可不出建议；
数据可信，规则引擎才允许算账。
```

规则引擎不得直接读取外部接口值，必须读取：

```text
market_data_clean.clean_value
data_quality_result.can_use_for_rule
source_compare_result.compare_status
```

当关键数据不可用、过期、源冲突、质量评分过低时：

```text
不生成自动买入建议
不生成自动再平衡建议
提示用户人工确认
```

### 3.3 策略文档是投资规则权威

本 PRD 中涉及投资策略的地方只描述产品能力。

具体规则以以下文档为准：

```text
《ETF定投助手投资策略说明书 V4.1》
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
→ 系统检查数据源状态
→ 系统读取市场数据缓存
→ 执行数据新鲜度检查
→ 执行主备源交叉校验
→ 执行数据质量评分
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
数据源可信度说明
计算批次ID
```

---

## 6. 页面结构

系统保留主功能结构，但新增“数据源管理”作为设置页一级模块，也可作为顶部二级入口。

| 页面 | 定位 | 核心交互 |
|---|---|---|
| 总览 | 每周操作入口 | 更新持仓、生成资金调拨执行单、查看风险与再平衡 |
| 趋势 | 估值与数据分析 | 查看多周期估值、溢价、股息率、数据质量 |
| 设置 | 系统配置 | 目标比例、预算、规则参数、现金水池 |
| 数据源管理 | 数据可信度管理 | 数据源配置、主备源校验、质量评分、拉取日志、异常处理 |

数据源管理可以实现为：

```text
方案A：设置页中的独立Tab
方案B：顶部导航独立页面
MVP建议：设置页独立Tab
```

---

## 7. 总览页需求

### 7.1 页面结构

总览页采用四段式：

```text
第一段：持仓上传与校准
第二段：数据可信度卡
第三段：本周资金调拨结论卡
第四段：风险红线与再平衡审计卡 + 明细折叠表
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

---

### 7.3 数据可信度卡

新增模块：数据可信度卡。

展示位置：

```text
持仓上传区下方，资金调拨结论卡上方
```

展示内容：

```text
数据质量总分
本次是否允许自动生成建议
行情价格状态
基金净值状态
QDII溢价状态
指数估值状态
股息率状态
主备源一致性
缓存更新时间
异常指标数量
```

示例：

```text
数据可信度：可用 86分

行情价格：通过
基金净值：通过
QDII溢价：可疑，净值可能滞后
指数估值：通过
红利股息率：数据不足

本次建议：允许生成买入建议；不允许触发强再平衡。
```

状态规则：

| 状态 | 说明 | 执行动作 |
|---|---|---|
| 优秀 | 质量分 >= 90 | 可生成买入和再平衡建议 |
| 可用 | 质量分 75~89 | 可生成建议，但需标注 |
| 可疑 | 质量分 60~74 | 仅展示观察建议，不触发强规则 |
| 不可用 | 质量分 < 60 | 不生成自动建议 |

当关键数据异常时展示：

```text
关键数据源异常，本次不生成自动执行建议，请先处理数据源问题或人工确认。
```

---

### 7.4 本周资金调拨结论卡

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
数据质量总分
```

---

### 7.5 风险红线与再平衡审计卡

展示三类信息：

#### A. 一票否决

```text
标的
触发规则
实际值
阈值
结果
数据源
数据质量
```

#### B. 暂停买入

```text
标的
原因
买入金额
释放预算去向
数据质量说明
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
数据源可信度
```

---

### 7.6 持仓与计算明细折叠表

主表字段：

| 字段 | 说明 |
|---|---|
| 代码 | ETF代码 |
| 名称 | ETF名称 |
| 当前市值 | OCR/手动校准后的市值 |
| 当前占比 | 定投资产口径 |
| 目标占比 | 设置页目标 |
| 偏离度 | 当前占比 - 目标占比 |
| 数据状态 | 通过/异常/不足/源冲突 |
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
主源数据
备源数据
源差异
数据质量评分
数据血缘
AI解释
```

---

### 7.7 资产配置图

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
主数据源
备份数据源
更新时间
数据质量状态
```

展示规则：

1. 近1年分位只做情绪参考。
2. 近5年分位用于买入侧。
3. 近10年/最长历史分位用于再平衡侧。
4. 样本不足时标记，不触发强规则。

---

### 8.3 国内ETF指标

对中证A500、沪深300、科创50展示：

```text
PE值
PE多周期分位
PB值
PB多周期分位
估值趋势图
数据源
数据质量
规则影响说明
```

A500需特殊展示：

```text
自身历史样本不足时，提示“样本不足”
显示代理指数参考，例如沪深300 / 中证800 / 全A宽基
```

---

### 8.4 红利ETF指标

红利ETF展示：

```text
股息率
股息率多周期分位
PE/PB辅助指标
股息率趋势图
数据源
数据质量
规则影响说明
```

---

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
净值日期
净值滞后天数
数据源
数据质量
规则影响说明
```

说明：

```text
QDII高溢价对买入是负面因素；
如果已满足再平衡条件，高溢价可作为卖出辅助窗口。
```

---

### 8.6 数据血缘展示

每个指标支持展开“数据血缘”。

展示字段：

```text
metric_type
source_id
source_api
raw_value
clean_value
trade_date
fetch_time
updated_at
quality_score
quality_status
source_compare_status
can_use_for_rule
abnormal_reason
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

---

### 9.3 现金水池配置

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

## 10. 数据源管理模块需求

### 10.1 模块定位

数据源管理模块用于管理：

```text
数据从哪里来
数据准不准
数据是否新鲜
数据是否能参与规则计算
数据异常时系统如何降级
```

模块目标：

```text
从单一AkShare抓取
升级为
多源接入、主备校验、质量评分、异常熔断、可回溯数据血缘
```

---

### 10.2 数据源注册中心 DataSource Registry

功能：

1. 维护所有数据源基础信息。
2. 配置数据源类型。
3. 配置是否启用。
4. 配置优先级。
5. 配置支持指标。
6. 配置API Token。
7. 配置频率限制。
8. 查看健康状态。
9. 查看最近成功时间。
10. 查看最近错误。

字段：

```text
source_id
source_name
source_type
provider_type
base_url
auth_type
api_key_required
rate_limit
enabled
priority
supported_metrics
last_success_time
last_error_time
health_status
error_message
```

数据源类型：

| 类型 | 示例 |
|---|---|
| free_open_source | AkShare、efinance、BaoStock |
| freemium_api | Tushare Pro、Alpha Vantage |
| paid_sdk | JQData |
| commercial | Wind、Choice、iFinD |
| official | 指数公司官网、基金公司官网 |
| manual | 用户手动导入CSV |

---

### 10.3 指标级数据源配置

系统必须按指标配置数据源，而不是只配置一个全局主源。

支持指标：

```text
ETF场内价格
基金净值
QDII溢价率
指数PE/PB
估值分位
红利股息率
交易日历
ETF基础信息
基金分红
```

每个指标支持配置：

```text
主源 primary_source
备源 backup_source
校验源 validator_source
差异容忍阈值
过期阈值
是否允许单源降级
是否允许参与强规则
```

示例：

| 指标 | 主源 | 备源 | 校验源 |
|---|---|---|---|
| ETF场内价格 | Tushare / JQData | AkShare / efinance | 东方财富 / 交易所 |
| 基金净值 | Tushare / JQData | AkShare / 天天基金 | 基金公司官网 |
| QDII溢价率 | 自算：价格/净值-1 | 东方财富展示值 | 净值更新时间校验 |
| 指数估值 | 指数公司 / Tushare / JQData | AkShare | Wind / Choice / iFinD |
| 红利股息率 | 指数公司 / 商业源 | AkShare / 东方财富 | 指数官网 / 基金报告 |

---

### 10.4 数据源适配器 DataSource Adapter

每个数据源必须实现统一接口。

```python
class DataSourceAdapter:
    source_id: str
    source_name: str

    def health_check(self) -> dict:
        ...

    def fetch_etf_price(self, code: str, start_date: str, end_date: str) -> list[dict]:
        ...

    def fetch_fund_nav(self, code: str, start_date: str, end_date: str) -> list[dict]:
        ...

    def fetch_index_valuation(self, index_code: str, start_date: str, end_date: str) -> list[dict]:
        ...

    def fetch_dividend_yield(self, code: str, start_date: str, end_date: str) -> list[dict]:
        ...

    def fetch_trading_calendar(self, start_date: str, end_date: str) -> list[dict]:
        ...
```

要求：

```text
不同数据源差异在Adapter内部处理
规则引擎不直接调用具体数据源
所有Adapter输出统一字段结构
所有Adapter输出必须保留raw_json
```

统一输出字段：

```text
code
trade_date
metric_type
raw_value
raw_json
source_id
source_api
fetch_time
request_id
```

---

### 10.5 数据获取调度 Data Fetch Scheduler

推荐调度：

| 任务 | 时间 | 说明 |
|---|---|---|
| A股ETF行情 | 15:10 / 15:30后 | 更新收盘价 |
| 指数估值 | 16:00后 | 更新PE/PB |
| 基金净值 | 20:00后 | 更新普通基金净值 |
| QDII净值 | 21:00后 / 次日 | 注意时区滞后 |
| 股息率 | 每日16:00 / 每周一次 | 视数据源频率 |
| 数据源健康检查 | 每小时 | 检查接口可用性 |
| 主备源校验 | 每日数据更新后 | 生成质量评分 |
| 历史数据回补 | 每日21:00 | 补缺失日期 |

---

### 10.6 数据清洗引擎 Data Cleaning Engine

所有数据入库前统一清洗。

```python
def clean_numeric(value):
    if value is None:
        return None
    try:
        x = float(value)
    except Exception:
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    if abs(x) >= 999999:
        return None
    return x
```

异常值规则：

| 指标 | 异常条件 |
|---|---|
| PE | <=0 或 >=500 |
| PB | <=0 或 >=100 |
| QDII溢价率 | abs(value) > 30% |
| 股息率 | <0 或 >20% |
| 净值 | <=0 |
| 价格 | <=0 |
| 市值 | <=0 |
| 份额 | <0 |

处理要求：

```text
raw_value保留
clean_value置空
is_valid=false
abnormal_reason写明原因
```

---

### 10.7 主备源交叉校验 Cross Source Validator

功能：

1. 对同一指标的主源和备源进行对比。
2. 生成差异率。
3. 判断是否通过质量阈值。
4. 决定该指标是否允许参与规则计算。

校验阈值：

| 字段 | 通过阈值 | 严重异常阈值 |
|---|---:|---:|
| ETF收盘价 | <=0.1% | >0.3% |
| 基金净值 | <=0.3% | >0.8% |
| QDII溢价率 | <=0.5个百分点 | >1个百分点 |
| PE/PB原始值 | <=2% | >5% |
| PE/PB分位 | <=5个百分点 | >10个百分点 |
| 股息率 | <=0.2个百分点 | >0.5个百分点 |

处理：

```text
通过：参与规则
轻微差异：参与规则但标注
严重差异：不参与规则，提示人工确认
```

---

### 10.8 数据质量评分 Data Quality Score

每个指标生成0~100分质量评分：

```text
数据新鲜度：25分
主备源一致性：30分
字段完整性：20分
异常值检测：15分
数据源健康：10分
```

评级：

| 分数 | 状态 | 是否参与规则 |
|---:|---|---|
| >=90 | 优秀 | 可以参与强规则 |
| 75~89 | 可用 | 可以参与规则，但需标注 |
| 60~74 | 可疑 | 默认不参与强规则，仅展示 |
| <60 | 不可用 | 不参与规则 |

规则：

```text
买入建议至少要求数据质量 >=75
再平衡建议至少要求数据质量 >=90
QDII溢价买入否决至少要求价格和净值数据均可用
```

---

### 10.9 数据降级与熔断机制

当主源失败：

```text
尝试备源
备源成功且质量通过 → 使用备源，并标记source_fallback=true
备源也失败 → 使用最近有效缓存，并标记stale=true
缓存过期 → 阻断自动建议
```

当主备源冲突：

```text
不盲目选择任一来源
标记source_conflict
阻断强买入/强再平衡规则
提示人工确认
```

当只有单一数据源：

```text
允许展示
允许生成观察建议
不允许触发强再平衡
买入侧仅允许保守建议，并展示single_source_warning
```

当数据异常：

```text
关键数据异常 → 暂停自动买入/再平衡
辅助数据异常 → 继续计算，但展示风险提示
```

---

### 10.10 数据源管理页面

设置页新增「数据源管理」Tab。

功能区块：

1. 数据源列表。
2. 指标级主备源配置。
3. API Token配置。
4. 数据源启用/停用。
5. 数据源连接测试。
6. 最近拉取状态。
7. 错误日志。
8. 主备源差异阈值配置。
9. 手动刷新数据。
10. 数据质量结果查看。
11. 数据血缘查看。
12. 数据源异常处理提示。

数据源列表字段：

| 字段 | 说明 |
|---|---|
| 数据源 | AkShare / Tushare / JQData等 |
| 类型 | 免费/付费/商业/官方 |
| 覆盖指标 | 行情/净值/估值/溢价/股息率 |
| 当前角色 | 主源/备源/校验源 |
| 状态 | 正常/异常/限流/Token失效 |
| 最近成功时间 | last_success_time |
| 最近错误 | last_error_message |
| 操作 | 测试/刷新/启用/停用 |

---

## 11. 规则引擎需求

### 11.1 规则引擎职责

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

### 11.2 计算模块

规则引擎拆成以下模块：

```text
DataSourceEngine
DataQualityEngine
ValuationEngine
BuyAllocationEngine
RebalanceEngine
CashPoolEngine
AuditEngine
```

### 11.3 数据准入

规则引擎只能读取：

```text
market_data_clean.clean_value
data_quality_result.can_use_for_rule
source_compare_result.compare_status
```

当：

```text
can_use_for_rule = false
```

对应指标不得参与买入和再平衡计算。

### 11.4 买入算法

买入算法使用：

```text
目标缺口驱动算法
```

具体规则参考：

```text
《ETF定投助手投资策略说明书 V4.1》第6章
```

### 11.5 再平衡算法

再平衡算法使用：

```text
估值极端 + 明显超配 双条件触发
```

具体规则参考：

```text
《ETF定投助手投资策略说明书 V4.1》第7章
```

---

## 12. API需求

### 12.1 Python微服务接口

| 接口 | 功能 |
|---|---|
| GET /api/health | 微服务健康检查、数据更新时间、规则引擎版本 |
| POST /api/refresh | 手动刷新市场数据并执行ETL清洗 |
| GET /api/cached/valuation | 获取估值数据、多周期分位、数据质量 |
| GET /api/cached/premium | 获取QDII溢价数据、3/7/30日均值 |
| GET /api/cached/nav | 获取ETF净值 |
| GET /api/cached/dividend | 获取股息率数据 |
| POST /api/calculate | 生成完整资金调拨执行单 |
| GET /api/data-sources | 获取数据源列表 |
| POST /api/data-sources | 新增数据源 |
| PUT /api/data-sources/{id} | 更新数据源配置 |
| POST /api/data-sources/{id}/test | 测试数据源连通性 |
| POST /api/data-sources/{id}/enable | 启用数据源 |
| POST /api/data-sources/{id}/disable | 停用数据源 |
| GET /api/data-sources/status | 查看所有数据源健康状态 |
| POST /api/data-sources/compare | 执行主备源差异校验 |
| GET /api/data-quality/summary | 获取整体数据质量 |
| GET /api/data-quality/{code} | 获取单只ETF数据质量 |
| GET /api/data-quality/logs | 获取数据质量日志 |
| GET /api/data-quality/conflicts | 获取主备源冲突列表 |
| GET /api/data-fetch/logs | 获取数据拉取日志 |

---

### 12.2 数据刷新接口

| 接口 | 方法 | 说明 |
|---|---|---|
| /api/refresh/market-data | POST | 刷新全部市场数据 |
| /api/refresh/etf-price | POST | 刷新ETF价格 |
| /api/refresh/fund-nav | POST | 刷新基金净值 |
| /api/refresh/valuation | POST | 刷新指数估值 |
| /api/refresh/premium | POST | 刷新QDII溢价 |
| /api/refresh/dividend | POST | 刷新股息率 |

---

### 12.3 /api/calculate 输入

```json
{
  "holding_snapshot_id": "holding-20260617",
  "weekly_budget": 40000,
  "target_config": {},
  "rule_config_version": "rules-v4.1",
  "strategy_version": "strategy-v4.1",
  "allocation_mode": "conservative"
}
```

### 12.4 /api/calculate 输出

必须返回：

```json
{
  "calculation_id": "20260617-220000-a1b2c3",
  "engine_version": "target-gap-rebalance-v4.1",
  "strategy_version": "strategy-v4.1",
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
    "rules_config_version": "rules-v4.1",
    "strategy_version": "strategy-v4.1",
    "data_quality_score": 86,
    "data_quality_status": "usable"
  },
  "buy_suggestions": [],
  "pause_suggestions": [],
  "rebalance_suggestions": [],
  "cash_pool_suggestions": [],
  "data_quality_summary": {},
  "source_comparison_summary": {},
  "rules_hit_summary": {}
}
```

---

## 13. 数据库需求

### 13.1 etf_config

```sql
CREATE TABLE etf_config (
    code TEXT PRIMARY KEY,
    name TEXT,
    asset_class TEXT,
    target_ratio REAL,
    is_dca_target BOOLEAN,
    is_blacklisted BOOLEAN,
    role TEXT,
    created_at TEXT,
    updated_at TEXT
);
```

### 13.2 holding_snapshot

```sql
CREATE TABLE holding_snapshot (
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
);
```

### 13.3 data_source

```sql
CREATE TABLE data_source (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT,
    provider_type TEXT,
    auth_type TEXT,
    api_key_encrypted TEXT,
    enabled BOOLEAN DEFAULT TRUE,
    priority INTEGER,
    rate_limit_per_min INTEGER,
    health_status TEXT,
    last_success_time TEXT,
    last_error_time TEXT,
    last_error_message TEXT,
    created_at TEXT,
    updated_at TEXT
);
```

### 13.4 data_source_capability

```sql
CREATE TABLE data_source_capability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT,
    metric_type TEXT,
    asset_scope TEXT,
    is_primary BOOLEAN DEFAULT FALSE,
    is_backup BOOLEAN DEFAULT FALSE,
    is_validator BOOLEAN DEFAULT FALSE,
    priority INTEGER,
    enabled BOOLEAN DEFAULT TRUE
);
```

### 13.5 market_data_raw

```sql
CREATE TABLE market_data_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    trade_date TEXT,
    metric_type TEXT,
    source_id TEXT,
    source_api TEXT,
    raw_value TEXT,
    raw_json TEXT,
    fetch_time TEXT,
    request_id TEXT
);
```

### 13.6 market_data_clean

```sql
CREATE TABLE market_data_clean (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    trade_date TEXT,
    metric_type TEXT,
    clean_value REAL,
    source_id TEXT,
    is_valid BOOLEAN,
    abnormal_reason TEXT,
    updated_at TEXT,
    UNIQUE(code, trade_date, metric_type, source_id)
);
```

### 13.7 source_compare_result

```sql
CREATE TABLE source_compare_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    trade_date TEXT,
    metric_type TEXT,
    primary_source TEXT,
    backup_source TEXT,
    primary_value REAL,
    backup_value REAL,
    diff_value REAL,
    diff_pct REAL,
    threshold REAL,
    compare_status TEXT,
    created_at TEXT
);
```

### 13.8 data_quality_result

```sql
CREATE TABLE data_quality_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    trade_date TEXT,
    metric_type TEXT,
    quality_score REAL,
    quality_status TEXT,
    freshness_score REAL,
    consistency_score REAL,
    completeness_score REAL,
    abnormal_score REAL,
    source_health_score REAL,
    can_use_for_rule BOOLEAN,
    reason TEXT,
    created_at TEXT
);
```

### 13.9 data_fetch_log

```sql
CREATE TABLE data_fetch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    source_id TEXT,
    metric_type TEXT,
    code TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT,
    row_count INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    fetch_time TEXT
);
```

### 13.10 rule_config

```sql
CREATE TABLE rule_config (
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
);
```

### 13.11 calculation_log

```sql
CREATE TABLE calculation_log (
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
    data_quality_snapshot_json TEXT,
    source_compare_snapshot_json TEXT,
    created_at TEXT
);
```

---

## 14. AI解释需求

### 14.1 LLM职责

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

### 14.2 LLM输入

LLM只能接收：

```text
规则引擎输出JSON
命中规则明细
数据质量明细
市场数据快照
数据源可信度摘要
宏观环境摘要
```

### 14.3 一致性校验

展示AI文案前必须校验：

1. AI文案中的金额是否等于规则引擎金额。
2. AI是否提到未命中的规则。
3. AI是否说“因宏观环境调整金额”。
4. final_amount=0的标的是否被AI说成“少量买入”。
5. AI是否把数据质量异常解释成确定性结论。

若不一致：

```text
拒绝展示AI文案
改用模板解释
记录ai_check_result
```

---

## 15. 数据清洗与图表安全

### 15.1 后端清洗

所有外部数据入库前必须：

1. 转换为 numeric。
2. 将 NaN、Inf 转为 null。
3. 将 99999999、-99999999 等异常占位转为 null。
4. 设置 is_valid=false。
5. 记录 abnormal_reason。
6. 不允许异常值进入规则引擎。

### 15.2 前端图表保护

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

## 16. 验收标准

### 16.1 策略正确性验收

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

### 16.2 数据源管理验收

| 场景 | 期望 |
|---|---|
| 配置多个数据源 | 支持AkShare、efinance、Tushare、JQData等 |
| 数据源Token缺失 | 状态显示未配置，不影响其他源 |
| 数据源测试成功 | 显示正常、延迟、最近成功时间 |
| 数据源测试失败 | 记录错误日志 |
| 主源失败 | 自动尝试备源 |
| 主备源冲突 | 标记source_conflict并阻断强规则 |
| 只有单源可用 | 允许展示，限制强再平衡 |
| 数据源健康异常 | 总览页数据可信度卡提示 |
| API限流 | 记录限流错误，并进入降级 |
| 手动刷新 | 可重新拉取并更新质量评分 |

### 16.3 数据准确性验收

| 场景 | 期望 |
|---|---|
| 主备源价格差异超过阈值 | 标记源不一致 |
| ETF净值超过2个交易日未更新 | 标黄 |
| QDII溢价缺失 | 不自动买入 |
| 99999999进入数据 | clean_value=null，不进入图表 |
| 样本不足 | 展示但不触发强规则 |
| 缓存过期 | 页面提示数据可能过期 |
| 数据质量评分<60 | 不参与规则 |
| 买入建议信号 | 数据质量至少75分 |
| 再平衡信号 | 数据质量至少90分 |

### 16.4 页面验收

总览页：

- [ ] 有资金调拨结论卡。
- [ ] 有数据可信度卡。
- [ ] 有风险红线与再平衡审计卡。
- [ ] 有持仓与计算明细折叠表。
- [ ] 展示买入、暂停、再平衡、现金水池流向。
- [ ] 展示 calculation_id 和数据更新时间。
- [ ] 展示数据质量状态。

趋势页：

- [ ] 展示多周期估值分位。
- [ ] 展示样本天数。
- [ ] 展示主源、备源、更新时间。
- [ ] 展示数据质量评分。
- [ ] 展示QDII溢价3/7/30日数据。
- [ ] 展示红利ETF股息率分位。
- [ ] 图表无异常大数。
- [ ] 每个指标可展开查看数据血缘。

设置页 / 数据源管理页：

- [ ] 可配置目标比例。
- [ ] 可配置每周预算。
- [ ] 可配置规则阈值。
- [ ] 可配置数据源。
- [ ] 可配置指标级主源/备源/校验源。
- [ ] 可配置数据质量阈值。
- [ ] 可配置现金水池。
- [ ] 可测试数据源连通性。
- [ ] 可查看数据拉取日志。
- [ ] 可查看主备源冲突。
- [ ] 规则参数用自然语言展示。

---

## 17. 迭代优先级

### P0：先修数据可信度

1. DataSource Registry。
2. AkShare Adapter 标准化。
3. efinance Adapter 作为免费备源。
4. Tushare Pro Adapter 框架和Token入口。
5. market_data_raw / market_data_clean 拆表。
6. data_fetch_log。
7. 数据清洗引擎。
8. 阻断 99999999、NaN、Inf 进入图表和规则。
9. 总览页数据可信度卡。

### P1：完善主备校验

1. Cross Source Validator。
2. Data Quality Score。
3. 指标级主源/备源/校验源配置。
4. 数据质量接口。
5. 数据源管理页面。
6. QDII溢价自算并显示3日/7日均值。
7. 关键数据异常时阻断自动建议。

### P2：完善资金调拨闭环

1. target-gap买入算法。
2. 再平衡引擎。
3. calculation_log。
4. AI一致性校验。
5. 趋势页多周期估值。
6. 现金水池展示。

### P3：增强专业能力

1. JQData完整接入。
2. Wind / Choice / iFinD 适配器预留。
3. 官方指数公司/基金公司校验源。
4. 数据源自动切换。
5. 历史建议回溯。
6. 规则回测。
7. 数据质量周报。
8. 微信/邮件推送。

---

## 18. 最终交付目标

用户每周只需要：

```text
1. 更新持仓。
2. 查看数据可信度。
3. 点击生成执行单。
4. 查看本周资金调拨结论。
5. 查看红线和再平衡原因。
6. 必要时展开明细和数据血缘。
7. 线下执行。
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
数据来自哪里
主备源是否一致
AI有没有改金额
```

最终产品形态：

```text
一个可审计、可解释、数据可信、纪律化的ETF资金调拨辅助系统
```
