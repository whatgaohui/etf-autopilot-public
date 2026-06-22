"""Rule Engine (target-gap-v2) - 100% deterministic calculation, AI has no authority to modify.

Implements the gap-driven allocation algorithm:
  Step 1:  Read holdings, targets, rules, weekly_budget, market_data
  Step 2:  Compute invested_asset_value (only investable codes)
  Step 3:  after_budget_total = invested_asset_value + weekly_budget
  Step 4:  For each investable holding compute gap fields
  Step 5:  Veto filtering (one-vote veto)
  Step 6:  Build investable pool = base_gap>0 AND not vetoed
  Step 7:  Allocate budget by gap proportion
  Step 8:  Apply reduce/boost multipliers (reduce > boost)
  Step 9:  Gap cap (never buy more than the gap)
  Step 10: Total budget constraint
  Step 11: Round to integers, fix rounding diff on largest item
  Step 12: Build response with full audit fields

Rule execution priority: Veto > data-quality > reduce > boost > gap-allocation.
When both reduce and boost hit, reduce wins (conservative principle).

CRITICAL FIX vs v1:
  - v1 used static target-ratio normalization → over-allocated ETFs STILL got bought.
  - v2 uses target-gap-driven allocation: an over-allocated ETF has base_gap_amount=0
    and is excluded from the investable pool, so it gets amount=0 and a reason
    "当前占比30.4%高于目标18%，已超配，本周不补仓。"
"""
import logging
import math
import uuid
from datetime import datetime
from typing import Optional

from models.schemas import (
    CalculateRequest,
    CalculateResponse,
    CashPoolSuggestion,
    DataQuality,
    RebalanceSuggestion,
    RuleHit,
    SuggestionItem,
)

logger = logging.getLogger(__name__)

# Codes that are NOT investable targets — they have target_ratio=0 / not in targets.
# They appear in suggestions with amount=0 and a vetoed info hit so the user can see
# they are excluded from weekly buying on purpose.
DEFAULT_NON_INVESTABLE_HINT = {"518880", "511990"}

# QDII overseas ETFs whose data quality requires premium_today (not pe_percentile)
QDII_CODES = {"513500", "513300"}

# 现金水池标的 (V4 strategy doc §8)
CASH_POOL_CODE = "511990"

# A股宽基再平衡标的 (V4 strategy doc §7.2): 159338/510330/588000
A_SHARE_REBALANCE_CODES = {"159338", "510330", "588000"}
# 红利ETF (V4 strategy doc §7.3): 510880
DIVIDEND_REBALANCE_CODES = {"510880"}
# 美股宽基再平衡标的 (V4 strategy doc §7.4): 513500/513300
US_SHARE_REBALANCE_CODES = {"513500", "513300"}


# ─── helpers ──────────────────────────────────────────────────────────────────

def safe_num(value) -> Optional[float]:
    """Return None for None/NaN/Inf/sentinel values (abs >= 999999)."""
    if value is None:
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    if abs(x) >= 999999:
        return None
    return x


def _check_staleness(code: str, md: dict) -> tuple[bool, str, str]:
    """V4 策略书§5.4 缓存过期规则。

    返回 (is_stale, stale_level, stale_reason)。
    - A股ETF收盘价/指数估值：非最新交易日标红；超2交易日标黄
    - QDII净值：超2交易日标黄
    - 溢价率：当日缺失标红
    - 股息率：超7交易日标黄
    """
    is_qdii = code in QDII_CODES
    updated_at = md.get("updated_at") or md.get("date") or ""
    if not updated_at:
        return (True, "red", "数据时间缺失")

    try:
        # 解析更新时间
        updated_str = str(updated_at)[:19]
        dt_updated = datetime.fromisoformat(updated_str) if "T" in updated_str or "-" in updated_str else None
        if dt_updated is None:
            # 尝试只取日期
            dt_updated = datetime.strptime(str(updated_at)[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return (True, "red", f"数据时间格式异常: {updated_at}")

    now = datetime.now()
    # 计算自然天数差（交易日判断需要节假日表，这里用自然天近似）
    days_diff = (now - dt_updated).days
    hours_diff = (now - dt_updated).total_seconds() / 3600

    # 溢价率当日缺失 → 标红（仅QDII）
    if is_qdii:
        premium = safe_num(md.get("premium_today"))
        if premium is None:
            return (True, "red", "QDII溢价率当日缺失")

    # A股：非最新交易日（>1天且非周末）→ 标红
    if not is_qdii:
        if days_diff >= 4:  # 超3天（覆盖周末）标红
            return (True, "red", f"A股数据已过期{days_diff}天，非最新交易日")
        if days_diff >= 3:  # 超2交易日标黄
            return (True, "yellow", f"A股数据{days_diff}天未更新，可能非最新交易日")

    # QDII净值：超2交易日（自然天≥4覆盖周末）标黄
    if is_qdii:
        if days_diff >= 5:
            return (True, "yellow", f"QDII净值{days_diff}天未更新，可能滞后")

    # 股息率：超7天标黄
    div = safe_num(md.get("dividend_yield"))
    if div is not None and days_diff >= 8:
        return (True, "yellow", f"股息率数据{days_diff}天未更新")

    return (False, "", "")


def validate_data_quality(code: str, md: dict) -> DataQuality:
    """V4 数据质量校验（策略书§5.3 五状态 + §4.5 数据血缘 + §5.4 缓存过期）。

    五状态：
      passed             - 数据新鲜、样本充足、关键字段齐全
      minor_abnormal     - 小幅异常但在容忍范围（如样本略不足但可参考）
      serious_abnormal   - 关键字段异常（PE≤0/≥500、PB≤0/≥100 等）
      insufficient       - 样本不足或关键字段缺失
      source_inconsistent- 主备源差异超阈值（当前单源，暂不触发）
    """
    source = "akshare"
    sample_days = 0
    sd = md.get("sample_days")
    if sd is not None:
        try:
            sample_days = int(sd)
        except (TypeError, ValueError):
            sample_days = 0
    if sample_days <= 0:
        for hist_key in ("pe_history", "pb_history", "premium_30d", "nav_history", "dividend_yield_history"):
            hist = md.get(hist_key) or []
            if isinstance(hist, list) and len(hist) > sample_days:
                sample_days = len(hist)

    required_sample_days = 1000
    is_sample_enough = sample_days >= 500

    # 缺失字段计数
    missing_count = 0
    for key in ("pe_percentile", "pb_percentile", "premium_today", "premium_7d_avg"):
        v = md.get(key)
        if v is None or safe_num(v) is None:
            missing_count += 1

    pe_present = safe_num(md.get("pe_percentile")) is not None
    premium_present = safe_num(md.get("premium_today")) is not None
    is_qdii = code in QDII_CODES

    # V4 §5.2 异常值检测（PE≤0或≥500、PB≤0或≥100、溢价abs>30%、股息率<0或>20%）
    outlier_count = 0
    abnormal_reasons = []
    pe_raw = safe_num(md.get("pe"))
    pb_raw = safe_num(md.get("pb"))
    premium_raw = safe_num(md.get("premium_today"))
    dy_raw = safe_num(md.get("dividend_yield"))

    if pe_raw is not None and (pe_raw <= 0 or pe_raw >= 500):
        outlier_count += 1
        abnormal_reasons.append(f"PE={pe_raw:.1f}异常")
    if pb_raw is not None and (pb_raw <= 0 or pb_raw >= 100):
        outlier_count += 1
        abnormal_reasons.append(f"PB={pb_raw:.2f}异常")
    if premium_raw is not None and abs(premium_raw) > 30:
        outlier_count += 1
        abnormal_reasons.append(f"溢价率{premium_raw:.1f}%异常")
    if dy_raw is not None and (dy_raw < 0 or dy_raw > 20):
        outlier_count += 1
        abnormal_reasons.append(f"股息率{dy_raw:.2f}%异常")

    # 缓存过期检测（§5.4）
    is_stale, stale_level, stale_reason = _check_staleness(code, md)

    # 判断是否可计算
    if is_qdii:
        can_calculate = is_sample_enough and premium_present and outlier_count == 0
    else:
        can_calculate = is_sample_enough and pe_present and outlier_count == 0

    # V4 §5.3 五状态判定（优先级：严重异常 > 源不一致 > 数据不足 > 轻微异常 > 通过）
    if outlier_count > 0:
        quality_status = "serious_abnormal"
        abnormal_reason = "；".join(abnormal_reasons)
    elif not is_sample_enough or (not pe_present and not is_qdii) or (not premium_present and is_qdii):
        quality_status = "insufficient"
        reasons = []
        if not is_sample_enough:
            reasons.append(f"样本不足({sample_days}<{required_sample_days})")
        if not pe_present and not is_qdii:
            reasons.append("PE分位缺失")
        if not premium_present and is_qdii:
            reasons.append("溢价率缺失")
        abnormal_reason = "；".join(reasons)
    elif is_stale and stale_level == "red":
        quality_status = "serious_abnormal"
        abnormal_reason = stale_reason
    elif is_stale and stale_level == "yellow":
        quality_status = "minor_abnormal"
        abnormal_reason = stale_reason
    else:
        quality_status = "passed"
        abnormal_reason = ""

    # V4 §4.5 数据血缘
    if is_qdii:
        raw_value = premium_raw
        percentile_window = "premium"
    else:
        raw_value = pe_raw
        percentile_window = "5y" if safe_num(md.get("pe_percentile_5y")) is not None else "default"

    clean_value = raw_value if outlier_count == 0 else None
    is_valid = outlier_count == 0 and quality_status != "serious_abnormal"

    updated_at = md.get("updated_at") or md.get("date") or ""

    # V4.1 §10.8: 读取持久化的质量评分（优先用 refresh 时计算并持久化的分数）
    quality_score_val: Optional[float] = None
    can_use_for_rule_val = False
    can_use_for_strong_rule_val = False
    try:
        from services.data_quality_score import get_latest_quality, GRADE_EXCELLENT, GRADE_USABLE
        # valuation 用指数代码查，其他用 ETF 代码查
        lookup_code = code
        # 估值指标的 code 是指数代码，rule_engine 里传进来的 code 是 ETF 代码
        # 需要映射：ETF 代码 → 指数代码（用于 valuation 查询）
        from config import TRACKED_ETFS
        metric_type_for_lookup = "valuation" if not is_qdii else "premium"
        if metric_type_for_lookup == "valuation":
            etf_info = TRACKED_ETFS.get(code, {})
            lookup_code = etf_info.get("index_code", code)
        else:
            lookup_code = code

        persisted = get_latest_quality(lookup_code, metric_type_for_lookup)
        if persisted and persisted.get("quality_score") is not None:
            quality_score_val = persisted["quality_score"]
            can_use_for_rule_val = bool(persisted.get("can_use_for_rule"))
            can_use_for_strong_rule_val = bool(persisted.get("can_use_for_strong_rule"))
    except Exception as e:
        logger.warning(f"[RULE-ENGINE] Failed to read quality score for {code}: {e}")

    # 如果没有持久化分数，根据 5 态质量状态兜底推断（保守）
    if quality_score_val is None:
        if quality_status == "passed":
            quality_score_val = 85.0  # 可用但未达强规则门槛
            can_use_for_rule_val = True
            can_use_for_strong_rule_val = False
        elif quality_status == "minor_abnormal":
            quality_score_val = 65.0  # 可疑
            can_use_for_rule_val = False
            can_use_for_strong_rule_val = False
        else:
            quality_score_val = 40.0  # 不可用
            can_use_for_rule_val = False
            can_use_for_strong_rule_val = False

    # V4.1 §10.8: 质量分门槛 — 不达标时升级 veto
    # 买入需 >=75，再平衡需 >=90
    # 这里只标记 can_use_for_rule/can_use_for_strong_rule，真正的 veto 在 _check_veto_hits 里触发

    # V4.1 §10.9 / S2-T5 + S2-T8: 从 cross_check_log 读取最新交叉校验结果，
    # 判定 single_source_warning（单源场景）和 source_conflict（主备源冲突）
    single_source_warning_val = False
    source_conflict_val = False
    try:
        from services.data_source_manager import _get_db
        import sqlite3 as _sqlite3
        conn = _get_db()
        conn.row_factory = _sqlite3.Row
        try:
            # 查最新一条 cross_check_log（用 lookup_code 即指数代码 for valuation，ETF 代码 for premium）
            cc_row = conn.execute(
                """SELECT quality_status
                   FROM cross_check_log
                   WHERE code = ? AND field = ?
                   ORDER BY fetch_time DESC LIMIT 1""",
                (lookup_code, metric_type_for_lookup),
            ).fetchone()
            if cc_row:
                qs = cc_row["quality_status"] or ""
                # source_conflict: 主备源差异超阈值（quality_status='source_inconsistent'）
                if qs == "source_inconsistent":
                    source_conflict_val = True
                # single_source_warning: 单源场景
                # - no_backup: 无备源配置
                # - backup_failed: 备源拉取失败
                # - primary_failed: 主源失败只剩备源（也算单源）
                if qs in ("no_backup", "backup_failed", "primary_failed"):
                    single_source_warning_val = True
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"[RULE-ENGINE] Failed to read cross_check_log for {code}: {e}")

    # V4.1 S2-T5: 单源场景下，限制强再平衡规则（can_use_for_strong_rule 强制 False）
    if single_source_warning_val:
        can_use_for_strong_rule_val = False

    # V4.1 S2-T8: 主备源冲突时，强制阻断强规则 + 标记需人工确认
    if source_conflict_val:
        can_use_for_strong_rule_val = False
        # 主备源冲突也阻断买入（保守策略）
        can_use_for_rule_val = False

    return DataQuality(
        source=source,
        sampleDays=sample_days,
        requiredSampleDays=required_sample_days,
        isSampleEnough=is_sample_enough,
        missingCount=missing_count,
        outlierCount=outlier_count,
        canCalculate=can_calculate,
        updatedAt=str(updated_at) if updated_at else "",
        # V4 新增
        qualityStatus=quality_status,
        abnormalReason=abnormal_reason,
        isStale=is_stale,
        staleLevel=stale_level,
        staleReason=stale_reason,
        percentileWindow=percentile_window,
        rawValue=raw_value,
        cleanValue=clean_value,
        isValid=is_valid,
        # V4.1 新增
        qualityScore=quality_score_val,
        canUseForRule=can_use_for_rule_val,
        canUseForStrongRule=can_use_for_strong_rule_val,
        singleSourceWarning=single_source_warning_val,
        sourceConflict=source_conflict_val,
    )


def _fmt_pct(v: Optional[float]) -> str:
    if v is None:
        return "—"
    return f"{v:.1f}%"


# ─── Rule evaluation helpers (return structured RuleHit) ──────────────────────

def _rule_matches(rule, code: str) -> bool:
    """Check whether a rule applies to this code (scope check)."""
    if rule.applicable_scope == "all":
        return True
    # specific scope: code must be in applicable_codes
    return code in (rule.applicable_codes or [])


def _check_veto_hits(
    code: str,
    current_ratio: float,
    target_ratio: float,
    pe_percentile: Optional[float],
    premium_today: Optional[float],
    data_quality: DataQuality,
    rules: list,
    premium_7d_avg: Optional[float] = None,
) -> list[RuleHit]:
    """Check veto rules. Returns list of RuleHit objects."""
    hits: list[RuleHit] = []

    # 1) Data quality veto — conservative: key data missing → don't auto-buy
    if not data_quality.can_calculate:
        missing_hint = "PE分位缺失" if code not in QDII_CODES else "溢价率缺失"
        hits.append(RuleHit(
            ruleType="veto",
            ruleName="数据质量否决",
            conditionText=f"关键数据{missing_hint}或样本不足({data_quality.sample_days}天<{data_quality.required_sample_days}天)",
            actualValue=missing_hint,
            threshold=str(data_quality.required_sample_days),
            effect="本周不买入，等待数据补全",
        ))

    # V4.1 §10.8: 质量评分门槛否决 — 买入需 >=75
    # can_use_for_rule=False 表示质量分 <75，强制否决买入
    if data_quality.can_calculate and not data_quality.can_use_for_rule:
        score = data_quality.quality_score
        hits.append(RuleHit(
            ruleType="veto",
            ruleName="数据质量评分否决",
            conditionText=f"数据质量评分 {score} < 75（买入门槛）",
            actualValue=f"{score}分" if score is not None else "无评分",
            threshold="75",
            effect="本周不买入，数据可信度不足",
        ))

    # V4.1 §10.9 / S2-T8: 主备源冲突熔断 — 主备源差异超阈值
    # 触发条件：cross_check_log 最新记录 quality_status='source_inconsistent'
    # 效果：阻断买入，需人工确认主备源哪个为准
    if data_quality.source_conflict:
        hits.append(RuleHit(
            ruleType="veto",
            ruleName="主备源冲突熔断",
            conditionText="主备源数据差异超阈值，无法自动判定哪个为准",
            actualValue="source_inconsistent",
            threshold="≤容忍阈值",
            effect="本周不买入，请人工确认数据源",
        ))

    # V4.1 §10.9 / S2-T5: 单源场景提示（info 级别，不阻断买入但限制强再平衡）
    # 不加 veto，但通过 can_use_for_strong_rule=False 在再平衡引擎里限制
    # 这里仅作为 audit 记录，让前端展示该 ETF 处于单源场景
    if data_quality.single_source_warning and data_quality.can_calculate:
        hits.append(RuleHit(
            ruleType="info",
            ruleName="单源场景提示",
            conditionText="该指标仅有单一数据源可用（备源未配置/不可用/拉取失败）",
            actualValue="single_source",
            threshold="双源校验",
            effect="本周可买入，但不参与强再平衡规则",
        ))

    for rule in rules:
        if not rule.is_enabled:
            continue
        if rule.type != "veto":
            continue
        if not _rule_matches(rule, code):
            continue

        threshold = rule.threshold_value
        threshold_max = rule.threshold_value_max

        if "blacklist" in rule.id.lower() or "黑名单" in rule.name:
            if code in (rule.applicable_codes or []):
                hits.append(RuleHit(
                    ruleType="veto",
                    ruleName=rule.name,
                    conditionText="ETF 在黑名单中",
                    actualValue=code,
                    threshold="",
                    effect="本周不买入",
                ))

        elif "high_pe" in rule.id.lower() or "极高分位" in rule.name:
            # PE percentile veto (default threshold 80)
            if pe_percentile is not None and threshold is not None and pe_percentile > threshold:
                hits.append(RuleHit(
                    ruleType="veto",
                    ruleName=rule.name,
                    conditionText=f"PE分位 > {threshold}%",
                    actualValue=f"{pe_percentile:.1f}%",
                    threshold=f"{threshold}%",
                    effect="本周不买入",
                ))

        elif "qdii_premium" in rule.id.lower() or "溢价红线" in rule.name:
            if code in (rule.applicable_codes or []) and premium_today is not None and threshold is not None and premium_today > threshold:
                # V4 策略书§3.3: 买入否决叠加3日/7日均值条件
                # "当日溢价>3%，且近3日/7日均值不低" → 避免偶发异常误判
                # 如果7日均值也有数据且>threshold*0.5（均值不低），则确认否决
                # 如果7日均值数据缺失，保守起见仍否决（单日高溢价已足够风险）
                avg_confirm = True
                avg_hint = ""
                if premium_7d_avg is not None:
                    if premium_7d_avg < threshold * 0.5:
                        # 7日均值较低，可能是偶发单日异常，降级为减量而非否决
                        avg_confirm = False
                        avg_hint = f"（7日均{premium_7d_avg:.2f}%较低，可能偶发异常，降级为减量）"
                if avg_confirm:
                    hits.append(RuleHit(
                        ruleType="veto",
                        ruleName=rule.name,
                        conditionText=f"QDII溢价率 > {threshold}%{avg_hint}",
                        actualValue=f"{premium_today:.2f}%" + (f" / 7日均{premium_7d_avg:.2f}%" if premium_7d_avg is not None else ""),
                        threshold=f"{threshold}%",
                        effect="本周不买入",
                    ))

    return hits


def _check_reduce_hits(
    code: str,
    current_ratio: float,
    target_ratio: float,
    pe_percentile: Optional[float],
    premium_today: Optional[float],
    rules: list,
) -> list[RuleHit]:
    """Check reduce rules. Returns list of RuleHit objects."""
    hits: list[RuleHit] = []

    for rule in rules:
        if not rule.is_enabled:
            continue
        if rule.type != "reduce":
            continue
        if not _rule_matches(rule, code):
            continue

        threshold = rule.threshold_value
        threshold_max = rule.threshold_value_max

        if "qdii_premium" in rule.id.lower() or "溢价预警" in rule.name:
            # QDII premium in [threshold, threshold_max] (default 2~3)
            if (
                premium_today is not None
                and threshold is not None
                and threshold_max is not None
                and threshold <= premium_today <= threshold_max
            ):
                hits.append(RuleHit(
                    ruleType="reduce",
                    ruleName=rule.name,
                    conditionText=f"{threshold}% ≤ 溢价率 ≤ {threshold_max}%",
                    actualValue=f"{premium_today:.2f}%",
                    threshold=f"{threshold}~{threshold_max}%",
                    effect="额度×0.5",
                ))

        elif "high_pe" in rule.id.lower() or "偏高" in rule.name:
            if (
                pe_percentile is not None
                and threshold is not None
                and threshold_max is not None
                and threshold <= pe_percentile <= threshold_max
            ):
                hits.append(RuleHit(
                    ruleType="reduce",
                    ruleName=rule.name,
                    conditionText=f"{threshold}% ≤ PE分位 ≤ {threshold_max}%",
                    actualValue=f"{pe_percentile:.1f}%",
                    threshold=f"{threshold}~{threshold_max}%",
                    effect="额度×0.5",
                ))

        elif "over_concentrated" in rule.id.lower() or "过度集中" in rule.name:
            # current_ratio > target_ratio * threshold (default 1.5)
            if (
                target_ratio > 0
                and threshold is not None
                and current_ratio > target_ratio * threshold
            ):
                pct_cur = current_ratio * 100
                pct_tgt = target_ratio * 100
                hits.append(RuleHit(
                    ruleType="reduce",
                    ruleName=rule.name,
                    conditionText=f"当前占比 > 目标占比 × {threshold}",
                    actualValue=f"当前{pct_cur:.1f}% / 目标{pct_tgt:.1f}%",
                    threshold=f"目标×{threshold}",
                    effect="额度×0.5",
                ))

    return hits


def _check_boost_hits(
    code: str,
    current_ratio: float,
    target_ratio: float,
    pe_percentile: Optional[float],
    rules: list,
) -> list[RuleHit]:
    """Check boost rules. Returns list of RuleHit objects."""
    hits: list[RuleHit] = []

    for rule in rules:
        if not rule.is_enabled:
            continue
        if rule.type != "boost":
            continue
        if not _rule_matches(rule, code):
            continue

        threshold = rule.threshold_value

        if "very_low_pe" in rule.id.lower() or "极度低估" in rule.name:
            if pe_percentile is not None and threshold is not None and pe_percentile < threshold:
                hits.append(RuleHit(
                    ruleType="boost",
                    ruleName=rule.name,
                    conditionText=f"PE分位 < {threshold}%",
                    actualValue=f"{pe_percentile:.1f}%",
                    threshold=f"{threshold}%",
                    effect="额度×2.0",
                ))

        elif "large_negative_deviation" in rule.id.lower() or "负偏离" in rule.name:
            # current_ratio < target_ratio * threshold (default 0.5)
            if (
                target_ratio > 0
                and threshold is not None
                and current_ratio < target_ratio * threshold
            ):
                pct_cur = current_ratio * 100
                pct_tgt = target_ratio * 100
                hits.append(RuleHit(
                    ruleType="boost",
                    ruleName=rule.name,
                    conditionText=f"当前占比 < 目标占比 × {threshold}",
                    actualValue=f"当前{pct_cur:.1f}% / 目标{pct_tgt:.1f}%",
                    threshold=f"目标×{threshold}",
                    effect="额度×2.0",
                ))

    return hits


# ─── reason_summary builder ──────────────────────────────────────────────────

def _build_reason_summary(
    *,
    vetoed: bool,
    veto_hits: list[RuleHit],
    reduce_hits: list[RuleHit],
    boost_hits: list[RuleHit],
    over_allocated: bool,
    current_ratio: float,
    target_ratio: float,
    pe_percentile: Optional[float],
    premium_today: Optional[float],
) -> str:
    if vetoed:
        # Find the dominant veto cause for a concise summary
        if veto_hits:
            # Prefer data-quality veto first (it has its own distinct format)
            for h in veto_hits:
                if "数据质量" in h.rule_name:
                    return f"{h.actual_value}，样本不足，触发一票否决，本周不买。"
            # Then PE percentile veto (condition_text contains "PE分位 >" and actual_value is a percentile number)
            for h in veto_hits:
                if "PE分位" in h.condition_text and "缺失" not in h.actual_value:
                    return f"PE分位{h.actual_value}超过{h.threshold}红线，触发一票否决，本周不买。"
            # Then QDII premium veto (condition_text contains "QDII溢价率 >" and actual_value is a premium number)
            for h in veto_hits:
                if "QDII溢价率" in h.condition_text and "缺失" not in h.actual_value:
                    return f"QDII溢价率{h.actual_value}超过{h.threshold}红线，触发一票否决，本周不买。"
            # Then blacklist veto
            for h in veto_hits:
                if "黑名单" in h.rule_name or "黑名单" in h.condition_text:
                    return f"该ETF在{h.rule_name}中，本周不买。"
            # Generic veto fallback
            return f"触发{veto_hits[0].rule_name}，本周不买。"
        return "触发一票否决，本周不买。"

    if over_allocated:
        pct_cur = current_ratio * 100
        pct_tgt = target_ratio * 100
        return f"当前占比{pct_cur:.1f}%高于目标{pct_tgt:.0f}%，已超配，本周不补仓。"

    if reduce_hits:
        # Use the first reduce hit for the headline
        h = reduce_hits[0]
        if "PE分位" in h.condition_text:
            return f"PE分位{h.actual_value}处于偏高区间，触发减量规则，额度减半。"
        if "溢价率" in h.condition_text:
            return f"溢价率{h.actual_value}处于预警区间，触发减量规则，额度减半。"
        if "当前占比" in h.condition_text:
            return f"当前占比超过目标{h.threshold}，触发减量规则，额度减半。"
        return f"触发{h.rule_name}，额度减半。"

    if boost_hits:
        h = boost_hits[0]
        if "PE分位" in h.condition_text:
            return f"PE分位{h.actual_value}处于极度低估区间，触发加量规则，额度翻倍。"
        if "当前占比" in h.condition_text:
            return f"当前占比远低于目标{h.threshold}，触发加量规则，额度翻倍。"
        return f"触发{h.rule_name}，额度翻倍。"

    return "估值与配置正常，按目标缺口比例分配预算。"


# ─── Rebalance Engine (V4 strategy doc §7) ────────────────────────────────────
#
# 再平衡不是清仓择时，而是当资产同时满足「极高估 + 明显超配」时，
# 卖出超配部分，维护组合纪律。卖的是超配部分，不卖核心底仓。
#
# 三类标的差异化规则：
#   A股宽基(§7.2): PE/PB分位>90%且超配≥5pp → 卖超额30%
#                   PE/PB分位>95%且超配≥8pp → 卖超额50%
#   红利ETF(§7.3): 股息率分位<15%且超配≥5pp → 卖超额30%
#                   股息率分位<10%且超配≥8pp → 卖超额50%
#   美股宽基(§7.4): PE分位>95%且超配≥10pp → 卖超额20%
#                    QDII溢价>5%且超配≥5pp → 卖超额30%~50%
#
# 超额市值 = 当前持仓市值 - 当前定投资产总额 × 目标占比
# 卖出金额 = 超额市值 × 卖出比例
# 资金去向：华宝添益(511990)
#
# 注：当前数据层只有单个 pe_percentile（本质5年分位）和 dividend_yield（原始值）。
# 迭代2将引入多周期(1/3/5/10年)分位。此处先用现有分位作为估值判据，红利用
# 股息率历史分位（若缓存有 dividend_yield_percentile 则用之，否则用原始股息率反推）。

def _check_a_share_rebalance(
    code: str,
    name: str,
    pe_percentile: Optional[float],
    pb_percentile: Optional[float],
    current_ratio_pct: float,
    target_ratio_pct: float,
    current_value: float,
    invested_total: float,
) -> Optional[RebalanceSuggestion]:
    """A股宽基再平衡（§7.2）。current_ratio/target_ratio 传入百分点（如 23.0 表示 23%）。"""
    # 取 PE/PB 分位中较高者作为估值判据（保守）
    valuation = None
    metric = ""
    if pe_percentile is not None and pb_percentile is not None:
        if pe_percentile >= pb_percentile:
            valuation, metric = pe_percentile, "pe_percentile"
        else:
            valuation, metric = pb_percentile, "pb_percentile"
    elif pe_percentile is not None:
        valuation, metric = pe_percentile, "pe_percentile"
    elif pb_percentile is not None:
        valuation, metric = pb_percentile, "pb_percentile"

    if valuation is None:
        return None  # 数据不足，不触发强卖出（§7.2 + §3.2 样本不足规则）

    over_pp = current_ratio_pct - target_ratio_pct  # 超配百分点
    target_value = invested_total * (target_ratio_pct / 100.0)
    excess_value = current_value - target_value

    if excess_value <= 0:
        return None  # 未超配，不卖（即使极高估也只暂停新增）

    # Level2: 分位>95% 且 超配≥8pp → 卖50%
    if valuation > 95 and over_pp >= 8:
        sell_ratio, level, threshold_desc = 0.5, "level2", f"PE/PB分位{valuation:.1f}%>95% 且 超配{over_pp:.1f}pp≥8pp"
    # Level1: 分位>90% 且 超配≥5pp → 卖30%
    elif valuation > 90 and over_pp >= 5:
        sell_ratio, level, threshold_desc = 0.3, "level1", f"PE/PB分位{valuation:.1f}%>90% 且 超配{over_pp:.1f}pp≥5pp"
    else:
        return None  # 不满足双条件

    sell_amount = int(round(excess_value * sell_ratio))
    if sell_amount < 100:
        return None  # 金额过小不值得再平衡

    reason = (
        f"{name} {metric}={valuation:.1f}%处于极高估区间，当前占比{current_ratio_pct:.1f}%"
        f"超过目标{target_ratio_pct:.1f}%达{over_pp:.1f}pp，触发{level}再平衡，"
        f"卖出超额市值¥{excess_value:,.0f}的{int(sell_ratio*100)}%=¥{sell_amount:,}，资金转入华宝添益。"
    )

    return RebalanceSuggestion(
        code=code, name=name,
        trigger_type="a_share_pe", trigger_level=level,
        valuation_metric=metric, valuation_value=valuation, valuation_threshold=threshold_desc,
        target_ratio=target_ratio_pct / 100.0, current_ratio=current_ratio_pct / 100.0,
        deviation_pp=round(over_pp, 2), over_concentration_pp=round(max(over_pp, 0), 2),
        current_value=current_value, target_value=round(target_value, 2),
        excess_value=round(excess_value, 2), sell_ratio=sell_ratio, sell_amount=sell_amount,
        cash_destination=CASH_POOL_CODE, reason_summary=reason,
        rules_hit=[RuleHit(
            rule_type="rebalance", rule_name=f"A股宽基再平衡-{level}",
            condition_text=threshold_desc,
            actual_value=f"分位{valuation:.1f}%/超配{over_pp:.1f}pp/超额¥{excess_value:,.0f}",
            threshold=f"卖出{int(sell_ratio*100)}%", effect=f"卖出¥{sell_amount:,}→华宝添益",
        )],
    )


def _check_dividend_rebalance(
    code: str,
    name: str,
    dividend_yield: Optional[float],
    dividend_yield_percentile: Optional[float],
    current_ratio_pct: float,
    target_ratio_pct: float,
    current_value: float,
    invested_total: float,
) -> Optional[RebalanceSuggestion]:
    """红利ETF再平衡（§7.3）。股息率分位低=贵。"""
    # 优先用股息率分位；若只有原始股息率，无法算分位则不触发强规则（保守）
    dy_pct = dividend_yield_percentile
    if dy_pct is None:
        return None  # 缺分位数据，不触发（迭代2补多周期分位后可完善）

    over_pp = current_ratio_pct - target_ratio_pct
    target_value = invested_total * (target_ratio_pct / 100.0)
    excess_value = current_value - target_value

    if excess_value <= 0:
        return None

    # Level2: 股息率分位<10% 且 超配≥8pp → 卖50%
    if dy_pct < 10 and over_pp >= 8:
        sell_ratio, level, threshold_desc = 0.5, "level2", f"股息率分位{dy_pct:.1f}%<10% 且 超配{over_pp:.1f}pp≥8pp"
    # Level1: 股息率分位<15% 且 超配≥5pp → 卖30%
    elif dy_pct < 15 and over_pp >= 5:
        sell_ratio, level, threshold_desc = 0.3, "level1", f"股息率分位{dy_pct:.1f}%<15% 且 超配{over_pp:.1f}pp≥5pp"
    else:
        return None

    sell_amount = int(round(excess_value * sell_ratio))
    if sell_amount < 100:
        return None

    reason = (
        f"{name} 股息率分位{dy_pct:.1f}%偏低（价格相对偏贵），当前占比{current_ratio_pct:.1f}%"
        f"超过目标{target_ratio_pct:.1f}%达{over_pp:.1f}pp，触发{level}再平衡，"
        f"卖出超额市值¥{excess_value:,.0f}的{int(sell_ratio*100)}%=¥{sell_amount:,}，资金转入华宝添益。"
    )

    return RebalanceSuggestion(
        code=code, name=name,
        trigger_type="dividend_yield", trigger_level=level,
        valuation_metric="dividend_yield_percentile", valuation_value=dy_pct, valuation_threshold=threshold_desc,
        target_ratio=target_ratio_pct / 100.0, current_ratio=current_ratio_pct / 100.0,
        deviation_pp=round(over_pp, 2), over_concentration_pp=round(max(over_pp, 0), 2),
        current_value=current_value, target_value=round(target_value, 2),
        excess_value=round(excess_value, 2), sell_ratio=sell_ratio, sell_amount=sell_amount,
        cash_destination=CASH_POOL_CODE, reason_summary=reason,
        rules_hit=[RuleHit(
            rule_type="rebalance", rule_name=f"红利ETF再平衡-{level}",
            condition_text=threshold_desc,
            actual_value=f"股息率分位{dy_pct:.1f}%/超配{over_pp:.1f}pp/超额¥{excess_value:,.0f}",
            threshold=f"卖出{int(sell_ratio*100)}%", effect=f"卖出¥{sell_amount:,}→华宝添益",
        )],
    )


def _check_us_share_rebalance(
    code: str,
    name: str,
    pe_percentile: Optional[float],
    premium_today: Optional[float],
    current_ratio_pct: float,
    target_ratio_pct: float,
    current_value: float,
    invested_total: float,
) -> Optional[RebalanceSuggestion]:
    """美股宽基再平衡（§7.4）。PE分位或QDII溢价两条触发路径。

    PE分位>95%且超配≥10pp → 极端再平衡卖超额20%
    QDII溢价>5%且超配≥5pp → 情绪溢价再平衡卖超额30%~50%（取0.4中值）
    关键原则：QDII高溢价对买入是坏事；若已满足再平衡条件，高溢价是更好的卖出窗口。
    """
    over_pp = current_ratio_pct - target_ratio_pct
    target_value = invested_total * (target_ratio_pct / 100.0)
    excess_value = current_value - target_value

    if excess_value <= 0:
        return None

    # 优先检查 QDII 溢价路径（情绪溢价再平衡，卖出窗口更好）
    if premium_today is not None and premium_today > 5 and over_pp >= 5:
        sell_ratio, level, threshold_desc = 0.4, "level2", f"QDII溢价{premium_today:.2f}%>5% 且 超配{over_pp:.1f}pp≥5pp"
        trigger_type, metric, val = "us_qdii_premium", "premium_today", premium_today
    # 再检查 PE 分位路径（极端再平衡，更克制）
    elif pe_percentile is not None and pe_percentile > 95 and over_pp >= 10:
        sell_ratio, level, threshold_desc = 0.2, "level1", f"PE分位{pe_percentile:.1f}%>95% 且 超配{over_pp:.1f}pp≥10pp"
        trigger_type, metric, val = "us_pe", "pe_percentile", pe_percentile
    else:
        return None

    sell_amount = int(round(excess_value * sell_ratio))
    if sell_amount < 100:
        return None

    reason = (
        f"{name} {threshold_desc}，触发美股{level}再平衡，"
        f"卖出超额市值¥{excess_value:,.0f}的{int(sell_ratio*100)}%=¥{sell_amount:,}，资金转入华宝添益。"
        + ("（QDII高溢价提供更好的卖出窗口）" if trigger_type == "us_qdii_premium" else "")
    )

    return RebalanceSuggestion(
        code=code, name=name,
        trigger_type=trigger_type, trigger_level=level,
        valuation_metric=metric, valuation_value=val, valuation_threshold=threshold_desc,
        target_ratio=target_ratio_pct / 100.0, current_ratio=current_ratio_pct / 100.0,
        deviation_pp=round(over_pp, 2), over_concentration_pp=round(max(over_pp, 0), 2),
        current_value=current_value, target_value=round(target_value, 2),
        excess_value=round(excess_value, 2), sell_ratio=sell_ratio, sell_amount=sell_amount,
        cash_destination=CASH_POOL_CODE, reason_summary=reason,
        rules_hit=[RuleHit(
            rule_type="rebalance", rule_name=f"美股宽基再平衡-{level}",
            condition_text=threshold_desc,
            actual_value=f"{metric}={val:.2f}/超配{over_pp:.1f}pp/超额¥{excess_value:,.0f}",
            threshold=f"卖出{int(sell_ratio*100)}%", effect=f"卖出¥{sell_amount:,}→华宝添益",
        )],
    )


def run_rebalance_engine(
    holdings: list,
    target_ratios: dict,
    market_data: dict,
    invested_total: float,
) -> list[RebalanceSuggestion]:
    """执行再平衡引擎，返回所有触发再平衡的标的。

    holdings: list of Holding (含 code/name/market_value/current_ratio)
    target_ratios: {code: target_ratio(分数, 如0.18)}
    market_data: {code: {pe_percentile, pb_percentile, premium_today, dividend_yield, dividend_yield_percentile...}}
    invested_total: 当前定投资产总额（仅6只定投ETF市值之和）
    """
    rebalance_list: list[RebalanceSuggestion] = []

    for h in holdings:
        code = h.code
        if code not in target_ratios or target_ratios[code] <= 0:
            continue  # 非定投标的不参与再平衡

        # V4.1 §10.8: 再平衡强规则门槛 — 质量分需 >=90 才允许触发再平衡
        # 质量分 <90 时跳过该标的的再平衡检查（保守，宁可少卖不能误卖）
        md_for_dq = market_data.get(code, {}) or {}
        dq_check = validate_data_quality(code, md_for_dq)
        if not dq_check.can_use_for_strong_rule:
            logger.info(
                f"[REBALANCE] {code} skipped: quality score {dq_check.quality_score} < 90 (strong rule threshold)"
            )
            continue

        target_ratio_pct = target_ratios[code] * 100.0
        # current_ratio: 优先用 holdings 里的（已被前端算成百分数并转成分数传入引擎），
        # 这里需要百分数。advice/route.ts 传入的 currentRatio 是分数(0~1)。
        req_ratio = safe_num(h.current_ratio)
        if req_ratio is not None and 0 <= req_ratio <= 1.0:
            current_ratio_pct = req_ratio * 100.0
        else:
            # 回退：用 invested_total 计算
            current_ratio_pct = (h.market_value / invested_total * 100.0) if invested_total > 0 else 0.0

        md = market_data.get(code, {}) or {}
        # V4 多周期估值（策略书§3.1）：再平衡侧优先用10年分位，回退到全历史/默认分位
        # 卖出必须更保守，用10年或全历史为主
        pe_pct_10y = safe_num(md.get("pe_percentile_10y"))
        pe_pct_all = safe_num(md.get("pe_percentile_all"))
        pe_pct_default = safe_num(md.get("pe_percentile"))
        # 优先级：10y > all > 默认(5y)
        pe_pct = pe_pct_10y if pe_pct_10y is not None else (pe_pct_all if pe_pct_all is not None else pe_pct_default)

        pb_pct_10y = safe_num(md.get("pb_percentile_10y"))
        pb_pct_all = safe_num(md.get("pb_percentile_all"))
        pb_pct_default = safe_num(md.get("pb_percentile"))
        pb_pct = pb_pct_10y if pb_pct_10y is not None else (pb_pct_all if pb_pct_all is not None else pb_pct_default)

        premium = safe_num(md.get("premium_today"))
        dy = safe_num(md.get("dividend_yield"))
        dy_pct = safe_num(md.get("dividend_yield_percentile"))

        suggestion: Optional[RebalanceSuggestion] = None
        if code in A_SHARE_REBALANCE_CODES:
            suggestion = _check_a_share_rebalance(
                code, h.name, pe_pct, pb_pct,
                current_ratio_pct, target_ratio_pct, h.market_value, invested_total,
            )
        elif code in DIVIDEND_REBALANCE_CODES:
            suggestion = _check_dividend_rebalance(
                code, h.name, dy, dy_pct,
                current_ratio_pct, target_ratio_pct, h.market_value, invested_total,
            )
        elif code in US_SHARE_REBALANCE_CODES:
            suggestion = _check_us_share_rebalance(
                code, h.name, pe_pct, premium,
                current_ratio_pct, target_ratio_pct, h.market_value, invested_total,
            )

        if suggestion is not None:
            rebalance_list.append(suggestion)
            logger.info(f"[REBALANCE] {code} {h.name} triggered {suggestion.trigger_level}: sell ¥{suggestion.sell_amount}")

    return rebalance_list


# ─── Main calculation ─────────────────────────────────────────────────────────

def calculate_suggestions(
    request: CalculateRequest,
    market_data: dict,
) -> CalculateResponse:
    """Execute the 12-step target-gap-v2 rule engine calculation.

    Args:
        request: Calculation request with holdings, target_ratios, rules, weekly_budget.
        market_data: Dict mapping code -> {pe_percentile, premium_today, premium_7d_avg, ...}

    Returns:
        CalculateResponse with deterministic allocation results and full audit fields.
    """
    holdings = request.holdings
    target_ratios = {tr.code: tr.target_ratio for tr in request.target_ratios}
    rules = request.rules
    weekly_budget = request.weekly_budget

    holdings_map = {h.code: h for h in holdings}

    # ──────────────────────────────────────────────
    # Step 2: Determine investable codes & invested_asset_value
    # ──────────────────────────────────────────────
    # investable_codes = codes present in target_ratios with target_ratio > 0
    investable_codes = {c for c, r in target_ratios.items() if r > 0}

    invested_asset_value = 0.0
    for h in holdings:
        if h.code in investable_codes:
            invested_asset_value += h.market_value

    # ──────────────────────────────────────────────
    # Step 3: after_budget_total
    # ──────────────────────────────────────────────
    after_budget_total = invested_asset_value + weekly_budget

    # ──────────────────────────────────────────────
    # Step 4-5: Compute gap fields & run veto check for each investable holding
    # ──────────────────────────────────────────────
    per_item: dict[str, dict] = {}

    for h in holdings:
        code = h.code
        if code not in investable_codes:
            continue  # non-investable handled later
        md = market_data.get(code, {}) or {}
        target_ratio = target_ratios.get(code, 0)

        current_value = float(h.market_value)
        if invested_asset_value > 0:
            current_ratio = current_value / invested_asset_value
        else:
            current_ratio = 0.0
        # Override with the request's current_ratio if it's already a fraction and reasonable
        # (the request current_ratio is a fraction in [0,1])
        req_ratio = safe_num(h.current_ratio)
        if req_ratio is not None and 0 <= req_ratio <= 1.0:
            current_ratio = req_ratio

        target_value_after_budget = after_budget_total * target_ratio
        gap_amount = target_value_after_budget - current_value
        base_gap_amount = max(0.0, gap_amount)

        pe_percentile = safe_num(md.get("pe_percentile"))
        pb_percentile = safe_num(md.get("pb_percentile"))
        # V4 多周期估值（策略书§3.1）：买入侧优先用5年分位，回退到默认分位
        pe_percentile_5y = safe_num(md.get("pe_percentile_5y"))
        pb_percentile_5y = safe_num(md.get("pb_percentile_5y"))
        buy_pe_percentile = pe_percentile_5y if pe_percentile_5y is not None else pe_percentile
        buy_pb_percentile = pb_percentile_5y if pb_percentile_5y is not None else pb_percentile
        premium_today = safe_num(md.get("premium_today"))
        premium_7d_avg = safe_num(md.get("premium_7d_avg"))
        dividend_yield = safe_num(md.get("dividend_yield"))

        dq = validate_data_quality(code, md)

        veto_hits = _check_veto_hits(
            code=code,
            current_ratio=current_ratio,
            target_ratio=target_ratio,
            pe_percentile=buy_pe_percentile,
            premium_today=premium_today,
            data_quality=dq,
            rules=rules,
            premium_7d_avg=premium_7d_avg,
        )
        reduce_hits = _check_reduce_hits(
            code=code,
            current_ratio=current_ratio,
            target_ratio=target_ratio,
            pe_percentile=buy_pe_percentile,
            premium_today=premium_today,
            rules=rules,
        )
        boost_hits = _check_boost_hits(
            code=code,
            current_ratio=current_ratio,
            target_ratio=target_ratio,
            pe_percentile=buy_pe_percentile,
            rules=rules,
        )

        # V4.1 S2-T5: 单源场景的 info 提示不应导致 vetoed=True
        # 仅 ruleType="veto" 的 hits 才算真正的否决
        vetoed = any(h.rule_type == "veto" for h in veto_hits)
        over_allocated = (not vetoed) and base_gap_amount <= 0

        per_item[code] = {
            "name": h.name,
            "current_value": current_value,
            "target_ratio": target_ratio,
            "current_ratio": current_ratio,
            "target_value_after_budget": target_value_after_budget,
            "gap_amount": gap_amount,
            "base_gap_amount": base_gap_amount,
            "pe_percentile": pe_percentile,
            "pb_percentile": pb_percentile,
            "premium_today": premium_today,
            "premium_7d_avg": premium_7d_avg,
            "dividend_yield": dividend_yield,
            # V4 多周期分位
            "pe_percentile_1y": safe_num(md.get("pe_percentile_1y")),
            "pe_percentile_3y": safe_num(md.get("pe_percentile_3y")),
            "pe_percentile_5y": safe_num(md.get("pe_percentile_5y")),
            "pe_percentile_10y": safe_num(md.get("pe_percentile_10y")),
            "pe_percentile_all": safe_num(md.get("pe_percentile_all")),
            "pb_percentile_1y": safe_num(md.get("pb_percentile_1y")),
            "pb_percentile_3y": safe_num(md.get("pb_percentile_3y")),
            "pb_percentile_5y": safe_num(md.get("pb_percentile_5y")),
            "pb_percentile_10y": safe_num(md.get("pb_percentile_10y")),
            "pb_percentile_all": safe_num(md.get("pb_percentile_all")),
            "data_quality": dq,
            "veto_hits": veto_hits,
            "reduce_hits": reduce_hits,
            "boost_hits": boost_hits,
            "vetoed": vetoed,
            "over_allocated": over_allocated,
        }

    # ──────────────────────────────────────────────
    # Step 6: Build investable pool = base_gap>0 AND not vetoed
    # ──────────────────────────────────────────────
    pool_codes = [
        c for c, it in per_item.items()
        if it["base_gap_amount"] > 0 and not it["vetoed"]
    ]

    # ──────────────────────────────────────────────
    # Step 7: Allocate budget by gap proportion
    # ──────────────────────────────────────────────
    total_gap = sum(per_item[c]["base_gap_amount"] for c in pool_codes)

    base_amounts: dict[str, float] = {}
    if total_gap > 0:
        for c in pool_codes:
            base_amounts[c] = weekly_budget * per_item[c]["base_gap_amount"] / total_gap
    else:
        # All gaps closed / all vetoed: no allocation this week
        for c in pool_codes:
            base_amounts[c] = 0.0

    # ──────────────────────────────────────────────
    # Step 8: Apply reduce/boost multipliers (reduce > boost)
    # ──────────────────────────────────────────────
    pre_cap_amounts: dict[str, float] = {}
    multipliers: dict[str, float] = {}
    effective_hits: dict[str, list] = {}

    for c in pool_codes:
        it = per_item[c]
        reduce_hits = it["reduce_hits"]
        boost_hits = it["boost_hits"]

        if reduce_hits:
            multiplier = 0.5
            effective_hits[c] = reduce_hits
            if boost_hits:
                # reduce wins; keep boost as info
                effective_hits[c] = reduce_hits + [
                    RuleHit(
                        rule_type="info",
                        rule_name=bh.rule_name,
                        condition_text=bh.condition_text + "（被减量规则压制，未生效）",
                        actual_value=bh.actual_value,
                        threshold=bh.threshold,
                        effect="未生效",
                    ) for bh in boost_hits
                ]
                logger.info(f"[MULTIPLIER] {c} both reduce & boost hit, reduce wins → 0.5")
        elif boost_hits:
            multiplier = 2.0
            effective_hits[c] = boost_hits
        else:
            multiplier = 1.0
            effective_hits[c] = []

        multipliers[c] = multiplier
        pre_cap_amounts[c] = base_amounts[c] * multiplier

    # ──────────────────────────────────────────────
    # Step 9: Gap cap — never buy more than the gap
    # ──────────────────────────────────────────────
    for c in pool_codes:
        cap = per_item[c]["base_gap_amount"]
        if pre_cap_amounts[c] > cap:
            pre_cap_amounts[c] = cap

    # ──────────────────────────────────────────────
    # Step 10: Total budget constraint
    # ──────────────────────────────────────────────
    total_pre_cap = sum(pre_cap_amounts.values())
    if total_pre_cap > weekly_budget and total_pre_cap > 0:
        scale = weekly_budget / total_pre_cap
        for c in pool_codes:
            pre_cap_amounts[c] = pre_cap_amounts[c] * scale
        logger.info(
            f"[BUDGET] Total pre-cap {total_pre_cap:.0f} > budget {weekly_budget:.0f}, "
            f"scaling by {scale:.4f}"
        )

    # ──────────────────────────────────────────────
    # Step 11: Round to integers, fix rounding diff on largest item
    # ──────────────────────────────────────────────
    rounded_amounts: dict[str, int] = {c: int(round(v)) for c, v in pre_cap_amounts.items()}

    total_rounded = sum(rounded_amounts.values())
    diff = int(round(weekly_budget)) - total_rounded
    if diff != 0 and rounded_amounts:
        largest_code = max(rounded_amounts, key=rounded_amounts.get)
        # Only adjust if the largest item would not become negative
        if rounded_amounts[largest_code] + diff >= 0:
            rounded_amounts[largest_code] += diff
            logger.info(f"[ROUNDING] Adjusted {largest_code} by {diff} to fix rounding difference")

    # ──────────────────────────────────────────────
    # Step 12: Build response with full audit fields
    # ──────────────────────────────────────────────
    suggestions: list[SuggestionItem] = []

    for h in holdings:
        code = h.code
        md = market_data.get(code, {}) or {}

        if code not in investable_codes:
            # Non-investable: include with amount=0, vetoed=True, multiplier=0
            # Reason: blacklist / 非定投标的
            req_ratio = safe_num(h.current_ratio)
            current_ratio = req_ratio if (req_ratio is not None and 0 <= req_ratio <= 1.0) else 0.0
            info_hit = RuleHit(
                ruleType="veto",
                ruleName="非定投标的",
                conditionText="该ETF不在投资目标池中（如现金管理或家庭配置品种）",
                actualValue=code,
                threshold="",
                effect="本周不买入",
            )
            suggestions.append(SuggestionItem(
                code=code,
                name=h.name,
                amount=0,
                targetRatio=0.0,
                currentRatio=current_ratio,
                deviation=0.0,
                pePercentile=None,
                pbPercentile=None,
                premiumToday=None,
                premium7dAvg=None,
                dividendYield=None,
                currentValue=float(h.market_value),
                targetValueAfterBudget=0.0,
                gapAmount=0.0,
                baseGapAmount=0.0,
                dataQuality=None,
                preCapAmount=0.0,
                reasonSummary="非定投标的（现金管理或家庭配置），本周不买入。",
                rulesHit=[info_hit],
                multiplier=0.0,
                vetoed=True,
            ))
            continue

        it = per_item[code]
        veto_hits = it["veto_hits"]
        reduce_hits = it["reduce_hits"]
        boost_hits = it["boost_hits"]
        vetoed = it["vetoed"]
        over_allocated = it["over_allocated"]

        # Determine the final amount, multiplier, effective hits, reason_summary
        if vetoed:
            amount = 0
            multiplier = 0.0
            eff_hits = list(veto_hits)
            # If reduce/boost also hit, log them as info (not effective)
            for rh in reduce_hits + boost_hits:
                eff_hits.append(RuleHit(
                    rule_type="info",
                    rule_name=rh.rule_name,
                    condition_text=rh.condition_text + "（被否决规则覆盖，未生效）",
                    actual_value=rh.actual_value,
                    threshold=rh.threshold,
                    effect="未生效",
                ))
            base_gap_amount = it["base_gap_amount"]
            pre_cap_amount = 0.0
            reason_summary = _build_reason_summary(
                vetoed=True,
                veto_hits=veto_hits,
                reduce_hits=reduce_hits,
                boost_hits=boost_hits,
                over_allocated=False,
                current_ratio=it["current_ratio"],
                target_ratio=it["target_ratio"],
                pe_percentile=it["pe_percentile"],
                premium_today=it["premium_today"],
            )
        elif over_allocated:
            # base_gap_amount == 0 (or <= 0) → excluded from pool
            amount = 0
            multiplier = 0.0
            eff_hits = list(reduce_hits) + list(boost_hits)
            # Add info hit for over-allocation
            eff_hits.insert(0, RuleHit(
                ruleType="info",
                ruleName="已超配",
                conditionText="当前占比高于目标占比，目标缺口≤0",
                actualValue=f"当前{it['current_ratio']*100:.1f}% / 目标{it['target_ratio']*100:.0f}%",
                threshold="目标占比",
                effect="本周不补仓",
            ))
            base_gap_amount = it["base_gap_amount"]
            pre_cap_amount = 0.0
            reason_summary = _build_reason_summary(
                vetoed=False,
                veto_hits=[],
                reduce_hits=reduce_hits,
                boost_hits=boost_hits,
                over_allocated=True,
                current_ratio=it["current_ratio"],
                target_ratio=it["target_ratio"],
                pe_percentile=it["pe_percentile"],
                premium_today=it["premium_today"],
            )
        else:
            amount = int(rounded_amounts.get(code, 0))
            multiplier = multipliers.get(code, 1.0)
            eff_hits = list(effective_hits.get(code, []))  # copy
            # V4.1 §10.9 / S2-T5: 把单源场景 info 提示保留到最终 rules_hit
            # （否则会被 effective_hits 过滤掉，前端无法看到该 ETF 处于单源场景）
            for vh in veto_hits:
                if vh.rule_type == "info":
                    eff_hits.append(vh)
            base_gap_amount = it["base_gap_amount"]
            pre_cap_amount = float(pre_cap_amounts.get(code, 0.0))
            reason_summary = _build_reason_summary(
                vetoed=False,
                veto_hits=[],
                reduce_hits=reduce_hits,
                boost_hits=boost_hits,
                over_allocated=False,
                current_ratio=it["current_ratio"],
                target_ratio=it["target_ratio"],
                pe_percentile=it["pe_percentile"],
                premium_today=it["premium_today"],
            )

        suggestions.append(SuggestionItem(
            code=code,
            name=h.name,
            amount=amount,
            targetRatio=it["target_ratio"],
            currentRatio=it["current_ratio"],
            deviation=round(it["current_ratio"] - it["target_ratio"], 4),
            pePercentile=it["pe_percentile"],
            pbPercentile=it["pb_percentile"],
            premiumToday=it["premium_today"],
            premium7dAvg=it["premium_7d_avg"],
            dividendYield=it["dividend_yield"],
            # V4 多周期分位
            pePercentile1y=it.get("pe_percentile_1y"),
            pePercentile3y=it.get("pe_percentile_3y"),
            pePercentile5y=it.get("pe_percentile_5y"),
            pePercentile10y=it.get("pe_percentile_10y"),
            pePercentileAll=it.get("pe_percentile_all"),
            pbPercentile1y=it.get("pb_percentile_1y"),
            pbPercentile3y=it.get("pb_percentile_3y"),
            pbPercentile5y=it.get("pb_percentile_5y"),
            pbPercentile10y=it.get("pb_percentile_10y"),
            pbPercentileAll=it.get("pb_percentile_all"),
            currentValue=it["current_value"],
            targetValueAfterBudget=it["target_value_after_budget"],
            gapAmount=it["gap_amount"],
            baseGapAmount=base_gap_amount,
            dataQuality=it["data_quality"],
            preCapAmount=pre_cap_amount,
            reasonSummary=reason_summary,
            rulesHit=eff_hits,
            multiplier=multiplier,
            vetoed=vetoed,
        ))

    total_allocated = sum(s.amount for s in suggestions)
    total_unallocated = int(round(weekly_budget)) - total_allocated
    if total_unallocated < 0:
        # Shouldn't happen, but safety guard
        total_unallocated = 0

    # ──────────────────────────────────────────────
    # V4 Step 13: Rebalance Engine (§7) — 估值极端+超配双条件触发卖出
    # ──────────────────────────────────────────────
    rebalance_suggestions = run_rebalance_engine(
        holdings=holdings,
        target_ratios=target_ratios,
        market_data=market_data,
        invested_total=invested_asset_value,
    )
    total_rebalanced = sum(r.sell_amount for r in rebalance_suggestions)

    # ──────────────────────────────────────────────
    # V4 Step 14: Cash Pool Engine (§8) — 未分配+再平衡释放资金→华宝添益
    # ──────────────────────────────────────────────
    cash_pool_suggestions: list[CashPoolSuggestion] = []
    if total_unallocated > 0:
        cash_pool_suggestions.append(CashPoolSuggestion(
            code=CASH_POOL_CODE, name="华宝添益ETF",
            inflowType="unallocated",
            inflowAmount=total_unallocated,
            description=f"本周未分配新增预算¥{total_unallocated:,}转入华宝添益。",
        ))
    if total_rebalanced > 0:
        cash_pool_suggestions.append(CashPoolSuggestion(
            code=CASH_POOL_CODE, name="华宝添益ETF",
            inflowType="rebalance_release",
            inflowAmount=total_rebalanced,
            description=f"本周再平衡释放资金¥{total_rebalanced:,}转入华宝添益。",
        ))
    cash_pool_inflow = total_unallocated + total_rebalanced

    # Find the latest updated_at in market_data for the snapshot
    latest_updated = ""
    for md in market_data.values():
        if not isinstance(md, dict):
            continue
        u = md.get("updated_at") or md.get("date") or ""
        if u and str(u) > latest_updated:
            latest_updated = str(u)

    # ──────────────────────────────────────────────
    # V4 迭代13: PRD§11.3 分类清单 + 汇总字段
    # ──────────────────────────────────────────────
    buy_suggestions = [s for s in suggestions if s.amount > 0]
    pause_suggestions = [s for s in suggestions if s.amount == 0]

    # data_quality_summary: 各标的数据质量状态汇总
    dq_summary = {}
    for s in suggestions:
        if s.data_quality:
            dq_summary[s.code] = {
                "qualityStatus": s.data_quality.quality_status,
                "qualityScore": s.data_quality.quality_score,
                "canUseForRule": s.data_quality.can_use_for_rule,
                "canUseForStrongRule": s.data_quality.can_use_for_strong_rule,
                "isStale": s.data_quality.is_stale,
                "staleLevel": s.data_quality.stale_level,
                "canCalculate": s.data_quality.can_calculate,
                "sampleDays": s.data_quality.sample_days,
                # V4.1 S2-T5/S2-T8: 单源场景 + 主备源冲突
                "singleSourceWarning": s.data_quality.single_source_warning,
                "sourceConflict": s.data_quality.source_conflict,
            }

    # rules_hit_summary: 按规则类型计数
    rh_summary = {"veto": 0, "reduce": 0, "boost": 0, "rebalance": 0, "info": 0}
    for s in suggestions:
        for rh in s.rules_hit:
            rt = rh.rule_type if hasattr(rh, "rule_type") else "info"
            rh_summary[rt] = rh_summary.get(rt, 0) + 1
    for r in rebalance_suggestions:
        for rh in r.rules_hit:
            rt = rh.rule_type if hasattr(rh, "rule_type") else "info"
            rh_summary[rt] = rh_summary.get(rt, 0) + 1

    return CalculateResponse(
        calculationId=f"calc-{uuid.uuid4().hex[:12]}",
        engineVersion="target-gap-rebalance-v4",
        strategyVersion="strategy-v4",
        calculatedAt=datetime.now().isoformat(),
        allocationStrategy="conservative",
        dataSnapshot={
            "marketDataCacheTime": latest_updated or datetime.now().isoformat(),
            "rulesConfigVersion": "rules-v4",
            "strategyVersion": "strategy-v4",
            "investedAssetValue": round(invested_asset_value, 2),
            "afterBudgetTotal": round(after_budget_total, 2),
            "totalGap": round(total_gap, 2) if total_gap > 0 else 0.0,
        },
        totalBudget=int(round(weekly_budget)),
        totalAllocated=total_allocated,
        totalUnallocated=total_unallocated,
        suggestions=suggestions,
        # V4 新增字段
        rebalanceSuggestions=rebalance_suggestions,
        cashPoolSuggestions=cash_pool_suggestions,
        totalRebalanced=total_rebalanced,
        totalRebalanceAmount=total_rebalanced,
        cashPoolInflow=cash_pool_inflow,
        cashDestination=CASH_POOL_CODE,
        externalInflow=int(round(weekly_budget)),
        internalRelease=total_rebalanced,
        # PRD§11.3 分类清单 + 汇总
        buySuggestions=[s.model_dump(by_alias=True) for s in buy_suggestions],
        pauseSuggestions=[s.model_dump(by_alias=True) for s in pause_suggestions],
        dataQualitySummary=dq_summary,
        rulesHitSummary=rh_summary,
    )
