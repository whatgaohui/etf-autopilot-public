"""csindex_direct service — 直连中证指数官网（不依赖 akshare）.

V4.1 PRD §10.2 / S5-T9:
    提供一个权威校验源（validator role），直连中证指数官网 OSS 静态资源，
    不经过 akshare 间接调用，作为主源 akshare 失效时的独立校验/降级备源。

数据源:
    - 指数估值（PE/PB/股息率）：中证指数 OSS 静态 xls 文件
      https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/{index_code}indicator.xls
      （akshare 内部 stock_zh_index_value_csindex 用的也是这个 URL）
      仅返回近 20 个交易日数据，包含字段：市盈率1/2、股息率1/2（无 PB）。

支持字段:
    - valuation: 拉取 PE + 股息率（PB 不提供，返回 None）
    - dividend:  拉取股息率

设计原则:
    1. 不直接写缓存（DataSourceManager 决定是否落库）
    2. 与 akshare_service._fetch_csindex_valuation / fetch_dividend_yield 返回字段对齐
    3. 阻塞 IO 走 asyncio.to_thread 避免阻塞事件循环
    4. 限流：每次调用 sleep 1s（csindex 限流严格）
    5. 失败时返回带 source="csindex_direct(error: ...)" 的空数据，不抛异常
"""
from __future__ import annotations

import asyncio
import io
import logging
import math
from datetime import datetime
from typing import Optional

import httpx
import pandas as pd

logger = logging.getLogger(__name__)

# csindex OSS 静态 xls URL（与 akshare stock_zh_index_value_csindex 同源）
_CSIINDEX_XLS_URL = (
    "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/"
    "{code}indicator.xls"
)

# 反爬规避 headers
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/119.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.csindex.com.cn/",
    "Accept": "application/vnd.ms-excel, application/octet-stream, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 限流锁：csindex 限流严格，串行调用 + sleep
_FETCH_LOCK = asyncio.Lock()


def is_available() -> bool:
    """csindex_direct 是否可用（只需 httpx + pandas 已装）。"""
    return True


def _to_float(v) -> Optional[float]:
    """安全转 float，NaN/Inf/哨兵值返回 None。"""
    if v is None:
        return None
    try:
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return None
        if abs(x) >= 999999:
            return None
        return x
    except (TypeError, ValueError):
        return None


def _date_to_str(val) -> str:
    """日期值转 YYYY-MM-DD 字符串。csindex xls 的日期格式是 YYYYMMDD 数字字符串。"""
    s = str(val).strip()
    if not s:
        return ""
    # 处理 YYYYMMDD 格式
    if s.isdigit() and len(s) == 8:
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    # 处理已经是 YYYY-MM-DD 的格式
    if len(s) >= 10:
        return s[:10]
    return s


def _calc_percentile(current_value: Optional[float], history: list[float]) -> Optional[float]:
    """计算当前值在历史序列中的百分位（0-100）。样本不足返回 None。"""
    if current_value is None or not history:
        return None
    clean = [v for v in (_to_float(x) for x in history) if v is not None]
    cv = _to_float(current_value)
    if cv is None or not clean:
        return None
    return round(sum(1 for v in clean if v <= cv) / len(clean) * 100, 2)


async def _fetch_xls_bytes(index_code: str) -> bytes:
    """异步拉取 csindex xls 二进制内容。"""
    url = _CSIINDEX_XLS_URL.format(code=index_code)
    return await asyncio.to_thread(_sync_get, url)


def _sync_get(url: str) -> bytes:
    """同步 GET，返回 response.content。"""
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        r = client.get(url, headers=_HEADERS)
        r.raise_for_status()
        return r.content


def _parse_xls(content: bytes) -> pd.DataFrame:
    """解析 csindex xls 字节流为 DataFrame，标准化列名。

    返回列：日期 / 指数代码 / 指数中文简称 / 市盈率1 / 市盈率2 / 股息率1 / 股息率2
    """
    df = pd.read_excel(io.BytesIO(content))
    # 标准化列名（akshare 内部也是这么做的）
    rename_map = {}
    cols = list(df.columns)
    for c in cols:
        cstr = str(c)
        if cstr.startswith("日期"):
            rename_map[c] = "日期"
        elif cstr.startswith("指数代码"):
            rename_map[c] = "指数代码"
        elif cstr.startswith("指数中文简称"):
            rename_map[c] = "指数中文简称"
        elif cstr.startswith("市盈率1"):
            rename_map[c] = "市盈率1"
        elif cstr.startswith("市盈率2"):
            rename_map[c] = "市盈率2"
        elif cstr.startswith("市净率1"):
            rename_map[c] = "市净率1"
        elif cstr.startswith("市净率2"):
            rename_map[c] = "市净率2"
        elif cstr.startswith("股息率1"):
            rename_map[c] = "股息率1"
        elif cstr.startswith("股息率2"):
            rename_map[c] = "股息率2"
    if rename_map:
        df = df.rename(columns=rename_map)

    # 日期标准化（YYYYMMDD → datetime → YYYY-MM-DD 字符串）
    if "日期" in df.columns:
        df["日期"] = pd.to_datetime(df["日期"], format="%Y%m%d", errors="coerce")
        df = df.dropna(subset=["日期"]).sort_values("日期", ascending=True).reset_index(drop=True)
        df["日期"] = df["日期"].dt.strftime("%Y-%m-%d")

    # 数值列转 numeric
    for c in ("市盈率1", "市盈率2", "市净率1", "市净率2", "股息率1", "股息率2"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


async def fetch_index_valuation(index_code: str, index_name: str = "") -> dict:
    """拉取指数估值 PE/PB + 历史百分位（csindex 直连）。

    返回字段与 akshare_service._fetch_csindex_valuation 对齐：
        pe / pb / pe_percentile / pb_percentile / date /
        pe_history / pb_history / sample_days /
        pe_percentile_1y / 3y / 5y / 10y / all /
        pb_percentile_1y / 3y / 5y / 10y / all /
        source / source_api

    注意：csindex xls 仅返回近 20 个交易日，不提供 PB（市净率）。
    多周期分位样本不足时全部为 None。
    """
    async with _FETCH_LOCK:
        try:
            content = await _fetch_xls_bytes(index_code)
        except Exception as e:
            logger.warning(f"[CSINDEX_DIRECT] fetch xls failed for {index_code}: {str(e)[:120]}")
            return {
                "pe": None, "pb": None,
                "pe_percentile": None, "pb_percentile": None,
                "pe_history": [], "pb_history": [],
                "date": datetime.now().strftime("%Y-%m-%d"),
                "sample_days": 0,
                "source": f"csindex_direct(error: {str(e)[:60]})",
                "source_api": "csindex_direct:indicator.xls",
            }
        # 限流：拉取后 sleep 1s
        await asyncio.sleep(1.0)

    try:
        df = _parse_xls(content)
    except Exception as e:
        logger.warning(f"[CSINDEX_DIRECT] parse xls failed for {index_code}: {str(e)[:120]}")
        return {
            "pe": None, "pb": None,
            "pe_percentile": None, "pb_percentile": None,
            "pe_history": [], "pb_history": [],
            "date": datetime.now().strftime("%Y-%m-%d"),
            "sample_days": 0,
            "source": f"csindex_direct(parse_error: {str(e)[:60]})",
            "source_api": "csindex_direct:indicator.xls",
        }

    if df.empty:
        return {
            "pe": None, "pb": None,
            "pe_percentile": None, "pb_percentile": None,
            "pe_history": [], "pb_history": [],
            "date": datetime.now().strftime("%Y-%m-%d"),
            "sample_days": 0,
            "source": "csindex_direct(no_data)",
            "source_api": "csindex_direct:indicator.xls",
        }

    last_row = df.iloc[-1]
    # PE 优先 市盈率2（TTM），次选 市盈率1（静态）
    pe_col = "市盈率2" if "市盈率2" in df.columns and pd.notna(last_row.get("市盈率2")) else "市盈率1"
    current_pe = _to_float(last_row.get(pe_col))

    # PB 列在 csindex xls 中不存在，返回 None
    current_pb = None
    pb_col = None

    data_date = str(last_row.get("日期", ""))[:10] or datetime.now().strftime("%Y-%m-%d")

    # 构建 PE 历史（list of {date, value}）
    pe_history: list[dict] = []
    pe_vals: list[float] = []
    if pe_col and pe_col in df.columns:
        for _, row in df.iterrows():
            d = str(row.get("日期", ""))[:10]
            v = _to_float(row.get(pe_col))
            if d and v is not None:
                pe_history.append({"date": d, "value": v})
                pe_vals.append(v)

    pe_percentile = _calc_percentile(current_pe, pe_vals)

    # 多周期分位（样本太少基本都为 None，但保留接口对齐）
    pe_multi = _calc_multi_period(current_pe, pe_history, "value")
    pb_multi = _calc_multi_period(None, [], "value")

    result = {
        "pe": current_pe,
        "pb": current_pb,
        "pe_percentile": pe_percentile,
        "pb_percentile": None,
        "date": data_date,
        "pe_history": pe_history,
        "pb_history": [],
        # 多周期分位（与 akshare_service 字段对齐）
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
        "source": "csindex_direct",
        "source_api": "csindex_direct:indicator.xls",
    }
    logger.info(
        f"[CSINDEX_DIRECT] valuation {index_code}: PE={current_pe} (date={data_date}, samples={len(pe_history)})"
    )
    return result


async def fetch_dividend_yield(index_code: str) -> dict:
    """拉取指数股息率（csindex 直连）。

    返回字段与 akshare_service.fetch_dividend_yield 对齐：
        dividend_yield / dividend_yield_percentile / dividend_yield_history / date /
        source / source_api
    """
    async with _FETCH_LOCK:
        try:
            content = await _fetch_xls_bytes(index_code)
        except Exception as e:
            logger.warning(f"[CSINDEX_DIRECT] fetch xls (dividend) failed for {index_code}: {str(e)[:120]}")
            return {
                "dividend_yield": None,
                "dividend_yield_percentile": None,
                "dividend_yield_history": [],
                "date": datetime.now().strftime("%Y-%m-%d"),
                "source": f"csindex_direct(error: {str(e)[:60]})",
                "source_api": "csindex_direct:indicator.xls",
            }
        await asyncio.sleep(1.0)

    try:
        df = _parse_xls(content)
    except Exception as e:
        logger.warning(f"[CSINDEX_DIRECT] parse xls (dividend) failed for {index_code}: {str(e)[:120]}")
        return {
            "dividend_yield": None,
            "dividend_yield_percentile": None,
            "dividend_yield_history": [],
            "date": datetime.now().strftime("%Y-%m-%d"),
            "source": f"csindex_direct(parse_error: {str(e)[:60]})",
            "source_api": "csindex_direct:indicator.xls",
        }

    if df.empty:
        return {
            "dividend_yield": None,
            "dividend_yield_percentile": None,
            "dividend_yield_history": [],
            "date": datetime.now().strftime("%Y-%m-%d"),
            "source": "csindex_direct(no_data)",
            "source_api": "csindex_direct:indicator.xls",
        }

    last_row = df.iloc[-1]
    # 股息率 优先 股息率2（计算用股本），次选 股息率1（总股本）
    dy_col = "股息率2" if "股息率2" in df.columns and pd.notna(last_row.get("股息率2")) else "股息率1"
    current_dy = _to_float(last_row.get(dy_col))
    data_date = str(last_row.get("日期", ""))[:10] or datetime.now().strftime("%Y-%m-%d")

    dy_history: list[dict] = []
    dy_vals: list[float] = []
    if dy_col and dy_col in df.columns:
        for _, row in df.iterrows():
            d = str(row.get("日期", ""))[:10]
            v = _to_float(row.get(dy_col))
            if d and v is not None:
                dy_history.append({"date": d, "value": v})
                dy_vals.append(v)

    dy_percentile = _calc_percentile(current_dy, dy_vals)

    result = {
        "dividend_yield": current_dy,
        "dividend_yield_percentile": dy_percentile,
        "dividend_yield_history": dy_history,
        "date": data_date,
        "source": "csindex_direct",
        "source_api": "csindex_direct:indicator.xls",
    }
    logger.info(
        f"[CSINDEX_DIRECT] dividend {index_code}: DY={current_dy} (date={data_date}, samples={len(dy_history)})"
    )
    return result


def _calc_multi_period(
    current_value: Optional[float], history: list[dict], value_key: str = "value"
) -> dict:
    """计算多周期分位（与 akshare_service.calculate_multi_period_percentiles 对齐）。

    csindex xls 仅 20 个交易日数据，1y/3y/5y/10y 窗口几乎都返回 None，
    但 'all' 窗口可用（基于全部 20 个样本）。
    """
    result: dict = {"1y": None, "3y": None, "5y": None, "10y": None, "all": None, "sample_days": 0}
    cv = _to_float(current_value)
    if cv is None or not history:
        return result

    points: list[tuple[str, float]] = []
    for p in history:
        if not isinstance(p, dict):
            continue
        d = p.get("date")
        v = _to_float(p.get(value_key))
        if d and v is not None:
            points.append((str(d)[:10], v))

    if not points:
        return result

    result["sample_days"] = len(points)
    result["all"] = _calc_percentile(cv, [v for _, v in points])

    # csindex xls 仅 ~20 个交易日，1y/3y/5y/10y 窗口样本不足 30，全部为 None
    # 保留逻辑结构，未来若换数据源（含长历史）则自动生效
    now = datetime.now()
    from datetime import timedelta
    for years, key in [(1, "1y"), (3, "3y"), (5, "5y"), (10, "10y")]:
        cutoff = (now - timedelta(days=years * 365)).strftime("%Y-%m-%d")
        window = [v for d, v in points if d >= cutoff]
        if len(window) >= 30:
            result[key] = _calc_percentile(cv, window)
    return result
