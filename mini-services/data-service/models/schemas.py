"""Pydantic models for request/response types."""
from typing import Optional
from pydantic import BaseModel, Field


# ─── Holding ───
class Holding(BaseModel):
    code: str = Field(..., description="ETF code, e.g. 159338")
    name: str = Field(..., description="ETF name")
    market_value: float = Field(..., alias="marketValue", description="Market value in yuan")
    current_ratio: float = Field(..., alias="currentRatio", description="Current portfolio ratio, e.g. 0.148")

    model_config = {"populate_by_name": True}


# ─── Target Ratio ───
class TargetRatio(BaseModel):
    code: str
    target_ratio: float = Field(..., alias="targetRatio", description="Target ratio, e.g. 0.18")

    model_config = {"populate_by_name": True}


# ─── Rule ───
class Rule(BaseModel):
    id: str
    name: str
    type: str = Field(..., description="veto | reduce | boost")
    threshold_value: Optional[float] = Field(None, alias="thresholdValue")
    threshold_value_max: Optional[float] = Field(None, alias="thresholdValueMax")
    applicable_scope: str = Field("all", alias="applicableScope", description="all | specific")
    applicable_codes: list[str] = Field(default_factory=list, alias="applicableCodes")
    is_enabled: bool = Field(True, alias="isEnabled")

    model_config = {"populate_by_name": True}


# ─── Calculate Request ───
class CalculateRequest(BaseModel):
    holdings: list[Holding]
    target_ratios: list[TargetRatio] = Field(..., alias="targetRatios")
    rules: list[Rule]
    weekly_budget: float = Field(..., alias="weeklyBudget", description="Weekly investment budget in yuan")
    # V4 PRD§11.2: 可选输入字段
    holding_snapshot_id: str = Field("", alias="holdingSnapshotId", description="持仓快照ID")
    strategy_version: str = Field("strategy-v4", alias="strategyVersion", description="策略版本")
    allocation_mode: str = Field("conservative", alias="allocationMode", description="分配模式 conservative|neutral")

    model_config = {"populate_by_name": True}


# ─── Structured Rule Hit (audit-friendly) ───
class RuleHit(BaseModel):
    rule_type: str = Field(..., alias="ruleType", description="veto | reduce | boost | info")
    rule_name: str = Field(..., alias="ruleName")
    condition_text: str = Field("", alias="conditionText")
    actual_value: str = Field("", alias="actualValue")
    threshold: str = Field("")
    effect: str = Field("")

    model_config = {"populate_by_name": True}


# ─── Data Quality audit (V4 策略书§4.5 数据血缘 + §5.3 五状态 + §5.4 缓存过期) ───
class DataQuality(BaseModel):
    source: str = "akshare"
    sample_days: int = Field(0, alias="sampleDays")
    required_sample_days: int = Field(1000, alias="requiredSampleDays")
    is_sample_enough: bool = Field(False, alias="isSampleEnough")
    missing_count: int = Field(0, alias="missingCount")
    outlier_count: int = Field(0, alias="outlierCount")
    can_calculate: bool = Field(False, alias="canCalculate")
    updated_at: str = Field("", alias="updatedAt")
    # V4 §5.3 数据质量五状态：passed | minor_abnormal | serious_abnormal | insufficient | source_inconsistent
    quality_status: str = Field("insufficient", alias="qualityStatus",
        description="passed/minor_abnormal/serious_abnormal/insufficient/source_inconsistent")
    abnormal_reason: str = Field("", alias="abnormalReason")
    # V4 §5.4 缓存过期
    is_stale: bool = Field(False, alias="isStale")
    stale_level: str = Field("", alias="staleLevel", description="red | yellow | ")
    stale_reason: str = Field("", alias="staleReason")
    # V4 §4.5 数据血缘
    percentile_window: str = Field("", alias="percentileWindow", description="5y | 10y | all")
    raw_value: Optional[float] = Field(None, alias="rawValue")
    clean_value: Optional[float] = Field(None, alias="cleanValue")
    is_valid: bool = Field(True, alias="isValid")
    # V4.1 §10.8 数据质量评分 0-100
    quality_score: Optional[float] = Field(None, alias="qualityScore",
        description="0-100 质量评分：>=90优秀 / 75-89可用 / 60-74可疑 / <60不可用")
    can_use_for_rule: bool = Field(False, alias="canUseForRule",
        description="是否可参与买入规则（质量分>=75）")
    can_use_for_strong_rule: bool = Field(False, alias="canUseForStrongRule",
        description="是否可参与强规则/再平衡（质量分>=90）")
    # V4.1 §10.9 / S2-T5: 单源场景标记 — 该字段仅有此源可用时，限制强再平衡
    single_source_warning: bool = Field(False, alias="singleSourceWarning",
        description="单源场景：仅有此源可用（备源未配置/不可用/拉取失败），限制强再平衡")
    # V4.1 §10.9 / S2-T8: 主备源冲突熔断 — 主备源差异超阈值，阻断强买入/强再平衡，需人工确认
    source_conflict: bool = Field(False, alias="sourceConflict",
        description="主备源冲突：主备源差异超阈值，已阻断强规则，需人工确认")

    model_config = {"populate_by_name": True}


# ─── Suggestion Item ───
class SuggestionItem(BaseModel):
    code: str
    name: str
    amount: int = Field(..., description="Suggested buy amount in yuan (integer)")
    target_ratio: float = Field(..., alias="targetRatio")
    current_ratio: float = Field(..., alias="currentRatio")
    deviation: float = Field(..., description="deviation = current_ratio - target_ratio")
    pe_percentile: Optional[float] = Field(None, alias="pePercentile")
    pb_percentile: Optional[float] = Field(None, alias="pbPercentile")
    premium_today: Optional[float] = Field(None, alias="premiumToday")
    premium_7d_avg: Optional[float] = Field(None, alias="premium7dAvg")
    dividend_yield: Optional[float] = Field(None, alias="dividendYield")
    # V4 多周期估值分位（策略书§3）
    pe_percentile_1y: Optional[float] = Field(None, alias="pePercentile1y")
    pe_percentile_3y: Optional[float] = Field(None, alias="pePercentile3y")
    pe_percentile_5y: Optional[float] = Field(None, alias="pePercentile5y")
    pe_percentile_10y: Optional[float] = Field(None, alias="pePercentile10y")
    pe_percentile_all: Optional[float] = Field(None, alias="pePercentileAll")
    pb_percentile_1y: Optional[float] = Field(None, alias="pbPercentile1y")
    pb_percentile_3y: Optional[float] = Field(None, alias="pbPercentile3y")
    pb_percentile_5y: Optional[float] = Field(None, alias="pbPercentile5y")
    pb_percentile_10y: Optional[float] = Field(None, alias="pbPercentile10y")
    pb_percentile_all: Optional[float] = Field(None, alias="pbPercentileAll")
    current_value: float = Field(0, alias="currentValue")
    target_value_after_budget: float = Field(0, alias="targetValueAfterBudget")
    gap_amount: float = Field(0, alias="gapAmount")
    base_gap_amount: float = Field(0, alias="baseGapAmount")
    data_quality: Optional[DataQuality] = Field(None, alias="dataQuality")
    pre_cap_amount: float = Field(0, alias="preCapAmount")
    reason_summary: str = Field("", alias="reasonSummary")
    # rules_hit is now a list of structured RuleHit objects (was list[str] in v1)
    rules_hit: list[RuleHit] = Field(default_factory=list, alias="rulesHit")
    multiplier: float = Field(1.0, description="Applied multiplier: 0.5 / 1.0 / 2.0")
    vetoed: bool = Field(False, description="Whether this ETF is vetoed this week")

    model_config = {"populate_by_name": True}


# ─── Rebalance Suggestion (V4 strategy doc §7) ───
class RebalanceSuggestion(BaseModel):
    """再平衡卖出建议。卖的是超配部分，不卖核心底仓。

    触发条件：极高估 + 明显超配 双条件同时满足。
    超额市值 = 当前持仓市值 - 当前定投资产总额 × 目标占比
    卖出金额 = 超额市值 × 卖出比例(20%~50%)
    资金去向：华宝添益(511990)
    """
    code: str
    name: str
    # 触发信息
    trigger_type: str = Field(..., alias="triggerType", description="a_share_pe | dividend_yield | us_pe | us_qdii_premium")
    trigger_level: str = Field(..., alias="triggerLevel", description="level1 | level2")
    valuation_metric: str = Field(..., alias="valuationMetric", description="pe_percentile | pb_percentile | dividend_yield_percentile | premium_today")
    valuation_value: Optional[float] = Field(None, alias="valuationValue")
    valuation_threshold: str = Field("", alias="valuationThreshold")
    # 配置信息
    target_ratio: float = Field(..., alias="targetRatio")
    current_ratio: float = Field(..., alias="currentRatio")
    deviation_pp: float = Field(..., alias="deviationPp", description="当前占比-目标占比, 百分点")
    over_concentration_pp: float = Field(..., alias="overConcentrationPp", description="超配百分点(=deviation_pp when >0)")
    # 金额信息
    current_value: float = Field(..., alias="currentValue")
    target_value: float = Field(..., alias="targetValue", description="当前定投资产总额×目标占比")
    excess_value: float = Field(..., alias="excessValue", description="超额市值=当前市值-目标市值")
    sell_ratio: float = Field(..., alias="sellRatio", description="卖出比例 0.2~0.5")
    sell_amount: int = Field(..., alias="sellAmount", description="建议卖出金额(整数)")
    # 去向与说明
    cash_destination: str = Field("511990", alias="cashDestination")
    reason_summary: str = Field("", alias="reasonSummary")
    rules_hit: list[RuleHit] = Field(default_factory=list, alias="rulesHit")

    model_config = {"populate_by_name": True}


# ─── Cash Pool Suggestion (V4 strategy doc §8) ───
class CashPoolSuggestion(BaseModel):
    """现金水池流向建议。华宝添益(511990)承接未投资资金和再平衡释放资金。"""
    code: str = "511990"
    name: str = "华宝添益ETF"
    inflow_type: str = Field(..., alias="inflowType", description="unallocated | rebalance_release")
    inflow_amount: int = Field(..., alias="inflowAmount")
    description: str = Field("", alias="description")

    model_config = {"populate_by_name": True}


# ─── Calculate Response ───
class CalculateResponse(BaseModel):
    calculation_id: str = Field("", alias="calculationId")
    engine_version: str = Field("target-gap-rebalance-v4", alias="engineVersion")
    strategy_version: str = Field("strategy-v4", alias="strategyVersion")
    calculated_at: str = Field("", alias="calculatedAt")
    allocation_strategy: str = Field("conservative", alias="allocationStrategy")
    data_snapshot: dict = Field(default_factory=dict, alias="dataSnapshot")
    total_budget: int = Field(..., alias="totalBudget")
    total_allocated: int = Field(..., alias="totalAllocated")
    total_unallocated: int = Field(..., alias="totalUnallocated")
    suggestions: list[SuggestionItem]
    # V4 新增：再平衡 + 现金水池
    rebalance_suggestions: list[RebalanceSuggestion] = Field(default_factory=list, alias="rebalanceSuggestions")
    cash_pool_suggestions: list[CashPoolSuggestion] = Field(default_factory=list, alias="cashPoolSuggestions")
    total_rebalanced: int = Field(0, alias="totalRebalanced")
    # PRD§11.3: total_rebalance_amount（别名，与 totalRebalanced 同值）
    total_rebalance_amount: int = Field(0, alias="totalRebalanceAmount")
    cash_pool_inflow: int = Field(0, alias="cashPoolInflow")
    cash_destination: str = Field("511990", alias="cashDestination")
    external_inflow: int = Field(0, alias="externalInflow", description="本周外部注入预算")
    internal_release: int = Field(0, alias="internalRelease", description="再平衡释放资金")
    # PRD§11.3: 分类清单（buy/pause 从 suggestions 拆分）
    buy_suggestions: list = Field(default_factory=list, alias="buySuggestions", description="买入建议清单(amount>0)")
    pause_suggestions: list = Field(default_factory=list, alias="pauseSuggestions", description="暂停买入清单(amount=0)")
    # PRD§11.3: 汇总字段
    data_quality_summary: dict = Field(default_factory=dict, alias="dataQualitySummary")
    rules_hit_summary: dict = Field(default_factory=dict, alias="rulesHitSummary")
    # V4.1 §10.8 / S3-T3: 主备源交叉校验摘要，回填响应体供前端展示
    # 结构：{primary: str, backup: str, crossValidated: bool, totalChecks: int,
    #        passed: int, inconsistent: int, failed: int, details: [{code, field, ...}]}
    source_comparison: dict = Field(default_factory=dict, alias="sourceComparison")

    model_config = {"populate_by_name": True}


# ─── History point helpers ───
class PEHistoryPoint(BaseModel):
    date: str
    value: Optional[float] = None

    model_config = {"populate_by_name": True}


class PremiumHistoryPoint(BaseModel):
    date: str
    premium: Optional[float] = None

    model_config = {"populate_by_name": True}


class NAVHistoryPoint(BaseModel):
    date: str
    nav: Optional[float] = None

    model_config = {"populate_by_name": True}


class DividendYieldHistoryPoint(BaseModel):
    date: str
    value: Optional[float] = None

    model_config = {"populate_by_name": True}


# ─── Cached Data ───
class CachedValuation(BaseModel):
    code: str
    name: str
    pe: Optional[float] = None
    pb: Optional[float] = None
    pe_percentile: Optional[float] = Field(None, alias="pePercentile")
    pb_percentile: Optional[float] = Field(None, alias="pbPercentile")
    pe_history: list[PEHistoryPoint] = Field(default_factory=list, alias="peHistory")
    pb_history: list[PEHistoryPoint] = Field(default_factory=list, alias="pbHistory")
    date: str = ""
    # V4 多周期分位（策略书§3，PRD§8.2 趋势页要求展示）
    pe_percentile_1y: Optional[float] = Field(None, alias="pePercentile1y")
    pe_percentile_3y: Optional[float] = Field(None, alias="pePercentile3y")
    pe_percentile_5y: Optional[float] = Field(None, alias="pePercentile5y")
    pe_percentile_10y: Optional[float] = Field(None, alias="pePercentile10y")
    pe_percentile_all: Optional[float] = Field(None, alias="pePercentileAll")
    pb_percentile_1y: Optional[float] = Field(None, alias="pbPercentile1y")
    pb_percentile_3y: Optional[float] = Field(None, alias="pbPercentile3y")
    pb_percentile_5y: Optional[float] = Field(None, alias="pbPercentile5y")
    pb_percentile_10y: Optional[float] = Field(None, alias="pbPercentile10y")
    pb_percentile_all: Optional[float] = Field(None, alias="pbPercentileAll")
    sample_days: int = Field(0, alias="sampleDays")
    source: str = "akshare"
    is_estimated: bool = Field(False, alias="isEstimated")
    # V4.1 BUG-2026-06-A500-PB: PB 数据来源标注
    # 可能值: csindex / 沪深300代理 / csindex(无PB) / csindex(error) / csindex(无PB,代理失败:...)
    pb_source: Optional[str] = Field(None, alias="pbSource")
    # V4.1 BUG-2026-06-A500-PE: PE 数据来源标注
    # 可能值: csindex / 沪深300代理 / multpl.com / 标普500代理 / csindex(无PE) / csindex(error)
    pe_source: Optional[str] = Field(None, alias="peSource")

    model_config = {"populate_by_name": True}


class CachedPremium(BaseModel):
    code: str
    name: str
    premium_today: Optional[float] = Field(None, alias="premiumToday")
    premium_7d_avg: Optional[float] = Field(None, alias="premium7dAvg")
    # V4.1 S4-T6: 3 日溢价均值（QDII 短期溢价趋势指标）
    premium_3d_avg: Optional[float] = Field(None, alias="premium3dAvg")
    premium_30d: list[PremiumHistoryPoint] = Field(default_factory=list, alias="premium30d")
    date: str = ""

    model_config = {"populate_by_name": True}


class CachedNav(BaseModel):
    code: str
    name: str
    nav: Optional[float] = None
    nav_history: list[NAVHistoryPoint] = Field(default_factory=list, alias="navHistory")
    date: str = ""

    model_config = {"populate_by_name": True}


class KlinePoint(BaseModel):
    date: str
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    volume: Optional[float] = None

    model_config = {"populate_by_name": True}


class CachedKline(BaseModel):
    code: str
    name: str
    kline_history: list[KlinePoint] = Field(default_factory=list, alias="klineHistory")
    date: str = ""
    # V4.1 BUG-2026-06-A500-KLINE: K线数据来源 + 是否净值代理
    # source: akshare / eastmoney_direct / all_failed
    # is_nav_proxy: True 表示用 LSJZ 历史净值代理（OHLC 字段都是净值）
    source: Optional[str] = "akshare"
    is_nav_proxy: bool = Field(False, alias="isNavProxy")

    model_config = {"populate_by_name": True}


class CachedDividend(BaseModel):
    code: str
    name: str
    dividend_yield: Optional[float] = Field(None, alias="dividendYield")
    dividend_yield_percentile: Optional[float] = Field(None, alias="dividendYieldPercentile")
    dividend_yield_history: list[DividendYieldHistoryPoint] = Field(default_factory=list, alias="dividendYieldHistory")
    date: str = ""

    model_config = {"populate_by_name": True}


# ─── Market Index (broad market indices for Trends page) ───
class PriceHistoryPoint(BaseModel):
    date: str
    value: Optional[float] = None

    model_config = {"populate_by_name": True}


class CachedMarketIndex(BaseModel):
    code: str
    name: str
    category: str = ""
    current_value: Optional[float] = Field(None, alias="currentValue")
    daily_change: Optional[float] = Field(None, alias="dailyChange")
    daily_change_percent: Optional[float] = Field(None, alias="dailyChangePercent")
    ma20: Optional[float] = Field(None, alias="ma20")
    ma60: Optional[float] = Field(None, alias="ma60")
    price_history: list[PriceHistoryPoint] = Field(default_factory=list, alias="priceHistory")
    date: str = ""

    model_config = {"populate_by_name": True}


# ─── Cached Summary ───
class CachedSummaryItem(BaseModel):
    code: str
    name: str
    category: str = Field("domestic", description="domestic | overseas")
    pe: Optional[float] = None
    pb: Optional[float] = None
    pe_percentile: Optional[float] = Field(None, alias="pePercentile")
    pb_percentile: Optional[float] = Field(None, alias="pbPercentile")
    premium_today: Optional[float] = Field(None, alias="premiumToday")
    premium_7d_avg: Optional[float] = Field(None, alias="premium7dAvg")
    # V4.1 BUG-2026-06-PREMIUM-AVG: summary 也补 3d 均值字段
    premium_3d_avg: Optional[float] = Field(None, alias="premium3dAvg")
    nav: Optional[float] = None
    dividend_yield: Optional[float] = Field(None, alias="dividendYield")
    valuation_date: str = Field("", alias="valuationDate")
    premium_date: str = Field("", alias="premiumDate")
    nav_date: str = Field("", alias="navDate")
    dividend_date: str = Field("", alias="dividendDate")
    is_estimated: bool = Field(False, alias="isEstimated")

    model_config = {"populate_by_name": True}


class CachedSummaryResponse(BaseModel):
    items: list[CachedSummaryItem]
    last_updated: str = Field("", alias="lastUpdated")

    model_config = {"populate_by_name": True}


# ─── Health ───
class HealthResponse(BaseModel):
    status: str
    timestamp: str


# ─── Refresh ───
class RefreshResponse(BaseModel):
    success: bool
    message: str
    updated_codes: list[str] = Field(default_factory=list)
    # V4.1 §10.8: 质量评分摘要（刷新后返回）
    quality_summary: Optional[dict] = Field(None, alias="qualitySummary")
    cross_check_summary: Optional[dict] = Field(None, alias="crossCheckSummary")
    # V4.1 §10.9 / S2-T4: 熔断降级链路摘要（含 fallback/stale/blocked/single_source 统计）
    fallback_summary: Optional[dict] = Field(None, alias="fallbackSummary")

    model_config = {"populate_by_name": True}
