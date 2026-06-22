"""Data Quality Router — V4.1 PRD §10.8 数据质量评分 + §12.1 数据质量接口.

Endpoints:
- GET /api/data-quality/summary    — 全量质量摘要（总分 + 各状态计数 + 是否允许出建议）
- GET /api/data-quality/{code}     — 单只 ETF 的所有指标质量评分
- GET /api/data-quality/logs       — 质量日志（按时间倒序，可按 status 过滤）
- GET /api/data-quality/conflicts  — 主备源冲突列表
- GET /api/data-quality/fetch-logs — 数据拉取日志（V4.1 §13.9 data_fetch_log 表）
"""
import logging
import sqlite3
from typing import Optional

from fastapi import APIRouter, Query

from config import DB_PATH
from services.data_quality_score import (
    get_quality_summary,
    get_quality_by_code,
    get_quality_logs,
    get_quality_conflicts,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data-quality", tags=["data-quality"])


@router.get("/summary")
async def get_summary():
    """全量数据质量摘要（PRD §12.1: GET /api/data-quality/summary）。

    返回：
    - total_metrics: 总指标数
    - excellent/usable/suspicious/unavailable: 各状态计数
    - avg_score: 平均质量分
    - allow_buy_suggestion: 是否允许出买入建议（至少 1 个指标 can_use_for_rule）
    - allow_rebalance_suggestion: 是否允许出再平衡建议（至少 1 个指标 can_use_for_strong_rule）
    - items: 各指标的详细质量评分
    """
    return get_quality_summary()


@router.get("/{code}")
async def get_by_code(code: str):
    """单只 ETF 的所有指标质量评分（PRD §12.1: GET /api/data-quality/{code}）。"""
    items = get_quality_by_code(code)
    if not items:
        return {"code": code, "items": [], "message": f"no quality records for {code}"}
    # 汇总
    scores = [it.get("quality_score", 0) for it in items if it.get("quality_score") is not None]
    avg = round(sum(scores) / len(scores), 1) if scores else 0
    return {
        "code": code,
        "items": items,
        "avg_score": avg,
        "metric_count": len(items),
    }


@router.get("/logs/list")
async def get_logs(
    limit: int = Query(100, ge=1, le=500),
    status: Optional[str] = Query(None, description="excellent|usable|suspicious|unavailable"),
):
    """数据质量日志（PRD §12.1: GET /api/data-quality/logs）。"""
    return {"logs": get_quality_logs(limit=limit, status=status)}


@router.get("/conflicts/list")
async def get_conflicts(limit: int = Query(50, ge=1, le=200)):
    """主备源冲突列表（PRD §12.1: GET /api/data-quality/conflicts）。"""
    return {"conflicts": get_quality_conflicts(limit=limit)}


@router.post("/recompute")
async def recompute_quality_scores():
    """V4.1 BUG-2026-06-QUALITY: 基于现有缓存数据重算质量分（不重新拉数）。

    用于修复质量分计算逻辑后，无需完整 refresh 即可刷新质量评分。
    从 market_data_cache 读取最新数据 + cross_check_log 最新记录，重算并持久化。
    """
    import json
    from config import TRACKED_ETFS
    from services.data_quality_score import (
        compute_quality_score,
        persist_quality_score,
    )

    _QDII_CODES = {"513500", "513300", "518880"}
    quality_scores: list[dict] = []
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            # 建立交叉校验索引：取每个 (code, field) 的最新一条 cross_check_log
            cc_rows = conn.execute(
                """SELECT ccl.* FROM cross_check_log ccl
                   INNER JOIN (
                       SELECT code, field, MAX(fetch_time) AS max_ts
                       FROM cross_check_log GROUP BY code, field
                   ) latest ON ccl.code = latest.code AND ccl.field = latest.field
                            AND ccl.fetch_time = latest.max_ts"""
            ).fetchall()
            cc_index: dict[tuple[str, str], dict] = {}
            for r in cc_rows:
                cc_index[(r["code"], r["field"])] = dict(r)

            for etf_code, info in TRACKED_ETFS.items():
                index_code = info["index_code"]
                is_qdii = etf_code in _QDII_CODES

                metric_code_map = {
                    "valuation": index_code,
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
                    try:
                        md = json.loads(row["data_json"]) if row["data_json"] else {}
                    except Exception:
                        md = {}
                    md["updated_at"] = row["updated_at"] or row["fetch_time"] or row["date"]
                    md["date"] = row["date"] or ""
                    md["trade_date"] = row["trade_date"] or row["date"] or ""
                    md["source"] = row["source"] or ""
                    md["source_api"] = row["source_api"] or ""

                    cc = cc_index.get((cache_code, metric_type))

                    # 判断源健康状态（同 refresh.py 逻辑）
                    source_health = "healthy"
                    actual_src = (row["source"] or "")
                    if cc:
                        qs = cc.get("quality_status", "")
                        if qs == "primary_failed":
                            source_health = "degraded"
                        elif qs in ("both_failed",):
                            source_health = "degraded" if md else "failed"
                        elif qs == "backup_failed":
                            source_health = "healthy"
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
        logger.error(f"[DATA-QUALITY] recompute error: {e}")
        return {"success": False, "error": str(e)}

    total = len(quality_scores)
    excellent = sum(1 for s in quality_scores if s["quality_status"] == "excellent")
    usable = sum(1 for s in quality_scores if s["quality_status"] == "usable")
    suspicious = sum(1 for s in quality_scores if s["quality_status"] == "suspicious")
    unavailable = sum(1 for s in quality_scores if s["quality_status"] == "unavailable")
    avg_score = round(sum(s["quality_score"] for s in quality_scores) / total, 1) if total > 0 else 0

    return {
        "success": True,
        "total_metrics": total,
        "excellent": excellent,
        "usable": usable,
        "suspicious": suspicious,
        "unavailable": unavailable,
        "avg_score": avg_score,
        "items": quality_scores,
    }


@router.get("/fetch-logs/list")
async def get_fetch_logs(
    limit: int = Query(100, ge=1, le=500),
    source_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="success|error"),
):
    """数据拉取日志（V4.1 PRD §13.9: data_fetch_log 表）。

    用于设置页"错误日志查看器"和"最近拉取状态"展示。
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            sql = """SELECT request_id, source_id, metric_type, code,
                            start_date, end_date, status, row_count,
                            latency_ms, error_message, fetch_time
                     FROM data_fetch_log WHERE 1=1"""
            params: list = []
            if source_id:
                sql += " AND source_id = ?"
                params.append(source_id)
            if status:
                sql += " AND status = ?"
                params.append(status)
            sql += " ORDER BY fetch_time DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
            return {"logs": [dict(r) for r in rows], "count": len(rows)}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DATA-QUALITY] get_fetch_logs error: {e}")
        return {"logs": [], "count": 0, "error": str(e)}
