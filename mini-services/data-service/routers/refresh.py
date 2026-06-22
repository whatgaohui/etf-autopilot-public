"""Manual refresh endpoint — triggers data refresh via DataSourceManager (V4 §4).

V4 策略书§4.1: 主源 + 备源 + 交叉校验。本路由通过 DataSourceManager
统一调度，每次刷新都会对关键字段（valuation/premium/nav/dividend）执行
主备源交叉校验，结果写入 cross_check_log 表。

V4.1 PRD§10.8: 刷新后对每个 (code, metric_type) 计算数据质量评分 0-100，
持久化到 data_quality_result 表，供规则引擎和前端可信度卡读取。

V4.1 PRD§10.9 / S2-T4: 接入熔断降级链路 fetch_with_fallback。主源失败自动
切备源，备源失败用缓存，缓存过期才阻断。fallback_summary 统计降级次数。
"""
import asyncio
import logging
import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks

from models.schemas import RefreshResponse
from services.akshare_service import (
    _save_to_cache,
    refresh_market_indices,
)
from services.data_source_manager import get_manager, FallbackResult
from services.data_quality_score import compute_quality_score, persist_quality_score
from config import DB_PATH, TRACKED_ETFS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["refresh"])

# Track refresh status
_refresh_status: Optional[dict] = None


# QDII 代码集合（用于质量评分时区分完整性判断）
_QDII_CODES = {"513500", "513300"}


def _compute_and_persist_quality_scores(
    cross_check_summary: list[dict],
) -> dict:
    """V4.1 §10.8: 刷新后对每个 (code, metric_type) 计算质量评分并持久化。

    从 market_data_cache 读取最新数据，结合 cross_check_summary 中的交叉校验结果，
    调用 compute_quality_score 计算 0-100 分，写入 data_quality_result 表。
    """
    # 建立交叉校验索引：{(code, field): check_dict}
    cc_index: dict[tuple[str, str], dict] = {}
    for cc in cross_check_summary:
        code = cc.get("code", "")
        field = cc.get("field", "")
        if code and field:
            cc_index[(code, field)] = cc

    quality_scores: list[dict] = []
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            # 读取每个 tracked ETF 的最新缓存数据
            for etf_code, info in TRACKED_ETFS.items():
                index_code = info["index_code"]
                is_qdii = etf_code in _QDII_CODES

                # 对每个 metric_type 计算质量分
                metric_code_map = {
                    "valuation": index_code,   # 估值用指数代码
                    "premium": etf_code,
                    "nav": etf_code,
                }
                if etf_code == "510880":
                    metric_code_map["dividend"] = index_code

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
                    # 补充血缘字段到 md，供质量分计算用
                    md["updated_at"] = row["updated_at"] or row["fetch_time"] or row["date"]
                    md["date"] = row["date"] or ""
                    md["trade_date"] = row["trade_date"] or row["date"] or ""
                    # V4.1 BUG-2026-06-QUALITY: 传入 source/source_api 供 source_health 判断
                    md["source"] = row["source"] or ""
                    md["source_api"] = row["source_api"] or ""

                    # 查交叉校验结果
                    cc = cc_index.get((cache_code, metric_type))

                    # 判断源健康状态
                    # V4.1 BUG-2026-06-QUALITY: 不再仅依赖 cross_check 的 quality_status，
                    # 而是综合判断: 缓存有值 + source 非空 → healthy；缓存有值但 source 含 cache: → degraded；
                    # 缓存无值 → failed（compute_quality_score 内部会再兜底判断）
                    source_health = "healthy"
                    actual_src = (row["source"] or "")
                    if cc:
                        qs = cc.get("quality_status", "")
                        if qs == "primary_failed":
                            source_health = "degraded"
                        elif qs in ("both_failed",):
                            # cross_check 报 both_failed，但缓存有值 → 降级而非故障
                            source_health = "degraded" if md else "failed"
                        elif qs == "backup_failed":
                            # 备源失败但主源有值 → 仍 healthy（单源可用）
                            source_health = "healthy"
                    # 缓存 source 含 cache: 前缀 → 使用了 stale 缓存，标 degraded
                    if "cache:" in actual_src and source_health == "healthy":
                        source_health = "degraded"

                    score = compute_quality_score(
                        code=cache_code,
                        metric_type=metric_type,
                        md=md,
                        cross_check=cc,
                        source_health=source_health,
                        is_qdii=is_qdii,
                    )
                    persist_quality_score(score)
                    quality_scores.append(score.to_dict())
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[REFRESH] Failed to compute quality scores: {e}")

    # 汇总
    total = len(quality_scores)
    excellent = sum(1 for s in quality_scores if s["quality_status"] == "excellent")
    usable = sum(1 for s in quality_scores if s["quality_status"] == "usable")
    suspicious = sum(1 for s in quality_scores if s["quality_status"] == "suspicious")
    unavailable = sum(1 for s in quality_scores if s["quality_status"] == "unavailable")
    avg_score = round(sum(s["quality_score"] for s in quality_scores) / total, 1) if total > 0 else 0

    return {
        "total_metrics": total,
        "excellent": excellent,
        "usable": usable,
        "suspicious": suspicious,
        "unavailable": unavailable,
        "avg_score": avg_score,
        "allow_buy_suggestion": sum(1 for s in quality_scores if s["can_use_for_rule"]) > 0,
        "allow_rebalance_suggestion": sum(1 for s in quality_scores if s["can_use_for_strong_rule"]) > 0,
    }


def _do_refresh():
    """Run the refresh in a synchronous wrapper for background tasks."""
    global _refresh_status
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(_async_refresh())
        _refresh_status = result
    except Exception as e:
        logger.error(f"[REFRESH] Background refresh error: {e}")
        _refresh_status = {"status": "error", "message": str(e), "completed_at": datetime.now().isoformat()}
    finally:
        loop.close()


async def _fetch_and_cache_with_fallback(
    mgr, data_type: str, code: str, **kwargs
) -> tuple[bool, FallbackResult]:
    """V4.1 §10.9 / S2-T4: 通过熔断降级链路取数并写入缓存。

    返回 (success, fallback_result)。
    success=True 表示拿到有效数据（含 stale 缓存）；False 表示完全 blocked。
    """
    result = await mgr.fetch_with_fallback(data_type, code, **kwargs)

    if result.blocked and not result.data:
        return False, result

    # 写入缓存（用降级链路返回的真实源名，避免血缘失真）
    # 日期优先从 data 取，回退到今天
    data_date = result.data.get("date") or datetime.now().strftime("%Y-%m-%d")
    # V4.1 S2-T4: 剥离 "cache:" 前缀，避免连续刷新时 "cache:cache:..." 累积
    # stale=True 时数据来自缓存，无需重写（缓存已存在）；仅 fallback 切源时需重写血缘
    real_source = result.source
    real_source_api = result.source_api or f"{real_source}:{data_type}"
    if real_source.startswith("cache:"):
        # 数据来自缓存，源名剥离 cache: 前缀（保留原始源如 akshare/tushare/efinance）
        real_source = real_source[len("cache:"):]
        if real_source_api.startswith("cache:"):
            real_source_api = real_source_api[len("cache:"):]
        # stale 场景：缓存已存在，跳过重写避免 source 累积污染
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
        logger.warning(f"[REFRESH] _save_to_cache failed for {code}/{data_type}: {e}")

    success = not result.blocked
    return success, result


async def _async_refresh() -> dict:
    """Run the actual refresh and return results.

    V4.1 §10.9 / S2-T4: 通过 DataSourceManager.fetch_with_fallback 执行熔断降级链路。
    主源失败自动切备源，备源失败用缓存，缓存过期才阻断。
    同时通过 fetch_with_cross_check 做主备源交叉校验，写入 cross_check_log。
    """
    results = {}
    updated_codes = []
    cross_check_summary: list[dict] = []
    fallback_summary: list[dict] = []  # V4.1 S2-T4: 降级链路统计

    mgr = get_manager()

    for etf_code, info in TRACKED_ETFS.items():
        index_code = info["index_code"]
        index_name = info.get("index_name", "")
        has_errors = False

        # 1. Fetch valuation（V4.1 S2-T4: 熔断降级 + 交叉校验）
        try:
            success, fb = await _fetch_and_cache_with_fallback(
                mgr, "valuation", index_code, index_name=index_name
            )
            if success:
                results[f"{etf_code}_valuation"] = (
                    f"ok (PE={fb.data.get('pe')}, source={fb.source}"
                    f"{' [fallback]' if fb.source_fallback else ''}"
                    f"{' [stale]' if fb.stale else ''})"
                )
                fallback_summary.append({
                    "code": index_code, "metric": "valuation",
                    "source": fb.source, "source_fallback": fb.source_fallback,
                    "stale": fb.stale, "blocked": fb.blocked,
                    "single_source_warning": fb.single_source_warning,
                    "reason": fb.reason,
                })
            else:
                results[f"{etf_code}_valuation"] = f"blocked: {fb.reason}"
                has_errors = True
            # 交叉校验（独立于降级链路，写 cross_check_log）
            try:
                _, check = await mgr.fetch_with_cross_check("valuation", index_code, index_name=index_name)
                cross_check_summary.append(check.to_dict())
            except Exception as ce:
                logger.warning(f"[REFRESH] cross-check valuation {index_code} failed: {ce}")
        except Exception as e:
            results[f"{etf_code}_valuation"] = f"error: {str(e)}"
            has_errors = True

        # 2. Fetch premium（V4.1 S2-T4: 熔断降级 + 交叉校验）
        try:
            success, fb = await _fetch_and_cache_with_fallback(mgr, "premium", etf_code)
            if success:
                results[f"{etf_code}_premium"] = (
                    f"ok (premium={fb.data.get('premium_today')}, source={fb.source}"
                    f"{' [fallback]' if fb.source_fallback else ''}"
                    f"{' [stale]' if fb.stale else ''})"
                )
                fallback_summary.append({
                    "code": etf_code, "metric": "premium",
                    "source": fb.source, "source_fallback": fb.source_fallback,
                    "stale": fb.stale, "blocked": fb.blocked,
                    "single_source_warning": fb.single_source_warning,
                    "reason": fb.reason,
                })
            else:
                results[f"{etf_code}_premium"] = f"blocked: {fb.reason}"
                has_errors = True
            try:
                _, check = await mgr.fetch_with_cross_check("premium", etf_code)
                cross_check_summary.append(check.to_dict())
            except Exception as ce:
                logger.warning(f"[REFRESH] cross-check premium {etf_code} failed: {ce}")
        except Exception as e:
            results[f"{etf_code}_premium"] = f"error: {str(e)}"
            has_errors = True

        # 3. Fetch NAV（V4.1 S2-T4: 熔断降级 + 交叉校验）
        try:
            success, fb = await _fetch_and_cache_with_fallback(mgr, "nav", etf_code)
            if success:
                results[f"{etf_code}_nav"] = (
                    f"ok (NAV={fb.data.get('nav')}, source={fb.source}"
                    f"{' [fallback]' if fb.source_fallback else ''}"
                    f"{' [stale]' if fb.stale else ''})"
                )
                fallback_summary.append({
                    "code": etf_code, "metric": "nav",
                    "source": fb.source, "source_fallback": fb.source_fallback,
                    "stale": fb.stale, "blocked": fb.blocked,
                    "single_source_warning": fb.single_source_warning,
                    "reason": fb.reason,
                })
            else:
                results[f"{etf_code}_nav"] = f"blocked: {fb.reason}"
                has_errors = True
            try:
                _, check = await mgr.fetch_with_cross_check("nav", etf_code)
                cross_check_summary.append(check.to_dict())
            except Exception as ce:
                logger.warning(f"[REFRESH] cross-check nav {etf_code} failed: {ce}")
        except Exception as e:
            results[f"{etf_code}_nav"] = f"error: {str(e)}"
            has_errors = True

        # 4. Fetch dividend for 红利ETF
        if etf_code == "510880":
            try:
                success, fb = await _fetch_and_cache_with_fallback(mgr, "dividend", index_code)
                if success:
                    results[f"{etf_code}_dividend"] = (
                        f"ok (div_yield={fb.data.get('dividend_yield')}, source={fb.source}"
                        f"{' [fallback]' if fb.source_fallback else ''})"
                    )
                    fallback_summary.append({
                        "code": index_code, "metric": "dividend",
                        "source": fb.source, "source_fallback": fb.source_fallback,
                        "stale": fb.stale, "blocked": fb.blocked,
                        "single_source_warning": fb.single_source_warning,
                        "reason": fb.reason,
                    })
                else:
                    results[f"{etf_code}_dividend"] = f"blocked: {fb.reason}"
                    has_errors = True
                try:
                    _, check = await mgr.fetch_with_cross_check("dividend", index_code)
                    cross_check_summary.append(check.to_dict())
                except Exception as ce:
                    logger.warning(f"[REFRESH] cross-check dividend {index_code} failed: {ce}")
            except Exception as e:
                results[f"{etf_code}_dividend"] = f"error: {str(e)}"
                has_errors = True

        if not has_errors:
            updated_codes.append(etf_code)

    # 5. Fetch broad market indices
    try:
        market_updated = await refresh_market_indices()
        results["market_indices"] = f"ok ({len(market_updated)} indices updated)"
    except Exception as e:
        results["market_indices"] = f"error: {str(e)}"

    success_count = len(updated_codes)
    total = len(TRACKED_ETFS)

    # 交叉校验汇总
    cc_passed = sum(1 for c in cross_check_summary if c.get("quality_status") == "passed")
    cc_inconsistent = sum(1 for c in cross_check_summary if c.get("quality_status") == "source_inconsistent")
    cc_failed = sum(1 for c in cross_check_summary if c.get("quality_status") in ("primary_failed", "both_failed"))

    # V4.1 S2-T4: 降级链路汇总
    fb_total = len(fallback_summary)
    fb_fallback = sum(1 for f in fallback_summary if f.get("source_fallback"))
    fb_stale = sum(1 for f in fallback_summary if f.get("stale") and not f.get("blocked"))
    fb_blocked = sum(1 for f in fallback_summary if f.get("blocked"))
    fb_single_source = sum(1 for f in fallback_summary if f.get("single_source_warning"))
    fb_source_conflict = sum(1 for c in cross_check_summary if c.get("source_conflict"))

    # V4.1 §10.8: 计算并持久化数据质量评分
    quality_summary = _compute_and_persist_quality_scores(cross_check_summary)

    return {
        "status": "completed",
        "success_count": success_count,
        "total": total,
        "results": results,
        "updated_codes": updated_codes,
        "cross_check": {
            "total": len(cross_check_summary),
            "passed": cc_passed,
            "inconsistent": cc_inconsistent,
            "failed": cc_failed,
            "source_conflict": fb_source_conflict,
        },
        "fallback_summary": {
            "total": fb_total,
            "fallback_count": fb_fallback,
            "stale_count": fb_stale,
            "blocked_count": fb_blocked,
            "single_source_count": fb_single_source,
            "source_conflict_count": fb_source_conflict,
            "details": fallback_summary,
        },
        "quality_summary": quality_summary,
        "completed_at": datetime.now().isoformat(),
    }


@router.post("/refresh", response_model=RefreshResponse)
async def refresh_data(background_tasks: BackgroundTasks):
    """Trigger manual data refresh via DataSourceManager (V4.1 §10.9 熔断降级链路).

    Returns when refresh completes. Check status with GET /api/refresh/status.
    """
    global _refresh_status
    _refresh_status = {"status": "running", "started_at": datetime.now().isoformat()}

    try:
        result = await _async_refresh()
        _refresh_status = result
        return RefreshResponse(
            success=True,
            message="Data refresh completed.",
            updated_codes=result.get("updated_codes", []),
            quality_summary=result.get("quality_summary"),
            cross_check_summary=result.get("cross_check"),
            fallback_summary=result.get("fallback_summary"),
        )
    except Exception as e:
        _refresh_status = {"status": "error", "message": str(e), "completed_at": datetime.now().isoformat()}
        return RefreshResponse(
            success=False,
            message=f"Refresh error: {e}",
            updated_codes=[],
        )


@router.get("/refresh/status")
async def get_refresh_status():
    """Get the status of the most recent refresh operation."""
    global _refresh_status
    if _refresh_status is None:
        return {"status": "never_run", "message": "No refresh has been triggered yet"}
    return _refresh_status
