"""Efinance data fetching service (free, no-token backup source).

V4.1 PRD§10.2: 多源冗余 — 提供一个免费、免 Token 的备源，作为 AkShare 主源失败时的
自动降级目标，避免单 Token 失效就退化为单源。

V4.1 PRD§10.4: 适配器定位
    - 指数估值 PE/PB：efinance 不直接提供，仍走 akshare/tushare
    - ETF 行情价：ef.stock.get_quote_history（同源 eastmoney，可能被限流，作降级备份）
    - 基金净值：ef.fund.get_quote_history（独立端点，稳定可用）
    - ETF 溢价率：close/nav 计算
    - 股息率：efinance 不提供，仍走 akshare/csindex

设计原则：
    1. 不直接写缓存（DataSourceManager 决定是否落库，本服务只返回数据）
    2. 与 akshare_service 返回值字段对齐，便于交叉校验
    3. 所有阻塞调用走 asyncio.to_thread，避免阻塞事件循环
    4. 限流/网络异常时返回 None 字段 + source 标记，不抛异常
    5. V4.1 S2-T1: efinance 包体较大（含 bs4/websocket/multitasking），
       延迟到首次实际调用时才 import，避免拖累服务启动内存

BUG-2026-06-EFINANCE (本轮修复):
    A. is_available() 之前返回 False 直到首次 fetch，导致设置页源健康面板
       永远显示 "不可用"。修复：首次调用 is_available 时主动 import efinance
       并缓存结果，UI 立刻能拿到准确状态。
    B. fetch_etf_nav 之前用 df.iloc[-1] 取最后一行，但 efinance 的 fund 数据
       是按日期倒序返回（最新在最前）。iloc[-1] 取到的是 2012 年最早一条
       （如 510300 NAV=1.007），而非当日净值。修复：改用 iloc[0] 取最新一条，
       并补回 nav_history 字段，与 eastmoney_direct 返回结构对齐。
    C. fetch_etf_close_price 走 ef.stock.get_quote_history → 命中
       push2his.eastmoney.com，该 host 在沙箱/部分网络环境被防火墙直接 RST。
       修复：失败时降级直连 push2delay.eastmoney.com（东方财富官方 15 分钟
       延时行情端点，沙箱可达），用与 eastmoney_direct_service 相同的
       secid/fields 解析最新价 f43。
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# V4.1 S2-T1: 延迟导入标记 — 不在模块顶部 import efinance，避免启动时占用 ~80MB 内存
_EFINANCE_LIB = None
_EFINANCE_IMPORT_TRIED = False


def _get_efinance_lib():
    """V4.1 S2-T1: 延迟导入 efinance 库，首次调用时才真正 import。

    BUG-2026-06-EFINANCE-A: 之前 is_available() 仅检查 _EFINANCE_LIB 缓存，
    不会触发实际 import，导致设置页永远显示 efinance 不可用。现在
    is_available() 会主动调用本函数完成 import，所以这里改成幂等触发即可。
    """
    global _EFINANCE_LIB, _EFINANCE_IMPORT_TRIED
    if _EFINANCE_LIB is not None:
        return _EFINANCE_LIB
    if _EFINANCE_IMPORT_TRIED:
        return None
    _EFINANCE_IMPORT_TRIED = True
    try:
        import efinance as ef  # noqa: F401
        _EFINANCE_LIB = ef
        logger.info("[EFINANCE] library imported successfully (lazy load done)")
        return ef
    except ImportError:
        logger.warning("[EFINANCE] efinance library not installed. pip install efinance")
        return None
    except Exception as e:
        logger.warning(f"[EFINANCE] Failed to import efinance: {e}")
        return None


def is_available() -> bool:
    """efinance 是否可用（无需 Token，只需库已安装）。

    BUG-2026-06-EFINANCE-A 修复：首次调用就主动触发 import，避免设置页
    健康面板在 fetch 之前永远显示 False。
    """
    return _get_efinance_lib() is not None


def _to_float(v) -> Optional[float]:
    """安全转 float，NaN/Inf/异常值返回 None。"""
    if v is None:
        return None
    try:
        x = float(v)
        if x != x or x in (float("inf"), float("-inf")):  # NaN/Inf
            return None
        if abs(x) >= 999999:  # 哨兵值
            return None
        return x
    except (TypeError, ValueError):
        return None


# ─── BUG-2026-06-EFINANCE-C: push2his 被防火墙 RST 时的降级端点 ──────────────────
# push2his.eastmoney.com 在沙箱/部分网络环境会被防火墙直接 RST，
# ef.stock.get_quote_history 命中该 host 时 100% 失败。
# 降级走 push2delay.eastmoney.com（东方财富官方 15 分钟延时行情端点），
# 用 secid/fields 直接解析最新价 f43（与 eastmoney_direct_service 相同协议）。
_PUSH2_DELAY_URL = "https://push2delay.eastmoney.com/api/qt/stock/get"
_PUSH2_FIELDS = "f43,f44,f45,f46,f47,f48,f57,f58,f170"
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


def _secid(etf_code: str) -> str:
    """构造 eastmoney secid（沪市 5/6/9 → 1；深市 1/0/3 → 0）。"""
    prefix = "1" if etf_code.startswith("5") else "0"
    return f"{prefix}.{etf_code}"


def _sync_get_push2delay(etf_code: str) -> Optional[dict]:
    """直连 push2delay.eastmoney.com 拉 ETF 实时最新价。

    返回 dict 形如 {"f43": 4.984, "f44": 5.001, ...} 或 None。
    """
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            r = client.get(
                _PUSH2_DELAY_URL,
                params={
                    "secid": _secid(etf_code),
                    "fields": _PUSH2_FIELDS,
                    "fltt": "2",
                    "invt": "2",
                },
                headers=_QUOTE_HEADERS,
            )
            r.raise_for_status()
            data = r.json()
        d = data.get("data") if isinstance(data, dict) else None
        if d and d.get("f43") is not None:
            return d
        return None
    except Exception as e:
        logger.warning(
            f"[EFINANCE] push2delay fallback failed for {etf_code}: {str(e)[:100]}"
        )
        return None


async def fetch_etf_nav(etf_code: str) -> dict:
    """Fetch ETF NAV from efinance（基金净值）。

    使用 ef.fund.get_quote_history，返回单位净值历史，取第一行作为当日净值。

    BUG-2026-06-EFINANCE-B 修复：
        efinance 的 fund 数据按日期倒序返回（最新在最前），之前用 df.iloc[-1]
        取到的是历史最早一条（如 510300 在 2012-05-04 的 NAV=1.007），
        而非当日净值。现在改用 df.iloc[0] 取最新一条，同时补回 nav_history
        字段，与 eastmoney_direct_service.fetch_etf_nav 返回结构对齐。
    """
    ef = _get_efinance_lib()
    if ef is None:
        return {"nav": None, "nav_history": [], "date": "", "source": "efinance(unavailable)"}

    try:
        df = await asyncio.to_thread(ef.fund.get_quote_history, etf_code)
        if df is None or df.empty:
            return {"nav": None, "nav_history": [], "date": "", "source": "efinance(no_data)"}

        # BUG-2026-06-EFINANCE-B: efinance fund 数据按日期倒序，iloc[0] 是最新一条
        latest = df.iloc[0]
        nav = _to_float(latest.get("单位净值"))
        date_str = str(latest.get("日期", ""))[:10]

        # 构建 nav_history（升序，过滤无效行），取最近 30 条供 premium 7d 均值计算
        nav_history: list[dict] = []
        # df 倒序，直接 iterrows 后反转
        recent = df.head(30).iloc[::-1]
        for _, row in recent.iterrows():
            d = str(row.get("日期", ""))[:10]
            v = _to_float(row.get("单位净值"))
            if d and v is not None and v > 0:
                nav_history.append({"date": d, "nav": v})

        return {
            "nav": nav,
            "nav_history": nav_history,
            "date": date_str,
            "source": "efinance",
            "source_api": "efinance:fund.get_quote_history",
        }
    except Exception as e:
        logger.error(f"[EFINANCE] fetch_etf_nav({etf_code}) error: {e}")
        return {
            "nav": None, "nav_history": [], "date": "",
            "source": f"efinance(error: {str(e)[:40]})",
        }


async def fetch_etf_close_price(etf_code: str) -> dict:
    """Fetch ETF close price from efinance（K线收盘价）。

    BUG-2026-06-EFINANCE-C 修复：
        ef.stock.get_quote_history 命中 push2his.eastmoney.com，该 host 在
        沙箱/部分网络环境被防火墙 RST。修复策略：
          1) 先试 ef.stock.get_quote_history（保持原有调用方式）
          2) 失败时降级直连 push2delay.eastmoney.com（官方 15 分钟延时行情）
          3) 仍失败则返回 source="efinance(no_data)" 让上层 fallback 到其他源
    """
    ef = _get_efinance_lib()
    if ef is None:
        return {"close": None, "date": "", "source": "efinance(unavailable)"}

    # ── 1) 先试 ef.stock.get_quote_history（原有路径）─────────────────────────
    try:
        # klt=101 日线, fqt=1 前复权
        df = await asyncio.to_thread(
            ef.stock.get_quote_history, etf_code, klt=101, fqt=1
        )
        if df is not None and not df.empty:
            # 同 fund 数据，stock K 线也是倒序，iloc[0] 是最新一条
            latest = df.iloc[0]
            close = _to_float(latest.get("收盘"))
            date_str = str(latest.get("日期", ""))[:10]
            if close is not None and close > 0:
                return {
                    "close": close,
                    "date": date_str,
                    "source": "efinance",
                    "source_api": "efinance:stock.get_quote_history",
                }
            logger.warning(
                f"[EFINANCE] ef.stock.get_quote_history({etf_code}) returned empty close, "
                f"falling back to push2delay"
            )
        else:
            logger.warning(
                f"[EFINANCE] ef.stock.get_quote_history({etf_code}) returned empty df, "
                f"falling back to push2delay"
            )
    except Exception as e:
        logger.warning(
            f"[EFINANCE] ef.stock.get_quote_history({etf_code}) failed (push2his blocked?), "
            f"falling back to push2delay: {str(e)[:80]}"
        )

    # ── 2) 降级 push2delay.eastmoney.com（沙箱可达）──────────────────────────
    try:
        data = await asyncio.to_thread(_sync_get_push2delay, etf_code)
        if data:
            close = _to_float(data.get("f43"))
            if close is not None and close > 0:
                # push2delay 是实时行情端点，无 trade_date 字段，用当天日期
                date_str = datetime.now().strftime("%Y-%m-%d")
                return {
                    "close": close,
                    "date": date_str,
                    "source": "efinance",
                    "source_api": "efinance:push2delay_fallback/qt/stock/get",
                }
    except Exception as e:
        logger.warning(
            f"[EFINANCE] push2delay fallback error for {etf_code}: {str(e)[:80]}"
        )

    # ── 3) 全部失败 ────────────────────────────────────────────────────────
    return {"close": None, "date": "", "source": "efinance(no_data)"}


async def fetch_etf_premium(etf_code: str) -> dict:
    """Fetch ETF premium from efinance（ETF 溢价率）。

    通过 close price 和 NAV 计算：premium = (close / nav - 1) * 100
    如果任一获取失败，返回 None。
    """
    ef = _get_efinance_lib()
    if ef is None:
        return {"premium_today": None, "premium_7d_avg": None, "date": "",
                "source": "efinance(unavailable)"}

    # 并发拉 close 和 nav
    price_task = fetch_etf_close_price(etf_code)
    nav_task = fetch_etf_nav(etf_code)
    price_result, nav_result = await asyncio.gather(price_task, nav_task)

    close = _to_float(price_result.get("close"))
    nav = _to_float(nav_result.get("nav"))

    if close is None or nav is None or nav <= 0:
        return {
            "premium_today": None,
            "premium_7d_avg": None,
            "date": price_result.get("date") or nav_result.get("date", ""),
            "source": "efinance(insufficient_data)",
        }

    premium = round((close / nav - 1) * 100, 4)

    # 用 nav_history 估算近 7 日均值（close 历史缺失时简化为 None）
    # 这里 nav_history 是 ETF 净值历史，与 close 不严格匹配，仅作粗略参考
    premium_7d_avg: Optional[float] = None
    nav_history = nav_result.get("nav_history") or []
    if len(nav_history) >= 2:
        try:
            recent_n = min(7, len(nav_history))
            recent_navs = [item["nav"] for item in nav_history[-recent_n:] if item.get("nav")]
            # 用最近 close / 历史平均 nav 近似 premium 7d 均值（粗略，仅作降级备源参考）
            if recent_navs and close:
                avg_nav = sum(recent_navs) / len(recent_navs)
                if avg_nav > 0:
                    premium_7d_avg = round((close / avg_nav - 1) * 100, 4)
        except Exception:
            premium_7d_avg = None

    return {
        "premium_today": premium,
        "premium_7d_avg": premium_7d_avg,
        "date": price_result.get("date") or nav_result.get("date", ""),
        "source": "efinance",
        "source_api": "efinance:stock+fund",
        "close": close,
        "nav": nav,
    }


async def fetch_index_valuation(index_code: str) -> dict:
    """Fetch index PE/PB from efinance。

    efinance 不直接提供指数估值数据（PE/PB），仅提供指数行情。
    返回 None，让 DataSourceManager 跳过此源继续尝试 tushare。
    """
    return {
        "pe": None,
        "pb": None,
        "pe_percentile": None,
        "pb_percentile": None,
        "date": "",
        "source": "efinance(unsupported_metric)",
    }


async def fetch_dividend_yield(index_code: str) -> dict:
    """Fetch dividend yield from efinance。

    efinance 不直接提供股息率历史，返回 None。
    """
    return {
        "dividend_yield": None,
        "date": "",
        "source": "efinance(unsupported_metric)",
    }
