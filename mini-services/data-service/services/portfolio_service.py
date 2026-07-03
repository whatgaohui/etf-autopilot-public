"""V5.0 Portfolio Service — 投资收益追踪.

从 Prisma 业务DB (custom.db) 读取持仓快照 (holding_snapshot),
从 market_data.db 读取 K线历史, 计算累计收益/年化收益/收益曲线,
并对比沪深300基准 (510330 ETF).

返回格式与前端 `src/lib/api.ts` 的 PortfolioPerformance / PortfolioPerformancePoint 对齐:
  PortfolioPerformance = {
    totalInvested, totalValue, totalReturn, totalReturnPct, annualReturn, vsBenchmark,
    history: [{date, invested, value, returnPct}]
  }

关键概念:
  - 持仓快照: 用户每次手动输入/OCR上传的持仓记录, 包含 shares / costPrice / marketValue
  - 我们采用 "最新快照" 作为当前持仓视图, 用快照最早的日期作为收益起点
  - 收益曲线: 用历史 K线收盘价 × 最新份额 推算过去每个交易日的市值
  - 累计投入 (totalInvested): 取最新快照的 sum(shares × costPrice) 作为成本基准
  - 沪深300基准: 用 510330 ETF 同期收益率对比
"""
import json
import logging
import math
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from config import DB_PATH, TRACKED_ETFS

logger = logging.getLogger(__name__)

# Prisma 业务DB路径
CUSTOM_DB_PATH = "/home/z/my-project/db/custom.db"

# 沪深300基准ETF代码 (沪深300ETF)
BENCHMARK_CODE = "510330"

# 一年天数 (用于年化计算)
DAYS_PER_YEAR = 365


# ─── 数据加载 ────────────────────────────────────────────────────────────────

def _load_holdings_from_prisma() -> list[dict]:
    """从 custom.db 的 holding_snapshot 表加载所有持仓快照.

    Prisma SQLite 把 DateTime 存为 epoch 毫秒 (Int).
    返回按 snapshotDate 升序的快照列表.
    """
    try:
        conn = sqlite3.connect(CUSTOM_DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT id, snapshotDate, etfCode, etfName, shares, costPrice,
                       marketValue, currentRatio, createdAt
                FROM holding_snapshot
                ORDER BY snapshotDate ASC
                """
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[PORTFOLIO] load holdings from prisma failed: {e}")
        return []


def _load_kline_history(code: str) -> list[dict]:
    """从 market_data.db 加载 K线历史 (升序)."""
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
        hist = sorted(hist, key=lambda x: x.get("date", ""))
        return hist
    finally:
        conn.close()


def _parse_date(d) -> Optional[datetime]:
    """解析日期 (字符串或 epoch 毫秒)."""
    if d is None:
        return None
    if isinstance(d, (int, float)):
        try:
            return datetime.fromtimestamp(d / 1000.0, tz=timezone.utc)
        except (ValueError, OSError):
            return None
    if isinstance(d, str):
        try:
            return datetime.strptime(d[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return None


def _fmt_date(dt: datetime) -> str:
    """格式化为 'YYYY-MM-DD'."""
    return dt.strftime("%Y-%m-%d")


# ─── 计算逻辑 ────────────────────────────────────────────────────────────────

def _get_close_at_or_before(kline: list[dict], target_date: str) -> Optional[float]:
    """返回 <= target_date 的最近一条 K线收盘价."""
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


def _get_close_at_or_after(kline: list[dict], target_date: str) -> Optional[float]:
    """返回 >= target_date 的最近一条 K线收盘价."""
    for pt in kline:
        d = pt.get("date", "")
        if d >= target_date:
            close = pt.get("close")
            if close is not None:
                return float(close)
    return None


def _build_history_points(
    share_map: dict[str, float],
    cost_basis: float,
    klines: dict[str, list[dict]],
    start_str: str,
    today_str: str,
    snapshot_market_values: Optional[dict[str, float]] = None,
    max_points: int = 200,
) -> list[dict]:
    """构建收益曲线点列表: [{date, invested, value, returnPct}].

    - invested: 累计投入 (用最新快照的 cost basis 作为常量基准; 简化处理)
    - value: 当日总市值 (sum shares × close; 无K线的标的用快照市值作为常量 fallback)
    - returnPct: (value - invested) / invested × 100
    """
    snapshot_market_values = snapshot_market_values or {}
    # 取所有K线日期的并集 (>= start_str)
    all_dates = set()
    for code, hist in klines.items():
        for pt in hist:
            d = pt.get("date", "")
            if d >= start_str and pt.get("close") is not None:
                all_dates.add(d)
    # 如果至少有一个标的有K线, 用K线日期; 否则用 [today_str] 至少返回1个点
    if not all_dates:
        all_dates = {today_str}
    all_dates = sorted(all_dates)

    # 逐日计算总市值
    points = []
    for d in all_dates:
        total_mv = 0.0
        for code, shares in share_map.items():
            close = _get_close_at_or_before(klines.get(code, []), d)
            if close is not None:
                total_mv += shares * close
            else:
                # 无K线数据 (例如 511990 货币基金) → 用快照市值作为常量
                total_mv += snapshot_market_values.get(code, 0.0)
        return_pct = ((total_mv - cost_basis) / cost_basis * 100) if cost_basis > 0 else 0.0
        points.append({
            "date": d,
            "invested": round(cost_basis, 2),
            "value": round(total_mv, 2),
            "returnPct": round(return_pct, 2),
        })

    # 采样: 点太多时均匀采样
    if len(points) > max_points:
        step = len(points) // max_points
        points = points[::step][:max_points]

    return points


def get_portfolio_performance() -> dict:
    """计算投资收益汇总.

    返回前端期望的 PortfolioPerformance 结构:
      {
        totalInvested, totalValue, totalReturn, totalReturnPct, annualReturn, vsBenchmark,
        history: [{date, invested, value, returnPct}],
        // 额外字段 (前端忽略, 供调试/扩展):
        holdings, benchmark, snapshotInfo
      }
    """
    # 1. 加载持仓快照
    snapshots = _load_holdings_from_prisma()
    if not snapshots:
        return {
            "totalInvested": 0,
            "totalValue": 0,
            "totalReturn": 0,
            "totalReturnPct": 0,
            "annualReturn": 0,
            "vsBenchmark": 0,
            "history": [],
            "holdings": [],
            "benchmark": None,
            "snapshotInfo": None,
        }

    # 2. 找最新快照 (按 snapshotDate 取每个 etfCode 最新的)
    latest_per_etf: dict[str, dict] = {}
    earliest_snapshot_date = None
    latest_snapshot_date = None
    for s in snapshots:
        code = s.get("etfCode")
        if not code:
            continue
        sd = s.get("snapshotDate")
        if earliest_snapshot_date is None or sd < earliest_snapshot_date:
            earliest_snapshot_date = sd
        if latest_snapshot_date is None or sd > latest_snapshot_date:
            latest_snapshot_date = sd
        if code not in latest_per_etf or s.get("snapshotDate") > latest_per_etf[code].get("snapshotDate", 0):
            latest_per_etf[code] = s

    if not latest_per_etf:
        return {
            "totalInvested": 0, "totalValue": 0, "totalReturn": 0,
            "totalReturnPct": 0, "annualReturn": 0, "vsBenchmark": 0,
            "history": [], "holdings": [], "benchmark": None, "snapshotInfo": None,
        }

    # 3. 加载各 ETF 的 K线 (用于取最新收盘价)
    klines = {code: _load_kline_history(code) for code in latest_per_etf}

    # 4. 计算各 ETF 的当前市值 + 成本基准
    today_str = datetime.now().strftime("%Y-%m-%d")
    holdings_out = []
    total_current_value = 0.0
    total_cost_basis = 0.0
    share_map = {}  # 用于历史曲线: {code: shares}
    snapshot_market_values = {}  # 用于无K线标的的 fallback: {code: snapshot_market_value}

    for code, snap in latest_per_etf.items():
        shares = float(snap.get("shares") or 0)
        cost_price = float(snap.get("costPrice") or 0)
        snap_market_value = float(snap.get("marketValue") or 0)
        etf_name = snap.get("etfName") or TRACKED_ETFS.get(code, {}).get("name", code)

        kline = klines.get(code, [])
        current_price = None
        if kline:
            current_price = kline[-1].get("close")
            if current_price is not None:
                current_price = float(current_price)

        current_market_value = shares * current_price if current_price is not None else snap_market_value
        cost_basis = shares * cost_price
        profit = current_market_value - cost_basis
        profit_pct = (profit / cost_basis * 100) if cost_basis > 0 else 0.0

        total_current_value += current_market_value
        total_cost_basis += cost_basis
        share_map[code] = shares
        snapshot_market_values[code] = snap_market_value

        holdings_out.append({
            "code": code,
            "name": etf_name,
            "shares": round(shares, 2),
            "costPrice": round(cost_price, 4),
            "currentPrice": round(current_price, 4) if current_price is not None else None,
            "costBasis": round(cost_basis, 2),
            "currentMarketValue": round(current_market_value, 2),
            "snapshotMarketValue": round(snap_market_value, 2),
            "profit": round(profit, 2),
            "profitPct": round(profit_pct, 2),
            "currentRatio": round(float(snap.get("currentRatio") or 0), 4),
        })

    total_profit = total_current_value - total_cost_basis
    total_return_pct = (total_profit / total_cost_basis * 100) if total_cost_basis > 0 else 0.0

    # 5. 年化收益率 — 用最早快照日期到今天的天数
    annualized_pct = 0.0
    days_held = 0
    earliest_dt = _parse_date(earliest_snapshot_date)
    if earliest_dt and total_cost_basis > 0 and total_current_value > 0:
        if earliest_dt.tzinfo:
            earliest_naive = earliest_dt.replace(tzinfo=None)
        else:
            earliest_naive = earliest_dt
        now_dt = datetime.now()
        days_held = (now_dt - earliest_naive).days
        if days_held > 0:
            ratio = total_current_value / total_cost_basis
            if ratio > 0:
                annualized_pct = (ratio ** (DAYS_PER_YEAR / days_held) - 1.0) * 100

    # 6. 沪深300基准 (510330 ETF)
    benchmark = _compute_benchmark_return(earliest_snapshot_date, today_str)

    # 7. 超额收益
    vs_benchmark = 0.0
    if benchmark and benchmark.get("returnPct") is not None:
        vs_benchmark = round(total_return_pct - benchmark["returnPct"], 2)

    # 8. 构建历史曲线 (用于前端 chart: invested vs value)
    earliest_str = _fmt_date(_parse_date(earliest_snapshot_date)) if earliest_snapshot_date else today_str
    history = _build_history_points(
        share_map, total_cost_basis, klines, earliest_str, today_str,
        snapshot_market_values=snapshot_market_values, max_points=200
    )

    return {
        # 前端期望字段
        "totalInvested": round(total_cost_basis, 2),
        "totalValue": round(total_current_value, 2),
        "totalReturn": round(total_profit, 2),
        "totalReturnPct": round(total_return_pct, 2),
        "annualReturn": round(annualized_pct, 2),
        "vsBenchmark": vs_benchmark,
        "history": history,
        # 额外字段 (前端忽略, 供调试/扩展)
        "holdings": holdings_out,
        "benchmark": benchmark,
        "snapshotInfo": {
            "earliestDate": earliest_str,
            "latestDate": _fmt_date(_parse_date(latest_snapshot_date)) if latest_snapshot_date else "",
            "count": len(snapshots),
            "etfCount": len(latest_per_etf),
            "daysHeld": days_held,
        },
    }


def _compute_benchmark_return(earliest_snapshot_ms: Optional[int], today_str: str) -> Optional[dict]:
    """计算沪深300基准 (510330 ETF) 同期收益率.

    earliest_snapshot_ms: 最早持仓快照的 epoch 毫秒 (收益起点)
    today_str: 'YYYY-MM-DD' (收益终点)
    """
    if earliest_snapshot_ms is None:
        return None
    earliest_dt = _parse_date(earliest_snapshot_ms)
    if not earliest_dt:
        return None
    start_str = _fmt_date(earliest_dt)

    kline = _load_kline_history(BENCHMARK_CODE)
    if not kline:
        return None

    start_close = _get_close_at_or_after(kline, start_str)
    end_close = _get_close_at_or_before(kline, today_str)
    if not start_close or not end_close or start_close <= 0:
        return None

    return_pct = (end_close / start_close - 1.0) * 100
    return {
        "code": BENCHMARK_CODE,
        "name": TRACKED_ETFS.get(BENCHMARK_CODE, {}).get("name", "沪深300ETF"),
        "startDate": start_str,
        "endDate": today_str,
        "startPrice": round(start_close, 4),
        "endPrice": round(end_close, 4),
        "returnPct": round(return_pct, 2),
    }


def get_portfolio_performance_history() -> dict:
    """收益历史序列 (用于绘制曲线).

    返回前端期望的 {history: PortfolioPerformancePoint[]} 结构:
      [{date, invested, value, returnPct}]
    """
    perf = get_portfolio_performance()
    return {"history": perf.get("history", [])}
