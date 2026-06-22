"""APScheduler daily jobs for automatic data caching.

Scheduled jobs:
- 15:30: Valuation, Premium, Dividend data updates
- 20:00: NAV data update
- 21:00: Historical data backfill

V4.1 §10.2 / S3-T1: 定时任务接入 DataSourceManager.fetch_with_cross_check，
让定时刷新也能产 cross_check_log（不只是手动 /api/refresh 才有）。
V4.1 §10.4 / S3-T5: 历史回补任务改用 fetch_with_fallback（熔断降级链路）。
V4.1 §10.6 / S3-T4: 新增 source_health_check 任务（每小时整点），
对每个 enabled 适配器调 health_check()，结果写 data_source_status 表。
"""
import asyncio
import logging
import sqlite3
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from config import SCHEDULED_JOBS, TRACKED_ETFS, DB_PATH
from services.akshare_service import _save_to_cache, refresh_market_indices
from services.data_source_manager import get_manager, FallbackResult
from services.data_quality_score import compute_quality_score, persist_quality_score

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()

# QDII 代码集合
_QDII_CODES = {"513500", "513300"}


# ─── 共享：定时任务的降级+交叉校验+质量评分全链路 ──────────────────────────────

async def _scheduled_fetch_and_cache(
    data_type: str, code: str, **kwargs
) -> tuple[bool, FallbackResult]:
    """定时任务专用：通过熔断降级链路取数 + 写缓存。

    复用 refresh.py 的 _fetch_and_cache_with_fallback 思路，但独立于 HTTP 路由。
    """
    mgr = get_manager()
    result = await mgr.fetch_with_fallback(data_type, code, **kwargs)

    if result.blocked and not result.data:
        return False, result

    data_date = result.data.get("date") or datetime.now().strftime("%Y-%m-%d")
    real_source = result.source
    real_source_api = result.source_api or f"{real_source}:{data_type}"
    if real_source.startswith("cache:"):
        # stale 场景：缓存已存在，跳过重写
        return (not result.blocked), result

    try:
        _save_to_cache(
            code=code,
            data_type=data_type,
            date_str=str(data_date)[:10],
            data=result.data,
            source_name=real_source,
            source_api=real_source_api,
        )
    except Exception as e:
        logger.warning(f"[SCHEDULER] _save_to_cache failed for {code}/{data_type}: {e}")

    return (not result.blocked), result


async def _scheduled_cross_check(data_type: str, code: str, **kwargs) -> dict:
    """定时任务专用：执行主备源交叉校验，写 cross_check_log + source_compare_result。"""
    mgr = get_manager()
    try:
        _, check = await mgr.fetch_with_cross_check(data_type, code, **kwargs)
        return check.to_dict()
    except Exception as e:
        logger.warning(f"[SCHEDULER] cross-check {data_type} {code} failed: {e}")
        return {}


def _persist_quality_for_metric(
    cross_check_summary: list[dict],
    etf_code: str,
    index_code: str,
    is_qdii: bool,
) -> None:
    """定时任务专用：对单个 ETF 的多个指标计算质量评分并持久化。"""
    cc_index: dict[tuple[str, str], dict] = {}
    for cc in cross_check_summary:
        c = cc.get("code", "")
        f = cc.get("field", "")
        if c and f:
            cc_index[(c, f)] = cc

    metric_code_map = {
        "valuation": index_code,
        "premium": etf_code,
        "nav": etf_code,
    }
    if etf_code == "510880":
        metric_code_map["dividend"] = index_code

    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            for metric_type, cache_code in metric_code_map.items():
                row = conn.execute(
                    """SELECT data_json, updated_at, date, raw_value, clean_value,
                              source, source_api, is_valid, abnormal_reason,
                              sample_days, percentile_window, percentile, trade_date, fetch_time
                       FROM market_data_cache
                       WHERE code = ? AND data_type = ?
                       ORDER BY updated_at DESC LIMIT 1""",
                    (cache_code, metric_type),
                ).fetchone()
                if not row:
                    continue
                import json
                try:
                    md = json.loads(row["data_json"]) if row["data_json"] else {}
                except Exception:
                    md = {}
                md["updated_at"] = row["updated_at"] or row["fetch_time"] or row["date"]
                md["date"] = row["date"] or ""
                md["trade_date"] = row["trade_date"] or row["date"] or ""

                cc = cc_index.get((cache_code, metric_type))
                source_health = "healthy"
                if cc:
                    qs = cc.get("quality_status", "")
                    if qs == "primary_failed":
                        source_health = "degraded"
                    elif qs in ("both_failed",):
                        source_health = "failed"

                try:
                    score = compute_quality_score(
                        code=cache_code,
                        metric_type=metric_type,
                        md=md,
                        cross_check=cc,
                        source_health=source_health,
                        is_qdii=is_qdii,
                    )
                    persist_quality_score(score)
                except Exception as e:
                    logger.warning(f"[SCHEDULER] quality score {etf_code}/{metric_type} failed: {e}")
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[SCHEDULER] _persist_quality_for_metric {etf_code} error: {e}")


# ─── 定时任务实现 ──────────────────────────────────────────────────────────────

async def job_valuation_update():
    """Update index PE/PB and percentile data for all tracked ETFs (15:30).

    V4.1 S3-T1: 走 fetch_with_fallback 熔断降级 + fetch_with_cross_check 交叉校验 +
    compute_quality_score 质量评分。
    """
    logger.info("[SCHEDULER] Running job: valuation_update")
    try:
        cross_check_summary: list[dict] = []
        for code, etf_info in TRACKED_ETFS.items():
            index_code = etf_info["index_code"]
            index_name = etf_info.get("index_name", "")
            try:
                success, fb = await _scheduled_fetch_and_cache(
                    "valuation", index_code, index_name=index_name
                )
                if success:
                    logger.info(
                        f"[SCHEDULER] valuation {code}: PE={fb.data.get('pe')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''}{' [stale]' if fb.stale else ''}"
                    )
                else:
                    logger.warning(f"[SCHEDULER] valuation {code} blocked: {fb.reason}")
                # 交叉校验（独立写 cross_check_log）
                cc = await _scheduled_cross_check("valuation", index_code, index_name=index_name)
                if cc:
                    cross_check_summary.append(cc)
                # 质量评分
                _persist_quality_for_metric(
                    cross_check_summary, code, index_code, code in _QDII_CODES
                )
            except Exception as e:
                logger.error(f"[SCHEDULER] valuation {code} error: {e}")
            await asyncio.sleep(0.5)
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_valuation_update: {e}")


async def job_premium_update():
    """Update ETF premium rate data for all tracked ETFs (15:30)."""
    logger.info("[SCHEDULER] Running job: premium_update")
    try:
        cross_check_summary: list[dict] = []
        for code, etf_info in TRACKED_ETFS.items():
            try:
                success, fb = await _scheduled_fetch_and_cache("premium", code)
                if success:
                    logger.info(
                        f"[SCHEDULER] premium {code}: {fb.data.get('premium_today')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''}{' [stale]' if fb.stale else ''}"
                    )
                else:
                    logger.warning(f"[SCHEDULER] premium {code} blocked: {fb.reason}")
                cc = await _scheduled_cross_check("premium", code)
                if cc:
                    cross_check_summary.append(cc)
                _persist_quality_for_metric(
                    cross_check_summary, code, etf_info["index_code"], code in _QDII_CODES
                )
            except Exception as e:
                logger.error(f"[SCHEDULER] premium {code} error: {e}")
            await asyncio.sleep(0.5)
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_premium_update: {e}")


async def job_nav_update():
    """Update ETF NAV data for all tracked ETFs (20:00)."""
    logger.info("[SCHEDULER] Running job: nav_update")
    try:
        cross_check_summary: list[dict] = []
        for code, etf_info in TRACKED_ETFS.items():
            try:
                success, fb = await _scheduled_fetch_and_cache("nav", code)
                if success:
                    logger.info(
                        f"[SCHEDULER] nav {code}: {fb.data.get('nav')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''}{' [stale]' if fb.stale else ''}"
                    )
                else:
                    logger.warning(f"[SCHEDULER] nav {code} blocked: {fb.reason}")
                cc = await _scheduled_cross_check("nav", code)
                if cc:
                    cross_check_summary.append(cc)
                _persist_quality_for_metric(
                    cross_check_summary, code, etf_info["index_code"], code in _QDII_CODES
                )
            except Exception as e:
                logger.error(f"[SCHEDULER] nav {code} error: {e}")
            await asyncio.sleep(0.5)
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_nav_update: {e}")


async def job_dividend_update():
    """Update dividend yield data for 红利指数 (15:30)."""
    logger.info("[SCHEDULER] Running job: dividend_update")
    try:
        cross_check_summary: list[dict] = []
        dividend_etf = TRACKED_ETFS.get("510880")
        if dividend_etf:
            index_code = dividend_etf["index_code"]
            try:
                success, fb = await _scheduled_fetch_and_cache("dividend", index_code)
                if success:
                    logger.info(
                        f"[SCHEDULER] dividend 510880: yield={fb.data.get('dividend_yield')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''}"
                    )
                else:
                    logger.warning(f"[SCHEDULER] dividend 510880 blocked: {fb.reason}")
                cc = await _scheduled_cross_check("dividend", index_code)
                if cc:
                    cross_check_summary.append(cc)
                _persist_quality_for_metric(cross_check_summary, "510880", index_code, False)
            except Exception as e:
                logger.error(f"[SCHEDULER] dividend 510880 error: {e}")
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_dividend_update: {e}")


async def job_history_backfill():
    """Backfill missing historical data (21:00).

    V4.1 §10.4 / S3-T5: 改用 fetch_with_fallback 熔断降级链路，
    补缺失日期时也能切源。
    """
    logger.info("[SCHEDULER] Running job: history_backfill")
    try:
        for code in TRACKED_ETFS:
            try:
                success, fb = await _scheduled_fetch_and_cache("nav", code)
                if success:
                    logger.info(
                        f"[SCHEDULER] backfill nav {code}: nav={fb.data.get('nav')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''}{' [stale]' if fb.stale else ''}"
                    )
                else:
                    logger.warning(f"[SCHEDULER] backfill nav {code} blocked: {fb.reason}")
            except Exception as e:
                logger.error(f"[SCHEDULER] backfill nav {code} error: {e}")
            await asyncio.sleep(0.5)

        # 海外 ETF 重点补 premium
        for code, info in TRACKED_ETFS.items():
            if info.get("category") == "overseas":
                try:
                    success, fb = await _scheduled_fetch_and_cache("premium", code)
                    if success:
                        logger.info(
                            f"[SCHEDULER] backfill premium {code}: {fb.data.get('premium_today')}, source={fb.source}"
                            f"{' [fallback]' if fb.source_fallback else ''}{' [stale]' if fb.stale else ''}"
                        )
                    else:
                        logger.warning(f"[SCHEDULER] backfill premium {code} blocked: {fb.reason}")
                except Exception as e:
                    logger.error(f"[SCHEDULER] backfill premium {code} error: {e}")
                await asyncio.sleep(0.5)

        logger.info("[SCHEDULER] history_backfill completed")
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_history_backfill: {e}")


async def job_market_index_update():
    """Update broad market index data for Trends page (15:30)."""
    logger.info("[SCHEDULER] Running job: market_index_update")
    try:
        updated = await refresh_market_indices()
        logger.info(f"[SCHEDULER] Market indices updated: {updated}")
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_market_index_update: {e}")


async def job_kline_update():
    """V4.1 BUG-2026-06-A500-KLINE: 拉取所有 ETF K线（每日 18:30 收盘后）。

    链路：akshare.fund_etf_hist_sina → 失败时 eastmoney_direct LSJZ 历史净值代理。
    拉到的数据写 cache 表（data_type='kline'），前端 /api/cached/kline 读取展示。
    """
    logger.info("[SCHEDULER] Running job: kline_update")
    from services.akshare_service import fetch_etf_kline

    try:
        success_count = 0
        for code in TRACKED_ETFS.keys():
            try:
                result = await fetch_etf_kline(code)
                kline_history = result.get("kline_history", [])
                is_proxy = result.get("is_nav_proxy", False)
                source = result.get("source", "unknown")
                logger.info(
                    f"[SCHEDULER] kline {code}: {len(kline_history)} points, "
                    f"is_nav_proxy={is_proxy}, source={source}"
                )
                if kline_history:
                    success_count += 1
                else:
                    logger.warning(f"[SCHEDULER] kline {code}: empty kline_history, source={source}")
            except Exception as e:
                logger.error(f"[SCHEDULER] kline {code} failed: {e}")
            # 限流：每个 ETF 之间间隔 1 秒
            await asyncio.sleep(1.0)

        logger.info(
            f"[SCHEDULER] kline_update completed: {success_count}/{len(TRACKED_ETFS)} ETFs updated"
        )
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_kline_update: {e}")


async def job_source_health_check():
    """V4.1 §10.6 / S3-T4: 数据源健康检查（每小时整点）。

    对每个 enabled 适配器调 health_check()，结果写 data_source_status 表。
    健康检查策略：
    - akshare/efinance: 实际尝试拉一个轻量数据（akshare 拉 1 只 ETF premium）
    - tushare: 检查 token 是否配置（不实际拉取避免耗积分）
    """
    logger.info("[SCHEDULER] Running job: source_health_check")
    try:
        mgr = get_manager()
        overview = mgr.get_sources_overview()
        now_iso = datetime.now().isoformat()
        conn = sqlite3.connect(DB_PATH)
        try:
            for src in overview:
                name = src.get("name", "")
                # 跳过 planned 的（未实现适配器）
                if src.get("status") == "planned":
                    continue
                source_type = src.get("role", "reference")
                latency_ms = 0
                status = "ok"
                error_msg = ""
                last_success = now_iso

                if not src.get("available"):
                    status = "unconfigured"
                    error_msg = "adapter not available (missing token or dependency)"
                    last_success = ""
                else:
                    # 实际 ping 一下（轻量调用）
                    start = datetime.now()
                    try:
                        if name == "akshare":
                            # 用一只 ETF premium 做轻量 ping
                            adapter = mgr._adapters.get("akshare")
                            if adapter:
                                r = await adapter.fetch("premium", "510330")
                                if not r.success:
                                    status = "error"
                                    error_msg = (r.error or "")[:200]
                                    last_success = ""
                        elif name == "tushare":
                            # tushare 只检查 token，不实际拉（耗积分）
                            from services import tushare_service
                            if not (tushare_service.TUSHARE_AVAILABLE and tushare_service._get_tushare_token()):
                                status = "error"
                                error_msg = "tushare token not configured"
                                last_success = ""
                        elif name == "efinance":
                            adapter = mgr._adapters.get("efinance")
                            if adapter:
                                # efinance 用 nav 做轻量 ping
                                r = await adapter.fetch("nav", "510330")
                                if not r.success:
                                    status = "error"
                                    error_msg = (r.error or "")[:200]
                                    last_success = ""
                        else:
                            # 子适配器（akshare_legu / akshare_csindex 等）只在 is_available 时记 ok
                            status = "ok" if src.get("available") else "unconfigured"
                    except Exception as e:
                        status = "error"
                        error_msg = str(e)[:200]
                        last_success = ""
                    latency_ms = int((datetime.now() - start).total_seconds() * 1000)

                conn.execute(
                    """INSERT INTO data_source_status
                       (source_name, source_type, last_fetch_time, last_success_time,
                        status, error_message, latency_ms, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (name, source_type, now_iso, last_success,
                     status, error_msg, latency_ms, now_iso),
                )
                logger.info(
                    f"[SCHEDULER] health_check {name}: status={status} latency={latency_ms}ms"
                    + (f" error={error_msg}" if error_msg else "")
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[SCHEDULER] Error in job_source_health_check: {e}")


def setup_scheduler():
    """Set up and configure the APScheduler with daily jobs."""
    # Job mapping
    job_map = {
        "valuation_update": job_valuation_update,
        "premium_update": job_premium_update,
        "nav_update": job_nav_update,
        "dividend_update": job_dividend_update,
        "market_index_update": job_market_index_update,
        "history_backfill": job_history_backfill,
        "kline_update": job_kline_update,
    }

    for job_config in SCHEDULED_JOBS:
        job_id = job_config["id"]
        job_func = job_map.get(job_id)
        if job_func:
            scheduler.add_job(
                job_func,
                "cron",
                hour=job_config["hour"],
                minute=job_config["minute"],
                id=job_id,
                name=job_config["description"],
                replace_existing=True,
            )
            logger.info(
                f"[SCHEDULER] Registered job '{job_id}' at {job_config['hour']:02d}:{job_config['minute']:02d}"
            )
        else:
            logger.warning(f"[SCHEDULER] Unknown job_id: {job_id}")

    # V4.1 S3-T4: 数据源健康检查任务（每小时整点）
    scheduler.add_job(
        job_source_health_check,
        "cron",
        minute=0,  # 每小时整点
        id="source_health_check",
        name="Hourly data source health check (V4.1 S3-T4)",
        replace_existing=True,
    )
    logger.info("[SCHEDULER] Registered job 'source_health_check' at every hour:00")

    return scheduler
