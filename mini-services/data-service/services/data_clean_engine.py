"""Data Cleaning Engine — PRD v4.1 §10.6 数据清洗引擎.

独立模块，统一处理所有外部数据入库前的清洗逻辑：
1. clean_numeric(value) — None/NaN/Inf/sentinel(999999) 拦截
2. clean_series(points, value_key) — 历史序列过滤
3. detect_abnormal(metric_type, value) — 异常值检测（PE/PB/溢价/股息率/净值/价格）
4. abnormal_reason(metric_type, value) — 异常原因描述

设计原则（PRD §10.6 / §15.1）：
- raw_value 保留原始值（用于追溯）
- clean_value 置空异常值（用于规则引擎）
- is_valid=false 标记异常
- abnormal_reason 写明原因
- 不允许异常值进入规则引擎

本模块是清洗逻辑的"唯一来源"，akshare_service 和 rule_engine 都应 import 使用，
避免逻辑散落两处导致漂移。
"""
from __future__ import annotations

import math
from typing import Optional

# ─── 异常值检测阈值（PRD §10.6）─────────────────────────────────────────────────
# 格式：(metric_type, min_valid, max_valid, abs_flag)
# abs_flag=True 表示用 abs(value) 比较（如溢价率可正可负）
ABNORMAL_THRESHOLDS: dict[str, dict] = {
    "pe": {"min": 0, "max": 500, "abs": False, "label": "PE"},
    "pb": {"min": 0, "max": 100, "abs": False, "label": "PB"},
    "premium": {"min": -30, "max": 30, "abs": False, "label": "溢价率"},  # 百分点
    "dividend_yield": {"min": 0, "max": 20, "abs": False, "label": "股息率"},  # 百分点
    "nav": {"min": 0, "max": None, "abs": False, "label": "净值"},  # 只检查下界
    "price": {"min": 0, "max": None, "abs": False, "label": "价格"},
    "market_value": {"min": 0, "max": None, "abs": False, "label": "市值"},
    "shares": {"min": 0, "max": None, "abs": False, "label": "份额"},
}

# sentinel 占位值（PRD §15.1: 99999999、-99999999 等异常占位）
SENTINEL_ABS = 999999


def clean_numeric(value) -> Optional[float]:
    """数值清洗：None/NaN/Inf/sentinel → None，否则返回 float。

    PRD §10.6:
        if value is None: return None
        x = float(value)
        if math.isnan(x) or math.isinf(x): return None
        if abs(x) >= 999999: return None
        return x
    """
    if value is None:
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    if abs(x) >= SENTINEL_ABS:
        return None
    return x


def clean_series(points: list[dict], value_key: str = "value") -> list[dict]:
    """历史序列清洗：过滤掉 safe_num 为 None 的点。

    用于 pe_history / pb_history / premium_30d / nav_history /
    dividend_yield_history / price_history 列表，确保图表不会出现 99999999 异常大数。

    PRD §15.2: 前端图表渲染前二次过滤（本函数是后端第一次过滤）。
    """
    result: list[dict] = []
    for p in points or []:
        if not isinstance(p, dict):
            continue
        v = p.get(value_key)
        cleaned = clean_numeric(v)
        if cleaned is None:
            continue
        new_point = dict(p)
        new_point[value_key] = cleaned
        result.append(new_point)
    return result


def detect_abnormal(metric_type: str, value) -> bool:
    """检测某指标值是否异常（PRD §10.6 异常值规则）。

    Args:
        metric_type: pe / pb / premium / dividend_yield / nav / price / market_value / shares
        value: 原始值（可以是 None / str / int / float）

    Returns:
        True 表示异常，False 表示正常或无法判断（value 为 None 时返回 False）
    """
    if value is None:
        return False
    x = clean_numeric(value)
    if x is None:
        # 本身就是 sentinel/NaN/Inf → 异常
        return True

    cfg = ABNORMAL_THRESHOLDS.get(metric_type)
    if not cfg:
        return False

    cmp_val = abs(x) if cfg["abs"] else x
    if cmp_val < cfg["min"]:
        return True
    if cfg["max"] is not None and cmp_val > cfg["max"]:
        return True
    return False


def abnormal_reason(metric_type: str, value) -> str:
    """生成异常原因描述（用于 abnormal_reason 字段）。"""
    if value is None:
        return ""
    x = clean_numeric(value)
    cfg = ABNORMAL_THRESHOLDS.get(metric_type, {})
    label = cfg.get("label", metric_type)
    if x is None:
        return f"{label}={value}为sentinel/NaN/Inf异常值"
    cmp_val = abs(x) if cfg.get("abs") else x
    if cmp_val < cfg.get("min", float("-inf")):
        return f"{label}={x}低于下界{cfg.get('min')}"
    if cfg.get("max") is not None and cmp_val > cfg["max"]:
        return f"{label}={x}超上界{cfg['max']}"
    return ""


def is_valid_value(metric_type: str, value) -> bool:
    """值是否有效（非 None + 非 sentinel + 非异常）。"""
    if value is None:
        return False
    return not detect_abnormal(metric_type, value)


# ─── 兼容层：旧 API 名称（akshare_service 和 rule_engine 历史调用）──────────────
# 这些别名保持向后兼容，避免一次性改太多调用点
safe_num = clean_numeric
clean_numeric_series = clean_series
