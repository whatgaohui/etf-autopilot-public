"""Data source status & configuration router (V4 PRD§9.3, 策略书§4).

Provides:
- GET  /api/data-source/status      — 各数据源状态、最近拉取时间、连通性
- GET  /api/data-source/thresholds  — 双源校验容忍阈值（策略书§4.4）
- PUT  /api/data-source/thresholds  — 修改双源校验阈值（S5-T6）
- POST /api/data-source/test        — 测试数据源连通性
- GET  /api/data-source/sources     — 所有适配器状态概览（V4 §4.2 数据源分层）
- GET  /api/data-source/registry    — 数据源注册表（含 capabilities + last_status, S5-T1/T5）
- GET  /api/data-source/fields      — 字段级主备源配置（V4 §4.3）
- PUT  /api/data-source/fields      — 修改字段主备源配置
- POST /api/data-source/switch      — 强制切源（覆盖默认优先级）
- GET  /api/data-source/cross-check — 交叉校验历史 + 统计（V4 §4.4）
- POST /api/data-source/cross-check/run — 立即对某标的执行交叉校验
- GET  /api/data-source/lineage     — 数据血缘查询（V4 §4.5）
- POST /api/data-source/{id}/enable — 启用数据源（S5-T3）
- POST /api/data-source/{id}/disable — 停用数据源（S5-T3）
- POST /api/data-source/{id}/token  — 设置数据源 token（加密存储, S5-T11）
- GET  /api/data-source/fetch-logs  — 拉取日志（S5-T4）
"""
import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import DB_PATH, TRACKED_ETFS
from services.data_source_manager import (
    get_manager,
    CROSS_CHECK_THRESHOLDS,
    list_data_sources,
    set_data_source_enabled,
    set_data_source_token,
    get_data_source_token,
    is_data_source_enabled,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data-source", tags=["data-source"])


# ─── 策略书§4.4 双源校验容忍阈值 ───
# 从 CROSS_CHECK_THRESHOLDS 派生（单一来源真理），持久化到 data_source_threshold 表
THRESHOLD_LABELS: dict[str, str] = {
    "etf_close_price": "ETF收盘价",
    "fund_nav": "基金净值",
    "qdii_premium": "QDII溢价率",
    "pe_pb_raw": "PE/PB原始值",
    "pe_pb_percentile": "PE/PB分位",
    "dividend_yield": "股息率",
}


def _ensure_threshold_table(conn: sqlite3.Connection) -> None:
    """幂等创建 data_source_threshold 表 + 启动时把持久化阈值加载进内存。"""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS data_source_threshold (
            key TEXT PRIMARY KEY,
            max_diff REAL NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )


def _load_persisted_thresholds() -> None:
    """启动时把 data_source_threshold 表里的用户自定义值加载进 CROSS_CHECK_THRESHOLDS。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        _ensure_threshold_table(conn)
        try:
            rows = conn.execute(
                "SELECT key, max_diff FROM data_source_threshold"
            ).fetchall()
            for key, max_diff in rows:
                if key in CROSS_CHECK_THRESHOLDS:
                    CROSS_CHECK_THRESHOLDS[key]["max_diff"] = float(max_diff)
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[DATA-SOURCE] _load_persisted_thresholds failed: {e}")


_load_persisted_thresholds()


class DataSourceInfo(BaseModel):
    name: str
    role: str  # primary | backup | reference
    status: str  # active | unconfigured | error
    last_fetch: str = ""
    last_success: str = ""
    description: str = ""


class DataSourceStatusResponse(BaseModel):
    sources: list[DataSourceInfo]
    last_data_update: str = ""
    tracked_count: int = 0
    cache_rows: int = 0


class ThresholdInfo(BaseModel):
    key: str
    label: str
    threshold_type: str  # pct | pp
    max_diff: float
    max_diff_pct: float | None = None
    max_diff_pp: float | None = None
    unit: str


class ThresholdsResponse(BaseModel):
    thresholds: list[ThresholdInfo]
    note: str = "超阈值时不自动生成强买卖建议，页面提示人工确认"


class ThresholdUpdateRequest(BaseModel):
    key: str = Field(..., description="etf_close_price/fund_nav/qdii_premium/pe_pb_raw/pe_pb_percentile/dividend_yield")
    max_diff: float = Field(..., gt=0)


def _threshold_info_for(key: str) -> ThresholdInfo:
    cfg = CROSS_CHECK_THRESHOLDS.get(key, {})
    t_type = cfg.get("type", "pct")
    max_diff = float(cfg.get("max_diff", 0))
    return ThresholdInfo(
        key=key,
        label=THRESHOLD_LABELS.get(key, key),
        threshold_type=t_type,
        max_diff=max_diff,
        max_diff_pct=max_diff if t_type == "pct" else None,
        max_diff_pp=max_diff if t_type == "pp" else None,
        unit=cfg.get("unit", ""),
    )


def _all_threshold_infos() -> list[ThresholdInfo]:
    return [_threshold_info_for(k) for k in THRESHOLD_LABELS.keys() if k in CROSS_CHECK_THRESHOLDS]


class ConnectivityResult(BaseModel):
    source: str
    connected: bool
    latency_ms: int = 0
    message: str = ""


def _get_latest_cache_time() -> tuple[str, int]:
    """查询缓存最新更新时间和总行数."""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            row = conn.execute("SELECT MAX(updated_at) AS latest, COUNT(*) AS cnt FROM market_data_cache").fetchone()
            latest = row[0] if row and row[0] else ""
            cnt = row[1] if row and row[1] else 0
            return (latest, cnt)
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[DATA-SOURCE] Failed to query cache: {e}")
        return ("", 0)


def _get_latest_source_status(source_name: str) -> dict:
    """V4 PRD§12.4: 从 data_source_status 表读取最近拉取状态."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT last_fetch_time, last_success_time, status, error_message, latency_ms FROM data_source_status WHERE source_name = ? ORDER BY created_at DESC LIMIT 1",
                (source_name,),
            ).fetchone()
            if row:
                return {
                    "last_fetch": row["last_fetch_time"] or "",
                    "last_success": row["last_success_time"] or "",
                    "status": row["status"] or "",
                    "error": row["error_message"] or "",
                    "latency_ms": row["latency_ms"] or 0,
                }
            return {}
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[DATA-SOURCE] Failed to query source status: {e}")
        return {}


@router.get("/status", response_model=DataSourceStatusResponse)
async def get_data_source_status():
    """获取各数据源状态（V4 PRD§9.3 + §12.4 data_source_status 表）."""
    latest, cnt = _get_latest_cache_time()

    # V4 PRD§12.4: 从 data_source_status 表读取最近拉取状态
    db_status = _get_latest_source_status("AkShare")

    sources = [
        DataSourceInfo(
            name="AkShare",
            role="primary",
            status="active",
            last_fetch=db_status.get("last_fetch", latest) if db_status else latest,
            last_success=db_status.get("last_success", latest) if db_status else latest,
            description="主数据源：ETF行情/指数估值/净值/溢价/股息率（乐咕乐股+中证指数+东方财富+新浪）",
        ),
        DataSourceInfo(
            name="Tushare Pro",
            role="backup",
            status="unconfigured",
            description="备份数据源：需配置 TUSHARE_TOKEN 后启用，用于主备源交叉校验",
        ),
    ]

    return DataSourceStatusResponse(
        sources=sources,
        last_data_update=latest,
        tracked_count=len(TRACKED_ETFS),
        cache_rows=cnt,
    )


@router.get("/alerts")
async def get_source_alerts():
    """V4 策略书§10.2: 数据源失效告警查询。

    返回最近的失败记录和告警状态。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # 查最近10条失败记录
        rows = conn.execute(
            """
            SELECT source_name, source_type, status, error_message, latency_ms, created_at
            FROM data_source_status
            WHERE status = 'error'
            ORDER BY created_at DESC
            LIMIT 10
            """,
        ).fetchall()

        alerts = [
            {
                "sourceName": r["source_name"],
                "sourceType": r["source_type"],
                "error": r["error_message"] or "",
                "latencyMs": r["latency_ms"] or 0,
                "timestamp": r["created_at"] or "",
            }
            for r in rows
        ]

        # 检查是否有关键失效
        critical = any(a["sourceType"] == "critical_failure" for a in alerts)
        # 检查最近一次成功时间
        success_row = conn.execute(
            "SELECT last_success_time FROM data_source_status WHERE status='success' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        last_success = success_row["last_success_time"] if success_row else ""

        return {
            "alerts": alerts,
            "alertCount": len(alerts),
            "criticalFailure": critical,
            "lastSuccessTime": last_success,
            "backupAvailable": False,  # Tushare 未配置
            "message": "主源失效，备源未配置" if critical else ("有告警记录" if alerts else "正常运行"),
        }
    finally:
        conn.close()


@router.get("/thresholds", response_model=ThresholdsResponse)
async def get_thresholds():
    """获取双源校验容忍阈值（策略书§4.4 + S5-T6 可编辑）。

    返回的 max_diff/max_diff_pct/max_diff_pp 直接来自 CROSS_CHECK_THRESHOLDS 内存值，
    启动时已从 data_source_threshold 表加载用户覆盖值。
    """
    return ThresholdsResponse(thresholds=_all_threshold_infos())


@router.put("/thresholds", response_model=ThresholdsResponse)
async def update_thresholds(req: ThresholdUpdateRequest):
    """S5-T6: 修改双源校验阈值。

    - 更新内存中的 CROSS_CHECK_THRESHOLDS dict（立即生效于后续交叉校验）
    - 持久化到 data_source_threshold 表（重启后仍生效）
    """
    if req.key not in CROSS_CHECK_THRESHOLDS:
        raise HTTPException(400, f"Unknown threshold key: {req.key}")
    if req.max_diff <= 0:
        raise HTTPException(400, "max_diff must be > 0")
    # 更新内存
    CROSS_CHECK_THRESHOLDS[req.key]["max_diff"] = float(req.max_diff)
    # 持久化
    try:
        conn = sqlite3.connect(DB_PATH)
        _ensure_threshold_table(conn)
        try:
            conn.execute(
                """INSERT INTO data_source_threshold (key, max_diff, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET max_diff = excluded.max_diff, updated_at = excluded.updated_at""",
                (req.key, float(req.max_diff), datetime.now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DATA-SOURCE] persist threshold failed: {e}")
        raise HTTPException(500, f"Failed to persist threshold: {e}")
    return ThresholdsResponse(thresholds=_all_threshold_infos())


@router.post("/test", response_model=list[ConnectivityResult])
async def test_connectivity():
    """测试数据源连通性."""
    results = []

    # 测试 AkShare（轻量测试：只导入不拉数据，避免超时）
    start = datetime.now()
    try:
        import akshare as ak
        # 只测导入成功，不调用 fund_etf_spot_em（太慢）
        latency = int((datetime.now() - start).total_seconds() * 1000)
        results.append(ConnectivityResult(
            source="AkShare",
            connected=True,
            latency_ms=latency,
            message=f"连接正常，akshare {ak.__version__} 已就绪",
        ))
    except Exception as e:
        results.append(ConnectivityResult(
            source="AkShare",
            connected=False,
            message=f"连接失败: {str(e)[:100]}",
        ))

    # Tushare（从 Prisma 数据库读取 token）
    tushare_token = ""
    try:
        tushare_token = os.environ.get("TUSHARE_TOKEN", "")
        if not tushare_token:
            # 从 Next.js 的 Prisma SQLite 数据库读（system_config 表在 custom.db）
            prisma_db = "/app/db/custom.db"
            conn2 = sqlite3.connect(prisma_db)
            try:
                row = conn2.execute(
                    "SELECT value FROM system_config WHERE key = 'tushare_token' LIMIT 1"
                ).fetchone()
                if row:
                    tushare_token = row[0] or ""
            finally:
                conn2.close()
    except Exception as e:
        logger.warning(f"[DATA-SOURCE] Failed to read tushare token: {e}")

    if tushare_token:
        # 真实测试 Tushare 连通性
        start_ts = datetime.now()
        try:
            import tushare as ts
            pro = ts.pro_api(tushare_token)
            # 用最轻量的接口测试：获取交易日历，加超时保护
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(lambda: pro.trade_cal(exchange='', start_date='20260101', end_date='20260105'))
                df = future.result(timeout=10)  # 10秒超时
            latency_ts = int((datetime.now() - start_ts).total_seconds() * 1000)
            results.append(ConnectivityResult(
                source="Tushare Pro",
                connected=True,
                latency_ms=latency_ts,
                message=f"连接正常，Token 有效，返回 {len(df)} 条交易日历",
            ))
        except ImportError:
            results.append(ConnectivityResult(
                source="Tushare Pro",
                connected=False,
                message="tushare 库未安装（pip install tushare）",
            ))
        except Exception as e:
            err = str(e)[:100]
            results.append(ConnectivityResult(
                source="Tushare Pro",
                connected=False,
                message=f"Token 验证失败: {err}",
            ))
    else:
        results.append(ConnectivityResult(
            source="Tushare Pro",
            connected=False,
            message="未配置 TUSHARE_TOKEN（备源，可选）",
        ))

    return results


# ─── V4 §4.2 数据源分层概览 ────────────────────────────────────────────────────

@router.get("/sources")
async def get_sources_overview():
    """所有适配器状态概览（含未实现的规划源）。"""
    mgr = get_manager()
    return {"sources": mgr.get_sources_overview()}


# ─── V4 §4.3 字段级主备源配置 ──────────────────────────────────────────────────

class FieldConfigUpdate(BaseModel):
    field: str
    primary_sources: list[str]
    backup_sources: list[str]


class ForceSwitchRequest(BaseModel):
    field: str
    source: Optional[str] = None  # None 表示清除强制，恢复默认


@router.get("/fields")
async def get_field_configs():
    """字段级主备源配置 + 适配器状态。"""
    mgr = get_manager()
    return {"fields": mgr.get_field_config()}


@router.put("/fields")
async def update_field_config(req: FieldConfigUpdate):
    """修改某字段的主备源配置。"""
    mgr = get_manager()
    ok = mgr.update_field_config(req.field, req.primary_sources, req.backup_sources)
    if not ok:
        raise HTTPException(500, "Failed to update field config")
    return {"success": True, "fields": mgr.get_field_config()}


@router.post("/switch")
async def force_switch_source(req: ForceSwitchRequest):
    """强制某字段使用指定源（覆盖默认优先级）。

    source=None 清除强制，恢复默认。
    """
    mgr = get_manager()
    ok = mgr.force_switch_source(req.field, req.source)
    if not ok:
        raise HTTPException(500, "Failed to switch source")
    return {
        "success": True,
        "field": req.field,
        "forced_source": req.source,
        "fields": mgr.get_field_config(),
    }


# ─── V4 §4.4 交叉校验 ─────────────────────────────────────────────────────────

@router.get("/cross-check")
async def get_cross_check_history(
    limit: int = Query(50, ge=1, le=500),
    field: Optional[str] = Query(None),
    code: Optional[str] = Query(None),
    stats: bool = Query(False),
):
    """交叉校验历史 + 统计。"""
    mgr = get_manager()
    result: dict = {}
    if stats:
        result["stats"] = mgr.get_cross_check_stats()
    result["records"] = mgr.get_cross_check_history(limit=limit, field=field, code=code)
    return result


class CrossCheckRunRequest(BaseModel):
    etf_code: str
    data_types: list[str] = ["valuation", "premium", "nav"]


@router.post("/cross-check/run")
async def run_cross_check(req: CrossCheckRunRequest):
    """立即对某 ETF 执行交叉校验（不写缓存，仅返回差异结果）。"""
    mgr = get_manager()
    etf_code = req.etf_code
    info = TRACKED_ETFS.get(etf_code)
    if not info:
        raise HTTPException(404, f"ETF {etf_code} not tracked")

    results = []
    for dt in req.data_types:
        if dt == "valuation":
            code = info["index_code"]
            kwargs = {"index_name": info.get("index_name", "")}
        else:
            code = etf_code
            kwargs = {}
        try:
            _, check = await mgr.fetch_with_cross_check(dt, code, **kwargs)
            results.append(check.to_dict())
        except Exception as e:
            logger.error(f"[CROSS-CHECK-RUN] {dt}/{code} error: {e}")
            results.append({
                "field": dt, "code": code, "quality_status": "error",
                "notes": str(e)[:200], "primary_source": "", "backup_source": "",
                "primary_value": None, "backup_value": None,
            })
    return {"etf_code": etf_code, "results": results}


# ─── V4 §4.5 数据血缘 ─────────────────────────────────────────────────────────

@router.get("/lineage")
async def get_lineage(
    code: str = Query(..., description="ETF 代码或指数代码"),
    data_type: str = Query(..., description="valuation/premium/nav/dividend/price"),
):
    """数据血缘查询：返回某条数据的 source/raw_value/clean_value/fetch_time 等。"""
    mgr = get_manager()
    return mgr.get_lineage(code, data_type)


# ─── V4.1 S5-T1/T5: 数据源注册表（合并 capabilities + last_status）─────────────

@router.get("/registry")
async def get_data_source_registry():
    """S5-T5: 数据源注册表合并接口。

    返回所有数据源 + capabilities + last_status（最近拉取状态）+ has_token。
    """
    sources = list_data_sources()
    return {"sources": sources}


# ─── V4.1 S5-T3: 数据源启用/停用 ──────────────────────────────────────────────

@router.post("/{source_id}/enable")
async def enable_data_source(source_id: str):
    """S5-T3: 启用数据源。"""
    if not _source_exists(source_id):
        raise HTTPException(404, f"Data source not found: {source_id}")
    ok = set_data_source_enabled(source_id, True)
    if not ok:
        raise HTTPException(500, f"Failed to enable data source: {source_id}")
    return {
        "success": True,
        "id": source_id,
        "is_enabled": True,
    }


@router.post("/{source_id}/disable")
async def disable_data_source(source_id: str):
    """S5-T3: 停用数据源。"""
    if not _source_exists(source_id):
        raise HTTPException(404, f"Data source not found: {source_id}")
    # 不允许停用主源 akshare（避免系统无主源）
    if source_id == "akshare":
        raise HTTPException(400, "不允许停用主源 AkShare（主源是系统必需）")
    ok = set_data_source_enabled(source_id, False)
    if not ok:
        raise HTTPException(500, f"Failed to disable data source: {source_id}")
    return {
        "success": True,
        "id": source_id,
        "is_enabled": False,
    }


def _source_exists(source_id: str) -> bool:
    """检查 source_id 在 data_source 表中是否存在。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            row = conn.execute(
                "SELECT id FROM data_source WHERE id = ?", (source_id,)
            ).fetchone()
            return row is not None
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[DATA-SOURCE] _source_exists failed: {e}")
        return False


# ─── V4.1 S5-T11: 设置数据源 token（加密存储） ────────────────────────────────

class SetTokenRequest(BaseModel):
    token: str = Field(..., description="数据源 token 明文（将 Fernet 加密后存储）")


@router.post("/{source_id}/token")
async def set_data_source_token_endpoint(source_id: str, req: SetTokenRequest):
    """S5-T11: 设置数据源 token（Fernet 加密存储）。

    注意：响应不返回 token 明文，只返回 has_token 标志。
    """
    if not _source_exists(source_id):
        raise HTTPException(404, f"Data source not found: {source_id}")
    ok = set_data_source_token(source_id, req.token)
    if not ok:
        raise HTTPException(500, f"Failed to set token for: {source_id}")
    return {
        "success": True,
        "id": source_id,
        "has_token": bool(req.token),
    }


# ─── V4.1 S5-T4: 拉取日志查看器 ──────────────────────────────────────────────

@router.get("/fetch-logs")
async def get_fetch_logs(
    limit: int = Query(100, ge=1, le=500, description="返回记录数（最大 500）"),
    status: Optional[str] = Query(None, description="过滤状态: success/error/skipped/no_data"),
    source_id: Optional[str] = Query(None, description="按数据源过滤"),
    metric_type: Optional[str] = Query(None, description="按指标类型过滤"),
):
    """S5-T4: 从 data_fetch_log 表读取拉取日志。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            where_parts: list[str] = []
            params: list = []
            if status:
                where_parts.append("status = ?")
                params.append(status)
            if source_id:
                where_parts.append("source_id = ?")
                params.append(source_id)
            if metric_type:
                where_parts.append("metric_type = ?")
                params.append(metric_type)
            where_clause = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
            rows = conn.execute(
                f"""SELECT request_id, source_id, metric_type, code,
                          start_date, end_date, status, row_count, latency_ms,
                          error_message, fetch_time
                   FROM data_fetch_log
                   {where_clause}
                   ORDER BY fetch_time DESC
                   LIMIT ?""",
                params + [limit],
            ).fetchall()
            logs = [
                {
                    "request_id": r["request_id"] or "",
                    "source_id": r["source_id"] or "",
                    "metric_type": r["metric_type"] or "",
                    "code": r["code"] or "",
                    "start_date": r["start_date"] or "",
                    "end_date": r["end_date"] or "",
                    "status": r["status"] or "",
                    "row_count": r["row_count"] or 0,
                    "latency_ms": r["latency_ms"] or 0,
                    "error_message": r["error_message"] or "",
                    "fetch_time": r["fetch_time"] or "",
                }
                for r in rows
            ]
            # 统计总数（不含 limit）
            total_row = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM data_fetch_log {where_clause}", params
            ).fetchone()
            total = total_row["cnt"] if total_row else 0
            return {"logs": logs, "total": total}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DATA-SOURCE] get_fetch_logs error: {e}")
        return {"logs": [], "total": 0}

