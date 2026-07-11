"""V4.2 PRD§11 宏观温度计模块 — 4个日频指标数据拉取。

指标:
- cn_10y_bond_yield: 中国10年期国债收益率
- us_10y_treasury_yield: 美国10年期国债收益率
- usd_cnh: USD/CNH 离岸人民币汇率
- vix: VIX恐慌指数

原则: 宏观模块只做提示, 不改金额、不触发卖出、不覆盖规则引擎。
"""
import asyncio
import json
import logging
import sqlite3
import urllib.request
from datetime import datetime, timedelta
from typing import Optional

from config import DB_PATH

logger = logging.getLogger(__name__)

# 宏观指标 metric_type 常量
METRIC_CN_10Y_BOND = "cn_10y_bond_yield"
METRIC_US_10Y_TREASURY = "us_10y_treasury_yield"
METRIC_USD_CNH = "usd_cnh"
METRIC_VIX = "vix"

# V5.1 恐慌情绪指标体系新增(4个)
METRIC_VVIX = "vvix"
METRIC_SKEW = "skew"
METRIC_50ETF_QVIX = "qvix_50etf"
METRIC_300ETF_QVIX = "qvix_300etf"

# 指标分类
US_FEAR_METRICS = [METRIC_VIX, METRIC_VVIX, METRIC_SKEW]
CN_SENTIMENT_METRICS = [METRIC_50ETF_QVIX, METRIC_300ETF_QVIX]
ALL_FEAR_METRICS = US_FEAR_METRICS + CN_SENTIMENT_METRICS

ALL_MACRO_METRICS = [METRIC_CN_10Y_BOND, METRIC_US_10Y_TREASURY, METRIC_USD_CNH, METRIC_VIX,
                     METRIC_VVIX, METRIC_SKEW, METRIC_50ETF_QVIX, METRIC_300ETF_QVIX]

# 指标元信息(含分类)
MACRO_METRIC_META = {
    # 原有4个(利率+汇率)归"宏观温度计"
    METRIC_CN_10Y_BOND: {"name": "中国10年国债收益率", "unit": "%", "affects": "红利ETF、A股估值", "category": "macro_rate", "category_label": "利率与汇率", "direction": "up_negative"},
    METRIC_US_10Y_TREASURY: {"name": "美国10年国债收益率", "unit": "%", "affects": "标普500、纳斯达克、科创50", "category": "macro_rate", "category_label": "利率与汇率", "direction": "up_negative"},
    METRIC_USD_CNH: {"name": "USD/CNH离岸人民币", "unit": "", "affects": "A股宽基、QDII人民币收益", "category": "macro_rate", "category_label": "利率与汇率", "direction": "up_negative"},
    # 美股恐慌
    METRIC_VIX: {"name": "VIX恐慌指数", "unit": "", "affects": "全球风险偏好、现金水池战略价值", "category": "us_fear", "category_label": "美股恐慌指数", "direction": "up_negative"},
    METRIC_VVIX: {"name": "VVIX(VIX波动率)", "unit": "", "affects": "恐慌加速度", "category": "us_fear", "category_label": "美股恐慌指数", "direction": "up_negative"},
    METRIC_SKEW: {"name": "SKEW(尾部风险)", "unit": "", "affects": "黑天鹅担忧", "category": "us_fear", "category_label": "美股恐慌指数", "direction": "up_negative"},
    # A股情绪
    METRIC_50ETF_QVIX: {"name": "50ETF波指(QVIX)", "unit": "", "affects": "A股50ETF隐含波动率", "category": "cn_sentiment", "category_label": "A股情绪指标", "direction": "up_negative"},
    METRIC_300ETF_QVIX: {"name": "300ETF波指(QVIX)", "unit": "", "affects": "沪深300隐含波动率", "category": "cn_sentiment", "category_label": "A股情绪指标", "direction": "up_negative"},
}


def _ensure_macro_tables(conn: sqlite3.Connection) -> None:
    """V4.2 PRD§11.14: 建宏观3张表(幂等)。"""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS macro_metric_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_type TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            raw_value TEXT,
            clean_value REAL,
            source_id TEXT,
            source_api TEXT,
            quality_score REAL,
            quality_status TEXT,
            can_use_for_macro_prompt BOOLEAN DEFAULT 1,
            abnormal_reason TEXT,
            fetch_time TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(metric_type, trade_date, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_macro_metric_type_date ON macro_metric_cache(metric_type, trade_date DESC);

        CREATE TABLE IF NOT EXISTS macro_prompt_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_id TEXT UNIQUE,
            calculation_id TEXT,
            metric_type TEXT,
            trigger_type TEXT,
            current_value REAL,
            weekly_change REAL,
            monthly_change REAL,
            threshold REAL,
            prompt_text TEXT,
            severity TEXT,
            created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_macro_prompt_log_time ON macro_prompt_log(created_at DESC);

        CREATE TABLE IF NOT EXISTS macro_config (
            id TEXT PRIMARY KEY,
            metric_type TEXT,
            trigger_name TEXT,
            threshold_value REAL,
            threshold_unit TEXT,
            severity TEXT,
            enabled BOOLEAN DEFAULT 1,
            display_text TEXT,
            updated_at TEXT
        );
    """)
    # 初始化默认阈值配置(V4.2 PRD§11.5)
    defaults = [
        ("cn_bond_weekly_15bp", METRIC_CN_10Y_BOND, "单周变化>=15bp", 15.0, "bp", "normal", 1, "中国10年国债收益率单周上行15bp"),
        ("cn_bond_weekly_25bp", METRIC_CN_10Y_BOND, "单周变化>=25bp", 25.0, "bp", "strong", 1, "中国10年国债收益率单周上行25bp(强提示)"),
        ("us_treasury_weekly_25bp", METRIC_US_10Y_TREASURY, "单周变化>=25bp", 25.0, "bp", "normal", 1, "美国10年国债收益率单周上行25bp"),
        ("us_treasury_weekly_35bp", METRIC_US_10Y_TREASURY, "单周变化>=35bp", 35.0, "bp", "strong", 1, "美国10年国债收益率单周上行35bp(强提示)"),
        ("usd_cnh_weekly_1pct", METRIC_USD_CNH, "单周变化>=1%", 1.0, "pct", "normal", 1, "USD/CNH单周上行1%"),
        ("usd_cnh_weekly_2pct", METRIC_USD_CNH, "单周变化>=2%", 2.0, "pct", "strong", 1, "USD/CNH单周上行2%(强提示)"),
        ("vix_break_30", METRIC_VIX, "突破30", 30.0, "level", "strong", 1, "VIX突破30(强提示)"),
        ("vix_weekly_30pct", METRIC_VIX, "单周上升>=30%", 30.0, "pct", "normal", 1, "VIX单周上升30%"),
        ("vix_weekly_50pct", METRIC_VIX, "单周上升>=50%", 50.0, "pct", "strong", 1, "VIX单周上升50%(强提示)"),
        # V5.1 恐慌情绪指标阈值
        ("vvix_high_100", METRIC_VVIX, "VVIX>100(恐慌加速)", 100.0, "level", "strong", 1, "VVIX突破100,恐慌正在加速"),
        ("skew_high_150", METRIC_SKEW, "SKEW>150(尾部风险)", 150.0, "level", "strong", 1, "SKEW突破150,黑天鹅担忧升温"),
        ("qvix50_low_15", METRIC_50ETF_QVIX, "50ETF波指<15(市场平静)", 15.0, "level_low", "normal", 1, "50ETF波指低于15,市场情绪平静"),
        ("qvix50_high_30", METRIC_50ETF_QVIX, "50ETF波指>30(恐慌)", 30.0, "level", "strong", 1, "50ETF波指突破30,A股恐慌升温"),
        ("qvix300_high_30", METRIC_300ETF_QVIX, "300ETF波指>30(恐慌)", 30.0, "level", "strong", 1, "300ETF波指突破30,沪深300恐慌升温"),
    ]
    now = datetime.now().isoformat()
    for d in defaults:
        conn.execute(
            "INSERT OR IGNORE INTO macro_config (id, metric_type, trigger_name, threshold_value, threshold_unit, severity, enabled, display_text, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (*d, now),
        )
    conn.commit()


def _save_macro_metric(metric_type: str, trade_date: str, raw_value, clean_value: Optional[float],
                       source_id: str, source_api: str, quality_status: str = "usable") -> None:
    """保存宏观指标到 macro_metric_cache。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            _ensure_macro_tables(conn)
            now = datetime.now().isoformat()
            quality_score = 85.0 if clean_value is not None else 0.0
            conn.execute(
                """INSERT OR REPLACE INTO macro_metric_cache
                   (metric_type, trade_date, raw_value, clean_value, source_id, source_api,
                    quality_score, quality_status, can_use_for_macro_prompt, fetch_time, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (metric_type, trade_date, str(raw_value) if raw_value is not None else None,
                 clean_value, source_id, source_api, quality_score, quality_status,
                 1 if clean_value is not None else 0, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[MACRO] save {metric_type} error: {e}")


async def fetch_cn_10y_bond_yield() -> Optional[float]:
    """中国10年期国债收益率。拉取近30天历史以支持周/月变化计算。
    主源 akshare bond_china_yield, 备源 bond_zh_us_rate。
    返回最新值(百分点)。
    """
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.bond_china_yield, start_date="", end_date="")
        if df is not None and len(df) > 0:
            # 存最近30天历史(用于算周/月变化)
            df = df.sort_values("日期", ascending=False).head(30)
            latest_val = None
            for _, row in df.iterrows():
                val = row.get("10年") or row.get("10年期")
                if val is not None:
                    val = float(val)
                    today = str(row.get("日期", datetime.now().strftime("%Y-%m-%d")))[:10]
                    _save_macro_metric(METRIC_CN_10Y_BOND, today, val, val, "akshare", "bond_china_yield")
                    if latest_val is None:
                        latest_val = val
            if latest_val is not None:
                return latest_val
    except Exception as e:
        logger.warning(f"[MACRO] cn_10y_bond_yield primary failed: {e}")
    # 备源: bond_zh_us_rate
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.bond_zh_us_rate)
        if df is not None and len(df) > 0 and "中国国债收益率10年" in df.columns:
            df = df.tail(30)
            latest_val = None
            for _, row in df.iterrows():
                val = row.get("中国国债收益率10年")
                if val is not None and str(val).lower() != "nan":
                    val = float(val)
                    today = str(row.get("日期", datetime.now().strftime("%Y-%m-%d")))[:10]
                    _save_macro_metric(METRIC_CN_10Y_BOND, today, val, val, "akshare", "bond_zh_us_rate")
                    if latest_val is None:
                        latest_val = val
            if latest_val is not None:
                return latest_val
    except Exception as e:
        logger.warning(f"[MACRO] cn_10y_bond_yield fallback failed: {e}")
    return None


async def fetch_us_10y_treasury_yield() -> Optional[float]:
    """美国10年期国债收益率。拉取近30天历史。用 akshare bond_zh_us_rate()。
    返回百分点。
    """
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.bond_zh_us_rate)
        if df is None or len(df) == 0 or "美国国债收益率10年" not in df.columns:
            return None
        df = df.tail(30)
        latest_val = None
        for _, row in df.iterrows():
            val = row.get("美国国债收益率10年")
            if val is None or str(val).lower() == "nan":
                continue
            val = float(val)
            today = str(row.get("日期", datetime.now().strftime("%Y-%m-%d")))[:10]
            _save_macro_metric(METRIC_US_10Y_TREASURY, today, val, val, "akshare", "bond_zh_us_rate")
            if latest_val is None:
                latest_val = val
        return latest_val
    except Exception as e:
        logger.error(f"[MACRO] us_10y_treasury_yield error: {e}")
        return None


async def fetch_usd_cnh() -> Optional[float]:
    """USD/CNH 离岸人民币汇率。拉取30天历史。
    V4.2 P4-A: 主源改为 Yahoo Finance USDCNY=X (有最新历史), 
    备源 akshare fx_spot_quote / currency_boc_sina。
    返回汇率(如7.15)。
    """
    # 主源: Yahoo Finance USDCNY=X (V4.2 P4-A: 最稳定, 有30天历史)
    try:
        val = await _fetch_yahoo_quote("USDCNY=X", METRIC_USD_CNH, days=30)
        if val is not None:
            logger.info(f"[MACRO] usd_cnh from yahoo: {val}")
            return val
    except Exception as e:
        logger.warning(f"[MACRO] usd_cnh yahoo primary failed: {e}")
    # 备源1: akshare fx_spot_quote (只返回当日现价)
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.fx_spot_quote)
        if df is not None and len(df) > 0 and "货币对" in df.columns:
            row = df[df["货币对"].str.contains("美元/人民币|USD/CNY|USD/CNH", na=False)]
            if len(row) > 0:
                latest = row.iloc[0]
                val = latest.get("最新价")
                if val is None:
                    val = latest.iloc[-1]
                val = float(val)
                today = datetime.now().strftime("%Y-%m-%d")
                _save_macro_metric(METRIC_USD_CNH, today, val, val, "akshare", "fx_spot_quote")
                return val
    except Exception as e:
        logger.warning(f"[MACRO] usd_cnh fx_spot_quote fallback failed: {e}")
    # 备源2: currency_boc_sina(美元) 拉取历史
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.currency_boc_sina, symbol="美元")
        if df is not None and len(df) > 0:
            df = df.tail(30)
            latest_val = None
            for _, row in df.iterrows():
                mid = row.get("央行中间价") or row.get("中行折算价")
                if mid is not None:
                    val = float(mid) / 100.0
                    today = str(row.get("日期", datetime.now().strftime("%Y-%m-%d")))[:10]
                    _save_macro_metric(METRIC_USD_CNH, today, val, val, "akshare", "currency_boc_sina")
                    if latest_val is None:
                        latest_val = val
            if latest_val is not None:
                return latest_val
    except Exception as e:
        logger.warning(f"[MACRO] usd_cnh currency_boc_sina fallback failed: {e}")
    return None


async def _fetch_yahoo_quote(symbol: str, metric_type: str, days: int = 30) -> Optional[float]:
    """从 Yahoo Finance API 拉取指标历史(用于 VIX / USD-CNH 等)。
    存入 macro_metric_cache, 返回最新值。
    """
    import datetime as dt_mod
    period1 = int((datetime.now() - timedelta(days=days)).timestamp())
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={period1}&period2={int(datetime.now().timestamp())}&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=15))
    data = json.loads(resp.read())
    result = data["chart"]["result"][0]
    quotes = result["indicators"]["quote"][0]["close"]
    timestamps = result["timestamp"]
    latest_val = None
    for i in range(len(quotes)):
        if quotes[i] is not None:
            d = dt_mod.datetime.fromtimestamp(timestamps[i]).strftime("%Y-%m-%d")
            v = float(quotes[i])
            _save_macro_metric(metric_type, d, v, v, "yahoo", f"chart/{symbol}")
            latest_val = v
    return latest_val


async def fetch_vix() -> Optional[float]:
    """VIX恐慌指数。akshare 1.18 已无 index_vix。
    主源 Yahoo Finance ^VIX (拉取60天历史以支持月变化计算)。
    备源 akshare stock_us_hist(^VIX)。
    返回指数值(如18.50, 保留2位小数)。
    """
    # 主源: Yahoo Finance ^VIX (V4.2 P4-B: 拉60天历史支持月变化)
    try:
        val = await _fetch_yahoo_quote("%5EVIX", METRIC_VIX, days=60)
        if val is not None:
            logger.info(f"[MACRO] vix from yahoo: {val}")
            return val
    except Exception as e:
        logger.warning(f"[MACRO] vix yahoo primary failed: {e}")
    # 备源: akshare stock_us_hist ^VIX
    try:
        import akshare as ak
        df = await asyncio.to_thread(lambda: ak.stock_us_hist(symbol="^VIX", period="daily", adjust=""))
        if df is not None and len(df) > 0:
            latest = df.iloc[-1]
            for col in ["收盘", "收盘价", "close", "Close"]:
                if col in latest.index:
                    val = float(latest[col])
                    today = str(latest.get("日期", latest.get("date", datetime.now().strftime("%Y-%m-%d"))))[:10]
                    _save_macro_metric(METRIC_VIX, today, val, val, "akshare", "stock_us_hist_^VIX")
                    return val
    except Exception as e:
        logger.warning(f"[MACRO] vix stock_us_hist fallback failed: {e}")
    return None


async def fetch_vvix() -> Optional[float]:
    """VVIX - VIX的波动率(恐慌加速度)。Yahoo Finance ^VVIX。"""
    try:
        val = await _fetch_yahoo_quote("%5EVVIX", METRIC_VVIX, days=60)
        if val: logger.info(f"[MACRO] vvix from yahoo: {val}")
        return val
    except Exception as e:
        logger.warning(f"[MACRO] vvix failed: {e}")
        return None


async def fetch_skew() -> Optional[float]:
    """SKEW - 尾部风险/黑天鹅担忧。Yahoo Finance ^SKEW。"""
    try:
        val = await _fetch_yahoo_quote("%5ESKEW", METRIC_SKEW, days=60)
        if val: logger.info(f"[MACRO] skew from yahoo: {val}")
        return val
    except Exception as e:
        logger.warning(f"[MACRO] skew failed: {e}")
        return None


async def fetch_50etf_qvix() -> Optional[float]:
    """50ETF QVIX - A股50ETF隐含波动率(中国版VIX)。akshare。"""
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.index_option_50etf_qvix)
        if df is None or len(df) == 0:
            return None
        # 存最近30天历史
        df = df.tail(30)
        latest_val = None
        for _, row in df.iterrows():
            val = float(row.get("close", 0))
            if val > 0:
                today = str(row.get("date", datetime.now().strftime("%Y-%m-%d")))[:10]
                _save_macro_metric(METRIC_50ETF_QVIX, today, val, val, "akshare", "index_option_50etf_qvix")
                if latest_val is None:
                    latest_val = val
        if latest_val:
            logger.info(f"[MACRO] 50etf_qvix from akshare: {latest_val}")
        return latest_val
    except Exception as e:
        logger.warning(f"[MACRO] 50etf_qvix failed: {e}")
        return None


async def fetch_300etf_qvix() -> Optional[float]:
    """300ETF QVIX - 沪深300隐含波动率。akshare。"""
    try:
        import akshare as ak
        df = await asyncio.to_thread(ak.index_option_300etf_qvix)
        if df is None or len(df) == 0:
            return None
        df = df.tail(30)
        latest_val = None
        for _, row in df.iterrows():
            val = float(row.get("close", 0))
            if val > 0:
                today = str(row.get("date", datetime.now().strftime("%Y-%m-%d")))[:10]
                _save_macro_metric(METRIC_300ETF_QVIX, today, val, val, "akshare", "index_option_300etf_qvix")
                if latest_val is None:
                    latest_val = val
        if latest_val:
            logger.info(f"[MACRO] 300etf_qvix from akshare: {latest_val}")
        return latest_val
    except Exception as e:
        logger.warning(f"[MACRO] 300etf_qvix failed: {e}")
        return None


async def _fetch_with_timeout(coro, metric_type: str, timeout_sec: float = 45.0) -> Optional[float]:
    """带超时保护的 fetch 封装,防止单个 akshare 调用阻塞整个 refresh。"""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_sec)
    except asyncio.TimeoutError:
        logger.warning(f"[MACRO] {metric_type} fetch timed out after {timeout_sec}s")
        return None
    except Exception as e:
        logger.warning(f"[MACRO] {metric_type} fetch error: {e}")
        return None


async def refresh_all_macro() -> dict:
    """拉取全部8个宏观指标(4利率汇率+4恐慌情绪)。返回 {metric_type: value}。每个 fetch 带45s超时,单个失败不影响其他。"""
    results = {}
    results[METRIC_CN_10Y_BOND] = await _fetch_with_timeout(fetch_cn_10y_bond_yield(), METRIC_CN_10Y_BOND)
    results[METRIC_US_10Y_TREASURY] = await _fetch_with_timeout(fetch_us_10y_treasury_yield(), METRIC_US_10Y_TREASURY)
    results[METRIC_USD_CNH] = await _fetch_with_timeout(fetch_usd_cnh(), METRIC_USD_CNH)
    results[METRIC_VIX] = await _fetch_with_timeout(fetch_vix(), METRIC_VIX)
    # V5.1 恐慌情绪指标
    results[METRIC_VVIX] = await _fetch_with_timeout(fetch_vvix(), METRIC_VVIX)
    results[METRIC_SKEW] = await _fetch_with_timeout(fetch_skew(), METRIC_SKEW)
    results[METRIC_50ETF_QVIX] = await _fetch_with_timeout(fetch_50etf_qvix(), METRIC_50ETF_QVIX)
    results[METRIC_300ETF_QVIX] = await _fetch_with_timeout(fetch_300etf_qvix(), METRIC_300ETF_QVIX)
    return results


def get_macro_history(metric_type: str, days: int = 90) -> list[dict]:
    """获取宏观指标历史序列。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_macro_tables(conn)
            rows = conn.execute(
                "SELECT trade_date, clean_value, source_id FROM macro_metric_cache WHERE metric_type=? ORDER BY trade_date DESC LIMIT ?",
                (metric_type, days),
            ).fetchall()
            return [{"date": r["trade_date"], "value": r["clean_value"], "source": r["source_id"]} for r in rows]
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[MACRO] get_history error: {e}")
        return []


def _get_latest_metric(metric_type: str) -> Optional[dict]:
    """获取某指标最新一条缓存记录。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_macro_tables(conn)
            row = conn.execute(
                "SELECT * FROM macro_metric_cache WHERE metric_type=? ORDER BY trade_date DESC LIMIT 1",
                (metric_type,),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception:
        return None


def _get_metric_n_days_ago(metric_type: str, days: int) -> Optional[dict]:
    """获取某指标N天前的记录(用于算周变化/月变化)。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_macro_tables(conn)
            cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
            row = conn.execute(
                "SELECT * FROM macro_metric_cache WHERE metric_type=? AND trade_date<=? ORDER BY trade_date DESC LIMIT 1",
                (metric_type, cutoff),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception:
        return None
