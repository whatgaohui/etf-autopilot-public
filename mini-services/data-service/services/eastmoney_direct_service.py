"""eastmoney_direct service — 直连东方财富行情/净值 API（不依赖 akshare）.

V4.1 PRD §10.2 / S5-T10:
    提供一个权威校验源（validator role），直连东方财富行情/基金 API，
    不经过 akshare 间接调用，作为主源 akshare 失效时的独立校验/降级备源。

数据源:
    - ETF 实时行情（最新价/开高低/量额/涨跌幅）：
      push2.eastmoney.com/api/qt/stock/get?secid={prefix}.{code}&fields=f43,f44,f45,f46,f47,f48,f170
      （prefix：沪市 1，深市 0；510880/510330/513500/513300/588000 → 1，159338 → 0）
      字段：f43=最新价, f44=最高, f45=最低, f46=开盘, f47=成交量, f48=成交额, f170=涨跌幅

      注意：push2.eastmoney.com 在沙箱环境可能被防火墙拦截（Server disconnected），
      自动降级到 push2delay.eastmoney.com（东方财富官方延时 15 分钟行情端点，akshare 内部亦用此源）。

    - ETF 基金净值（历史净值）：
      api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=30
      需 Referer: https://fundf10.eastmoney.com/
      返回 LSJZList，取最新一条作为当日 NAV；可同时构建 nav_history

支持字段:
    - price:    ETF 实时最新价（f43）
    - nav:      ETF 基金净值（lsjz 第一条）
    - premium:  close/nav - 1（依赖 close 和 nav 都拉到）

设计原则:
    1. 不直接写缓存（DataSourceManager 决定是否落库）
    2. 与 akshare_service.fetch_etf_close_price / fetch_etf_nav / fetch_etf_premium 字段对齐
    3. 阻塞 IO 走 asyncio.to_thread 避免阻塞事件循环
    4. 限流：每次调用 sleep 0.5s（eastmoney 限流相对宽松，但 QDII 净值端点仍需限流）
    5. 失败时返回带 source="eastmoney_direct(error: ...)" 的空数据，不抛异常
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# push2 主端点（实时行情）
_PUSH2_URL = "http://push2.eastmoney.com/api/qt/stock/get"
# push2delay 备端点（延时 15 分钟，沙箱环境可达，akshare 内部同源）
_PUSH2_DELAY_URL = "https://push2delay.eastmoney.com/api/qt/stock/get"
# 基金净值历史端点（独立 host，沙箱可达）
_LSJZ_URL = "http://api.fund.eastmoney.com/f10/lsjz"

# push2 单 ETF 查询 fields
_PUSH2_FIELDS = "f43,f44,f45,f46,f47,f48,f57,f58,f170"

# 反爬 headers
_QUOTE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/119.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_FUND_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/119.0.0.0 Safari/537.36"
    ),
    "Referer": "https://fundf10.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 限流锁：串行调用 + sleep 0.5s，避免触发 eastmoney 限流
_FETCH_LOCK = asyncio.Lock()


def is_available() -> bool:
    """eastmoney_direct 是否可用（只需 httpx 已装）。"""
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


def _secid(etf_code: str) -> str:
    """构造 eastmoney secid（沪市前缀 1，深市前缀 0）。

    规则（与 akshare/eastmoney 官方一致）：
        - 代码以 '5' 开头（沪市 ETF / 科创 ETF / QDII）→ 1.{code}
        - 代码以 '1' 开头（深市 ETF）→ 0.{code}
    """
    prefix = "1" if etf_code.startswith("5") else "0"
    return f"{prefix}.{etf_code}"


def _sync_get_json(url: str, params: dict, headers: dict) -> dict:
    """同步 GET JSON。"""
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        r = client.get(url, params=params, headers=headers)
        r.raise_for_status()
        return r.json()


def _date_to_str(val) -> str:
    """日期值（YYYYMMDD 数字 / 字符串）转 YYYY-MM-DD。"""
    s = str(val).strip() if val is not None else ""
    if not s:
        return ""
    if s.isdigit() and len(s) == 8:
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]


async def fetch_etf_close_price(etf_code: str) -> dict:
    """拉取 ETF 实时最新价（push2 / push2delay 双端点）。

    返回字段：
        close / open / high / low / volume / amount / change_pct / date /
        source / source_api
    """
    async with _FETCH_LOCK:
        data, used_url = await _fetch_quote_with_fallback(etf_code)
        # 限流：成功失败都 sleep 0.5s（push2delay 仍有限流）
        await asyncio.sleep(0.5)

    if not data:
        return {
            "close": None, "date": "",
            "source": "eastmoney_direct(no_data)",
            "source_api": "eastmoney_direct:push2/push2delay",
        }

    close = _to_float(data.get("f43"))
    high = _to_float(data.get("f44"))
    low = _to_float(data.get("f45"))
    open_p = _to_float(data.get("f46"))
    volume = _to_float(data.get("f47"))
    amount = _to_float(data.get("f48"))
    change_pct = _to_float(data.get("f170"))
    # f57=代码, f58=名称（仅用于日志校验）
    code_in_resp = data.get("f57")
    name_in_resp = data.get("f58")
    date_str = datetime.now().strftime("%Y-%m-%d")  # 实时行情无 trade_date 字段，用当天

    api_label = "push2" if "push2.eastmoney.com" in used_url else "push2delay"
    result = {
        "close": close,
        "open": open_p,
        "high": high,
        "low": low,
        "volume": volume,
        "amount": amount,
        "change_pct": change_pct,
        "date": date_str,
        "source": "eastmoney_direct",
        "source_api": f"eastmoney_direct:{api_label}/qt/stock/get",
    }
    logger.info(
        f"[EASTMONEY_DIRECT] close {etf_code}: close={close} "
        f"(resp_code={code_in_resp}, name={name_in_resp}, via={api_label})"
    )
    return result


async def _fetch_quote_with_fallback(etf_code: str) -> tuple[Optional[dict], str]:
    """先试 push2（实时），失败降级 push2delay（延时 15 分钟）。

    返回 (data_dict_or_None, used_url)。
    """
    secid = _secid(etf_code)
    params = {"secid": secid, "fields": _PUSH2_FIELDS, "fltt": "2", "invt": "2"}

    # 1. 先试 push2.eastmoney.com（实时）
    try:
        data = await asyncio.to_thread(_sync_get_json, _PUSH2_URL, params, _QUOTE_HEADERS)
        d = data.get("data") if isinstance(data, dict) else None
        if d and d.get("f43") is not None:
            return d, _PUSH2_URL
        logger.debug(f"[EASTMONEY_DIRECT] push2 no data for {etf_code}, falling back to push2delay")
    except Exception as e:
        logger.debug(
            f"[EASTMONEY_DIRECT] push2.eastmoney.com failed for {etf_code} (likely sandbox firewall), "
            f"falling back to push2delay: {str(e)[:80]}"
        )

    # 2. 降级 push2delay.eastmoney.com（延时 15 分钟，沙箱可达）
    try:
        data = await asyncio.to_thread(_sync_get_json, _PUSH2_DELAY_URL, params, _QUOTE_HEADERS)
        d = data.get("data") if isinstance(data, dict) else None
        if d and d.get("f43") is not None:
            return d, _PUSH2_DELAY_URL
    except Exception as e:
        logger.warning(
            f"[EASTMONEY_DIRECT] push2delay also failed for {etf_code}: {str(e)[:120]}"
        )

    return None, ""


async def fetch_etf_nav(etf_code: str) -> dict:
    """拉取 ETF 基金净值历史（api.fund.eastmoney.com/f10/lsjz）。

    返回字段：
        nav / nav_history (list of {date, nav}) / date / source / source_api

    QDII 基金净值通常 T+1 公布，最近一条可能比当前交易日早 1 天。
    """
    async with _FETCH_LOCK:
        try:
            data = await asyncio.to_thread(
                _sync_get_json,
                _LSJZ_URL,
                {"fundCode": etf_code, "pageIndex": "1", "pageSize": "30"},
                _FUND_HEADERS,
            )
        except Exception as e:
            logger.warning(f"[EASTMONEY_DIRECT] lsjz failed for {etf_code}: {str(e)[:120]}")
            return {
                "nav": None, "nav_history": [], "date": "",
                "source": f"eastmoney_direct(error: {str(e)[:60]})",
                "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
            }
        await asyncio.sleep(0.5)

    if not isinstance(data, dict):
        return {
            "nav": None, "nav_history": [], "date": "",
            "source": "eastmoney_direct(invalid_response)",
            "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
        }

    lsjz_list = data.get("Data", {}).get("LSJZList", []) if isinstance(data.get("Data"), dict) else []
    if not lsjz_list:
        return {
            "nav": None, "nav_history": [], "date": "",
            "source": "eastmoney_direct(no_data)",
            "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
        }

    # lsjz 是按日期倒序返回（最新在最前），第一条就是最新
    latest = lsjz_list[0]
    nav = _to_float(latest.get("DWJZ"))
    date_str = str(latest.get("FSRQ", ""))[:10]

    # 构建 nav_history（按日期升序，过滤无效条目）
    nav_history: list[dict] = []
    for item in reversed(lsjz_list):
        d = str(item.get("FSRQ", ""))[:10]
        v = _to_float(item.get("DWJZ"))
        if d and v is not None and v > 0:
            nav_history.append({"date": d, "nav": v})

    result = {
        "nav": nav,
        "nav_history": nav_history,
        "date": date_str,
        "source": "eastmoney_direct",
        "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
    }
    logger.info(
        f"[EASTMONEY_DIRECT] nav {etf_code}: nav={nav} (date={date_str}, history={len(nav_history)})"
    )
    return result


async def fetch_etf_premium(etf_code: str) -> dict:
    """计算 ETF 溢价率（close / nav - 1）。

    并发拉 close（push2）和 nav（lsjz），取 close / nav - 1 * 100%。
    若 close 或 nav 任一缺失，premium_today=None。

    注意：QDII 基金净值 T+1 公布，"今日"溢价率实际是 close(T) / nav(T-1) - 1，
    会偏高（含当日基金涨跌），仅作参考。
    """
    # 并发拉 close 和 nav（独立 lock，避免死锁）
    close_task = asyncio.create_task(_fetch_close_unsafe(etf_code))
    nav_task = asyncio.create_task(_fetch_nav_unsafe(etf_code))
    close_result, nav_result = await asyncio.gather(close_task, nav_task, return_exceptions=False)

    close = _to_float(close_result.get("close"))
    nav = _to_float(nav_result.get("nav"))

    if close is None or nav is None or nav <= 0:
        return {
            "premium_today": None,
            "premium_7d_avg": None,
            "close": close,
            "nav": nav,
            "date": close_result.get("date") or nav_result.get("date", ""),
            "source": "eastmoney_direct(insufficient_data)",
            "source_api": "eastmoney_direct:push2+lsjz",
        }

    premium = round((close / nav - 1) * 100, 4)

    result = {
        "premium_today": premium,
        "premium_7d_avg": None,
        "close": close,
        "nav": nav,
        "date": close_result.get("date") or nav_result.get("date", ""),
        "source": "eastmoney_direct",
        "source_api": "eastmoney_direct:push2+lsjz",
    }
    logger.info(
        f"[EASTMONEY_DIRECT] premium {etf_code}: premium={premium}% "
        f"(close={close}, nav={nav})"
    )
    return result


async def _fetch_close_unsafe(etf_code: str) -> dict:
    """不带 lock 的 close 拉取（premium 内部调用，避免与外层 lock 冲突）。"""
    try:
        data, used_url = await _fetch_quote_with_fallback(etf_code)
        await asyncio.sleep(0.5)
        if not data:
            return {"close": None, "date": ""}
        close = _to_float(data.get("f43"))
        return {"close": close, "date": datetime.now().strftime("%Y-%m-%d")}
    except Exception as e:
        logger.warning(f"[EASTMONEY_DIRECT] _fetch_close_unsafe {etf_code}: {str(e)[:80]}")
        return {"close": None, "date": ""}


async def _fetch_nav_unsafe(etf_code: str) -> dict:
    """不带 lock 的 nav 拉取（premium 内部调用，避免与外层 lock 冲突）。"""
    try:
        data = await asyncio.to_thread(
            _sync_get_json,
            _LSJZ_URL,
            {"fundCode": etf_code, "pageIndex": "1", "pageSize": "30"},
            _FUND_HEADERS,
        )
        await asyncio.sleep(0.5)
        lsjz_list = data.get("Data", {}).get("LSJZList", []) if isinstance(data, dict) else []
        if not lsjz_list:
            return {"nav": None, "date": ""}
        latest = lsjz_list[0]
        nav = _to_float(latest.get("DWJZ"))
        date_str = str(latest.get("FSRQ", ""))[:10]
        return {"nav": nav, "date": date_str}
    except Exception as e:
        logger.warning(f"[EASTMONEY_DIRECT] _fetch_nav_unsafe {etf_code}: {str(e)[:80]}")
        return {"nav": None, "date": ""}


# ── ETF K线（LSJZ 多页拉历史净值作为 K线 fallback）─────────────────────────────
# V4.1 BUG-2026-06-A500-KLINE:
#   akshare.fund_etf_hist_sina 在沙箱/某些网络环境不通，且 scheduler 无 kline job，
#   导致 /api/cached/kline 对所有 ETF 都返回 []。fallback 用 LSJZ 历史净值当 K线：
#   LSJZ 返回每日单位净值 DWJZ，与 ETF 收盘价高度相关（ETF 收盘价≈单位净值+溢价），
#   足以支撑趋势图绘制。返回值里加 is_nav_proxy=True 字段标注，前端展示"净值代理"徽标。
#
# LSJZ 接口限制：pageSize 上限 20，需要分页拉取。
# 默认拉 13 页 = 260 条 ≈ 1 年交易日。


async def fetch_etf_kline(etf_code: str, pages: int = 13) -> dict:
    """拉取 ETF K线（用 LSJZ 历史净值代理）。

    Args:
        etf_code: ETF 代码，如 '159338'
        pages: LSJZ 分页数（每页 20 条，13 页 ≈ 1 年）

    Returns:
        Dict with kline_history list of {date, open, high, low, close, volume}
        所有 OHLC 字段都用净值填充（ETF 净值≈收盘价），volume=None。
        is_nav_proxy=True 标注为净值代理。
    """
    async with _FETCH_LOCK:
        all_lsjz: list[dict] = []
        for page in range(1, pages + 1):
            try:
                data = await asyncio.to_thread(
                    _sync_get_json,
                    _LSJZ_URL,
                    {"fundCode": etf_code, "pageIndex": str(page), "pageSize": "20"},
                    _FUND_HEADERS,
                )
            except Exception as e:
                logger.warning(
                    f"[EASTMONEY_DIRECT] kline lsjz page={page} failed for {etf_code}: {str(e)[:100]}"
                )
                break
            await asyncio.sleep(0.4)  # 限流

            lsjz_list = (
                data.get("Data", {}).get("LSJZList", [])
                if isinstance(data, dict) and isinstance(data.get("Data"), dict)
                else []
            )
            if not lsjz_list:
                break
            all_lsjz.extend(lsjz_list)

    if not all_lsjz:
        today = datetime.now().strftime("%Y-%m-%d")
        return {
            "date": today,
            "kline_history": [],
            "is_nav_proxy": True,
            "source": "eastmoney_direct(no_data)",
            "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
        }

    # LSJZ 是按日期倒序返回（最新在最前），反转为升序
    all_lsjz.reverse()

    # 构建 kline_history（用净值填充所有 OHLC 字段）
    kline_history: list[dict] = []
    for item in all_lsjz:
        d = str(item.get("FSRQ", ""))[:10]
        v = _to_float(item.get("DWJZ"))
        if d and v is not None and v > 0:
            kline_history.append({
                "date": d,
                "open": v,
                "high": v,
                "low": v,
                "close": v,
                "volume": None,  # LSJZ 无成交量
            })

    data_date = kline_history[-1]["date"] if kline_history else datetime.now().strftime("%Y-%m-%d")

    result = {
        "date": data_date,
        "kline_history": kline_history,
        "is_nav_proxy": True,  # 标注为净值代理（前端展示徽标）
        "source": "eastmoney_direct",
        "source_api": "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz",
    }
    logger.info(
        f"[EASTMONEY_DIRECT] kline {etf_code}: {len(kline_history)} points "
        f"(nav proxy, earliest={kline_history[0]['date'] if kline_history else 'N/A'})"
    )
    return result

