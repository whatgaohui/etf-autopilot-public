"""Akshare data fetching service — real implementation.

Data source mapping:
  - stock_index_pe_lg / stock_index_pb_lg  →  乐咕乐股 PE/PB (5+ years history)
  - stock_zh_index_value_csindex           →  中证指数 PE/股息率 (20 recent days)
  - fund_etf_spot_em                       →  东方财富 ETF 实时行情 (含折价率)
  - fund_etf_fund_info_em                  →  东方财富 ETF 历史净值
  - fund_etf_hist_sina                     →  新浪 ETF 日线行情
  - index_us_stock_sina                    →  新浪美股指数行情
"""
import asyncio
import json
import logging
import math
import sqlite3
from datetime import datetime, timedelta, date
from typing import Optional

import akshare as ak
import pandas as pd

from config import DB_PATH, TRACKED_ETFS, MARKET_INDICES

logger = logging.getLogger(__name__)

# ─── helpers ───────────────────────────────────────────────────────────────────

def _ensure_cache_columns(conn: sqlite3.Connection) -> None:
    """V4 PRD§12.3/策略书§4.5: 确保 market_data_cache 表有数据血缘独立列。

    幂等添加: raw_value, clean_value, source, source_api, is_valid,
    abnormal_reason, sample_days, percentile_window, percentile, trade_date, fetch_time
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(market_data_cache)").fetchall()}
    new_cols = [
        ("raw_value", "TEXT"),
        ("clean_value", "REAL"),
        ("source", "TEXT"),
        ("source_api", "TEXT"),
        ("is_valid", "BOOLEAN"),
        ("abnormal_reason", "TEXT"),
        ("sample_days", "INTEGER"),
        ("percentile_window", "TEXT"),
        ("percentile", "REAL"),
        ("trade_date", "TEXT"),
        ("fetch_time", "TEXT"),
    ]
    for col, coltype in new_cols:
        if col not in existing:
            try:
                conn.execute(f"ALTER TABLE market_data_cache ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass


def _record_source_status(source_name: str, source_type: str, success: bool, latency_ms: int = 0, error: str = ""):
    """V4 PRD§12.4: 记录数据源拉取状态到 data_source_status 表。"""
    now = datetime.now().isoformat()
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO data_source_status (source_name, source_type, last_fetch_time, last_success_time, status, error_message, latency_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_name,
                source_type,
                now,
                now if success else "",
                "success" if success else "error",
                error if not success else "",
                latency_ms,
                now,
            ),
        )
        conn.commit()
    except Exception as e:
        logger.warning(f"[SOURCE-STATUS] Failed to record: {e}")
    finally:
        conn.close()


def _save_to_cache(code: str, data_type: str, date_str: str, data: dict,
                   source_name: str = "akshare", source_api: str = ""):
    """Save data to the SQLite cache.

    V4 PRD§12.3/策略书§4.5: 同时写入数据血缘独立列（raw_value/clean_value/source/is_valid 等），
    保留 data_json 作为完整快照。

    V4.1 PRD§13.5/§13.6: 同时写入 market_data_raw（原始快照）和 market_data_clean（清洗后值），
    实现原始/清洗数据分层存储。规则引擎只读 market_data_clean.clean_value。

    V4.1 S2-T4: 新增 source_name/source_api 参数，让 fetch_with_fallback 链路能把
    降级后的真实数据源（如 tushare/efinance）正确写入血缘字段，避免血缘失真。
    """
    from services.data_clean_engine import clean_numeric, detect_abnormal, abnormal_reason

    # V4.1 S2-T4: 默认 source_api 与 data_type 对齐，允许调用方覆盖
    if not source_api:
        source_api = f"{source_name}:{data_type}"

    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_cache_columns(conn)

        # 从 data dict 提取数据血缘字段
        now_iso = datetime.now().isoformat()

        # 根据 data_type 决定 raw_value/clean_value/percentile 的取值
        raw_value = None
        clean_value = None
        percentile = None
        percentile_window = None
        is_valid = True
        abnormal_reason_str = ""
        # metric_type 映射到清洗引擎的异常检测类型
        clean_metric_type = data_type

        if data_type == "valuation":
            raw_value = data.get("pe")
            clean_value = clean_numeric(raw_value)
            percentile = data.get("pe_percentile")
            percentile_window = "5y" if data.get("pe_percentile_5y") is not None else "default"
            clean_metric_type = "pe"
            if raw_value is not None and detect_abnormal("pe", raw_value):
                is_valid = False
                abnormal_reason_str = abnormal_reason("pe", raw_value)
        elif data_type == "premium":
            raw_value = data.get("premium_today")
            clean_value = clean_numeric(raw_value)
            percentile_window = "premium"
            clean_metric_type = "premium"
            if raw_value is not None and detect_abnormal("premium", raw_value):
                is_valid = False
                abnormal_reason_str = abnormal_reason("premium", raw_value)
        elif data_type == "dividend":
            raw_value = data.get("dividend_yield")
            clean_value = clean_numeric(raw_value)
            percentile = data.get("dividend_yield_percentile")
            percentile_window = "5y"
            clean_metric_type = "dividend_yield"
            if raw_value is not None and detect_abnormal("dividend_yield", raw_value):
                is_valid = False
                abnormal_reason_str = abnormal_reason("dividend_yield", raw_value)
        elif data_type == "nav":
            raw_value = data.get("nav")
            clean_value = clean_numeric(raw_value)
            clean_metric_type = "nav"
            if raw_value is not None and detect_abnormal("nav", raw_value):
                is_valid = False
                abnormal_reason_str = abnormal_reason("nav", raw_value)

        sample_days = data.get("sample_days", 0)
        raw_json_str = json.dumps(data, ensure_ascii=False)

        # 1. 写入 market_data_cache（保持原有行为，兼容现有读取逻辑）
        conn.execute(
            """
            INSERT OR REPLACE INTO market_data_cache
                (date, code, data_type, data_json, updated_at,
                 raw_value, clean_value, source, source_api, is_valid,
                 abnormal_reason, sample_days, percentile_window, percentile,
                 trade_date, fetch_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                date_str, code, data_type, raw_json_str, now_iso,
                str(raw_value) if raw_value is not None else None,
                clean_value,
                source_name,  # V4.1 S2-T4: 用调用方传入的真实源名
                source_api,   # V4.1 S2-T4: 用调用方传入的真实 source_api
                is_valid,
                abnormal_reason_str,
                sample_days,
                percentile_window,
                percentile,
                date_str,
                now_iso,
            ),
        )

        # 2. V4.1 §13.5: 写入 market_data_raw（原始快照，含 raw_json 完整 payload）
        try:
            conn.execute(
                """INSERT INTO market_data_raw
                   (code, trade_date, metric_type, source_id, source_api,
                    raw_value, raw_json, fetch_time, request_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (code, date_str, data_type, source_name, source_api,
                 str(raw_value) if raw_value is not None else None,
                 raw_json_str, now_iso, f"{source_name}-{now_iso}"),
            )
        except Exception as e:
            logger.warning(f"[RAW] Failed to write market_data_raw for {code}/{data_type}: {e}")

        # 3. V4.1 §13.6: 写入 market_data_clean（清洗后值，UNIQUE 约束去重）
        try:
            conn.execute(
                """INSERT OR REPLACE INTO market_data_clean
                   (code, trade_date, metric_type, clean_value, source_id,
                    is_valid, abnormal_reason, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (code, date_str, data_type, clean_value, source_name,
                 1 if is_valid else 0, abnormal_reason_str, now_iso),
            )
        except Exception as e:
            logger.warning(f"[CLEAN] Failed to write market_data_clean for {code}/{data_type}: {e}")

        conn.commit()
    finally:
        conn.close()


def safe_num(value) -> Optional[float]:
    """Return None for None/NaN/Inf/sentinel values (abs >= 999999).

    This eliminates the 99999999 sentinel values that akshare sometimes returns
    for missing PE/PB/premium data, which break chart axes when plotted.

    V4.1: 委托给 services.data_clean_engine.clean_numeric，避免逻辑漂移。
    """
    from services.data_clean_engine import clean_numeric
    return clean_numeric(value)


def clean_numeric_series(points: list[dict], value_key: str = "value") -> list[dict]:
    """Filter a list of {date, <value_key>} dicts, dropping entries where safe_num(value) is None.

    Used to clean pe_history / pb_history / premium_30d / dividend_yield_history / nav_history /
    price_history lists so that broken chart axes (caused by 99999999 sentinels) never happen.

    V4.1: 委托给 services.data_clean_engine.clean_series，避免逻辑漂移。
    """
    from services.data_clean_engine import clean_series
    return clean_series(points, value_key)


def calculate_percentile(current_value: float, historical_values: list[float]) -> float:
    """Calculate percentile of current value in historical series (0-100)."""
    if not historical_values:
        return 0.0
    clean = [v for v in (safe_num(x) for x in historical_values) if v is not None]
    if not clean:
        return 0.0
    cv = safe_num(current_value)
    if cv is None:
        return 0.0
    return round(sum(1 for v in clean if v <= cv) / len(clean) * 100, 2)


def calculate_multi_period_percentiles(
    current_value: Optional[float],
    history: list[dict],
    value_key: str = "value",
) -> dict:
    """计算多周期分位（V4 策略书§3）。

    history: list of {"date": "YYYY-MM-DD", value_key: float}
    返回 {1y, 3y, 5y, 10y, all} 各周期分位（0-100），样本不足返回 None。

    周期用途（策略书§3.1）：
      - 1y: 短期情绪温度计，不参与强规则
      - 3y: 中期冷热辅助
      - 5y: 买入侧主判断
      - 10y/all: 再平衡侧主判断
    """
    result = {"1y": None, "3y": None, "5y": None, "10y": None, "all": None, "sample_days": 0}
    cv = safe_num(current_value)
    if cv is None or not history:
        return result

    # 按 date 过滤有效点
    points = []
    for p in history:
        if not isinstance(p, dict):
            continue
        d = p.get("date")
        v = safe_num(p.get(value_key))
        if d and v is not None:
            points.append((str(d)[:10], v))

    if not points:
        return result

    result["sample_days"] = len(points)
    result["all"] = calculate_percentile(cv, [v for _, v in points])

    now = datetime.now()
    for years, key in [(1, "1y"), (3, "3y"), (5, "5y"), (10, "10y")]:
        cutoff = (now - timedelta(days=years * 365)).strftime("%Y-%m-%d")
        window = [v for d, v in points if d >= cutoff]
        if len(window) >= 30:  # 至少30个样本点才算有效分位
            result[key] = calculate_percentile(cv, window)
        else:
            result[key] = None  # 样本不足

    return result



def _safe_float(val) -> Optional[float]:
    """Safely convert a value to float, return None on failure.

    Now delegates to safe_num so that sentinel values (abs >= 999999) are also rejected.
    """
    return safe_num(val)


def _date_to_str(val) -> str:
    """Convert various date types to YYYY-MM-DD string."""
    if isinstance(val, date):
        return val.strftime("%Y-%m-%d")
    if isinstance(val, pd.Timestamp):
        return val.strftime("%Y-%m-%d")
    return str(val)


def _date_to_str_short(val) -> str:
    """Convert date to YYYY-MM-DD, handling Timestamp with tz info."""
    if isinstance(val, pd.Timestamp):
        return val.tz_localize(None).strftime("%Y-%m-%d") if val.tzinfo else val.strftime("%Y-%m-%d")
    return _date_to_str(val)


# ─── Shared data cache (in-memory, valid for one refresh cycle) ───────────

_etf_spot_cache: Optional[pd.DataFrame] = None
_etf_spot_cache_time: Optional[datetime] = None
_SPOT_CACHE_TTL = timedelta(minutes=5)


async def _get_etf_spot_data() -> pd.DataFrame:
    """Get ETF spot data, using in-memory cache if fresh enough."""
    global _etf_spot_cache, _etf_spot_cache_time
    if _etf_spot_cache is not None and _etf_spot_cache_time is not None:
        if datetime.now() - _etf_spot_cache_time < _SPOT_CACHE_TTL:
            return _etf_spot_cache
    df = await asyncio.to_thread(ak.fund_etf_spot_em)
    _etf_spot_cache = df
    _etf_spot_cache_time = datetime.now()
    return df


def invalidate_etf_spot_cache():
    """Invalidate the ETF spot cache."""
    global _etf_spot_cache, _etf_spot_cache_time
    _etf_spot_cache = None
    _etf_spot_cache_time = None


# ─── Index valuation ──────────────────────────────────────────────────────────

# Estimated PE/PB for US indices (akshare doesn't provide US index PE/PB)
_US_INDEX_ESTIMATES = {
    "SPI": {  # S&P 500
        "pe": 25.0,
        "pb": 4.5,
        "pe_note": "Estimated; akshare does not provide US index PE data",
    },
    "IXIC": {  # Nasdaq Composite
        "pe": 40.0,
        "pb": 5.5,
        "pe_note": "Estimated; akshare does not provide US index PE data",
    },
}


async def fetch_index_valuation(index_code: str, index_name: str = "") -> dict:
    """Fetch index PE/PB and calculate 5-year percentile.

    V4 策略书§10.2: AkShare 失败时自动切换到 Tushare 备源。
    """
    logger.info(f"[AKSHARE] fetch_index_valuation: index_code={index_code}, index_name={index_name}")

    # Find the etf entry that maps to this index_code
    lg_index_name = None
    for code, info in TRACKED_ETFS.items():
        if info.get("index_code") == index_code:
            lg_index_name = info.get("lg_index_name")
            break

    try:
        # ── US indices ──
        if index_code in _US_INDEX_ESTIMATES:
            return await _fetch_us_index_valuation(index_code, index_name)

        # ── Domestic indices with lg support ──
        if lg_index_name:
            return await _fetch_lg_index_valuation(index_code, index_name, lg_index_name)

        # ── Other domestic indices: use csindex ──
        return await _fetch_csindex_valuation(index_code, index_name)
    except Exception as e:
        logger.error(f"[AKSHARE] fetch_index_valuation failed: {e}. Trying Tushare fallback...")
        _record_source_status("AkShare", "valuation", success=False, error=str(e)[:200])
        # V4 数据源自动切换: fallback to Tushare
        try:
            from services import tushare_service
            tushare_result = await tushare_service.fetch_index_valuation(index_code)
            if tushare_result.get("pe") is not None:
                logger.info(f"[TUSHARE] Fallback succeeded for {index_code}: PE={tushare_result.get('pe')}")
                _record_source_status("Tushare", "valuation", success=True, latency_ms=0)
                return tushare_result
        except Exception as te:
            logger.error(f"[TUSHARE] Fallback also failed: {te}")
            _record_source_status("Tushare", "valuation", success=False, error=str(te)[:200])
        # Both sources failed
        return {"pe": None, "pb": None, "pe_percentile": None, "pb_percentile": None, "date": "", "source": "all_failed"}


async def _fetch_lg_index_valuation(index_code: str, index_name: str, lg_name: str) -> dict:
    """Fetch PE/PB from 乐咕乐股 (5+ years of data)."""
    try:
        pe_df = await asyncio.to_thread(ak.stock_index_pe_lg, symbol=lg_name)
        pb_df = await asyncio.to_thread(ak.stock_index_pb_lg, symbol=lg_name)
    except Exception as e:
        logger.error(f"[AKSHARE] lg API error for {lg_name}: {e}")
        return await _fetch_csindex_valuation(index_code, index_name)

    pe_row = pe_df.iloc[-1]
    pb_row = pb_df.iloc[-1]

    current_pe = _safe_float(pe_row.get("滚动市盈率", pe_row.get("静态市盈率")))
    current_pb = _safe_float(pb_row.get("市净率"))
    data_date = _date_to_str(pe_row.get("日期", datetime.now()))

    five_years_ago = (datetime.now() - timedelta(days=5 * 365)).strftime("%Y-%m-%d")
    pe_col = "滚动市盈率" if "滚动市盈率" in pe_df.columns else "静态市盈率"

    pe_recent = pe_df[pe_df["日期"].astype(str) >= five_years_ago]
    pb_recent = pb_df[pb_df["日期"].astype(str) >= five_years_ago]

    pe_hist_vals = [_safe_float(v) for v in pe_recent[pe_col].tolist() if _safe_float(v) is not None]
    pb_hist_vals = [_safe_float(v) for v in pb_recent["市净率"].tolist() if _safe_float(v) is not None]

    pe_percentile = calculate_percentile(current_pe, pe_hist_vals) if current_pe else 0
    pb_percentile = calculate_percentile(current_pb, pb_hist_vals) if current_pb else 0

    # V4 多周期分位（策略书§3）：用完整历史计算，采样只用于画图
    # 构建完整（未采样）的 {date, value} 列表用于分位计算
    pe_full_history = []
    for _, row in pe_recent.iterrows():
        d = _date_to_str(row.get("日期"))
        v = _safe_float(row.get(pe_col))
        if d and v is not None:
            pe_full_history.append({"date": d, "value": v})
    pb_full_history = []
    for _, row in pb_recent.iterrows():
        d = _date_to_str(row.get("日期"))
        v = _safe_float(row.get("市净率"))
        if d and v is not None:
            pb_full_history.append({"date": d, "value": v})

    pe_multi = calculate_multi_period_percentiles(current_pe, pe_full_history, "value")
    pb_multi = calculate_multi_period_percentiles(current_pb, pb_full_history, "value")

    pe_history = _sample_history(pe_recent, "日期", pe_col, max_points=250)
    pb_history = _sample_history(pb_recent, "日期", "市净率", max_points=250)

    # Apply safe_num + clean_numeric_series to eliminate 99999999 sentinels
    result = {
        "pe": safe_num(current_pe),
        "pb": safe_num(current_pb),
        "pe_percentile": safe_num(pe_percentile) if pe_percentile else 0,
        "pb_percentile": safe_num(pb_percentile) if pb_percentile else 0,
        "date": data_date,
        "pe_history": clean_numeric_series(pe_history, "value"),
        "pb_history": clean_numeric_series(pb_history, "value"),
        # V4 多周期分位（§3）
        "pe_percentile_1y": pe_multi["1y"],
        "pe_percentile_3y": pe_multi["3y"],
        "pe_percentile_5y": pe_multi["5y"],
        "pe_percentile_10y": pe_multi["10y"],
        "pe_percentile_all": pe_multi["all"],
        "pb_percentile_1y": pb_multi["1y"],
        "pb_percentile_3y": pb_multi["3y"],
        "pb_percentile_5y": pb_multi["5y"],
        "pb_percentile_10y": pb_multi["10y"],
        "pb_percentile_all": pb_multi["all"],
        "sample_days": pe_multi["sample_days"],
    }

    _save_to_cache(index_code, "valuation", data_date, result)
    return result


async def _fetch_csindex_valuation(index_code: str, index_name: str) -> dict:
    """Fetch PE and PB from 中证指数官网.

    The csindex xls file columns include 市盈率1, 市盈率2, 股息率1, 股息率2.
    注意：csindex 官网 2023 年起已下线"市净率"列，所有指数都不再发布 PB。
    注意：csindex akshare 接口（stock_zh_index_value_csindex）只返回最近 20 条数据，
          无法支撑 5Y/10Y 分位计算。

    PE/PB Fallback 策略（V4.1 BUG-2026-06-A500-PB-PE）:
        当 csindex 数据点 < 30 条时，用"沪深300 代理"补全 PE/PB 历史序列：
        - 中证A500 (000510): 与沪深300 成分股重合度 ~70%，PE/PB 走势高度相关
        - 科创50 (000688): 与沪深300 相关性较低，但仍优于 20 条数据点
        - 比例缩放：用 csindex 当前 PE 值 / 沪深300 当前 PE 值 = 缩放系数，
          将沪深300 PE 历史乘以系数得到 A500 PE 代理历史，保证当前值一致。
        - 代理源会在返回 dict 中通过 `pe_source` / `pb_source` 字段标注，前端展示徽标。
    """
    try:
        df = await asyncio.to_thread(ak.stock_zh_index_value_csindex, symbol=index_code)
    except Exception as e:
        logger.error(f"[AKSHARE] csindex API error for {index_code}: {e}")
        today = datetime.now().strftime("%Y-%m-%d")
        return {"pe": None, "pb": None, "pe_percentile": 0, "pb_percentile": 0, "date": today, "pe_history": [], "pb_history": [], "pb_source": "csindex(error)", "pe_source": "csindex(error)"}

    df = df.sort_values("日期", ascending=True)
    last_row = df.iloc[-1]

    # Extract PE (prefer TTM 市盈率2 over static 市盈率1)
    pe_col = "市盈率2" if "市盈率2" in df.columns else ("市盈率1" if "市盈率1" in df.columns else None)
    current_pe = _safe_float(last_row.get(pe_col)) if pe_col else None

    # Extract PB (prefer 市净率2 over 市净率1) — csindex 2023 起已下线此列，几乎必为 None
    pb_col = "市净率2" if "市净率2" in df.columns else ("市净率1" if "市净率1" in df.columns else None)
    current_pb = _safe_float(last_row.get(pb_col)) if pb_col else None
    pb_source = "csindex" if current_pb is not None else None
    pe_source = "csindex" if current_pe is not None else None

    data_date = _date_to_str(last_row.get("日期", datetime.now()))

    # PE percentile and history
    pe_vals = []
    pe_history = []
    if pe_col:
        pe_vals = [_safe_float(v) for v in df[pe_col].tolist() if _safe_float(v) is not None]
        for _, row in df.iterrows():
            d = _date_to_str(row.get("日期"))
            v = _safe_float(row.get(pe_col))
            if d and v is not None:
                pe_history.append({"date": d, "value": v})
    pe_percentile = calculate_percentile(current_pe, pe_vals) if current_pe and pe_vals else 0

    # PB percentile and history（csindex 原始数据）
    pb_vals = []
    pb_history = []
    if pb_col:
        pb_vals = [_safe_float(v) for v in df[pb_col].tolist() if _safe_float(v) is not None]
        for _, row in df.iterrows():
            d = _date_to_str(row.get("日期"))
            v = _safe_float(row.get(pb_col))
            if d and v is not None:
                pb_history.append({"date": d, "value": v})
    pb_percentile = calculate_percentile(current_pb, pb_vals) if current_pb and pb_vals else 0

    logger.info(f"[AKSHARE] csindex valuation for {index_code}: PE={current_pe} (pe_pts={len(pe_history)}), PB={current_pb} (pb_pts={len(pb_history)}, pb_col={pb_col})")

    # ── PE/PB Fallback: csindex 数据点 < 30 时用沪深300 代理 ──
    # 适用场景：中证A500(000510)/科创50(000688) 等新指数 csindex 只有 20 条历史
    # 策略书§3.3: A500 样本不足时可用沪深300 辅助
    # 比例缩放: 用 csindex 当前值 / 沪深300 当前值 作为缩放系数，保证当前值一致
    needs_proxy = (len(pe_history) < 30 or (current_pb is None and not pb_history)) and index_code != "000300"
    if needs_proxy:
        try:
            logger.info(f"[AKSHARE] PE/PB fallback: 用沪深300 代理 {index_code} ({index_name}) pe_pts={len(pe_history)}")
            hs300_result = await _fetch_lg_index_valuation("000300", "沪深300", "沪深300")
            hs300_pe = hs300_result.get("pe")
            hs300_pb = hs300_result.get("pb")
            hs300_pe_history = hs300_result.get("pe_history", [])
            hs300_pb_history = hs300_result.get("pb_history", [])

            # PE 代理：用比例缩放让当前值与 csindex 一致
            if len(pe_history) < 30 and current_pe is not None and hs300_pe is not None and hs300_pe > 0:
                pe_scale = current_pe / hs300_pe
                proxy_pe_history = [
                    {"date": h["date"], "value": round(h["value"] * pe_scale, 4)}
                    for h in hs300_pe_history
                ]
                pe_history = proxy_pe_history
                pe_vals = [h["value"] for h in pe_history]
                pe_percentile = calculate_percentile(current_pe, pe_vals) if pe_vals else 0
                pe_source = "沪深300代理"
                logger.info(f"[AKSHARE] PE fallback 成功: {index_code} pe={current_pe} scale={pe_scale:.4f} (沪深300代理 {len(pe_history)}条)")

            # PB 代理：直接用沪深300 PB 值（PB 数值差异 <5% 无需缩放）
            if current_pb is None and hs300_pb is not None:
                current_pb = hs300_pb
                pb_history = hs300_pb_history
                pb_vals = [h["value"] for h in pb_history]
                pb_percentile = hs300_result.get("pb_percentile", 0)
                pb_source = "沪深300代理"
                logger.info(f"[AKSHARE] PB fallback 成功: {index_code} pb={current_pb} (沪深300代理 {len(pb_history)}条)")

            # 复用沪深300 多周期分位
            if pe_source == "沪深300代理":
                # PE 用比例缩放后的历史重算多周期分位
                pe_multi = calculate_multi_period_percentiles(current_pe, pe_history, "value")
            else:
                pe_multi = calculate_multi_period_percentiles(current_pe, pe_history, "value")

            if pb_source == "沪深300代理":
                pb_multi = {
                    "1y": hs300_result.get("pb_percentile_1y"),
                    "3y": hs300_result.get("pb_percentile_3y"),
                    "5y": hs300_result.get("pb_percentile_5y"),
                    "10y": hs300_result.get("pb_percentile_10y"),
                    "all": hs300_result.get("pb_percentile_all"),
                }
            else:
                pb_multi = calculate_multi_period_percentiles(current_pb, pb_history, "value")
        except Exception as e:
            logger.warning(f"[AKSHARE] PE/PB 代理失败 for {index_code}: {e}")
            if current_pb is None:
                pb_source = f"csindex(无PB,代理失败:{type(e).__name__})"
            if len(pe_history) < 30:
                pe_source = f"csindex(数据不足,代理失败:{type(e).__name__})"
            pe_multi = calculate_multi_period_percentiles(current_pe, pe_history, "value")
            pb_multi = calculate_multi_period_percentiles(current_pb, pb_history, "value")
    else:
        pe_multi = calculate_multi_period_percentiles(current_pe, pe_history, "value")
        pb_multi = calculate_multi_period_percentiles(current_pb, pb_history, "value")

    result = {
        "pe": safe_num(current_pe),
        "pb": safe_num(current_pb),
        "pe_percentile": safe_num(pe_percentile) if pe_percentile else 0,
        "pb_percentile": safe_num(pb_percentile) if pb_percentile else 0,
        "date": data_date,
        "pe_history": clean_numeric_series(pe_history, "value"),
        "pb_history": clean_numeric_series(pb_history, "value"),
        # V4 多周期分位（§3）
        "pe_percentile_1y": pe_multi["1y"],
        "pe_percentile_3y": pe_multi["3y"],
        "pe_percentile_5y": pe_multi["5y"],
        "pe_percentile_10y": pe_multi["10y"],
        "pe_percentile_all": pe_multi["all"],
        "pb_percentile_1y": pb_multi["1y"],
        "pb_percentile_3y": pb_multi["3y"],
        "pb_percentile_5y": pb_multi["5y"],
        "pb_percentile_10y": pb_multi["10y"],
        "pb_percentile_all": pb_multi["all"],
        "sample_days": pe_multi["sample_days"],
        # V4.1 BUG-2026-06-A500-PB-PE: PE/PB 数据来源标注
        "pe_source": pe_source or "csindex(无PE)",
        "pb_source": pb_source or "csindex(无PB)",
    }

    _save_to_cache(index_code, "valuation", data_date, result)
    return result


async def _fetch_multpl_pe_history() -> tuple[list[dict], float | None, str]:
    """从 multpl.com 抓取 S&P 500 PE 月度完整历史（1871 至今，约 1872 条）。

    V4.1 BUG-2026-06-US-PE-STALE:
        旧 regex `<td>([^<]+)</td>` 无法匹配带 `<abbr>` 子标签的"估算值"行
        （multpl.com 从 2025-10 起对当月及未来月用 <abbr title="Estimate">†</abbr> 标注），
        导致历史数据停在 2025-09-01（9 个月前）。
        修复: 改用 row-based 解析（先匹配 <tr>，再 strip 标签提取单元格文本），
        能正确捕获 2025-10 至今的估算值，PE 历史可延伸到今日 (2026-06-18)。

    Returns:
        (pe_history, current_pe, data_date)
    """
    import re
    import requests

    url = "https://www.multpl.com/s-p-500-pe-ratio/table?f=m"
    try:
        r = await asyncio.to_thread(
            requests.get,
            url,
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        if r.status_code != 200:
            logger.warning(f"[MULTPL] S&P500 PE HTTP {r.status_code}")
            return [], None, ""

        from datetime import datetime as _dt

        def _parse_date(s: str) -> str | None:
            s = s.strip()
            for fmt in ("%b %d, %Y", "%B %d, %Y"):
                try:
                    return _dt.strptime(s, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    continue
            return None

        def _parse_val(s: str) -> float | None:
            # 输入形如 "\n&#x2002;\n28.13\n" 或 "<abbr title=\"Estimate\">†</abbr> 32.23"
            # 先剥离所有 HTML 标签和实体
            s = re.sub(r"<[^>]+>", " ", s)
            s = re.sub(r"&[^;]+;", " ", s)
            m = re.search(r"-?\d+\.?\d*", s)
            try:
                return float(m.group()) if m else None
            except ValueError:
                return None

        # row-based 解析：先匹配 <tr> 块，再提取单元格文本
        # 这样能正确处理 <td><abbr>†</abbr> 32.23</td> 这种带子标签的单元格
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", r.text, re.DOTALL)
        history: list[dict] = []
        for row in rows:
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
            if len(cells) < 2:
                continue
            date_str = re.sub(r"<[^>]+>", "", cells[0]).strip()
            val_str = cells[1]
            if not date_str or date_str.lower() == "date":
                continue
            d = _parse_date(date_str)
            v = _parse_val(val_str)
            if d and v is not None:
                history.append({"date": d, "value": v})

        # rows 是新到旧，反转为旧到新
        history.reverse()
        # 去重（按日期保留最后一个）
        seen: dict[str, dict] = {}
        for h in history:
            seen[h["date"]] = h
        history = sorted(seen.values(), key=lambda x: x["date"])

        if not history:
            logger.warning("[MULTPL] S&P500 PE no matches")
            return [], None, ""

        current_pe = history[-1]["value"]
        data_date = history[-1]["date"]
        logger.info(f"[MULTPL] S&P500 PE: {len(history)} rows, range {history[0]['date']} ~ {history[-1]['date']}, current={current_pe}")
        return history, current_pe, data_date
    except Exception as e:
        logger.warning(f"[MULTPL] S&P500 PE fetch failed: {e}")
        return [], None, ""


async def _fetch_multpl_pb_history() -> tuple[list[dict], float | None, str]:
    """从 multpl.com 抓取 S&P 500 PB 季度历史（约 106 条，1999 Q4 至今）。

    V4.1 BUG-2026-06-US-PB-STALE:
        同 PE 修复，row-based 解析以捕获 <abbr> 估算行。
        修复后 PB 历史可延伸到 2026-06-18（含估算值）。

    Returns:
        (pb_history, current_pb, data_date)
    """
    import re
    import requests

    url = "https://www.multpl.com/s-p-500-price-to-book/table?f=m"
    try:
        r = await asyncio.to_thread(
            requests.get,
            url,
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        )
        if r.status_code != 200:
            logger.warning(f"[MULTPL] S&P500 PB HTTP {r.status_code}")
            return [], None, ""

        from datetime import datetime as _dt

        def _parse_date(s: str) -> str | None:
            s = s.strip()
            for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %Y", "%B %Y"):
                try:
                    return _dt.strptime(s, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    continue
            return None

        def _parse_val(s: str) -> float | None:
            s = re.sub(r"<[^>]+>", " ", s)
            s = re.sub(r"&[^;]+;", " ", s)
            m = re.search(r"-?\d+\.?\d*", s)
            try:
                return float(m.group()) if m else None
            except ValueError:
                return None

        # row-based 解析（同 PE 修复）
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", r.text, re.DOTALL)
        history: list[dict] = []
        for row in rows:
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
            if len(cells) < 2:
                continue
            date_str = re.sub(r"<[^>]+>", "", cells[0]).strip()
            val_str = cells[1]
            if not date_str or date_str.lower() == "date":
                continue
            d = _parse_date(date_str)
            v = _parse_val(val_str)
            if d and v is not None:
                history.append({"date": d, "value": v})

        history.reverse()
        seen: dict[str, dict] = {}
        for h in history:
            seen[h["date"]] = h
        history = sorted(seen.values(), key=lambda x: x["date"])

        if not history:
            return [], None, ""

        current_pb = history[-1]["value"]
        data_date = history[-1]["date"]
        logger.info(f"[MULTPL] S&P500 PB: {len(history)} rows, range {history[0]['date']} ~ {history[-1]['date']}, current={current_pb}")
        return history, current_pb, data_date
    except Exception as e:
        logger.warning(f"[MULTPL] S&P500 PB fetch failed: {e}")
        return [], None, ""


async def _fetch_us_index_valuation(index_code: str, index_name: str) -> dict:
    """Fetch US index PE/PB.

    V4.1 BUG-2026-06-US-PE-PB: 改用 multpl.com 抓取完整历史。
    - S&P 500 (SPI): multpl.com 原生 PE 月度（1871-至今，1872 条含估算）+ PB 季度（106 条）
    - Nasdaq (IXIC): multpl.com 不支持，用 S&P 500 历史 × 当前比值缩放代理

    V4.1 BUG-2026-06-US-PE-STALE-FIX:
        1. 修复 multpl regex 以捕获 <abbr> 估算行（数据从 2025-09 延伸到今日 2026-06-18）
        2. 用 ETF 日线净值作为时间基准，在 multpl 月度/季度锚点之间线性插值，
           生成日频 PE/PB 历史（5 年 ≈ 1211 个点），解决"近1月/近3月"图表为空的问题
    """
    estimates = _US_INDEX_ESTIMATES.get(index_code, {})
    today = datetime.now().strftime("%Y-%m-%d")

    # ETF code: 标普500 -> 513500, 纳斯达克 -> 513300
    etf_code = "513500" if index_code == "SPI" else "513300"

    # 尝试取美股指数当日价格日期
    sina_symbol = ".INX" if index_code == "SPI" else ".IXIC"
    price_date = today
    try:
        df = await asyncio.to_thread(ak.index_us_stock_sina, symbol=sina_symbol)
        price_date = _date_to_str(df.iloc[-1].get("date", today))
    except Exception as e:
        logger.warning(f"[AKSHARE] Failed to get US index price for {index_code}: {e}")

    # ── 抓 multpl.com S&P 500 PE/PB 历史（含估算行）──
    sp500_pe_history, sp500_pe, sp500_pe_date = await _fetch_multpl_pe_history()
    sp500_pb_history, sp500_pb, sp500_pb_date = await _fetch_multpl_pb_history()

    # 兜底: multpl 失败时用硬编码值
    if sp500_pe is None:
        sp500_pe = estimates.get("pe", 25.0)
        sp500_pe_history = [{"date": today, "value": sp500_pe}]
        sp500_pe_date = today
    if sp500_pb is None:
        sp500_pb = estimates.get("pb", 4.5)
        sp500_pb_history = [{"date": today, "value": sp500_pb}]
        sp500_pb_date = today

    # ── 标普500: 直接用 multpl 数据 ──
    if index_code == "SPI":
        current_pe = sp500_pe
        current_pb = sp500_pb
        pe_history_raw = sp500_pe_history
        pb_history_raw = sp500_pb_history
        pe_scale = 1.0
        pb_scale = 1.0
        pe_source = "multpl.com"
        pb_source = "multpl.com"

    # ── 纳斯达克: 用 S&P 500 历史 × 当前比值缩放代理 ──
    else:  # IXIC
        # 当前 PE/PB 用 _US_INDEX_ESTIMATES（更符合纳斯达克特性）
        current_pe = estimates.get("pe", 40.0)
        current_pb = estimates.get("pb", 5.5)
        # 比例缩放系数
        pe_scale = current_pe / sp500_pe if sp500_pe else 1.0
        pb_scale = current_pb / sp500_pb if sp500_pb else 1.0
        pe_history_raw = sp500_pe_history  # 缩放在插值时应用
        pb_history_raw = sp500_pb_history
        pe_source = "标普500代理"
        pb_source = "标普500代理"
        logger.info(f"[AKSHARE] Nasdaq proxy: pe_scale={pe_scale:.4f}, pb_scale={pb_scale:.4f}")

    # ── 用 ETF 日线净值作为时间基准，构建日频 PE/PB 历史 ──
    # multpl PE 是月度，PB 是季度，"近1月/近3月"图表会几乎为空
    # 通过线性插值填充日频数据点，使短周期图表可读
    pe_history, pb_history = await _build_daily_us_valuation(
        etf_code=etf_code,
        pe_anchors=pe_history_raw,
        pb_anchors=pb_history_raw,
        pe_scale=pe_scale,
        pb_scale=pb_scale,
        fallback_pe=pe_history_raw,
        fallback_pb=pb_history_raw,
    )

    # 如果日频构建成功，用最新点的值作为 current_pe/current_pb
    # (multpl 估算值已经是当日，但通过插值可能与 ETF 净值日期更对齐)
    if pe_history:
        last_pe = pe_history[-1].get("value")
        if last_pe is not None:
            current_pe = last_pe
    if pb_history:
        last_pb = pb_history[-1].get("value")
        if last_pb is not None:
            current_pb = last_pb

    # data_date 用今日（保证比旧硬编码记录新）
    data_date = today

    # 计算分位
    pe_vals = [h["value"] for h in pe_history if h.get("value") is not None]
    pb_vals = [h["value"] for h in pb_history if h.get("value") is not None]
    pe_percentile = calculate_percentile(current_pe, pe_vals) if current_pe and pe_vals else 0
    pb_percentile = calculate_percentile(current_pb, pb_vals) if current_pb and pb_vals else 0

    pe_multi = calculate_multi_period_percentiles(current_pe, pe_history, "value")
    pb_multi = calculate_multi_period_percentiles(current_pb, pb_history, "value")

    result = {
        "pe": safe_num(current_pe),
        "pb": safe_num(current_pb),
        "pe_percentile": safe_num(pe_percentile) if pe_percentile else 0,
        "pb_percentile": safe_num(pb_percentile) if pb_percentile else 0,
        "date": data_date,
        "pe_history": clean_numeric_series(pe_history, "value"),
        "pb_history": clean_numeric_series(pb_history, "value"),
        # V4 多周期分位（§3）
        "pe_percentile_1y": pe_multi["1y"],
        "pe_percentile_3y": pe_multi["3y"],
        "pe_percentile_5y": pe_multi["5y"],
        "pe_percentile_10y": pe_multi["10y"],
        "pe_percentile_all": pe_multi["all"],
        "pb_percentile_1y": pb_multi["1y"],
        "pb_percentile_3y": pb_multi["3y"],
        "pb_percentile_5y": pb_multi["5y"],
        "pb_percentile_10y": pb_multi["10y"],
        "pb_percentile_all": pb_multi["all"],
        "sample_days": pe_multi["sample_days"],
        # V4.1 BUG-2026-06-US-PE-PB: PE/PB 数据来源标注
        "pe_source": pe_source,
        "pb_source": pb_source,
        "is_estimated": index_code == "IXIC",  # 纳斯达克仍标 estimated
    }

    _save_to_cache(index_code, "valuation", data_date, result)
    return result


async def _build_daily_us_valuation(
    etf_code: str,
    pe_anchors: list[dict],
    pb_anchors: list[dict],
    pe_scale: float = 1.0,
    pb_scale: float = 1.0,
    fallback_pe: list[dict] | None = None,
    fallback_pb: list[dict] | None = None,
) -> tuple[list[dict], list[dict]]:
    """用 ETF 日线净值作为时间基准，对 multpl 月度/季度锚点线性插值生成日频 PE/PB 历史。

    V4.1 BUG-2026-06-US-PE-STALE-FIX:
        - multpl PE 月度（每月1个点）/ PB 季度（每季1个点）
        - 当用户切换"近1月/近3月"时间窗时，原数据只有 1-3 个点，图表几乎为空
        - 用 ETF 日线净值日期（约 1211 个交易日 ≈ 5 年）作为时间基准
        - 对每个 NAV 日期，在相邻 multpl 锚点之间做线性插值
        - 结果: 日频 PE/PB 历史，5 年覆盖，短周期图表可读

    Args:
        etf_code: ETF 代码（513500 标普500 / 513300 纳斯达克）
        pe_anchors: multpl PE 历史 [{"date": "YYYY-MM-DD", "value": float}]
        pb_anchors: multpl PB 历史
        pe_scale: 纳斯达克 PE 缩放系数（标普500=1.0）
        pb_scale: 纳斯达克 PB 缩放系数
        fallback_pe/pb: 插值失败时返回的兜底数据

    Returns:
        (daily_pe_history, daily_pb_history)
    """
    fallback_pe = fallback_pe or pe_anchors
    fallback_pb = fallback_pb or pb_anchors

    # 1. 取 ETF 日线净值（5 年 ≈ 1211 点）
    nav_dates: list[str] = []
    try:
        from services import eastmoney_direct_service
        em_result = await eastmoney_direct_service.fetch_etf_kline(etf_code, pages=60)
        klines = em_result.get("kline_history") or []
        seen = set()
        for k in klines:
            d = k.get("date")
            if d and d not in seen:
                seen.add(d)
                nav_dates.append(d)
        nav_dates.sort()
    except Exception as e:
        logger.warning(f"[US-DAILY] Failed to fetch ETF kline for {etf_code}: {e}")
        return fallback_pe, fallback_pb

    if len(nav_dates) < 10:
        logger.warning(f"[US-DAILY] {etf_code} nav_dates too few: {len(nav_dates)}")
        return fallback_pe, fallback_pb

    # 2. 准备锚点列表（应用缩放，按日期升序）
    from datetime import datetime as _dt

    def _prep(anchors: list[dict], scale: float) -> list[tuple[str, float, int]]:
        out = []
        for h in anchors:
            v = h.get("value")
            d = h.get("date")
            if v is None or not d:
                continue
            try:
                t = _dt.strptime(d[:10], "%Y-%m-%d").toordinal()
            except Exception:
                continue
            out.append((d[:10], float(v) * scale, t))
        out.sort(key=lambda x: x[2])
        return out

    pe_pts = _prep(pe_anchors, pe_scale)
    pb_pts = _prep(pb_anchors, pb_scale)

    if not pe_pts or not pb_pts:
        logger.warning(f"[US-DAILY] {etf_code} empty anchors: pe={len(pe_pts)} pb={len(pb_pts)}")
        return fallback_pe, fallback_pb

    # 3. 线性插值函数
    def _interp(pts: list[tuple[str, float, int]], target_date: str) -> float | None:
        try:
            tt = _dt.strptime(target_date[:10], "%Y-%m-%d").toordinal()
        except Exception:
            return None
        # 早于第一个锚点：返回首值
        if tt < pts[0][2]:
            return round(pts[0][1], 2)
        # 晚于最后一个锚点：返回末值（multpl 现已含估算到今日，一般不会超）
        if tt > pts[-1][2]:
            return round(pts[-1][1], 2)
        # 二分查找包围区间
        lo, hi = 0, len(pts) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if pts[mid][2] <= tt:
                lo = mid
            else:
                hi = mid
        d0, v0, t0 = pts[lo]
        d1, v1, t1 = pts[hi]
        if t1 == t0:
            return round(v0, 2)
        ratio = (tt - t0) / (t1 - t0)
        return round(v0 + (v1 - v0) * ratio, 2)

    # 4. 对每个 NAV 日期做插值
    daily_pe: list[dict] = []
    daily_pb: list[dict] = []
    for d in nav_dates:
        # 只保留 ETF 上市后的数据（即首个 NAV 日期之后）
        v_pe = _interp(pe_pts, d)
        v_pb = _interp(pb_pts, d)
        if v_pe is not None:
            daily_pe.append({"date": d, "value": v_pe})
        if v_pb is not None:
            daily_pb.append({"date": d, "value": v_pb})

    logger.info(
        f"[US-DAILY] {etf_code} ({index_code_label(etf_code)}): "
        f"pe {len(pe_anchors)}→{len(daily_pe)} pts, pb {len(pb_anchors)}→{len(daily_pb)} pts, "
        f"range {daily_pe[0]['date'] if daily_pe else 'N/A'}~{daily_pe[-1]['date'] if daily_pe else 'N/A'}"
    )
    return daily_pe, daily_pb


def index_code_label(etf_code: str) -> str:
    """ETF 代码 -> 简短标签，仅用于日志。"""
    return {
        "513500": "S&P500",
        "513300": "Nasdaq",
        "159338": "A500",
        "510880": "红利",
        "510330": "沪深300",
        "588000": "科创50",
    }.get(etf_code, etf_code)


# ─── ETF Premium (fast: uses cached spot data) ───────────────────────────

async def fetch_etf_premium(etf_code: str, include_history: bool = False) -> dict:
    """Fetch ETF premium rate.

    By default only fetches today's premium from real-time spot data.
    Set include_history=True to also calculate 30-day historical premium
    (this is slower as it requires additional API calls).
    """
    logger.info(f"[AKSHARE] fetch_etf_premium: etf_code={etf_code}, include_history={include_history}")

    premium_today = None
    data_date = datetime.now().strftime("%Y-%m-%d")

    # Get today's premium from shared spot data
    try:
        spot_df = await _get_etf_spot_data()
        row = spot_df[spot_df["代码"] == etf_code]
        if not row.empty:
            r = row.iloc[0]
            discount_rate = _safe_float(r.get("基金折价率"))
            premium_today = round(-discount_rate, 2) if discount_rate is not None else None
            data_date = _date_to_str_short(r.get("数据日期", datetime.now()))
    except Exception as e:
        logger.error(f"[AKSHARE] fund_etf_spot_em error for {etf_code}: {e}")

    # Calculate 7-day and 30-day historical premium only if requested
    premium_30d = []
    premium_7d_avg = None

    if include_history:
        try:
            premium_30d = await _fetch_historical_premium(etf_code, days=30)
        except Exception as e:
            logger.error(f"[AKSHARE] Historical premium error for {etf_code}: {e}")

        if premium_30d:
            last_7 = premium_30d[-7:] if len(premium_30d) >= 7 else premium_30d
            premiums_7d = [p["premium"] for p in last_7 if p.get("premium") is not None]
            if premiums_7d:
                premium_7d_avg = round(sum(premiums_7d) / len(premiums_7d), 2)

    # V4.1 BUG-2026-06-PREMIUM-AVG: 删除 "premium_7d_avg 兜底为 premium_today" 的错误逻辑
    # 旧逻辑导致 3d/7d 均值与当日值完全相同，无任何趋势参考价值。
    # 现在 premium_7d_avg 在历史拉取失败时保持 None，由 cached.py 从 DB 历史 premium_today 重建。
    # 同时，把今天的值追加到 premium_30d 末尾，保证当日数据点入序列
    if premium_today is not None:
        today_point = {"date": data_date, "premium": premium_today}
        # 避免重复日期
        if not premium_30d or premium_30d[-1].get("date") != data_date:
            premium_30d.append(today_point)
            premium_30d = premium_30d[-30:]  # 仅保留最近 30 个交易日

    # 如果有 30d 序列但 7d_avg 仍是 None（走到这里说明上面 if premium_30d 分支没进，但下面又补了今天），重新计算
    if premium_7d_avg is None and premium_30d:
        last_7 = premium_30d[-7:] if len(premium_30d) >= 7 else premium_30d
        premiums_7d = [p["premium"] for p in last_7 if p.get("premium") is not None]
        if premiums_7d:
            premium_7d_avg = round(sum(premiums_7d) / len(premiums_7d), 2)

    result = {
        "premium_today": safe_num(premium_today),
        "premium_7d_avg": safe_num(premium_7d_avg),
        "premium_30d": clean_numeric_series(premium_30d, "premium"),
        "date": data_date,
    }

    _save_to_cache(etf_code, "premium", data_date, result)
    return result


async def _fetch_historical_premium(etf_code: str, days: int = 30) -> list[dict]:
    """Calculate historical premium from price and NAV data."""
    if etf_code.startswith("5") or etf_code.startswith("6"):
        sina_prefix = "sh"
    else:
        sina_prefix = "sz"
    sina_symbol = f"{sina_prefix}{etf_code}"

    try:
        price_df = await asyncio.to_thread(ak.fund_etf_hist_sina, symbol=sina_symbol)
    except Exception as e:
        logger.error(f"[AKSHARE] fund_etf_hist_sina error for {sina_symbol}: {e}")
        return []

    try:
        nav_df = await asyncio.to_thread(ak.fund_etf_fund_info_em, fund=etf_code)
    except Exception as e:
        logger.error(f"[AKSHARE] fund_etf_fund_info_em error for {etf_code}: {e}")
        return []

    nav_df = nav_df.dropna(subset=["净值日期"])
    nav_df["净值日期_str"] = nav_df["净值日期"].apply(_date_to_str)
    price_df["date_str"] = price_df["date"].apply(_date_to_str)

    nav_lookup = {}
    for _, row in nav_df.iterrows():
        d = row["净值日期_str"]
        nav_val = _safe_float(row.get("单位净值"))
        if d and nav_val is not None:
            nav_lookup[d] = nav_val

    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    result = []

    for _, row in price_df.iterrows():
        d = row["date_str"]
        if d < cutoff:
            continue
        close = _safe_float(row.get("close"))
        nav = nav_lookup.get(d)
        if close and nav and nav > 0:
            premium = round((close - nav) / nav * 100, 2)
            result.append({"date": d, "premium": premium})

    return result


# ─── ETF NAV ──────────────────────────────────────────────────────────────────

async def fetch_etf_nav(etf_code: str) -> dict:
    """Fetch ETF latest NAV and historical NAV (up to 5 years)."""
    logger.info(f"[AKSHARE] fetch_etf_nav: etf_code={etf_code}")

    try:
        start_date = (datetime.now() - timedelta(days=5 * 365)).strftime("%Y%m%d")
        end_date = datetime.now().strftime("%Y%m%d")
        df = await asyncio.to_thread(
            ak.fund_etf_fund_info_em, fund=etf_code, start_date=start_date, end_date=end_date,
        )
    except Exception as e:
        logger.error(f"[AKSHARE] fund_etf_fund_info_em error for {etf_code}: {e}")
        today = datetime.now().strftime("%Y-%m-%d")
        return {"nav": None, "date": today, "nav_history": []}

    df = df.dropna(subset=["净值日期"])

    if df.empty:
        today = datetime.now().strftime("%Y-%m-%d")
        return {"nav": None, "date": today, "nav_history": []}

    last_row = df.iloc[-1]
    nav = _safe_float(last_row.get("单位净值"))
    data_date = _date_to_str(last_row.get("净值日期", datetime.now()))

    # Build nav history (sampled to ~250 points for charting)
    nav_history = []
    for _, row in df.iterrows():
        d = _date_to_str(row.get("净值日期"))
        v = _safe_float(row.get("单位净值"))
        if d and v is not None:
            nav_history.append({"date": d, "nav": v})

    if len(nav_history) > 500:
        step = len(nav_history) // 500
        nav_history = nav_history[::step] + [nav_history[-1]]

    result = {"nav": safe_num(nav), "date": data_date, "nav_history": clean_numeric_series(nav_history, "nav")}
    _save_to_cache(etf_code, "nav", data_date, result)
    return result


# ─── ETF K-line (OHLCV) ──────────────────────────────────────────────────────

async def fetch_etf_kline(etf_code: str, period: str = "daily") -> dict:
    """Fetch ETF K-line (OHLCV) data for candlestick charts.
    
    Args:
        etf_code: ETF code, e.g. '159338'
        period: 'daily', 'weekly', 'monthly'
    
    Returns:
        Dict with kline_history list of {date, open, high, low, close, volume}
    
    V4.1 BUG-2026-06-A500-KLINE:
        akshare.fund_etf_hist_sina 在沙箱网络环境常失败（新浪源不可达）。
        fallback 到 eastmoney_direct.fetch_etf_kline（LSJZ 历史净值代理），
        返回值含 is_nav_proxy=True 标注，前端展示"净值代理"徽标。
    """
    logger.info(f"[AKSHARE] fetch_etf_kline: etf_code={etf_code}, period={period}")
    
    # Map period to akshare parameter
    period_map = {"daily": "daily", "weekly": "weekly", "monthly": "monthly"}
    ak_period = period_map.get(period, "daily")
    
    if etf_code.startswith("5") or etf_code.startswith("6"):
        sina_prefix = "sh"
    else:
        sina_prefix = "sz"
    sina_symbol = f"{sina_prefix}{etf_code}"
    
    try:
        # Use fund_etf_hist_sina for K-line data
        df = await asyncio.to_thread(ak.fund_etf_hist_sina, symbol=sina_symbol)
    except Exception as e:
        logger.warning(f"[AKSHARE] fund_etf_hist_sina error for {sina_symbol}: {str(e)[:120]}")
        df = None
    
    if df is None or df.empty:
        # ── Fallback: 用 eastmoney_direct LSJZ 历史净值代理 K线 ──
        logger.info(f"[AKSHARE] kline fallback to eastmoney_direct (LSJZ nav proxy) for {etf_code}")
        try:
            from services import eastmoney_direct_service
            em_result = await eastmoney_direct_service.fetch_etf_kline(etf_code, pages=13)
            # 透传 eastmoney_direct 的字段（is_nav_proxy / source / source_api）
            return em_result
        except Exception as e:
            logger.error(f"[AKSHARE] eastmoney_direct kline fallback also failed for {etf_code}: {e}")
            today = datetime.now().strftime("%Y-%m-%d")
            return {"date": today, "kline_history": [], "is_nav_proxy": True,
                    "source": "all_failed", "source_api": "akshare_sina+eastmoney_lsjz"}
    
    # Build kline history from the dataframe
    kline_history = []
    for _, row in df.iterrows():
        d = _date_to_str(row.get("date"))
        open_val = _safe_float(row.get("open"))
        high_val = _safe_float(row.get("high"))
        low_val = _safe_float(row.get("low"))
        close_val = _safe_float(row.get("close"))
        volume_val = _safe_float(row.get("volume"))
        
        if d and close_val is not None:
            kline_history.append({
                "date": d,
                "open": open_val,
                "high": high_val,
                "low": low_val,
                "close": close_val,
                "volume": volume_val,
            })
    
    # Limit to last 5 years and sample if too many points
    five_years_ago = (datetime.now() - timedelta(days=5 * 365)).strftime("%Y-%m-%d")
    kline_history = [k for k in kline_history if k["date"] >= five_years_ago]

    if len(kline_history) > 800:
        step = len(kline_history) // 800
        kline_history = kline_history[::step] + [kline_history[-1]]

    # Apply safe_num to OHLCV values to eliminate any sentinel values
    for k in kline_history:
        k["open"] = safe_num(k.get("open"))
        k["high"] = safe_num(k.get("high"))
        k["low"] = safe_num(k.get("low"))
        k["close"] = safe_num(k.get("close"))
        k["volume"] = safe_num(k.get("volume"))

    data_date = kline_history[-1]["date"] if kline_history else datetime.now().strftime("%Y-%m-%d")

    result = {"date": data_date, "kline_history": kline_history, "is_nav_proxy": False,
              "source": "akshare", "source_api": "akshare:fund_etf_hist_sina"}
    _save_to_cache(etf_code, "kline", data_date, result)
    return result


# ─── Dividend Yield ───────────────────────────────────────────────────────────

async def fetch_dividend_yield(index_code: str = "000015") -> dict:
    """Fetch dividend yield for dividend index."""
    logger.info(f"[AKSHARE] fetch_dividend_yield: index_code={index_code}")

    try:
        df = await asyncio.to_thread(ak.stock_zh_index_value_csindex, symbol=index_code)
    except Exception as e:
        logger.error(f"[AKSHARE] csindex API error for {index_code}: {e}")
        today = datetime.now().strftime("%Y-%m-%d")
        return {"dividend_yield": 0, "dividend_yield_percentile": 0, "dividend_yield_history": [], "date": today}

    df = df.sort_values("日期", ascending=True)
    last_row = df.iloc[-1]
    dividend_yield = _safe_float(last_row.get("股息率2", last_row.get("股息率1")))
    data_date = _date_to_str(last_row.get("日期", datetime.now()))

    dy_col = "股息率2" if "股息率2" in df.columns else "股息率1"
    dy_vals = [_safe_float(v) for v in df[dy_col].tolist() if _safe_float(v) is not None]
    dy_percentile = calculate_percentile(dividend_yield, dy_vals) if dividend_yield else 0

    dividend_yield_history = []
    for _, row in df.iterrows():
        d = _date_to_str(row.get("日期"))
        v = _safe_float(row.get(dy_col))
        if d and v is not None:
            dividend_yield_history.append({"date": d, "value": v})

    result = {
        "dividend_yield": safe_num(dividend_yield),
        "dividend_yield_percentile": safe_num(dy_percentile) if dy_percentile else 0,
        "dividend_yield_history": clean_numeric_series(dividend_yield_history, "value"),
        "date": data_date,
    }

    _save_to_cache(index_code, "dividend", data_date, result)
    return result


# ─── Refresh all ──────────────────────────────────────────────────────────────

async def refresh_all_data(codes: list[str] | None = None) -> list[str]:
    """Refresh all data for the given codes (or all tracked codes if None).

    Optimized to:
    - Call fund_etf_spot_em only ONCE (shared across all premium fetches)
    - Skip historical premium during quick refresh
    """
    if codes is None:
        codes = list(TRACKED_ETFS.keys())

    # Pre-fetch ETF spot data (once for all ETFs)
    try:
        await _get_etf_spot_data()
        logger.info("[AKSHARE] Pre-fetched ETF spot data for all ETFs")
    except Exception as e:
        logger.error(f"[AKSHARE] Failed to pre-fetch ETF spot data: {e}")
        # V4 策略书§10.2: 数据源失效告警
        _record_source_status("AkShare", "etf_spot", success=False, error=str(e)[:200])

    # V4 策略书§10.2: 检查 AkShare 是否完全失效（spot 数据获取失败视为关键失效）
    spot_failed = False
    try:
        spot_df = await _get_etf_spot_data()
        if spot_df is None or len(spot_df) == 0:
            spot_failed = True
    except Exception:
        spot_failed = True

    if spot_failed:
        # 尝试备源切换（当前 Tushare 未配置，记录告警）
        _record_source_status("AkShare", "critical_failure", success=False, error="ETF spot data unavailable - 主源失效")
        logger.warning("[AKSHARE] Critical failure: ETF spot data unavailable. Backup source (Tushare) not configured.")

    updated = []
    refresh_start = datetime.now()
    for code in codes:
        etf_info = TRACKED_ETFS.get(code)
        if not etf_info:
            continue

        try:
            index_code = etf_info["index_code"]
            index_name = etf_info.get("index_name", "")

            # 1. Fetch valuation
            try:
                val = await fetch_index_valuation(index_code, index_name)
                logger.info(f"[AKSHARE] Valuation updated for {code}: PE={val.get('pe')}")
            except Exception as e:
                logger.error(f"[AKSHARE] Valuation error for {code}: {e}")

            # 2. Fetch premium (with history for QDII ETFs)
            try:
                is_overseas = etf_info.get("category") == "overseas"
                prem = await fetch_etf_premium(code, include_history=is_overseas)
                logger.info(f"[AKSHARE] Premium updated for {code}: {prem.get('premium_today')} (history={'yes' if is_overseas else 'no'})")
            except Exception as e:
                logger.error(f"[AKSHARE] Premium error for {code}: {e}")

            # 3. Fetch NAV
            try:
                nav = await fetch_etf_nav(code)
                logger.info(f"[AKSHARE] NAV updated for {code}: {nav.get('nav')}")
            except Exception as e:
                logger.error(f"[AKSHARE] NAV error for {code}: {e}")

            # 3.5 Fetch K-line data
            try:
                kline = await fetch_etf_kline(code)
                logger.info(f"[AKSHARE] K-line updated for {code}: {len(kline.get('kline_history', []))} points")
            except Exception as e:
                logger.error(f"[AKSHARE] K-line error for {code}: {e}")

            # 4. Fetch dividend for dividend index
            if code == "510880":
                try:
                    div = await fetch_dividend_yield(index_code)
                    logger.info(f"[AKSHARE] Dividend updated for {code}: yield={div.get('dividend_yield')}")
                except Exception as e:
                    logger.error(f"[AKSHARE] Dividend error for {code}: {e}")

            updated.append(code)
        except Exception as e:
            logger.error(f"Error refreshing data for {code}: {e}")

    # V4 PRD§12.4: 记录数据源拉取状态
    latency = int((datetime.now() - refresh_start).total_seconds() * 1000)
    _record_source_status("AkShare", "all_data_types", success=True, latency_ms=latency)

    return updated


# ─── Market Index Data (broad market indices for Trends page) ──────────────────

async def fetch_market_index_data(index_code: str) -> dict:
    """Fetch broad market index data: current value, daily change, and 60-day price history.

    Uses akshare's stock_zh_index_daily (Sina) for A-share indices and
    stock_hk_index_daily_sina for Hong Kong indices.
    These Sina-based APIs are more reliable than the East Money equivalents.
    """
    index_info = MARKET_INDICES.get(index_code)
    if not index_info:
        logger.error(f"[AKSHARE] Unknown market index: {index_code}")
        return {"code": index_code, "name": "", "currentValue": None, "dailyChange": None, "dailyChangePercent": None, "priceHistory": [], "date": ""}

    name = index_info["name"]
    category = index_info["category"]
    sina_symbol = index_info["sina_symbol"]

    logger.info(f"[AKSHARE] fetch_market_index_data: {index_code} ({name})")

    try:
        if category == "A股":
            # A-share indices: use stock_zh_index_daily (Sina Finance)
            # Columns: date, open, high, low, close, volume
            df = await asyncio.to_thread(ak.stock_zh_index_daily, symbol=sina_symbol)
            df = df.sort_values("date", ascending=True)
            last_row = df.iloc[-1]
            current_value = _safe_float(last_row.get("close"))
            prev_close = _safe_float(df.iloc[-2].get("close")) if len(df) >= 2 else None
            data_date = _date_to_str(last_row.get("date", datetime.now()))

            # Build 60-day price history (for chart + MA calculation)
            price_history = []
            recent_df = df.tail(60)
            for _, row in recent_df.iterrows():
                d = _date_to_str(row.get("date"))
                v = _safe_float(row.get("close"))
                if d and v is not None:
                    price_history.append({"date": d, "value": v})

        elif category == "港股":
            # Hong Kong indices: use stock_hk_index_daily_sina
            # Columns: date, open, high, low, close, volume, amount
            df = await asyncio.to_thread(ak.stock_hk_index_daily_sina, symbol=sina_symbol)
            df = df.sort_values("date", ascending=True)
            last_row = df.iloc[-1]
            current_value = _safe_float(last_row.get("close"))
            prev_close = _safe_float(df.iloc[-2].get("close")) if len(df) >= 2 else None
            data_date = _date_to_str(last_row.get("date", datetime.now()))

            price_history = []
            recent_df = df.tail(60)
            for _, row in recent_df.iterrows():
                d = _date_to_str(row.get("date"))
                v = _safe_float(row.get("close"))
                if d and v is not None:
                    price_history.append({"date": d, "value": v})
        else:
            logger.warning(f"[AKSHARE] Unknown category for {index_code}: {category}")
            return {"code": index_code, "name": name, "currentValue": None, "dailyChange": None, "dailyChangePercent": None, "priceHistory": [], "date": ""}

    except Exception as e:
        logger.error(f"[AKSHARE] Market index error for {index_code} ({name}): {e}")
        return {"code": index_code, "name": name, "currentValue": None, "dailyChange": None, "dailyChangePercent": None, "priceHistory": [], "date": ""}

    # Calculate daily change
    daily_change = None
    daily_change_pct = None
    cv = safe_num(current_value)
    pc = safe_num(prev_close)
    if cv is not None and pc is not None and pc > 0:
        daily_change = round(cv - pc, 2)
        daily_change_pct = round((cv - pc) / pc * 100, 2)

    # Compute MA20 and MA60
    closes = [p["value"] for p in price_history if p["value"] is not None]
    ma20 = round(sum(closes[-20:]) / len(closes[-20:]), 2) if len(closes) >= 20 else None
    ma60 = round(sum(closes[-60:]) / len(closes[-60:]), 2) if len(closes) >= 60 else None

    result = {
        "code": index_code,
        "name": name,
        "category": category,
        "currentValue": safe_num(current_value),
        "dailyChange": safe_num(daily_change),
        "dailyChangePercent": safe_num(daily_change_pct),
        "ma20": safe_num(ma20),
        "ma60": safe_num(ma60),
        "priceHistory": clean_numeric_series(price_history, "value"),
        "date": data_date,
    }

    _save_to_cache(index_code, "market_index", data_date, result)
    return result


async def refresh_market_indices() -> list[str]:
    """Refresh all broad market index data."""
    updated = []
    for code in MARKET_INDICES:
        try:
            result = await fetch_market_index_data(code)
            if result.get("currentValue") is not None:
                updated.append(code)
                logger.info(f"[AKSHARE] Market index updated: {code} ({result.get('name')}) = {result.get('currentValue')}")
            await asyncio.sleep(0.5)
        except Exception as e:
            logger.error(f"[AKSHARE] Error refreshing market index {code}: {e}")
    return updated


# ─── Utility ──────────────────────────────────────────────────────────────────

def _sample_history(df: pd.DataFrame, date_col: str, value_col: str, max_points: int = 250) -> list[dict]:
    """Sample a DataFrame into a list of {date, value} dicts."""
    if df.empty:
        return []

    result = []
    if len(df) <= max_points:
        for _, row in df.iterrows():
            d = _date_to_str(row.get(date_col))
            v = _safe_float(row.get(value_col))
            if d and v is not None:
                result.append({"date": d, "value": v})
    else:
        step = len(df) // max_points
        sampled = df.iloc[::step]
        if sampled.iloc[-1].name != df.iloc[-1].name:
            sampled = pd.concat([sampled, df.iloc[[-1]]])
        for _, row in sampled.iterrows():
            d = _date_to_str(row.get(date_col))
            v = _safe_float(row.get(value_col))
            if d and v is not None:
                result.append({"date": d, "value": v})

    return result


# ─── Forex (USD/CNY) — 文档范围外增强：汇率影响监控 ──────────────────────────────

async def fetch_forex_usd_cny() -> dict:
    """获取美元/人民币汇率（中行折算价）。

    用于监控汇率对海外配置(QDII)的实际购买力影响。
    """
    try:
        from datetime import timedelta
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=30)).strftime("%Y%m%d")

        df = await asyncio.to_thread(ak.currency_boc_sina, symbol="美元", start_date=start_date, end_date=end_date)
        if df.empty:
            return {"rate": None, "date": "", "history": [], "message": "无汇率数据"}

        df = df.sort_values("日期", ascending=True)
        last_row = df.iloc[-1]
        rate = _safe_float(last_row.get("中行折算价"))
        data_date = _date_to_str(last_row.get("日期"))

        # 取最近30天历史
        history = []
        for _, row in df.iterrows():
            d = _date_to_str(row.get("日期"))
            v = _safe_float(row.get("中行折算价"))
            if d and v is not None:
                history.append({"date": d, "value": v / 100.0})  # 转为标准汇率

        result = {
            "rate": rate / 100.0 if rate else None,  # 中行折算价是*100的，如680.96→6.8096
            "date": data_date,
            "history": history,
            "source": "akshare/boc_sina",
            "message": f"USD/CNY={rate/100.0:.4f}" if rate else "汇率获取失败",
        }

        _save_to_cache("USDCNY", "forex", data_date, result)
        return result
    except Exception as e:
        logger.error(f"[AKSHARE] Forex USD/CNY error: {e}")
        return {"rate": None, "date": "", "history": [], "message": f"汇率获取失败: {e}"}
