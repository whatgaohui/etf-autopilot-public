"""V4.2 PRD§16 后台管理 API.

提供数据维护与诊断能力：
- GET  /api/admin/db-stats        获取两个数据库所有表的行数和大小
- GET  /api/admin/table-data      查看指定表前N行数据
- POST /api/admin/clear-table     清空指定市场缓存表(需 confirm=True)
- POST /api/admin/reset-cache     批量清空所有市场数据缓存
- GET  /api/admin/export-business 导出业务数据库为 JSON(供下载备份)
- GET  /api/admin/service-status  服务状态汇总(进程/内存/DB大小)
"""
import logging
import os
import sqlite3
from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel

from config import DB_PATH as MARKET_DB_PATH, SERVICE_HOST, SERVICE_PORT

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"])

# 业务DB路径(Prisma custom.db)
BUSINESS_DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "db",
    "custom.db",
)


def _get_db_path(db_name: str) -> str:
    """db_name: 'business' 或 'market'."""
    return BUSINESS_DB_PATH if db_name == "business" else MARKET_DB_PATH


# 安全清单: 仅允许清空这些市场缓存/日志表(业务核心表严禁清空)
SAFE_CLEAR_TABLES = {
    "market_data_cache",
    "market_data_raw",
    "market_data_clean",
    "data_quality_result",
    "source_compare_result",
    "cross_check_log",
    "data_fetch_log",
    "macro_metric_cache",
    "macro_prompt_log",
}


@router.get("/db-stats")
async def get_db_stats():
    """获取两个数据库所有表的行数和大小."""
    result = {
        "business": {"tables": [], "file_size": 0},
        "market": {"tables": [], "file_size": 0},
    }
    for db_name, db_path in [("business", BUSINESS_DB_PATH), ("market", MARKET_DB_PATH)]:
        if not os.path.exists(db_path):
            continue
        result[db_name]["file_size"] = os.path.getsize(db_path)
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
            for t in tables:
                tname = t["name"]
                try:
                    count = conn.execute(f"SELECT count(*) FROM {tname}").fetchone()[0]
                except Exception as ce:
                    logger.warning(f"[ADMIN] count {db_name}.{tname} failed: {ce}")
                    count = -1
                # 尝试获取最近更新时间(若有 updated_at/created_at/fetch_time 列)
                last_update = ""
                for col in ["updated_at", "created_at", "fetch_time"]:
                    try:
                        row = conn.execute(
                            f"SELECT {col} FROM {tname} ORDER BY {col} DESC LIMIT 1"
                        ).fetchone()
                        if row and row[0]:
                            last_update = str(row[0])
                            break
                    except Exception:
                        pass
                result[db_name]["tables"].append(
                    {"name": tname, "rows": count, "last_update": last_update}
                )
            conn.close()
        except Exception as e:
            logger.error(f"[ADMIN] db-stats {db_name} error: {e}")
    return result


@router.get("/table-data")
async def get_table_data(
    db: str = Query(..., description="business | market"),
    table: str = Query(...),
    limit: int = Query(100, ge=1, le=1000),
):
    """查看表数据(前N行)."""
    db_path = _get_db_path(db)
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        # 获取列名
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        rows = conn.execute(f"SELECT * FROM {table} LIMIT ?").fetchall()
        data = [dict(r) for r in rows]
        conn.close()
        return {"table": table, "columns": cols, "rows": data, "count": len(data)}
    except Exception as e:
        logger.error(f"[ADMIN] table-data {db}.{table} error: {e}")
        return {"error": str(e), "table": table, "columns": [], "rows": [], "count": 0}


class ClearTableRequest(BaseModel):
    db: str
    table: str
    confirm: bool


@router.post("/clear-table")
async def clear_table(req: ClearTableRequest):
    """清空指定表(需 confirm=True).

    安全限制: 仅允许清空市场缓存/日志表, 业务核心表拒绝.
    """
    if not req.confirm:
        return {"success": False, "error": "需确认 confirm=true"}
    if req.table not in SAFE_CLEAR_TABLES:
        return {
            "success": False,
            "error": f"表 {req.table} 不在安全清空列表, 拒绝操作",
        }
    db_path = _get_db_path(req.db)
    try:
        conn = sqlite3.connect(db_path)
        before = conn.execute(f"SELECT count(*) FROM {req.table}").fetchone()[0]
        conn.execute(f"DELETE FROM {req.table}")
        conn.commit()
        conn.close()
        logger.info(f"[ADMIN] clear-table {req.db}.{req.table} deleted {before} rows")
        return {"success": True, "table": req.table, "deleted_rows": before}
    except Exception as e:
        logger.error(f"[ADMIN] clear-table {req.db}.{req.table} error: {e}")
        return {"success": False, "error": str(e)}


@router.post("/reset-cache")
async def reset_cache():
    """清空所有市场数据缓存(保留业务数据和配置)."""
    results = []
    conn = sqlite3.connect(MARKET_DB_PATH)
    for t in sorted(SAFE_CLEAR_TABLES):
        try:
            before = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            conn.execute(f"DELETE FROM {t}")
            results.append({"table": t, "deleted": before})
        except Exception as e:
            results.append({"table": t, "error": str(e)})
    conn.commit()
    conn.close()
    logger.info(f"[ADMIN] reset-cache cleared {len(results)} tables")
    return {"success": True, "cleared": results}


@router.get("/export-business")
async def export_business_data():
    """导出业务数据为 JSON(供前端下载备份)."""
    export = {}
    conn = sqlite3.connect(BUSINESS_DB_PATH)
    conn.row_factory = sqlite3.Row
    for table in ["etf_config", "holding_snapshot", "rule_config", "system_config"]:
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            export[table] = [dict(r) for r in rows]
        except Exception as e:
            export[table] = {"error": str(e)}
    conn.close()
    return {"data": export, "exported_at": datetime.now().isoformat()}


@router.get("/service-status")
async def service_status():
    """服务状态汇总."""
    status = {
        "data_service": {"running": True, "host": SERVICE_HOST, "port": SERVICE_PORT},
        "databases": {},
        "timestamp": datetime.now().isoformat(),
    }
    for db_name, db_path in [
        ("business", BUSINESS_DB_PATH),
        ("market", MARKET_DB_PATH),
    ]:
        if os.path.exists(db_path):
            status["databases"][db_name] = {
                "path": db_path,
                "size_mb": round(os.path.getsize(db_path) / 1024 / 1024, 2),
                "exists": True,
            }
        else:
            status["databases"][db_name] = {"exists": False}
    # 进程信息
    try:
        import psutil

        pid = os.getpid()
        status["data_service"]["pid"] = pid
        status["data_service"]["memory_mb"] = round(
            psutil.Process(pid).memory_info().rss / 1024 / 1024, 2
        )
        # 系统级指标(可选, 不阻塞)
        try:
            vm = psutil.virtual_memory()
            status["system"] = {
                "memory_total_mb": round(vm.total / 1024 / 1024, 2),
                "memory_used_pct": vm.percent,
                "cpu_pct": psutil.cpu_percent(interval=None),
            }
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"[ADMIN] psutil unavailable: {e}")
    return status
