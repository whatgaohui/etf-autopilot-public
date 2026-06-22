"""Tushare data fetching service (backup/verification source).

V4 策略书§4.1: 主源+备源+交叉校验。当 AkShare 失败时自动切换到 Tushare。
需要配置 tushare_token（在设置页数据源配置中输入）。

V4.1 PRD§10.4 / S2-T6: Tushare 分位计算补齐。
原 fetch_index_valuation 只返回 raw PE/PB（无分位），导致 PE/PB 分位无法做
主备源交叉校验。现拉取最近 5 年历史 PE/PB 序列后本地计算 1y/3y/5y 分位，
让分位可参与交叉校验（与 akshare 的 lg 子源结果对比，diff ≤5pp）。
"""
import logging
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# 尝试导入 tushare
try:
    import tushare as tushare_lib
    TUSHARE_AVAILABLE = True
except ImportError:
    TUSHARE_AVAILABLE = False
    logger.warning("[TUSHARE] tushare library not installed. pip install tushare")


def _get_tushare_token() -> str:
    """从环境变量、data_source 注册表（加密）或 Next.js Prisma 数据库获取 Tushare token。

    V4.1 S5-T11: 优先从 data_source 注册表读（Fernet 加密存储），
    兜底环境变量和 Prisma system_config 表（向后兼容）。
    """
    # 1. V4.1 S5-T11: 优先从 data_source 注册表读（加密存储）
    try:
        from services.data_source_manager import get_data_source_token, is_data_source_enabled
        # 检查 tushare 是否启用（停用则不返回 token）
        if not is_data_source_enabled("tushare"):
            return ""
        token = get_data_source_token("tushare")
        if token:
            return token
    except Exception as e:
        logger.debug(f"[TUSHARE] Failed to read token from data_source registry: {e}")

    # 2. 环境变量
    token = os.environ.get("TUSHARE_TOKEN", "")
    if token:
        return token

    # 3. 兜底：从 Next.js Prisma 数据库读
    try:
        prisma_db = "/app/db/custom.db"
        conn = sqlite3.connect(prisma_db)
        try:
            row = conn.execute(
                "SELECT value FROM system_config WHERE key = 'tushare_token' LIMIT 1"
            ).fetchone()
            if row and row[0]:
                return row[0]
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"[TUSHARE] Failed to read token from DB: {e}")
    return ""


def _get_pro_api():
    """获取 Tushare pro_api 实例（如果 token 可用且库已安装）。"""
    if not TUSHARE_AVAILABLE:
        return None
    token = _get_tushare_token()
    if not token:
        return None
    try:
        return tushare_lib.pro_api(token)
    except Exception as e:
        logger.error(f"[TUSHARE] Failed to init pro_api: {e}")
        return None


def _safe_float(v) -> Optional[float]:
    """安全转 float，过滤 NaN/Inf/哨兵值。"""
    if v is None:
        return None
    try:
        x = float(v)
        if x != x or x in (float("inf"), float("-inf")):
            return None
        if abs(x) >= 999999:
            return None
        return x
    except (TypeError, ValueError):
        return None


def _calc_percentile(current: float, history: list[float]) -> Optional[float]:
    """计算当前值在历史序列中的百分位（0-100）。

    与 akshare_service.calculate_percentile 算法一致：
    percentile = count(history <= current) / len(history) * 100
    """
    if not history or current is None:
        return None
    clean = [v for v in (_safe_float(x) for x in history) if v is not None]
    if not clean:
        return None
    cv = _safe_float(current)
    if cv is None:
        return None
    return round(sum(1 for v in clean if v <= cv) / len(clean) * 100, 2)


def _calc_multi_period_percentile(
    current: Optional[float], df_rows: list[dict], value_key: str
) -> dict:
    """V4.1 S2-T6: 计算多周期分位（1y/3y/5y）。

    df_rows: list of {"trade_date": "YYYYMMDD", value_key: float}
    返回 {1y, 3y, 5y, sample_days}
    """
    result = {"1y": None, "3y": None, "5y": None, "sample_days": 0}
    cv = _safe_float(current)
    if cv is None or not df_rows:
        return result

    # 解析日期 + 过滤有效点
    points: list[tuple[str, float]] = []
    for row in df_rows:
        d = str(row.get("trade_date", ""))[:8]
        v = _safe_float(row.get(value_key))
        if d and v is not None and len(d) == 8:
            try:
                # 转成 ISO 格式
                iso_d = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
                points.append((iso_d, v))
            except Exception:
                continue

    if not points:
        return result

    result["sample_days"] = len(points)
    now = datetime.now()
    all_values = [v for _, v in points]
    # 用全历史作为 5y 兜底（如果 5y 样本不足）
    result["5y"] = _calc_percentile(cv, all_values)

    for years, key in [(1, "1y"), (3, "3y"), (5, "5y")]:
        cutoff = (now - timedelta(days=years * 365)).strftime("%Y-%m-%d")
        window = [v for d, v in points if d >= cutoff]
        if len(window) >= 30:
            result[key] = _calc_percentile(cv, window)
        else:
            # 样本不足，5y 兜底用全历史
            if key == "5y":
                result[key] = _calc_percentile(cv, all_values)
            else:
                result[key] = None

    return result


async def fetch_index_valuation(index_code: str) -> dict:
    """Fetch index PE/PB from Tushare (backup source).

    V4.1 S2-T6: 拉取最近 5 年 index_dailybasic 历史 PE/PB 序列，
    本地计算 1y/3y/5y 分位，让分位可参与主备源交叉校验。
    """
    pro = _get_pro_api()
    if not pro:
        return {"pe": None, "pb": None, "pe_percentile": None, "pb_percentile": None,
                "pe_percentile_1y": None, "pe_percentile_3y": None, "pe_percentile_5y": None,
                "pb_percentile_1y": None, "pb_percentile_3y": None, "pb_percentile_5y": None,
                "date": "", "source": "tushare(unavailable)"}

    try:
        # V4.1 S2-T6: 拉取近 5 年历史数据用于分位计算
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=5 * 365)).strftime("%Y%m%d")

        df = pro.index_dailybasic(
            ts_code=index_code,
            start_date=start_date,
            end_date=end_date,
            fields="ts_code,trade_date,pe,pb",
        )
        if df is None or df.empty:
            return {"pe": None, "pb": None, "pe_percentile": None, "pb_percentile": None,
                    "pe_percentile_1y": None, "pe_percentile_3y": None, "pe_percentile_5y": None,
                    "pb_percentile_1y": None, "pb_percentile_3y": None, "pb_percentile_5y": None,
                    "date": "", "source": "tushare(no_data)"}

        # 按日期升序排序，取最后一行作为当日值
        df = df.sort_values("trade_date", ascending=True)
        last = df.iloc[-1]
        pe = _safe_float(last["pe"])
        pb = _safe_float(last["pb"])
        date = str(last["trade_date"])

        # V4.1 S2-T6: 本地计算多周期分位
        rows = df.to_dict("records")
        pe_pct_result = _calc_multi_period_percentile(pe, rows, "pe")
        pb_pct_result = _calc_multi_period_percentile(pb, rows, "pb")

        # 默认分位用 5y（与 akshare 行为对齐）
        pe_percentile = pe_pct_result["5y"]
        pb_percentile = pb_pct_result["5y"]

        return {
            "pe": pe,
            "pb": pb,
            "pe_percentile": pe_percentile,
            "pb_percentile": pb_percentile,
            "pe_percentile_1y": pe_pct_result["1y"],
            "pe_percentile_3y": pe_pct_result["3y"],
            "pe_percentile_5y": pe_pct_result["5y"],
            "pb_percentile_1y": pb_pct_result["1y"],
            "pb_percentile_3y": pb_pct_result["3y"],
            "pb_percentile_5y": pb_pct_result["5y"],
            "sample_days": pe_pct_result["sample_days"],
            "date": date,
            "source": "tushare",
        }
    except Exception as e:
        logger.error(f"[TUSHARE] fetch_index_valuation error: {e}")
        return {"pe": None, "pb": None, "pe_percentile": None, "pb_percentile": None,
                "pe_percentile_1y": None, "pe_percentile_3y": None, "pe_percentile_5y": None,
                "pb_percentile_1y": None, "pb_percentile_3y": None, "pb_percentile_5y": None,
                "date": "", "source": f"tushare(error: {str(e)[:50]})"}


async def fetch_etf_premium(etf_code: str) -> dict:
    """Fetch ETF premium from Tushare (backup source)."""
    pro = _get_pro_api()
    if not pro:
        return {"premium_today": None, "premium_7d_avg": None, "date": "", "source": "tushare(unavailable)"}

    try:
        # 用 fund_daily 获取场内价格
        df = pro.fund_daily(ts_code=f"{etf_code}.SH" if etf_code.startswith("5") else f"{etf_code}.SZ")
        if df is None or df.empty:
            return {"premium_today": None, "premium_7d_avg": None, "date": "", "source": "tushare(no_data)"}

        # 用 fund_nav 获取净值
        nav_df = pro.fund_nav(ts_code=f"{etf_code}.SH" if etf_code.startswith("5") else f"{etf_code}.SZ")
        if nav_df is None or nav_df.empty:
            return {"premium_today": None, "premium_7d_avg": None, "date": "", "source": "tushare(no_nav)"}

        close = float(df.iloc[-1]["close"])
        nav = float(nav_df.iloc[-1]["unit_nav"])
        if nav > 0:
            premium = (close / nav - 1) * 100
        else:
            premium = None

        return {
            "premium_today": premium,
            "premium_7d_avg": None,
            "date": str(df.iloc[-1]["trade_date"]),
            "source": "tushare",
        }
    except Exception as e:
        logger.error(f"[TUSHARE] fetch_etf_premium error: {e}")
        return {"premium_today": None, "premium_7d_avg": None, "date": "", "source": f"tushare(error)"}


async def fetch_etf_nav(etf_code: str) -> dict:
    """Fetch ETF NAV from Tushare (backup source)."""
    pro = _get_pro_api()
    if not pro:
        return {"nav": None, "date": "", "source": "tushare(unavailable)"}

    try:
        ts_code = f"{etf_code}.SH" if etf_code.startswith("5") else f"{etf_code}.SZ"
        df = pro.fund_nav(ts_code=ts_code)
        if df is None or df.empty:
            return {"nav": None, "date": "", "source": "tushare(no_data)"}

        last = df.iloc[-1]
        return {
            "nav": float(last["unit_nav"]) if last["unit_nav"] else None,
            "date": str(last["end_date"]),
            "source": "tushare",
        }
    except Exception as e:
        logger.error(f"[TUSHARE] fetch_etf_nav error: {e}")
        return {"nav": None, "date": "", "source": f"tushare(error)"}


async def fetch_dividend_yield(index_code: str) -> dict:
    """Fetch dividend yield from Tushare (backup source)."""
    pro = _get_pro_api()
    if not pro:
        return {"dividend_yield": None, "date": "", "source": "tushare(unavailable)"}

    try:
        df = pro.index_dailybasic(ts_code=index_code, fields="ts_code,trade_date,dv_ratio")
        if df is None or df.empty:
            return {"dividend_yield": None, "date": "", "source": "tushare(no_data)"}

        last = df.iloc[-1]
        return {
            "dividend_yield": float(last["dv_ratio"]) if last["dv_ratio"] else None,
            "date": str(last["trade_date"]),
            "source": "tushare",
        }
    except Exception as e:
        logger.error(f"[TUSHARE] fetch_dividend_yield error: {e}")
        return {"dividend_yield": None, "date": "", "source": f"tushare(error)"}
