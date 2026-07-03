"""V5.0 Execution Confirm Router — 执行确认闭环 API.

返回格式与前端 `src/lib/api.ts` 的 ExecutionHistoryItem 对齐:
  - POST /api/execution/confirm  → {success: boolean, ...}
  - GET  /api/execution/history  → {history: ExecutionHistoryItem[]}
"""
import json
import logging
import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from config import DB_PATH

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/execution", tags=["execution"])


# ─── 请求/响应模型 ────────────────────────────────────────────────────────────

class ConfirmItem(BaseModel):
    etf_code: str = Field(..., alias="etfCode")
    planned_amount: float = Field(..., alias="plannedAmount")
    actual_amount: float = Field(0, alias="actualAmount")
    status: str = Field("pending", alias="status",
                        description="pending | executed | skipped | partial")


class ConfirmRequest(BaseModel):
    calculation_id: str = Field(..., alias="calculationId")
    items: list[ConfirmItem]


# ─── DB helper ────────────────────────────────────────────────────────────────

def _ensure_execution_confirm_table(conn: sqlite3.Connection) -> None:
    """幂等创建 execution_confirm 表 (主键唯一约束: calculation_id + etf_code)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_confirm (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            calculation_id TEXT NOT NULL,
            etf_code TEXT NOT NULL,
            planned_amount REAL NOT NULL,
            actual_amount REAL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            confirmed_at TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(calculation_id, etf_code)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_exec_confirm_calc_id "
        "ON execution_confirm(calculation_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_exec_confirm_created "
        "ON execution_confirm(created_at DESC)"
    )


# ─── 端点 ────────────────────────────────────────────────────────────────────

@router.post("/confirm")
async def confirm_execution(request: ConfirmRequest):
    """POST /api/execution/confirm
    批量插入/更新 execution_confirm 表 (UPSERT 语义).

    返回前端期望的 {success: boolean} 结构 (额外字段 data 供调试).
    """
    if not request.items:
        return {"success": False, "error": "items 不能为空"}

    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_execution_confirm_table(conn)
        now = datetime.now().isoformat()
        for item in request.items:
            conn.execute(
                """
                INSERT INTO execution_confirm
                    (calculation_id, etf_code, planned_amount, actual_amount, status, confirmed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(calculation_id, etf_code) DO UPDATE SET
                    planned_amount = excluded.planned_amount,
                    actual_amount = excluded.actual_amount,
                    status = excluded.status,
                    confirmed_at = excluded.confirmed_at
                """,
                (
                    request.calculation_id,
                    item.etf_code,
                    item.planned_amount,
                    item.actual_amount,
                    item.status,
                    now,
                    now,
                ),
            )
        conn.commit()

        total = conn.execute(
            "SELECT COUNT(*) c FROM execution_confirm WHERE calculation_id = ?",
            (request.calculation_id,),
        ).fetchone()[0]
        return {
            "success": True,
            # 额外字段 (前端只读 success)
            "data": {
                "calculationId": request.calculation_id,
                "totalItems": len(request.items),
                "totalConfirmed": total,
                "confirmedAt": now,
            },
        }
    except Exception as e:
        logger.exception("[EXECUTION] confirm failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.get("/history")
async def get_execution_history(limit: int = Query(20, ge=1, le=200)):
    """GET /api/execution/history — 执行历史 (含计划 vs 实际偏差).

    返回前端期望的 {history: ExecutionHistoryItem[]} 结构:
      [{
        calculationId, date, planned, actual, deviation,
        items: [{etfCode, plannedAmount, actualAmount, status}]
      }]

    数据源:
      - calculation_log (主表, 提供计算批次元数据)
      - execution_confirm (子表, LEFT JOIN, 提供计划/实际/状态)
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_confirm_table(conn)

        # 拉取最近的 calculation_log 记录 (按 created_at desc)
        calc_rows = conn.execute(
            """
            SELECT calculation_id, created_at, total_budget, total_allocated,
                   total_unallocated
            FROM calculation_log
            WHERE calculation_id IS NOT NULL AND calculation_id != ''
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        history = []
        for cr in calc_rows:
            calc_id = cr["calculation_id"]
            ec_rows = conn.execute(
                """
                SELECT etf_code, planned_amount, actual_amount, status, confirmed_at, created_at
                FROM execution_confirm
                WHERE calculation_id = ?
                ORDER BY etf_code
                """,
                (calc_id,),
            ).fetchall()

            items = []
            total_planned = 0.0
            total_actual = 0.0
            for er in ec_rows:
                planned = er["planned_amount"] or 0
                actual = er["actual_amount"] or 0
                total_planned += planned
                total_actual += actual
                items.append({
                    "etfCode": er["etf_code"],
                    "plannedAmount": round(planned, 2),
                    "actualAmount": round(actual, 2),
                    "status": er["status"],
                })

            deviation = round(total_actual - total_planned, 2)

            history.append({
                "calculationId": calc_id,
                "date": cr["created_at"] or "",
                "planned": round(total_planned, 2),
                "actual": round(total_actual, 2),
                "deviation": deviation,
                "items": items,
                # 额外字段 (前端忽略, 供调试)
                "totalBudget": cr["total_budget"],
                "totalAllocated": cr["total_allocated"],
                "totalUnallocated": cr["total_unallocated"],
            })

        return {"history": history}
    except Exception as e:
        logger.exception("[EXECUTION] history failed")
        return {"history": []}
    finally:
        conn.close()
