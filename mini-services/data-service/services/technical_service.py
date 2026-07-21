"""V5.0 E6: 技术执行分类器。

MACD(12/26/9) + 20周均线 + 40周均线 → 原子状态 → 互斥分类 → 执行模式。

PRD §7.6要求:
- 获取复权日K和周K
- 计算 MACD 12/26/9、20周和40周均线
- 保存周线原子状态、日线原子状态和最终互斥分类
- 输出: strong/conflict/very_weak/improving/weak/neutral/unavailable
- 映射唯一系数和执行模式: immediate/staged/wait_pullback/base_only
- 技术数据缺失时回退中性(系数1.00), 不阻断基础规则
- QDII使用底层指数信号, 不用境内溢价价格替代
"""
import logging
import sqlite3
import json
from typing import Optional
from datetime import datetime
from config import DB_PATH

logger = logging.getLogger(__name__)

# 技术状态分类
TECHNICAL_STATES = [
    "strong",        # 周线+日线双确认, 强势
    "conflict",      # 周线确认但日线走弱, 或反之
    "very_weak",     # 周线+日线双走弱
    "improving",     # 从弱势开始改善
    "weak",          # 周线走弱但未恶化
    "neutral",       # 无明确信号
    "unavailable",   # 数据不足
]

# 执行模式映射
EXECUTION_MODES = {
    "strong": {"coefficient": 1.5, "mode": "immediate"},        # 强势, 可一次执行
    "conflict": {"coefficient": 0.8, "mode": "staged"},         # 冲突, 分批执行
    "very_weak": {"coefficient": 0.0, "mode": "wait_pullback"}, # 极弱, 等待回调
    "improving": {"coefficient": 1.2, "mode": "staged"},        # 改善中, 分批
    "weak": {"coefficient": 0.5, "mode": "base_only"},          # 弱势, 仅基础仓
    "neutral": {"coefficient": 1.0, "mode": "immediate"},       # 中性, 正常执行
    "unavailable": {"coefficient": 1.0, "mode": "immediate"},   # 数据不足, 回退中性
}


def calculate_macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    """计算MACD。
    返回 {macd_line: [...], signal_line: [...], histogram: [...]}
    """
    if len(closes) < slow + signal:
        return {"macd_line": [], "signal_line": [], "histogram": []}

    # EMA计算
    def ema(data, period):
        multiplier = 2 / (period + 1)
        ema_values = [data[0]]
        for i in range(1, len(data)):
            ema_values.append(data[i] * multiplier + ema_values[-1] * (1 - multiplier))
        return ema_values

    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    macd_line = [f - s for f, s in zip(ema_fast, ema_slow)]
    signal_line = ema(macd_line, signal)
    histogram = [m - s for m, s in zip(macd_line, signal_line)]

    return {"macd_line": macd_line, "signal_line": signal_line, "histogram": histogram}


def calculate_ma(closes: list[float], period: int) -> list[float]:
    """计算移动均线。"""
    if len(closes) < period:
        return []
    ma = []
    for i in range(period - 1, len(closes)):
        ma.append(sum(closes[i - period + 1:i + 1]) / period)
    return ma


def classify_weekly_state(closes: list[float]) -> str:
    """周线原子状态: above_ma20_above_ma40 / above_ma20_below_ma40 / below_ma20_above_ma40 / below_ma20_below_ma40"""
    ma20 = calculate_ma(closes, 20)
    ma40 = calculate_ma(closes, 40)
    if not ma20 or not ma40:
        return "insufficient_data"

    last_close = closes[-1]
    last_ma20 = ma20[-1]
    last_ma40 = ma40[-1]

    if last_close > last_ma20 and last_close > last_ma40:
        return "above_ma20_above_ma40"  # 周线确认
    elif last_close > last_ma20 and last_close <= last_ma40:
        return "above_ma20_below_ma40"  # 周线待确认
    elif last_close <= last_ma20 and last_close > last_ma40:
        return "below_ma20_above_ma40"  # 周线走弱
    else:
        return "below_ma20_below_ma40"  # 周线弱势


def classify_daily_state(closes: list[float]) -> str:
    """日线原子状态: macd_golden_cross / macd_death_cross / macd_above_zero / macd_below_zero / insufficient"""
    macd = calculate_macd(closes)
    if not macd["macd_line"] or len(macd["macd_line"]) < 2:
        return "insufficient"

    last_macd = macd["macd_line"][-1]
    last_signal = macd["signal_line"][-1]
    prev_macd = macd["macd_line"][-2]
    prev_signal = macd["signal_line"][-2]

    # 金叉: MACD从下方穿越信号线
    if prev_macd <= prev_signal and last_macd > last_signal:
        return "macd_golden_cross"
    # 死叉: MACD从上方穿越信号线
    if prev_macd >= prev_signal and last_macd < last_signal:
        return "macd_death_cross"
    # MACD在零轴上方
    if last_macd > 0:
        return "macd_above_zero"
    # MACD在零轴下方
    return "macd_below_zero"


def classify_technical(weekly_closes: list[float], daily_closes: list[float]) -> dict:
    """V5.0 E6: 最终互斥技术分类。

    组合周线+日线原子状态, 输出互斥分类:
    - strong: 周线确认 + 日线金叉/在零轴上方
    - conflict: 周线确认但日线死叉, 或周线弱势但日线金叉
    - very_weak: 周线弱势 + 日线死叉/在零轴下方
    - improving: 周线弱势但日线金叉(从弱势改善)
    - weak: 周线走弱(below_ma20) + 日线无金叉
    - neutral: 其他组合
    - unavailable: 数据不足

    返回 {
        state: str,
        coefficient: float,
        execution_mode: str,
        weekly_state: str,
        daily_state: str,
        macd: dict,
        ma20: float | None,
        ma40: float | None,
    }
    """
    weekly_state = classify_weekly_state(weekly_closes)
    daily_state = classify_daily_state(daily_closes)

    # 数据不足
    if weekly_state == "insufficient_data" or daily_state == "insufficient":
        state = "unavailable"
    # 周线确认 + 日线确认
    elif weekly_state == "above_ma20_above_ma40" and daily_state in ("macd_golden_cross", "macd_above_zero"):
        state = "strong"
    # 周线确认但日线走弱
    elif weekly_state == "above_ma20_above_ma40" and daily_state in ("macd_death_cross", "macd_below_zero"):
        state = "conflict"
    # 周线弱势但日线金叉(改善中)
    elif weekly_state in ("below_ma20_below_ma40", "below_ma20_above_ma40") and daily_state == "macd_golden_cross":
        state = "improving"
    # 周线弱势 + 日线走弱
    elif weekly_state == "below_ma20_below_ma40" and daily_state in ("macd_death_cross", "macd_below_zero"):
        state = "very_weak"
    # 周线走弱 + 日线无金叉
    elif weekly_state in ("below_ma20_above_ma40", "below_ma20_below_ma40"):
        state = "weak"
    # 其他
    else:
        state = "neutral"

    mode_info = EXECUTION_MODES.get(state, EXECUTION_MODES["neutral"])

    # 计算MACD和MA用于展示
    daily_macd = calculate_macd(daily_closes)
    weekly_ma20 = calculate_ma(weekly_closes, 20)
    weekly_ma40 = calculate_ma(weekly_closes, 40)

    return {
        "state": state,
        "coefficient": mode_info["coefficient"],
        "execution_mode": mode_info["mode"],
        "weekly_state": weekly_state,
        "daily_state": daily_state,
        "macd_histogram_tail": daily_macd["histogram"][-5:] if daily_macd["histogram"] else [],
        "macd_line_tail": daily_macd["macd_line"][-5:] if daily_macd["macd_line"] else [],
        "signal_line_tail": daily_macd["signal_line"][-5:] if daily_macd["signal_line"] else [],
        "ma20": weekly_ma20[-1] if weekly_ma20 else None,
        "ma40": weekly_ma40[-1] if weekly_ma40 else None,
    }


def get_technical_for_etf(code: str) -> dict:
    """从K线缓存获取ETF的技术分类。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT data_json FROM market_data_cache WHERE code=? AND data_type='kline'",
            (code,)
        ).fetchone()
        if not row:
            return {"state": "unavailable", "coefficient": 1.0, "execution_mode": "immediate", "reason": "无K线数据"}

        data = json.loads(row["data_json"])
        history = data.get("kline_history") or data.get("history") or []
        if len(history) < 60:
            return {
                "state": "unavailable", "coefficient": 1.0, "execution_mode": "immediate",
                "reason": f"K线数据不足({len(history)}天)",
            }

        closes = [h.get("close", 0) for h in history if h.get("close")]
        if len(closes) < 60:
            return {
                "state": "unavailable", "coefficient": 1.0, "execution_mode": "immediate",
                "reason": "收盘价不足",
            }

        # 日线用全部收盘价
        daily_closes = closes

        # 周线: 每5个交易日聚合为一周的收盘价(取每周末的收盘价)
        weekly_closes = [closes[i] for i in range(len(closes) - 1, -1, -5)]
        weekly_closes = list(reversed(weekly_closes))

        if len(weekly_closes) < 40:
            # 周线数据不足, 仅用日线
            result = classify_technical(closes[-60:], daily_closes[-60:])
            result["reason"] = f"周线数据不足({len(weekly_closes)}周), 仅用日线"
            result["etf_code"] = code
            return result

        result = classify_technical(weekly_closes, daily_closes)
        result["etf_code"] = code
        return result
    except Exception as e:
        logger.error(f"[TECH] {code} error: {e}")
        return {
            "state": "unavailable", "coefficient": 1.0, "execution_mode": "immediate",
            "reason": str(e)[:50],
        }
    finally:
        conn.close()
