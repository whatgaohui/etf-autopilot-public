"""V5.0 Execution Confirm Router — 执行确认闭环 API.

返回格式与前端 `src/lib/api.ts` 的 ExecutionHistoryItem 对齐:
  - POST /api/execution/confirm  → {success: boolean, ...}
  - GET  /api/execution/history  → {history: ExecutionHistoryItem[]}

V5.0 Sprint3 E8: 建议确认状态机(前半)
  - POST /api/execution/orders/create  — 从计算结果创建执行订单
  - POST /api/execution/orders/confirm — 确认/拒绝执行订单(状态机: pending→confirmed/rejected)
  - GET  /api/execution/orders         — 获取执行订单列表
  - GET  /api/execution/orders/status  — 获取订单状态摘要
"""
import json
import logging
import sqlite3
import uuid
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


# V5.0 Sprint3 E8: 建议确认状态机 — 创建/确认订单的请求模型
class OrderCreateItem(BaseModel):
    etf_code: str = Field(..., alias="etfCode")
    side: str = Field("buy", alias="side", description="buy | sell")
    planned_amount: float = Field(..., alias="plannedAmount")
    planned_shares: Optional[float] = Field(None, alias="plannedShares")
    execution_mode: str = Field("immediate", alias="executionMode",
        description="immediate | staged | wait_pullback | base_only")


class OrderCreateRequest(BaseModel):
    calculation_id: str = Field(..., alias="calculationId")
    items: list[OrderCreateItem]


class OrderConfirmItem(BaseModel):
    etf_code: str = Field(..., alias="etfCode")
    action: str = Field(..., alias="action", description="confirm | reject")
    reason: str = Field("", alias="reason", description="拒绝原因(reject时填写)")


class OrderConfirmRequest(BaseModel):
    calculation_id: str = Field(..., alias="calculationId")
    items: list[OrderConfirmItem]


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


def _ensure_execution_order_table(conn: sqlite3.Connection) -> None:
    """V5.0 Sprint3 E8: 幂等创建 execution_order 表.

    状态机: pending → confirmed/rejected → partially_executed/executed/cancelled/expired
    不允许跳过确认直接 executed (PRD §7.8 验收: 未确认建议不能进入成交状态).
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_order (
            id TEXT PRIMARY KEY,
            calculation_id TEXT NOT NULL,
            etf_code TEXT NOT NULL,
            side TEXT NOT NULL DEFAULT 'buy',
            planned_amount REAL NOT NULL,
            planned_shares REAL,
            execution_mode TEXT DEFAULT 'immediate',
            status TEXT NOT NULL DEFAULT 'pending',
            confirmed_at TEXT,
            rejected_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(calculation_id, etf_code)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_order_calc_id "
        "ON execution_order(calculation_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_order_status "
        "ON execution_order(status, created_at DESC)"
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


# ─── V5.0 Sprint3 E8: 建议确认状态机(前半) ────────────────────────────────────

@router.post("/orders/create")
async def create_orders(request: OrderCreateRequest):
    """POST /api/execution/orders/create
    从计算结果创建执行订单(状态默认 pending, 需要后续确认才能进入 executed).

    body: {calculationId, items: [{etfCode, side, plannedAmount, executionMode}]}

    幂等语义: 同一 (calculation_id, etf_code) 已存在则更新 planned_amount/execution_mode,
    status 重置为 pending(若已 confirmed/rejected 则保留原状态不覆盖).
    """
    if not request.items:
        return {"success": False, "error": "items 不能为空"}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        now = datetime.now().isoformat()
        created_count = 0
        updated_count = 0
        for item in request.items:
            # 检查是否已存在
            existing = conn.execute(
                "SELECT id, status FROM execution_order WHERE calculation_id=? AND etf_code=?",
                (request.calculation_id, item.etf_code),
            ).fetchone()
            if existing is None:
                order_id = f"eo-{uuid.uuid4().hex[:16]}"
                conn.execute(
                    """
                    INSERT INTO execution_order
                        (id, calculation_id, etf_code, side, planned_amount,
                         planned_shares, execution_mode, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (order_id, request.calculation_id, item.etf_code,
                     item.side, item.planned_amount, item.planned_shares,
                     item.execution_mode, now, now),
                )
                created_count += 1
            else:
                # UPSERT: 仅在仍为 pending 时更新计划字段; 已 confirmed/rejected 则保留
                if existing["status"] == "pending":
                    conn.execute(
                        """
                        UPDATE execution_order SET
                            side = ?, planned_amount = ?, planned_shares = ?,
                            execution_mode = ?, updated_at = ?
                        WHERE calculation_id=? AND etf_code=?
                        """,
                        (item.side, item.planned_amount, item.planned_shares,
                         item.execution_mode, now,
                         request.calculation_id, item.etf_code),
                    )
                    updated_count += 1
        conn.commit()
        return {
            "success": True,
            "data": {
                "calculationId": request.calculation_id,
                "totalItems": len(request.items),
                "created": created_count,
                "updated": updated_count,
                "createdAt": now,
            },
        }
    except Exception as e:
        logger.exception("[EXECUTION] orders/create failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.post("/orders/confirm")
async def confirm_orders(request: OrderConfirmRequest):
    """POST /api/execution/orders/confirm
    确认执行订单(整体或逐项).

    body: {calculationId, items: [{etfCode, action: 'confirm'|'reject', reason: ''}]}

    状态机: pending → confirmed | rejected
      - 已 confirmed 的订单不能再 reject (反之亦然), 返回 skipped
      - 不允许跳过确认直接 executed (PRD §7.8 验收: 未确认建议不能进入成交状态)
    """
    if not request.items:
        return {"success": False, "error": "items 不能为空"}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        now = datetime.now().isoformat()
        results = []
        confirmed_count = 0
        rejected_count = 0
        skipped_count = 0
        for item in request.items:
            row = conn.execute(
                "SELECT id, status FROM execution_order WHERE calculation_id=? AND etf_code=?",
                (request.calculation_id, item.etf_code),
            ).fetchone()
            if row is None:
                results.append({
                    "etfCode": item.etf_code, "action": item.action,
                    "result": "not_found",
                    "message": "订单不存在, 跳过",
                })
                skipped_count += 1
                continue

            current_status = row["status"]
            # 状态机约束: 只有 pending 才能转到 confirmed/rejected
            if current_status != "pending":
                results.append({
                    "etfCode": item.etf_code, "action": item.action,
                    "result": "skipped",
                    "message": f"当前状态 {current_status} 不允许 {item.action}",
                })
                skipped_count += 1
                continue

            new_status = "confirmed" if item.action == "confirm" else "rejected"
            conn.execute(
                """
                UPDATE execution_order SET
                    status = ?, confirmed_at = ?, rejected_reason = ?, updated_at = ?
                WHERE calculation_id=? AND etf_code=?
                """,
                (new_status,
                 now if item.action == "confirm" else None,
                 item.reason if item.action == "reject" else None,
                 now,
                 request.calculation_id, item.etf_code),
            )
            if item.action == "confirm":
                confirmed_count += 1
            else:
                rejected_count += 1
            results.append({
                "etfCode": item.etf_code, "action": item.action,
                "result": "ok", "newStatus": new_status,
            })

        conn.commit()
        return {
            "success": True,
            "data": {
                "calculationId": request.calculation_id,
                "totalItems": len(request.items),
                "confirmed": confirmed_count,
                "rejected": rejected_count,
                "skipped": skipped_count,
                "confirmedAt": now,
                "results": results,
            },
        }
    except Exception as e:
        logger.exception("[EXECUTION] orders/confirm failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.get("/orders")
async def get_orders(calculation_id: str = Query("", alias="calculationId", description="计算批次ID")):
    """GET /api/execution/orders?calculationId=xxx — 获取执行订单列表.

    若不传 calculationId, 则返回最近 50 条订单(跨批次).
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        if calculation_id:
            rows = conn.execute(
                """
                SELECT id, calculation_id, etf_code, side, planned_amount,
                       planned_shares, execution_mode, status, confirmed_at,
                       rejected_reason, created_at, updated_at
                FROM execution_order
                WHERE calculation_id = ?
                ORDER BY etf_code
                """,
                (calculation_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, calculation_id, etf_code, side, planned_amount,
                       planned_shares, execution_mode, status, confirmed_at,
                       rejected_reason, created_at, updated_at
                FROM execution_order
                ORDER BY created_at DESC
                LIMIT 50
                """
            ).fetchall()

        items = []
        for r in rows:
            items.append({
                "id": r["id"],
                "calculationId": r["calculation_id"],
                "etfCode": r["etf_code"],
                "side": r["side"],
                "plannedAmount": round(r["planned_amount"], 2) if r["planned_amount"] is not None else 0,
                "plannedShares": r["planned_shares"],
                "executionMode": r["execution_mode"],
                "status": r["status"],
                "confirmedAt": r["confirmed_at"],
                "rejectedReason": r["rejected_reason"],
                "createdAt": r["created_at"],
                "updatedAt": r["updated_at"],
            })
        return {"items": items, "total": len(items)}
    except Exception as e:
        logger.exception("[EXECUTION] orders GET failed")
        return {"items": [], "total": 0, "error": str(e)}
    finally:
        conn.close()


@router.get("/orders/status")
async def get_order_status(calculation_id: str = Query("", alias="calculationId", description="计算批次ID")):
    """GET /api/execution/orders/status?calculationId=xxx — 获取订单状态摘要.

    返回: {total, pending, confirmed, rejected, executed, partiallyExecuted,
           cancelled, expired, totalPlanned, totalConfirmed}
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        if not calculation_id:
            # 不传 calculationId 时返回全局摘要(最近 7 天)
            rows = conn.execute(
                """
                SELECT status, COUNT(*) AS cnt, COALESCE(SUM(planned_amount), 0) AS total_planned
                FROM execution_order
                WHERE created_at >= datetime('now', '-7 days')
                GROUP BY status
                """
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT status, COUNT(*) AS cnt, COALESCE(SUM(planned_amount), 0) AS total_planned
                FROM execution_order
                WHERE calculation_id = ?
                GROUP BY status
                """,
                (calculation_id,),
            ).fetchall()

        status_count = {
            "pending": 0, "confirmed": 0, "rejected": 0,
            "executed": 0, "partially_executed": 0,
            "cancelled": 0, "expired": 0,
        }
        total = 0
        total_planned = 0.0
        total_confirmed = 0.0
        for r in rows:
            s = r["status"] or "pending"
            cnt = r["cnt"] or 0
            amt = r["total_planned"] or 0
            status_count[s] = status_count.get(s, 0) + cnt
            total += cnt
            total_planned += amt
            if s in ("confirmed", "executed", "partially_executed"):
                total_confirmed += amt

        return {
            "calculationId": calculation_id,
            "total": total,
            "pending": status_count.get("pending", 0),
            "confirmed": status_count.get("confirmed", 0),
            "rejected": status_count.get("rejected", 0),
            "executed": status_count.get("executed", 0),
            "partiallyExecuted": status_count.get("partially_executed", 0),
            "cancelled": status_count.get("cancelled", 0),
            "expired": status_count.get("expired", 0),
            "totalPlanned": round(total_planned, 2),
            "totalConfirmed": round(total_confirmed, 2),
        }
    except Exception as e:
        logger.exception("[EXECUTION] orders/status failed")
        return {
            "calculationId": calculation_id,
            "total": 0, "pending": 0, "confirmed": 0, "rejected": 0,
            "executed": 0, "partiallyExecuted": 0, "cancelled": 0, "expired": 0,
            "totalPlanned": 0, "totalConfirmed": 0,
            "error": str(e),
        }
    finally:
        conn.close()

