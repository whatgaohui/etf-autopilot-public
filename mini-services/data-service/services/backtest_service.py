"""V5.0 Backtest Service — 回测验证模块.

对3种策略进行历史回测对比:
  1. 本系统策略 (PE分位简化版): PE分位<50%双倍买 / 50-80%正常 / 80-95%半价 / >95%不买
  2. 等额定投 (DCA): 每周固定买 weekly_budget
  3. 买入持有 (Buy&Hold): 初始全仓买入, 持有不动

数据来源:
  - market_data_cache 表 (data_type='kline') — 每只ETF 400+天 K线历史
  - market_data_cache 表 (data_type='valuation') — pe_history 用于推导历史PE分位

简化点:
  - 估值分位优先用 pe_history 推算 (rolling 250-day percentile);
    pe_history 不可用时 fallback 到 K线收盘价 rolling percentile.
  - 不考虑交易成本/分红/税费, 假设每周收盘价可成交.
  - 现金部分按0收益处理 (保守估计).

输出指标 (每种策略):
  - equity_curve: 每周总资产价值序列 [(date, value), ...]
  - final_value: 期末总资产
  - total_invested: 累计投入本金
  - total_return_pct: 累计收益率 %
  - annualized_return_pct: 年化收益率 %
  - max_drawdown_pct: 最大回撤 %
  - sharpe_ratio: 夏普比率 (无风险利率=2%)
"""
import json
import logging
import math
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

from config import DB_PATH, TRACKED_ETFS, DEFAULT_TARGET_RATIOS, DEFAULT_WEEKLY_BUDGET

logger = logging.getLogger(__name__)

# 无风险利率 (一年期国债收益率近似值)
RISK_FREE_RATE_ANNUAL = 0.02
# 一年大约的交易周数
WEEKS_PER_YEAR = 52
# rolling percentile 窗口 (约1年交易日)
PERCENTILE_WINDOW = 250


# ─── 数据加载 ────────────────────────────────────────────────────────────────

def _load_kline_history(code: str) -> list[dict]:
    """从 market_data_cache 加载指定 ETF 的 K线历史 (按日期升序).

    返回: [{date, open, high, low, close, volume}, ...]
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT data_json FROM market_data_cache "
            "WHERE code = ? AND data_type = 'kline' ORDER BY date DESC LIMIT 1",
            (code,),
        ).fetchone()
        if not row:
            return []
        data = json.loads(row["data_json"])
        hist = data.get("kline_history") or []
        # 按日期升序
        hist = sorted(hist, key=lambda x: x.get("date", ""))
        return hist
    finally:
        conn.close()


def _load_pe_history(etf_code: str) -> list[dict]:
    """加载 ETF 对应指数的 PE 历史序列 (按日期升序).

    valuation 数据存储在 INDEX code 下 (例: 159338 -> 000510).
    返回: [{date, value}, ...]  空列表表示无数据.
    """
    etf_info = TRACKED_ETFS.get(etf_code, {})
    index_code = etf_info.get("index_code") or etf_code
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT data_json FROM market_data_cache "
            "WHERE code = ? AND data_type = 'valuation' ORDER BY date DESC LIMIT 1",
            (index_code,),
        ).fetchone()
        if not row:
            return []
        data = json.loads(row["data_json"])
        pe_hist = data.get("pe_history") or []
        pe_hist = sorted(pe_hist, key=lambda x: x.get("date", ""))
        return pe_hist
    finally:
        conn.close()


def _load_all_klines() -> dict[str, list[dict]]:
    """加载全部6只ETF的K线历史. 返回 {code: [kline_points]}."""
    out = {}
    for code in TRACKED_ETFS:
        out[code] = _load_kline_history(code)
    return out


def _load_all_pe_histories() -> dict[str, list[dict]]:
    """加载全部6只ETF的PE历史. 返回 {etf_code: [pe_points]}."""
    out = {}
    for code in TRACKED_ETFS:
        out[code] = _load_pe_history(code)
    return out


# ─── 工具函数 ────────────────────────────────────────────────────────────────

def _parse_date(d: str) -> Optional[datetime]:
    """解析 'YYYY-MM-DD' 字符串."""
    if not d:
        return None
    try:
        return datetime.strptime(d[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def _rolling_percentile(value: float, history_values: list[float]) -> float:
    """计算 value 在 history_values 中的百分位 (0-100).

    percentile = count(history <= value) / len(history) * 100
    """
    if not history_values:
        return 50.0  # 无历史时假设中位
    le_count = sum(1 for v in history_values if v is not None and v <= value)
    return round(le_count / len(history_values) * 100.0, 2)


def _get_kline_close_at_or_before(kline: list[dict], target_date: str) -> Optional[float]:
    """返回 <= target_date 的最近一条 K线的收盘价."""
    # kline 已按日期升序
    result = None
    for pt in kline:
        d = pt.get("date", "")
        if d <= target_date:
            close = pt.get("close")
            if close is not None:
                result = float(close)
        else:
            break
    return result


def _get_pe_at_or_before(pe_hist: list[dict], target_date: str) -> Optional[float]:
    """返回 <= target_date 的最近一条 PE 值."""
    result = None
    for pt in pe_hist:
        d = pt.get("date", "")
        if d <= target_date:
            v = pt.get("value")
            if v is not None:
                result = float(v)
        else:
            break
    return result


def _calc_metrics(equity_curve: list[float], contributions: Optional[list[float]] = None) -> dict:
    """计算收益指标: 年化收益/最大回撤/夏普比率.

    equity_curve: 每周的总资产价值序列 (升序)
    contributions: 每周新增外部投入本金 (与 equity_curve 等长, 第0项=initial_capital).
                   若提供, 收益率按 TWR (Time-Weighted Return) 计算, 消除定投现金流的失真.
                   若为 None, 退化为传统 (final/initial - 1) 计算.

    TWR 算法:
      weekly_return[i] = (equity[i] - contribution[i]) / equity[i-1] - 1
      total_return = product(1 + weekly_return[i]) - 1
      annualized_return = (1 + total_return)^(52/weeks) - 1
      最大回撤/夏普基于 TWR 累计净值曲线
    """
    if not equity_curve or len(equity_curve) < 2:
        return {
            "finalValue": equity_curve[-1] if equity_curve else 0.0,
            "totalReturnPct": 0.0,
            "annualizedReturnPct": 0.0,
            "maxDrawdownPct": 0.0,
            "sharpeRatio": 0.0,
            "weeks": len(equity_curve),
        }

    initial = equity_curve[0]
    final = equity_curve[-1]
    weeks = len(equity_curve) - 1  # 周期数

    # ─── 周收益率序列 ───
    weekly_returns = []
    if contributions and len(contributions) == len(equity_curve):
        # TWR: 扣除本期新增投入后的真实收益
        for i in range(1, len(equity_curve)):
            prev = equity_curve[i - 1]
            contrib = contributions[i] or 0
            if prev > 0:
                # 本周净增长 = 期末值 - 期初值 - 本期新投入
                net_gain = equity_curve[i] - prev - contrib
                weekly_returns.append(net_gain / prev)
    else:
        for i in range(1, len(equity_curve)):
            prev = equity_curve[i - 1]
            if prev > 0:
                weekly_returns.append(equity_curve[i] / prev - 1.0)

    # ─── 累计收益率 (TWR-based) ───
    if weekly_returns:
        twr_factor = 1.0
        for r in weekly_returns:
            twr_factor *= (1.0 + r)
        total_return = twr_factor - 1.0
    else:
        total_return = (final / initial - 1.0) if initial > 0 else 0.0

    # ─── 年化收益率 ───
    if weeks > 0 and (1.0 + total_return) > 0:
        ann_return = (1.0 + total_return) ** (WEEKS_PER_YEAR / weeks) - 1.0
    else:
        ann_return = 0.0

    # ─── 累计 TWR 净值曲线 (起点=1.0) ───
    nav_curve = [1.0]
    for r in weekly_returns:
        nav_curve.append(nav_curve[-1] * (1.0 + r))

    # ─── 最大回撤 (基于 NAV) ───
    peak = nav_curve[0]
    max_dd = 0.0
    for v in nav_curve:
        if v > peak:
            peak = v
        if peak > 0:
            dd = (peak - v) / peak
            if dd > max_dd:
                max_dd = dd

    # ─── 夏普比率 ───
    sharpe = 0.0
    if weekly_returns:
        mean_w = sum(weekly_returns) / len(weekly_returns)
        var_w = sum((r - mean_w) ** 2 for r in weekly_returns) / max(len(weekly_returns) - 1, 1)
        std_w = math.sqrt(var_w) if var_w > 0 else 0.0
        if std_w > 0:
            # 年化夏普 = (年化收益 - 无风险年化) / 年化波动率
            ann_vol = std_w * math.sqrt(WEEKS_PER_YEAR)
            sharpe = (ann_return - RISK_FREE_RATE_ANNUAL) / ann_vol

    return {
        "finalValue": round(final, 2),
        "totalReturnPct": round(total_return * 100, 2),
        "annualizedReturnPct": round(ann_return * 100, 2),
        "maxDrawdownPct": round(max_dd * 100, 2),
        "sharpeRatio": round(sharpe, 3),
        "weeks": weeks,
    }


# ─── 策略实现 ────────────────────────────────────────────────────────────────

def _strategy_multiplier(percentile: float) -> tuple[float, str]:
    """本系统策略简化版 — 根据估值分位返回倍率与说明.

    - PE分位 < 50%: 双倍买 (2.0)
    - 50% <= PE分位 < 80%: 正常买 (1.0)
    - 80% <= PE分位 < 95%: 半价买 (0.5)
    - PE分位 >= 95%: 不买 (0.0)
    """
    if percentile < 50:
        return 2.0, f"低估({percentile:.0f}%<50%)×2.0"
    if percentile < 80:
        return 1.0, f"正常({percentile:.0f}%∈50-80%)×1.0"
    if percentile < 95:
        return 0.5, f"偏高({percentile:.0f}%∈80-95%)×0.5"
    return 0.0, f"极高估({percentile:.0f}%≥95%)×0.0"


def _run_strategy_backtest(
    klines: dict[str, list[dict]],
    pe_hists: dict[str, list[dict]],
    weekly_dates: list[str],
    initial_capital: float,
    weekly_budget: float,
    target_ratios: dict[str, float],
) -> dict:
    """本系统策略 (PE分位简化版).

    每周:
      0. 注入 weekly_budget 新资金到现金账户 (外部定投流入)
      1. 计算各ETF的PE分位 (rolling 250-day, fallback用价格分位)
      2. 由分位确定 multiplier
      3. 各ETF本周分配 = weekly_budget * target_ratio * multiplier
         (超过 weekly_budget 时按比例缩放; 剩余资金留作现金)
      4. 用当周收盘价成交, 更新持仓份额
      5. 总资产 = sum(持仓份额 × 当周收盘价) + 现金
    """
    # 持仓: {code: shares}
    holdings = {code: 0.0 for code in target_ratios}
    cash = initial_capital  # 初始现金底盘 (策略定投初始为0本金, 但允许initial_capital作为起始现金以与buy&hold可比)
    invested = initial_capital  # 累计外部投入本金 (含 initial_capital)
    equity_curve = []
    contributions = []  # 每周新增外部投入 (第0周=initial_capital, 后续=weekly_budget)
    actions_log = []  # 每周动作日志 (前若干周+后若干周, 防止过大)

    for i, wdate in enumerate(weekly_dates):
        # 0. 注入本周新定投资金 (DCA/Strategy 共有语义: 每周外部流入)
        if i > 0:
            cash += weekly_budget
            invested += weekly_budget
            contributions.append(weekly_budget)
        else:
            contributions.append(initial_capital)

        # 1. 计算各ETF分位
        percents = {}
        for code in target_ratios:
            pe = _get_pe_at_or_before(pe_hists.get(code, []), wdate)
            if pe is not None:
                # 用 wdate 之前的 PE 序列计算分位 (rolling window)
                pe_window = [
                    float(p["value"])
                    for p in pe_hists.get(code, [])
                    if p.get("date", "") <= wdate and p.get("value") is not None
                ]
                # 取最近 PERCENTILE_WINDOW 个
                pe_window = pe_window[-PERCENTILE_WINDOW:]
                percents[code] = _rolling_percentile(pe, pe_window)
            else:
                # fallback: 用价格分位
                kline = klines.get(code, [])
                close = _get_kline_close_at_or_before(kline, wdate)
                if close is None:
                    percents[code] = 50.0
                else:
                    price_window = [
                        float(p["close"])
                        for p in kline
                        if p.get("date", "") <= wdate and p.get("close") is not None
                    ]
                    price_window = price_window[-PERCENTILE_WINDOW:]
                    percents[code] = _rolling_percentile(close, price_window)

        # 2. 计算本周分配
        raw_allocs = {}
        mults = {}
        for code in target_ratios:
            mult, _note = _strategy_multiplier(percents[code])
            mults[code] = mult
            raw_allocs[code] = weekly_budget * target_ratios[code] * mult
        total_raw = sum(raw_allocs.values())

        # 3. 缩放到 weekly_budget (如果超额) ; 否则剩余留现金
        if total_raw > weekly_budget and total_raw > 0:
            scale = weekly_budget / total_raw
            for code in raw_allocs:
                raw_allocs[code] *= scale
            total_raw = weekly_budget

        # 4. 用当周收盘价成交 (第0周不买入, 仅作基线)
        if i > 0:
            for code in target_ratios:
                amount = raw_allocs[code]
                if amount <= 0:
                    continue
                close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
                if not close or close <= 0:
                    continue
                if cash < amount:
                    amount = max(cash, 0)
                if amount <= 0:
                    continue
                shares_bought = amount / close
                holdings[code] += shares_bought
                cash -= amount

        # 5. 计算总资产
        market_value = 0.0
        for code in target_ratios:
            close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
            if close:
                market_value += holdings[code] * close
        total_equity = market_value + cash
        equity_curve.append(total_equity)

        # 日志 (仅记录前5周 + 后5周, 避免过大)
        if i < 5 or i >= len(weekly_dates) - 5:
            actions_log.append({
                "date": wdate,
                "week": i,
                "cash": round(cash, 2),
                "marketValue": round(market_value, 2),
                "totalEquity": round(total_equity, 2),
                "allocations": {
                    code: {
                        "percentile": percents[code],
                        "multiplier": mults[code],
                        "amount": round(raw_allocs[code], 2),
                    }
                    for code in target_ratios
                },
            })

    metrics = _calc_metrics(equity_curve, contributions)
    metrics["totalInvested"] = round(invested, 2)
    metrics["equityCurve"] = [
        {"date": d, "value": round(v, 2)}
        for d, v in zip(weekly_dates, equity_curve)
    ]
    metrics["actionsLog"] = actions_log
    return metrics


def _run_dca_backtest(
    klines: dict[str, list[dict]],
    weekly_dates: list[str],
    initial_capital: float,
    weekly_budget: float,
    target_ratios: dict[str, float],
) -> dict:
    """等额定投 (DCA) — 每周固定按 target_ratio 比例买入.

    每周外部注入 weekly_budget 现金, 然后按 target_ratio 比例分配到各 ETF.
    """
    holdings = {code: 0.0 for code in target_ratios}
    cash = initial_capital
    invested = initial_capital
    equity_curve = []
    contributions = []

    for i, wdate in enumerate(weekly_dates):
        # 0. 注入本周新定投资金
        if i > 0:
            cash += weekly_budget
            invested += weekly_budget
            contributions.append(weekly_budget)
            # 1. 按 target_ratio 分配并买入
            for code in target_ratios:
                amount = weekly_budget * target_ratios[code]
                close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
                if not close or close <= 0:
                    continue
                if cash < amount:
                    amount = max(cash, 0)
                if amount <= 0:
                    continue
                holdings[code] += amount / close
                cash -= amount
        else:
            contributions.append(initial_capital)

        market_value = 0.0
        for code in target_ratios:
            close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
            if close:
                market_value += holdings[code] * close
        total_equity = market_value + cash
        equity_curve.append(total_equity)

    metrics = _calc_metrics(equity_curve, contributions)
    metrics["totalInvested"] = round(invested, 2)
    metrics["equityCurve"] = [
        {"date": d, "value": round(v, 2)}
        for d, v in zip(weekly_dates, equity_curve)
    ]
    return metrics


def _run_buyhold_backtest(
    klines: dict[str, list[dict]],
    weekly_dates: list[str],
    initial_capital: float,
    target_ratios: dict[str, float],
) -> dict:
    """买入持有 — 初始全仓按 target_ratio 买入, 持有不动."""
    holdings = {code: 0.0 for code in target_ratios}
    cash = initial_capital
    equity_curve = []

    for i, wdate in enumerate(weekly_dates):
        if i == 0:
            # 第0周全仓买入
            for code in target_ratios:
                amount = initial_capital * target_ratios[code]
                close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
                if not close or close <= 0:
                    continue
                if cash < amount:
                    amount = max(cash, 0)
                if amount <= 0:
                    continue
                holdings[code] += amount / close
                cash -= amount

        market_value = 0.0
        for code in target_ratios:
            close = _get_kline_close_at_or_before(klines.get(code, []), wdate)
            if close:
                market_value += holdings[code] * close
        total_equity = market_value + cash
        equity_curve.append(total_equity)

    metrics = _calc_metrics(equity_curve)
    metrics["totalInvested"] = round(initial_capital, 2)
    metrics["equityCurve"] = [
        {"date": d, "value": round(v, 2)}
        for d, v in zip(weekly_dates, equity_curve)
    ]
    return metrics


# ─── 主入口 ──────────────────────────────────────────────────────────────────

async def run_backtest(
    start_date: str,
    initial_capital: float,
    weekly_budget: float,
) -> dict:
    """执行回测.

    Args:
        start_date: 起始日期 'YYYY-MM-DD'
        initial_capital: 初始资金 (用于买入持有的全仓 + 策略/DCA的现金底盘)
        weekly_budget: 每周定投金额

    Returns:
        {
            "strategy_result": {...},   # 本系统策略
            "dca_result": {...},        # 等额定投
            "buyhold_result": {...},    # 买入持有
            "comparison": {...},        # 对比表
            "meta": {...}               # 元数据
        }
    """
    # 1. 加载K线 & PE历史
    klines = _load_all_klines()
    pe_hists = _load_all_pe_histories()

    # 2. 确定可用日期范围 (取所有ETF K线的交集日期)
    all_dates_set = None
    for code, hist in klines.items():
        if not hist:
            continue
        dates = {pt["date"] for pt in hist if pt.get("date") and pt.get("close")}
        if all_dates_set is None:
            all_dates_set = dates
        else:
            all_dates_set &= dates

    if not all_dates_set:
        return {
            "error": "K线数据不足, 无法执行回测. 请先调用 /api/refresh 拉取K线历史.",
            "strategy_result": None,
            "dca_result": None,
            "buyhold_result": None,
            "comparison": None,
        }

    all_dates = sorted(all_dates_set)

    # 3. 过滤 >= start_date 的日期
    start_dt = _parse_date(start_date)
    if start_dt is None:
        return {"error": f"start_date 格式错误, 应为 'YYYY-MM-DD', 收到: {start_date}"}

    filtered_dates = [d for d in all_dates if d >= start_date]
    if len(filtered_dates) < 10:
        return {
            "error": f"起始日期 {start_date} 之后仅有 {len(filtered_dates)} 个交易日, 不足以执行回测. "
                     f"建议选更早的起始日期 (K线最早日期: {all_dates[0]}).",
        }

    # 4. 按周采样 (每周取最后一个交易日)
    weekly_dates = []
    current_week = None
    for d in filtered_dates:
        dt = _parse_date(d)
        if dt is None:
            continue
        # ISO week
        iso_year, iso_week, _ = dt.isocalendar()
        week_key = (iso_year, iso_week)
        if week_key != current_week:
            current_week = week_key
            weekly_dates.append(d)
        else:
            weekly_dates[-1] = d  # 取该周最后一个交易日

    if len(weekly_dates) < 5:
        return {
            "error": f"起始日期后仅有 {len(weekly_dates)} 周, 不足以执行回测. 至少需要5周.",
        }

    # 5. 目标比例
    target_ratios = dict(DEFAULT_TARGET_RATIOS)

    logger.info(
        f"[BACKTEST] start_date={start_date}, weeks={len(weekly_dates)}, "
        f"initial_capital={initial_capital}, weekly_budget={weekly_budget}"
    )

    # 6. 执行3种策略
    try:
        strategy_result = _run_strategy_backtest(
            klines, pe_hists, weekly_dates, initial_capital, weekly_budget, target_ratios
        )
    except Exception as e:
        logger.exception("[BACKTEST] strategy backtest failed")
        strategy_result = {"error": str(e)}

    try:
        dca_result = _run_dca_backtest(
            klines, weekly_dates, initial_capital, weekly_budget, target_ratios
        )
    except Exception as e:
        logger.exception("[BACKTEST] dca backtest failed")
        dca_result = {"error": str(e)}

    try:
        buyhold_result = _run_buyhold_backtest(
            klines, weekly_dates, initial_capital, target_ratios
        )
    except Exception as e:
        logger.exception("[BACKTEST] buy&hold backtest failed")
        buyhold_result = {"error": str(e)}

    # 7. 对比表
    comparison = _build_comparison(strategy_result, dca_result, buyhold_result)

    # 8. 元数据
    meta = {
        "startDate": weekly_dates[0] if weekly_dates else "",
        "endDate": weekly_dates[-1] if weekly_dates else "",
        "weeks": len(weekly_dates),
        "etfCount": len(target_ratios),
        "etfCodes": list(target_ratios.keys()),
        "initialCapital": initial_capital,
        "weeklyBudget": weekly_budget,
        "riskFreeRate": RISK_FREE_RATE_ANNUAL,
        "klineDataRange": {"start": all_dates[0], "end": all_dates[-1]} if all_dates else None,
    }

    return {
        "strategy_result": strategy_result,
        "dca_result": dca_result,
        "buyhold_result": buyhold_result,
        "comparison": comparison,
        "meta": meta,
    }


def _build_comparison(strategy: dict, dca: dict, buyhold: dict) -> dict:
    """构建3策略对比表."""
    rows = []
    for name, r in [
        ("本系统策略(PE分位简化版)", strategy),
        ("等额定投(DCA)", dca),
        ("买入持有(Buy&Hold)", buyhold),
    ]:
        if isinstance(r, dict) and "error" not in r:
            rows.append({
                "strategy": name,
                "totalInvested": r.get("totalInvested", 0),
                "finalValue": r.get("finalValue", 0),
                "totalReturnPct": r.get("totalReturnPct", 0),
                "annualizedReturnPct": r.get("annualizedReturnPct", 0),
                "maxDrawdownPct": r.get("maxDrawdownPct", 0),
                "sharpeRatio": r.get("sharpeRatio", 0),
                "weeks": r.get("weeks", 0),
            })
        else:
            rows.append({
                "strategy": name,
                "error": r.get("error") if isinstance(r, dict) else "unknown",
            })

    # 找出最优策略 (按夏普比率)
    valid_rows = [r for r in rows if "error" not in r]
    best = None
    if valid_rows:
        best = max(valid_rows, key=lambda x: x.get("sharpeRatio", -999))
        best = best["strategy"]

    return {
        "rows": rows,
        "bestBySharpe": best,
    }
