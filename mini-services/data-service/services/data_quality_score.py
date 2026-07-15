"""Data Quality Score Engine — PRD v4.1 §10.8 数据质量评分.

每个指标生成 0~100 分质量评分，5 个子维度加权：
    数据新鲜度 freshness      : 25 分
    主备源一致性 consistency   : 30 分
    字段完整性 completeness    : 20 分
    异常值检测 abnormal        : 15 分
    数据源健康 source_health   : 10 分

评级（PRD §10.8）：
    >=90  优秀  可以参与强规则（再平衡）
    75~89 可用  可以参与规则（买入），但需标注
    60~74 可疑  默认不参与强规则，仅展示
    <60   不可用 不参与规则

规则引擎门槛（PRD §10.8）：
    买入建议至少要求数据质量 >=75
    再平衡建议至少要求数据质量 >=90
    QDII溢价买入否决至少要求价格和净值数据均可用

本模块是质量评分的"唯一来源"，refresh.py 刷新后调用、rule_engine 计算前读取。
"""
from __future__ import annotations

import logging
import math
import sqlite3
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from typing import Optional

from config import DB_PATH

logger = logging.getLogger(__name__)


# ─── 评分权重（PRD §10.8）──────────────────────────────────────────────────────
WEIGHT_FRESHNESS = 25
WEIGHT_CONSISTENCY = 30
WEIGHT_COMPLETENESS = 20
WEIGHT_ABNORMAL = 15
WEIGHT_SOURCE_HEALTH = 10


# ─── 评级阈值（PRD §10.8）──────────────────────────────────────────────────────
GRADE_EXCELLENT = 90   # 优秀：可参与强规则（再平衡）
GRADE_USABLE = 75      # 可用：可参与规则（买入）
GRADE_SUSPICIOUS = 60  # 可疑：仅展示，不参与强规则
# <60 不可用：不参与规则


# V5.0 Sprint1 E2: 统一数据质量门禁语义 (PRD V5.0 §数据质量门禁)
# 在 V4.x 的 quality_status (excellent/usable/suspicious/unavailable) 之外,
# 新增 5 状态门禁语义, 用于规则引擎统一判断"该指标是否参与何种规则":
GATE_STATUS: dict[str, str] = {
    "valid":    "数据有效,可参与规则",
    "degraded": "数据降级,禁用增强仓但保留基础仓",
    "stale":    "数据过期,该指标不参与强规则",
    "conflict": "主备源冲突,该标的硬否决",
    "missing":  "数据缺失,该指标不参与规则",
}


def get_gate_status(
    quality_score: float,
    quality_status: str,
    is_stale: bool,
    source_conflict: bool,
    missing_count: int,
) -> str:
    """V5.0 Sprint1 E2: 统一门禁语义判断。

    将 V4.x 的多个分散信号(quality_score / quality_status / staleness /
    source_conflict / missing_count) 收敛为单一门禁状态, 供规则引擎统一判断。

    优先级（从严到宽）:
      missing  > conflict > stale > degraded > valid

    Args:
        quality_score: 0~100 质量分
        quality_status: excellent|usable|suspicious|unavailable
        is_stale: 是否过期(由 _check_staleness 判断, red/yellow 都视为 stale)
        source_conflict: 主备源是否冲突(导致该标的硬否决)
        missing_count: 关键字段缺失数(若 quality_score==0 且 missing>0, 视为 missing)

    Returns:
        valid | degraded | stale | conflict | missing
    """
    # 1. missing: 关键数据完全缺失
    if missing_count > 0 and quality_score == 0:
        return "missing"
    # 2. conflict: 主备源冲突 → 该标的硬否决
    if source_conflict:
        return "conflict"
    # 3. stale: 数据过期 → 该指标不参与强规则
    if is_stale:
        return "stale"
    # 4. degraded: 质量分<60 → 禁用增强仓但保留基础仓
    if quality_score < GRADE_SUSPICIOUS:
        return "degraded"
    # 5. valid: 数据有效, 可参与规则
    return "valid"


@dataclass
class QualityScore:
    """数据质量评分结果。"""
    code: str
    metric_type: str
    trade_date: str = ""

    # 5 个子分
    freshness_score: float = 0.0
    consistency_score: float = 0.0
    completeness_score: float = 0.0
    abnormal_score: float = 0.0
    source_health_score: float = 0.0

    # 总分 + 状态
    quality_score: float = 0.0
    quality_status: str = "unavailable"  # excellent | usable | suspicious | unavailable
    can_use_for_rule: bool = False
    can_use_for_strong_rule: bool = False  # 再平衡等强规则
    reason: str = ""

    computed_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


# ─── 子分计算 ─────────────────────────────────────────────────────────────────

def _compute_freshness(updated_at: str, metric_type: str) -> tuple[float, str]:
    """数据新鲜度（25 分）。

    PRD §5.4 缓存过期规则：
    - 当日：25 分
    - 1 日内：20 分
    - 2 日内：15 分
    - 3 日内：10 分
    - >3 日：0 分
    """
    if not updated_at:
        return 0.0, "数据时间缺失"
    try:
        s = str(updated_at)[:19]
        if "T" in s or "-" in s:
            try:
                dt = datetime.fromisoformat(s)
            except ValueError:
                dt = datetime.strptime(str(updated_at)[:10], "%Y-%m-%d")
        else:
            dt = datetime.strptime(str(updated_at)[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return 0.0, f"数据时间格式异常: {updated_at}"

    now = datetime.now()
    days_diff = (now - dt).days

    if days_diff <= 0:
        return 25.0, ""
    if days_diff <= 1:
        return 20.0, ""
    if days_diff <= 2:
        return 15.0, ""
    if days_diff <= 3:
        return 10.0, f"数据{days_diff}天未更新"
    return 0.0, f"数据已过期{days_diff}天"


def _compute_consistency(
    primary_value: Optional[float],
    backup_value: Optional[float],
    diff_pct: Optional[float],
    diff_pp: Optional[float],
    threshold_type: str,
    threshold_max: float,
    has_backup: bool,
    cached_value_exists: bool = True,
) -> tuple[float, str]:
    """主备源一致性（30 分）。

    V4.1 BUG-2026-06-QUALITY-CONSISTENCY:
        旧逻辑: cross_check 报告 "both_failed" → consistency=0，即使实际数据已成功缓存。
        根因: cross_check 是独立操作（重新拉主备源），与 fetch_with_fallback 是两套调用。
              cross_check 的 primary/backup 失败 ≠ 实际取数失败。
        修复: 引入 cached_value_exists 参数。若缓存有值但 cross_check 失败，
              视为"单源可用"（20 分），不再判 0 分。

    PRD §10.7:
    - 主备源 diff ≤ 通过阈值：30 分
    - 主备源 diff ≤ 严重异常阈值：15 分（标注但不阻断）
    - 主备源 diff > 严重异常阈值：0 分
    - 无备源：20 分（降级，单源警告）
    - 备源失败（但主源有值）：20 分
    - 主备源均失败且缓存也无值：0 分
    """
    # 缓存有值 → 数据可用，至少 20 分
    if primary_value is not None and backup_value is not None:
        # 双源都有值，检查差异
        severe_threshold = threshold_max * 2
        diff = diff_pct if threshold_type == "pct" else diff_pp
        if diff is None:
            return 15.0, "无法计算差异"
        if diff <= threshold_max:
            return 30.0, ""
        if diff <= severe_threshold:
            return 15.0, f"主备源差异 {diff}{threshold_type} 超阈值"
        return 0.0, f"主备源差异 {diff}{threshold_type} 严重异常"

    # 单源有值或缓存有值
    if primary_value is not None or cached_value_exists:
        if not has_backup:
            return 20.0, "无备源配置，单源降级"
        # cross_check 备源失败但主源/缓存有值
        return 20.0, "备源不可用，主源单源降级"

    # 主备源均失败且缓存也无值
    return 0.0, "主备源均失败"


def _compute_completeness(
    md: dict, metric_type: str, is_qdii: bool
) -> tuple[float, str]:
    """字段完整性（20 分）—— metric-type-aware。

    V4.1 BUG-2026-06-QUALITY-COMPLETENESS:
        旧实现固定检查 ["pe","pb","premium_today","nav","dividend_yield"] 5 字段，
        但每个 metric_type 在 market_data_cache 里只存自己的字段（valuation 只存 pe/pb，
        nav 只存 nav...），导致每条记录都被误判"缺 2-4 个字段"。
        修复: 按 metric_type 只检查该指标本身的字段。

    PRD §10.8 完整性评级（按 metric_type 自身字段数折算）:
        全有 20 / 缺 1 非关键字段 15 / 缺 1 关键字段 10 / 缺 ≥2 字段 0
    """
    from services.data_clean_engine import clean_numeric

    # 每个 metric_type 的字段定义: (key_fields, optional_fields)
    # key_fields 缺失扣分重，optional_fields 缺失扣分轻
    metric_fields: dict[str, tuple[list[str], list[str]]] = {
        "valuation": (["pe", "pb"], ["pe_percentile", "pb_percentile"]),
        "premium": (["premium_today"], ["premium_7d_avg"]),
        "nav": (["nav"], ["nav_history"]),
        "dividend": (["dividend_yield"], ["dividend_yield_percentile"]),
        "kline": (["kline_history"], []),
        "forex": (["rate"], ["history"]),
    }
    key_fields, opt_fields = metric_fields.get(
        metric_type, (["value"], [])
    )

    missing_key = 0
    missing_opt = 0
    for f in key_fields:
        v = md.get(f)
        # kline_history / nav_history 是 list，需检查非空
        if isinstance(v, list):
            if not v:
                missing_key += 1
        elif clean_numeric(v) is None:
            # QDII 估值缺 PE/PB 视为非关键（海外指数本身就难取 PE/PB）
            if is_qdii and metric_type == "valuation" and f in ("pe", "pb"):
                missing_opt += 1
            else:
                missing_key += 1
    for f in opt_fields:
        v = md.get(f)
        if isinstance(v, list):
            if not v:
                missing_opt += 1
        elif clean_numeric(v) is None:
            missing_opt += 1

    if missing_key == 0 and missing_opt == 0:
        return 20.0, ""
    if missing_key == 0 and missing_opt == 1:
        return 15.0, "缺 1 个非关键字段"
    if missing_key == 1 and missing_opt == 0:
        return 10.0, "缺 1 个关键字段"
    if missing_key == 1 and missing_opt >= 1:
        return 5.0, f"缺 1 关键 + {missing_opt} 非关键字段"
    return 0.0, f"缺 {missing_key} 关键 + {missing_opt} 非关键字段，数据不完整"


def _compute_abnormal(
    pe_raw: Optional[float],
    pb_raw: Optional[float],
    premium_raw: Optional[float],
    dy_raw: Optional[float],
    nav_raw: Optional[float],
) -> tuple[float, str]:
    """异常值检测（15 分）。

    PRD §10.6:
    - 无异常：15 分
    - 有 1 异常：8 分
    - 有 ≥2 异常：0 分
    """
    from services.data_clean_engine import detect_abnormal

    abnormal_count = 0
    reasons = []
    if pe_raw is not None and detect_abnormal("pe", pe_raw):
        abnormal_count += 1
        reasons.append(f"PE={pe_raw}异常")
    if pb_raw is not None and detect_abnormal("pb", pb_raw):
        abnormal_count += 1
        reasons.append(f"PB={pb_raw}异常")
    if premium_raw is not None and detect_abnormal("premium", premium_raw):
        abnormal_count += 1
        reasons.append(f"溢价率{premium_raw}异常")
    if dy_raw is not None and detect_abnormal("dividend_yield", dy_raw):
        abnormal_count += 1
        reasons.append(f"股息率{dy_raw}异常")
    if nav_raw is not None and detect_abnormal("nav", nav_raw):
        abnormal_count += 1
        reasons.append(f"净值{nav_raw}异常")

    if abnormal_count == 0:
        return 15.0, ""
    if abnormal_count == 1:
        return 8.0, "；".join(reasons)
    return 0.0, f"{abnormal_count}个异常：" + "；".join(reasons)


def _compute_source_health(source_health_status: str) -> tuple[float, str]:
    """数据源健康（10 分）。

    PRD:
    - 主源健康：10 分
    - 主源降级（fallback 到备源）：5 分
    - 主源故障：0 分
    """
    if source_health_status == "healthy":
        return 10.0, ""
    if source_health_status == "degraded":
        return 5.0, "主源降级，已切备源"
    if source_health_status == "failed":
        return 0.0, "主源故障"
    return 5.0, f"未知源状态: {source_health_status}"


# ─── 主入口 ───────────────────────────────────────────────────────────────────

def compute_quality_score(
    code: str,
    metric_type: str,
    md: dict,
    cross_check: Optional[dict] = None,
    source_health: str = "healthy",
    is_qdii: bool = False,
) -> QualityScore:
    """计算单条数据的质量评分。

    Args:
        code: ETF 代码或指数代码
        metric_type: valuation / premium / nav / dividend / price
        md: market_data_cache 行数据（含 pe/pb/premium_today/nav/dividend_yield/updated_at 等）
        cross_check: 交叉校验结果 dict（含 primary_value/backup_value/diff_pct/diff_pp/threshold_type/threshold_max/quality_status）
                     None 表示无交叉校验记录
        source_health: healthy / degraded / failed
        is_qdii: 是否 QDII（影响完整性判断）

    Returns:
        QualityScore 对象
    """
    from services.data_clean_engine import clean_numeric
    from services.data_source_manager import CROSS_CHECK_THRESHOLDS, _threshold_key_for

    # 提取关键字段
    pe_raw = clean_numeric(md.get("pe"))
    pb_raw = clean_numeric(md.get("pb"))
    premium_raw = clean_numeric(md.get("premium_today"))
    dy_raw = clean_numeric(md.get("dividend_yield"))
    nav_raw = clean_numeric(md.get("nav"))
    updated_at = md.get("updated_at") or md.get("date") or md.get("fetch_time") or ""

    # 判断缓存是否有有效值（用于 consistency/source_health 兜底）
    # V4.1 BUG-2026-06-QUALITY: cross_check 独立失败 ≠ 实际取数失败，
    # 只要缓存里有值就说明实际取数链路是通的
    cached_value_exists = any(v is not None for v in [pe_raw, pb_raw, premium_raw, dy_raw, nav_raw])
    # kline_history / nav_history 是 list，单独检查
    if not cached_value_exists:
        for list_field in ("kline_history", "nav_history", "dividend_yield_history", "history"):
            v = md.get(list_field)
            if isinstance(v, list) and v:
                cached_value_exists = True
                break

    # 5 个子分
    f_score, f_reason = _compute_freshness(updated_at, metric_type)

    if cross_check:
        c_score, c_reason = _compute_consistency(
            primary_value=cross_check.get("primary_value"),
            backup_value=cross_check.get("backup_value"),
            diff_pct=cross_check.get("diff_pct"),
            diff_pp=cross_check.get("diff_pp"),
            threshold_type=cross_check.get("threshold_type", "pct"),
            threshold_max=cross_check.get("threshold_max", 5.0),
            has_backup=cross_check.get("backup_source") not in (None, "", "none"),
            cached_value_exists=cached_value_exists,
        )
    else:
        # 无交叉校验记录但缓存有值 → 单源 20 分；缓存无值 → 0 分
        if cached_value_exists:
            c_score, c_reason = 20.0, "无交叉校验，单源可用"
        else:
            c_score, c_reason = 0.0, "无交叉校验记录且缓存无值"

    comp_score, comp_reason = _compute_completeness(md, metric_type, is_qdii)
    a_score, a_reason = _compute_abnormal(pe_raw, pb_raw, premium_raw, dy_raw, nav_raw)

    # V4.1 BUG-2026-06-QUALITY-SOURCE: source_health 不再仅依赖 cross_check 的 quality_status，
    # 而是综合判断: 缓存有值 + source 非空 → healthy；缓存有值但 source 含 cache: → degraded；
    # 缓存无值 → failed
    actual_source = md.get("source") or md.get("source_api") or ""
    if not cached_value_exists:
        s_score, s_reason = 0.0, "缓存无数据"
    elif "cache:" in str(actual_source) or actual_source.startswith("stale"):
        s_score, s_reason = 5.0, "使用缓存数据（主源可能降级）"
    else:
        # 优先用传入的 source_health（来自 fallback_summary 的真实降级链路）
        s_score, s_reason = _compute_source_health(source_health)

    # 总分
    total = round(f_score + c_score + comp_score + a_score + s_score, 1)

    # 评级
    if total >= GRADE_EXCELLENT:
        status = "excellent"
        can_rule = True
        can_strong = True
        level_reason = ""
    elif total >= GRADE_USABLE:
        status = "usable"
        can_rule = True
        can_strong = False
        level_reason = "数据质量可用但未达强规则门槛(90)"
    elif total >= GRADE_SUSPICIOUS:
        status = "suspicious"
        can_rule = False
        can_strong = False
        level_reason = "数据质量可疑，仅展示不参与规则"
    else:
        status = "unavailable"
        can_rule = False
        can_strong = False
        level_reason = "数据质量不可用，不参与规则"

    # 合并原因
    reasons = [r for r in [f_reason, c_reason, comp_reason, a_reason, s_reason, level_reason] if r]
    reason_text = "；".join(reasons)

    return QualityScore(
        code=code,
        metric_type=metric_type,
        trade_date=str(md.get("date") or md.get("trade_date") or ""),
        freshness_score=f_score,
        consistency_score=c_score,
        completeness_score=comp_score,
        abnormal_score=a_score,
        source_health_score=s_score,
        quality_score=total,
        quality_status=status,
        can_use_for_rule=can_rule,
        can_use_for_strong_rule=can_strong,
        reason=reason_text,
    )


# ─── 数据库持久化 ─────────────────────────────────────────────────────────────

def _ensure_quality_result_table(conn: sqlite3.Connection) -> None:
    """幂等创建 data_quality_result 表（PRD §13.8）。"""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS data_quality_result (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            trade_date TEXT,
            metric_type TEXT NOT NULL,
            quality_score REAL NOT NULL,
            quality_status TEXT NOT NULL,
            freshness_score REAL,
            consistency_score REAL,
            completeness_score REAL,
            abnormal_score REAL,
            source_health_score REAL,
            can_use_for_rule BOOLEAN,
            can_use_for_strong_rule BOOLEAN,
            reason TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quality_result_code ON data_quality_result(code, metric_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_quality_result_status ON data_quality_result(quality_status, created_at DESC);
        """
    )


def persist_quality_score(score: QualityScore) -> bool:
    """持久化质量评分到 data_quality_result 表。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            _ensure_quality_result_table(conn)
            conn.execute(
                """INSERT INTO data_quality_result
                   (code, trade_date, metric_type, quality_score, quality_status,
                    freshness_score, consistency_score, completeness_score,
                    abnormal_score, source_health_score,
                    can_use_for_rule, can_use_for_strong_rule, reason, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (score.code, score.trade_date, score.metric_type,
                 score.quality_score, score.quality_status,
                 score.freshness_score, score.consistency_score, score.completeness_score,
                 score.abnormal_score, score.source_health_score,
                 1 if score.can_use_for_rule else 0,
                 1 if score.can_use_for_strong_rule else 0,
                 score.reason, score.computed_at),
            )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] Failed to persist score for {score.code}/{score.metric_type}: {e}")
        return False


# ─── 查询接口 ─────────────────────────────────────────────────────────────────

def get_latest_quality(code: str, metric_type: str) -> Optional[dict]:
    """查询某 code/metric_type 的最新质量评分。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_quality_result_table(conn)
            row = conn.execute(
                """SELECT * FROM data_quality_result
                   WHERE code = ? AND metric_type = ?
                   ORDER BY created_at DESC LIMIT 1""",
                (code, metric_type),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] get_latest_quality error: {e}")
        return None


def get_quality_summary() -> dict:
    """全量质量摘要（PRD §12.1: GET /api/data-quality/summary）。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_quality_result_table(conn)
            # 取每个 (code, metric_type) 的最新一条
            rows = conn.execute(
                """SELECT q.* FROM data_quality_result q
                   INNER JOIN (
                       SELECT code, metric_type, MAX(created_at) AS max_ts
                       FROM data_quality_result GROUP BY code, metric_type
                   ) latest ON q.code = latest.code AND q.metric_type = latest.metric_type
                          AND q.created_at = latest.max_ts"""
            ).fetchall()

            total = len(rows)
            excellent = sum(1 for r in rows if r["quality_status"] == "excellent")
            usable = sum(1 for r in rows if r["quality_status"] == "usable")
            suspicious = sum(1 for r in rows if r["quality_status"] == "suspicious")
            unavailable = sum(1 for r in rows if r["quality_status"] == "unavailable")

            scores = [r["quality_score"] for r in rows]
            avg_score = round(sum(scores) / total, 1) if total > 0 else 0

            can_rule_count = sum(1 for r in rows if r["can_use_for_rule"])
            can_strong_count = sum(1 for r in rows if r["can_use_for_strong_rule"])

            # V5.0 Sprint1 E2: 统一数据质量门禁语义统计
            # 从现有字段推导 is_stale / source_conflict / missing_count:
            #   - is_stale: freshness_score < 25 (V4.x 新鲜度评级, 25 分=当日)
            #   - source_conflict: reason 包含主备源冲突关键词且非 passed
            #   - missing_count: quality_status=unavailable 且 reason 含"缺" → 1, 否则 0
            gate_counts = {"valid": 0, "degraded": 0, "stale": 0,
                           "conflict": 0, "missing": 0}
            _conflict_keywords = ("主备源", "源不一致", "source_inconsistent",
                                  "source_conflict", "冲突")
            for r in rows:
                reason = r["reason"] or ""
                freshness = r["freshness_score"] if r["freshness_score"] is not None else 0
                is_stale = float(freshness) < 25.0
                source_conflict = any(kw in reason for kw in _conflict_keywords)
                # unavailable + reason 含 "缺" → 视为 missing
                missing_count = 1 if (
                    r["quality_status"] == "unavailable" and "缺" in reason
                ) else 0
                gate = get_gate_status(
                    quality_score=r["quality_score"] or 0,
                    quality_status=r["quality_status"] or "unavailable",
                    is_stale=is_stale,
                    source_conflict=source_conflict,
                    missing_count=missing_count,
                )
                gate_counts[gate] += 1

            return {
                "total_metrics": total,
                "excellent": excellent,
                "usable": usable,
                "suspicious": suspicious,
                "unavailable": unavailable,
                "avg_score": avg_score,
                "can_use_for_rule_count": can_rule_count,
                "can_use_for_strong_rule_count": can_strong_count,
                # V5.0 Sprint1 E2: 统一数据质量门禁语义统计
                "gate_status_counts": gate_counts,
                "overall_status": (
                    "excellent" if avg_score >= GRADE_EXCELLENT
                    else "usable" if avg_score >= GRADE_USABLE
                    else "suspicious" if avg_score >= GRADE_SUSPICIOUS
                    else "unavailable"
                ),
                "allow_buy_suggestion": can_rule_count > 0,
                "allow_rebalance_suggestion": can_strong_count > 0,
                "items": [dict(r) for r in rows],
            }
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] get_quality_summary error: {e}")
        return {"total_metrics": 0, "excellent": 0, "usable": 0, "suspicious": 0,
                "unavailable": 0, "avg_score": 0, "items": [],
                "gate_status_counts": {"valid": 0, "degraded": 0, "stale": 0,
                                       "conflict": 0, "missing": 0}}


def get_quality_by_code(code: str) -> list[dict]:
    """查询单只 ETF 的所有指标质量评分。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_quality_result_table(conn)
            rows = conn.execute(
                """SELECT * FROM data_quality_result
                   WHERE code = ?
                   ORDER BY created_at DESC""",
                (code,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] get_quality_by_code error: {e}")
        return []


def get_quality_logs(limit: int = 100, status: Optional[str] = None) -> list[dict]:
    """数据质量日志（按时间倒序）。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_quality_result_table(conn)
            if status:
                rows = conn.execute(
                    """SELECT * FROM data_quality_result
                       WHERE quality_status = ?
                       ORDER BY created_at DESC LIMIT ?""",
                    (status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM data_quality_result
                       ORDER BY created_at DESC LIMIT ?""",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] get_quality_logs error: {e}")
        return []


def get_quality_conflicts(limit: int = 50) -> list[dict]:
    """主备源冲突列表。

    精准匹配 reason 中含主备源冲突关键词的记录（由 _compute_consistency 生成），
    避免误命中所有含"源"字的记录。同时限定 quality_status 为可疑/不可用，
    排除已通过校验的记录。
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_quality_result_table(conn)
            rows = conn.execute(
                """SELECT * FROM data_quality_result
                   WHERE quality_status IN ('suspicious', 'unavailable')
                     AND (
                       reason LIKE '%主备源%'
                       OR reason LIKE '%源不一致%'
                       OR reason LIKE '%source_inconsistent%'
                       OR reason LIKE '%source_conflict%'
                       OR reason LIKE '%冲突%'
                     )
                   ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[QUALITY] get_quality_conflicts error: {e}")
        return []
