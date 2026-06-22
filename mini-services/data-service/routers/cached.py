"""Cached data read endpoints — read from local SQLite cache."""
import json
import logging
import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query

from config import DB_PATH, TRACKED_ETFS, MARKET_INDICES
from models.schemas import (
    CachedDividend,
    CachedKline,
    CachedMarketIndex,
    CachedNav,
    CachedPremium,
    CachedSummaryItem,
    CachedSummaryResponse,
    CachedValuation,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cached", tags=["cached"])


def _get_db() -> sqlite3.Connection:
    """Get a connection to the SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _get_latest_by_type(data_type: str) -> list[dict]:
    """Get the latest cached data for all codes of a given type."""
    conn = _get_db()
    try:
        cursor = conn.execute(
            """
            SELECT m.code, m.data_json, m.date, m.updated_at
            FROM market_data_cache m
            INNER JOIN (
                SELECT code, MAX(date) as max_date
                FROM market_data_cache
                WHERE data_type = ?
                GROUP BY code
            ) latest ON m.code = latest.code AND m.date = latest.max_date
            WHERE m.data_type = ?
            """,
            (data_type, data_type),
        )
        rows = cursor.fetchall()
        return [
            {
                "code": row["code"],
                "data": json.loads(row["data_json"]),
                "date": row["date"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


def _get_history_by_type(code: str, data_type: str, limit: int = 30) -> list[dict]:
    """Get historical cached data for a given code and type, ordered by date desc."""
    conn = _get_db()
    try:
        cursor = conn.execute(
            """
            SELECT date, data_json
            FROM market_data_cache
            WHERE code = ? AND data_type = ?
            ORDER BY date DESC
            LIMIT ?
            """,
            (code, data_type, limit),
        )
        rows = cursor.fetchall()
        return [
            {
                "date": row["date"],
                "data": json.loads(row["data_json"]),
            }
            for row in rows
        ]
    finally:
        conn.close()


def _rebuild_premium_30d_from_db(code: str, today_data: dict) -> list[dict]:
    """V4.1 BUG-2026-06-PREMIUM-AVG: 从 DB 历史 premium_today 重建 30d 序列。

    当适配器返回的 premium_30d 为空时（include_history=False 或拉取失败），
    从 market_data_cache 表中查最近 30 条同 code 的 premium 记录，
    提取每条的 premium_today + date，重建为 [{date, premium}, ...] 序列。

    注意：DB 里只有 1 条记录时（首次刷新），返回序列只有 1 个点。
    """
    history = _get_history_by_type(code, "premium", limit=30)
    series: list[dict] = []
    seen_dates: set[str] = set()
    for h in history:
        d = h.get("date") or (h.get("data") or {}).get("date")
        p = (h.get("data") or {}).get("premium_today")
        if d and p is not None and d not in seen_dates:
            series.append({"date": d, "premium": float(p)})
            seen_dates.add(d)
    # 按日期升序
    series.sort(key=lambda x: x["date"])
    return series


def _compute_premium_avg(series: list[dict], n: int) -> Optional[float]:
    """从 [{date, premium}, ...] 序列末尾取 n 个有效值求均值。"""
    if not series:
        return None
    last_n = series[-n:] if len(series) >= n else series
    vals = [p.get("premium") for p in last_n if isinstance(p, dict) and p.get("premium") is not None]
    if not vals:
        return None
    try:
        return round(sum(vals) / len(vals), 4)
    except (TypeError, ValueError):
        return None


@router.get("/valuation", response_model=list[CachedValuation])
async def get_cached_valuation():
    """Returns latest PE/PB percentile data from SQLite."""
    items = _get_latest_by_type("valuation")
    result = []
    for item in items:
        code = item["code"]
        # Find the ETF info — code might be an index_code or etf_code
        etf_info = TRACKED_ETFS.get(code, {})
        if not etf_info:
            # Try matching by index_code
            for ec, ei in TRACKED_ETFS.items():
                if ei.get("index_code") == code:
                    etf_info = ei
                    code = ec
                    break

        data = item["data"]
        result.append(
            CachedValuation(
                code=code,
                name=etf_info.get("name", code),
                pe=data.get("pe"),
                pb=data.get("pb"),
                pePercentile=data.get("pe_percentile"),
                pbPercentile=data.get("pb_percentile"),
                date=item["date"],
                peHistory=data.get("pe_history", []),
                pbHistory=data.get("pb_history", []),
                # V4 多周期分位
                pePercentile1y=data.get("pe_percentile_1y"),
                pePercentile3y=data.get("pe_percentile_3y"),
                pePercentile5y=data.get("pe_percentile_5y"),
                pePercentile10y=data.get("pe_percentile_10y"),
                pePercentileAll=data.get("pe_percentile_all"),
                pbPercentile1y=data.get("pb_percentile_1y"),
                pbPercentile3y=data.get("pb_percentile_3y"),
                pbPercentile5y=data.get("pb_percentile_5y"),
                pbPercentile10y=data.get("pb_percentile_10y"),
                pbPercentileAll=data.get("pb_percentile_all"),
                sampleDays=data.get("sample_days", 0),
                source="akshare",
                isEstimated=data.get("is_estimated", False),
                # V4.1 BUG-2026-06-A500-PB: PB 数据来源标注
                pbSource=data.get("pb_source"),
                # V4.1 BUG-2026-06-A500-PE: PE 数据来源标注
                peSource=data.get("pe_source"),
            )
        )
    return result


@router.get("/kline", response_model=list[CachedKline])
async def get_cached_kline(code: str | None = Query(None, description="可选：指定 ETF 代码（如 159338）触发拉取并返回该 ETF 的 K线")):
    """Returns latest ETF K-line data from SQLite.

    V4.1 BUG-2026-06-A500-KLINE:
        - 无 code 参数：返回所有 ETF 的 K线（与原行为一致）
        - 有 code 参数：如果该 ETF cache 里没有 kline 数据，立即触发拉取（akshare→eastmoney_direct 链路）
    """
    # 如果指定了 code 且 cache 里没有该 ETF 的 kline，触发拉取
    if code:
        existing = _get_latest_by_type("kline")
        existing_codes = {item["code"] for item in existing}
        if code not in existing_codes:
            logger.info(f"[CACHED] kline cache miss for {code}, triggering fetch...")
            try:
                from services.akshare_service import fetch_etf_kline
                await fetch_etf_kline(code)
            except Exception as e:
                logger.warning(f"[CACHED] kline fetch failed for {code}: {e}")
            # 重新读 cache
            existing = _get_latest_by_type("kline")
        # 只返回指定 code 的 K线
        items = [item for item in existing if item["code"] == code]
    else:
        items = _get_latest_by_type("kline")

    result = []
    for item in items:
        etf_code = item["code"]
        etf_info = TRACKED_ETFS.get(etf_code, {})
        data = item["data"]
        result.append(
            CachedKline(
                code=etf_code,
                name=etf_info.get("name", etf_code),
                klineHistory=data.get("kline_history", []),
                date=item["date"],
                # V4.1 BUG-2026-06-A500-KLINE: K线数据来源 + 是否净值代理
                source=data.get("source", "akshare"),
                isNavProxy=data.get("is_nav_proxy", False),
            )
        )
    return result


def _rebuild_premium_30d_from_db(code: str, today_data: dict) -> list[dict]:
    """V4.1 BUG-2026-06-PREMIUM-AVG: 从 DB 历史 premium_today 重建 30d 序列。

    当适配器返回的 premium_30d 为空时（include_history=False 或拉取失败），
    从 market_data_cache 表中查最近 30 条同 code 的 premium 记录，
    提取每条的 premium_today + date，重建为 [{date, premium}, ...] 序列。

    注意：DB 里只有 1 条记录时（首次刷新），返回序列只有 1 个点。
    """
    history = _get_history_by_type(code, "premium", limit=30)
    series: list[dict] = []
    seen_dates: set[str] = set()
    for h in history:
        d = h.get("date") or (h.get("data") or {}).get("date")
        p = (h.get("data") or {}).get("premium_today")
        if d and p is not None and d not in seen_dates:
            series.append({"date": d, "premium": float(p)})
            seen_dates.add(d)
    # 按日期升序
    series.sort(key=lambda x: x["date"])
    return series


def _compute_premium_avg(series: list[dict], n: int) -> Optional[float]:
    """从 [{date, premium}, ...] 序列末尾取 n 个有效值求均值。"""
    if not series:
        return None
    last_n = series[-n:] if len(series) >= n else series
    vals = [p.get("premium") for p in last_n if isinstance(p, dict) and p.get("premium") is not None]
    if not vals:
        return None
    try:
        return round(sum(vals) / len(vals), 4)
    except (TypeError, ValueError):
        return None


@router.get("/premium", response_model=list[CachedPremium])
async def get_cached_premium():
    """Returns latest ETF premium data from SQLite.

    V4.1 BUG-2026-06-PREMIUM-AVG:
        3d/7d 均值计算逻辑重写——不再错误地兜底为 premium_today。
        优先级：
          1. 当前记录的 premium_30d 序列（适配器 include_history=True 拉取的）
          2. 从 DB 历史 premium_today 重建 30d 序列（适配器未拉历史的兜底）
        基于 30d 序列末尾 N 个点计算 3d/7d 均值。
        如果序列只有 1 个点（首次刷新），3d/7d 均值 = 该点值（明确告知用户"数据不足"）。
    """
    items = _get_latest_by_type("premium")
    result = []
    for item in items:
        code = item["code"]
        etf_info = TRACKED_ETFS.get(code, {})
        data = item["data"]

        # 1. 取当前记录的 premium_30d
        premium_30d = data.get("premium_30d", []) or []

        # 2. 如果为空，从 DB 历史重建
        if not premium_30d:
            premium_30d = _rebuild_premium_30d_from_db(code, data)

        # 3. 如果还是空但 premium_today 有值，至少放入一个点（避免 UI 显示 "—"）
        today_premium = data.get("premium_today")
        if not premium_30d and today_premium is not None:
            today_date = item.get("date") or datetime.now().strftime("%Y-%m-%d")
            premium_30d = [{"date": today_date, "premium": float(today_premium)}]

        # 4. 计算 3d / 7d 均值
        premium_3d_avg = _compute_premium_avg(premium_30d, 3)
        premium_7d_avg = data.get("premium_7d_avg")
        if premium_7d_avg is None:
            premium_7d_avg = _compute_premium_avg(premium_30d, 7)

        result.append(
            CachedPremium(
                code=code,
                name=etf_info.get("name", code),
                premiumToday=today_premium,
                premium7dAvg=premium_7d_avg,
                premium3dAvg=premium_3d_avg,
                premium30d=premium_30d,
                date=item["date"],
            )
        )
    return result


@router.get("/nav", response_model=list[CachedNav])
async def get_cached_nav():
    """Returns latest ETF NAV data from SQLite."""
    items = _get_latest_by_type("nav")
    result = []
    for item in items:
        code = item["code"]
        etf_info = TRACKED_ETFS.get(code, {})
        data = item["data"]
        result.append(
            CachedNav(
                code=code,
                name=etf_info.get("name", code),
                nav=data.get("nav"),
                navHistory=data.get("nav_history", []),
                date=item["date"],
            )
        )
    return result


@router.get("/dividend", response_model=list[CachedDividend])
async def get_cached_dividend():
    """Returns latest dividend yield data from SQLite."""
    items = _get_latest_by_type("dividend")
    result = []
    for item in items:
        code = item["code"]
        # dividend data is stored with index_code as code
        etf_info = TRACKED_ETFS.get(code, {})
        etf_code = code
        if not etf_info:
            for ec, ei in TRACKED_ETFS.items():
                if ei.get("index_code") == code:
                    etf_info = ei
                    etf_code = ec
                    break

        data = item["data"]
        result.append(
            CachedDividend(
                code=etf_code,
                name=etf_info.get("name", code),
                dividendYield=data.get("dividend_yield"),
                dividendYieldPercentile=data.get("dividend_yield_percentile"),
                dividendYieldHistory=data.get("dividend_yield_history", []),
                date=item["date"],
            )
        )
    return result


@router.get("/market-index", response_model=list[CachedMarketIndex])
async def get_cached_market_index():
    """Returns latest broad market index data from SQLite."""
    items = _get_latest_by_type("market_index")
    result = []
    for item in items:
        code = item["code"]
        index_info = MARKET_INDICES.get(code, {})
        data = item["data"]
        result.append(
            CachedMarketIndex(
                code=code,
                name=data.get("name", index_info.get("name", code)),
                category=data.get("category", index_info.get("category", "")),
                currentValue=data.get("currentValue"),
                dailyChange=data.get("dailyChange"),
                dailyChangePercent=data.get("dailyChangePercent"),
                ma20=data.get("ma20"),
                ma60=data.get("ma60"),
                priceHistory=data.get("priceHistory", []),
                date=item["date"],
            )
        )
    return result


@router.get("/summary", response_model=CachedSummaryResponse)
async def get_cached_summary():
    """Returns all cached data summary for dashboard."""
    # Get all data types — both by ETF code and index code
    valuation_data = {}
    premium_data = {}
    nav_data = {}
    dividend_data = {}

    for item in _get_latest_by_type("valuation"):
        code = item["code"]
        valuation_data[code] = item
        # Also map by index_code → etf_code
        for ec, ei in TRACKED_ETFS.items():
            if ei.get("index_code") == code:
                valuation_data[ec] = item

    for item in _get_latest_by_type("premium"):
        premium_data[item["code"]] = item

    for item in _get_latest_by_type("nav"):
        nav_data[item["code"]] = item

    for item in _get_latest_by_type("dividend"):
        code = item["code"]
        dividend_data[code] = item
        # Also map by index_code → etf_code
        for ec, ei in TRACKED_ETFS.items():
            if ei.get("index_code") == code:
                dividend_data[ec] = item

    items = []
    last_updated = ""

    for code, etf_info in TRACKED_ETFS.items():
        val = valuation_data.get(code, {})
        prem = premium_data.get(code, {})
        nav = nav_data.get(code, {})
        div = dividend_data.get(code, {})

        val_d = val.get("data", {})
        prem_d = prem.get("data", {})
        nav_d = nav.get("data", {})
        div_d = div.get("data", {})

        # V4.1 BUG-2026-06-PREMIUM-AVG: summary 端点 3d/7d 均值与 /premium 端点保持一致
        # 优先用 prem_d.premium_30d；为空时从 DB 历史 premium_today 重建
        prem_30d_series = prem_d.get("premium_30d") or _rebuild_premium_30d_from_db(code, prem_d)
        prem_3d_avg = _compute_premium_avg(prem_30d_series, 3)
        prem_7d_avg = prem_d.get("premium_7d_avg")
        if prem_7d_avg is None:
            prem_7d_avg = _compute_premium_avg(prem_30d_series, 7)

        item = CachedSummaryItem(
            code=code,
            name=etf_info.get("name", code),
            category=etf_info.get("category", "domestic"),
            pe=val_d.get("pe"),
            pb=val_d.get("pb"),
            pe_percentile=val_d.get("pe_percentile"),
            pb_percentile=val_d.get("pb_percentile"),
            premium_today=prem_d.get("premium_today"),
            premium_7d_avg=prem_7d_avg,
            # V4.1 BUG-2026-06-PREMIUM-AVG: summary 补 3d 均值字段，与 /premium 端点一致
            premium_3d_avg=prem_3d_avg,
            nav=nav_d.get("nav"),
            dividend_yield=div_d.get("dividend_yield"),
            valuation_date=val.get("date", ""),
            premium_date=prem.get("date", ""),
            nav_date=nav.get("date", ""),
            dividend_date=div.get("date", ""),
            is_estimated=val_d.get("is_estimated", False),
        )
        items.append(item)

        # Track the most recent update time
        for source in [val, prem, nav, div]:
            ua = source.get("updated_at", "")
            if ua > last_updated:
                last_updated = ua

    return CachedSummaryResponse(
        items=items,
        lastUpdated=last_updated,
    )


@router.get("/forex")
async def get_forex():
    """获取美元/人民币汇率（文档范围外增强：汇率影响监控）。"""
    from services.akshare_service import fetch_forex_usd_cny
    return await fetch_forex_usd_cny()


@router.get("/lineage")
async def get_data_lineage(code: str = "", data_type: str = ""):
    """V4 PRD§12.3/策略书§4.5: 查询数据血缘字段（raw_value/clean_value/source/is_valid 等）。

    可按 code 和 data_type 过滤，返回最近一条记录的血缘信息。
    """
    from services.akshare_service import _ensure_cache_columns

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_cache_columns(conn)

        query = """
            SELECT code, data_type, date, raw_value, clean_value, source, source_api,
                   is_valid, abnormal_reason, sample_days, percentile_window, percentile,
                   trade_date, fetch_time, updated_at
            FROM market_data_cache
            WHERE 1=1
        """
        params = []
        if code:
            query += " AND code = ?"
            params.append(code)
        if data_type:
            query += " AND data_type = ?"
            params.append(data_type)
        query += " ORDER BY date DESC LIMIT 20"

        rows = conn.execute(query, params).fetchall()
        return {
            "lineage": [
                {
                    "code": r["code"],
                    "dataType": r["data_type"],
                    "date": r["date"],
                    "rawValue": r["raw_value"],
                    "cleanValue": r["clean_value"],
                    "source": r["source"],
                    "sourceApi": r["source_api"],
                    "isValid": r["is_valid"],
                    "abnormalReason": r["abnormal_reason"],
                    "sampleDays": r["sample_days"],
                    "percentileWindow": r["percentile_window"],
                    "percentile": r["percentile"],
                    "tradeDate": r["trade_date"],
                    "fetchTime": r["fetch_time"],
                    "updatedAt": r["updated_at"],
                }
                for r in rows
            ],
            "count": len(rows),
        }
    finally:
        conn.close()
