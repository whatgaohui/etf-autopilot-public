"""V5.0 Execution Confirm Router — 执行确认闭环 API.

返回格式与前端 `src/lib/api.ts` 的 ExecutionHistoryItem 对齐:
  - POST /api/execution/confirm  → {success: boolean, ...}
  - GET  /api/execution/history  → {history: ExecutionHistoryItem[]}

V5.0 Sprint3 E8: 建议确认状态机(前半)
  - POST /api/execution/orders/create  — 从计算结果创建执行订单
  - POST /api/execution/orders/confirm — 确认/拒绝执行订单(状态机: pending→confirmed/rejected)
  - GET  /api/execution/orders         — 获取执行订单列表
  - GET  /api/execution/orders/status  — 获取订单状态摘要

V5.0 Sprint4 E8: 成交回填(后半)
  - POST /api/execution/orders/fill    — 成交回填(幂等: idempotency_key, 部分/全部成交, 手续费进守恒)
  - POST /api/execution/orders/cancel  — 撤销订单(已成交部分保留, 未成交部分取消, 资金按原身份回退)
  - POST /api/execution/orders/expire  — 过期清理(超过 7 天未确认/未执行标记 expired)
  - GET  /api/execution/fills          — 成交记录查询
  - GET  /api/execution/reconciliation — 计划 vs 实际对账
"""
import json
import logging
import sqlite3
import uuid
from datetime import datetime, timedelta
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


# V5.0 Sprint4 E8: 成交回填请求模型
class FillRequest(BaseModel):
    """成交回填请求 — 支持 BUY / SELL 双向, 部分成交累加, 幂等保护."""
    order_id: str = Field(..., alias="orderId",
        description="执行订单ID(eo-xxx). 订单必须处于 confirmed 或 partially_executed 状态.")
    etf_code: str = Field(..., alias="etfCode")
    fill_price: float = Field(..., alias="fillPrice", description="成交价(元/份)")
    fill_shares: float = Field(..., alias="fillShares", description="成交份额(份)")
    fill_amount: float = Field(..., alias="fillAmount", description="成交金额(元) = fill_price × fill_shares")
    fee: float = Field(0, alias="fee", description="手续费(元, 进入资金守恒, 从对应子账户扣除)")
    idempotency_key: str = Field("", alias="idempotencyKey",
        description="幂等键(为空时用 fill_id 自动生成). 相同 key 只生效一次, 重复提交返回 409.")


class CancelRequest(BaseModel):
    """撤销订单请求 — 已成交部分保留, 未成交部分取消, 资金按原身份回退."""
    order_id: str = Field(..., alias="orderId")
    reason: str = Field("", alias="reason")


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


def _ensure_execution_order_columns(conn: sqlite3.Connection) -> None:
    """V5.0 Sprint4 E8: 幂等给 execution_order 表补充成交回填相关字段.

    老库可能只有 V5.0 Sprint3 的基础字段, 这里 ALTER 补齐:
      planned_shares / actual_amount / actual_shares / actual_price /
      fee / filled_at / cancelled_at / expired_at
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(execution_order)").fetchall()}
    new_cols = [
        ("planned_shares", "REAL"),
        ("actual_amount", "REAL DEFAULT 0"),
        ("actual_shares", "REAL DEFAULT 0"),
        ("actual_price", "REAL"),
        ("fee", "REAL DEFAULT 0"),
        ("filled_at", "TEXT"),
        ("cancelled_at", "TEXT"),
        ("expired_at", "TEXT"),
    ]
    for col, coltype in new_cols:
        if col not in existing:
            try:
                conn.execute(f"ALTER TABLE execution_order ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                # 并发或已存在, 忽略
                pass


def _ensure_execution_fill_table(conn: sqlite3.Connection) -> None:
    """V5.0 Sprint4 E8: 幂等创建 execution_fill 表 — 成交回填记录.

    idempotency_key UNIQUE: 相同 key 只生效一次(PRD §7.8 验收: 重复提交具备幂等保护).
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_fill (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            etf_code TEXT NOT NULL,
            fill_price REAL NOT NULL,
            fill_shares REAL NOT NULL,
            fill_amount REAL NOT NULL,
            fee REAL DEFAULT 0,
            fill_time TEXT NOT NULL,
            idempotency_key TEXT UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY (order_id) REFERENCES execution_order(id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_fill_order "
        "ON execution_fill(order_id, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_fill_etf "
        "ON execution_fill(etf_code, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_fill_idem "
        "ON execution_fill(idempotency_key)"
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


# ─── V5.0 Sprint4 E8: 成交回填(后半) ───────────────────────────────────────────

# 成交状态判定容差(元): actual_amount >= planned_amount - 1 视为全部成交
_FILL_FULL_TOLERANCE = 1.0

# 订单有效期(天): 超过此天数未确认/未执行的订单可被 expire 标记过期
_ORDER_VALIDITY_DAYS = 7


def _get_order_row(conn: sqlite3.Connection, order_id: str) -> Optional[sqlite3.Row]:
    """读取 execution_order 一行(包括 Sprint4 新增字段, 缺失时返回 None)."""
    conn.row_factory = sqlite3.Row
    return conn.execute(
        """SELECT id, calculation_id, etf_code, side, planned_amount,
                  COALESCE(planned_shares, NULL) AS planned_shares,
                  execution_mode, status, confirmed_at,
                  COALESCE(actual_amount, 0) AS actual_amount,
                  COALESCE(actual_shares, 0) AS actual_shares,
                  actual_price,
                  COALESCE(fee, 0) AS fee,
                  filled_at, cancelled_at, expired_at,
                  rejected_reason, created_at, updated_at
           FROM execution_order WHERE id = ?""",
        (order_id,),
    ).fetchone()


@router.post("/orders/fill")
async def fill_order(request: FillRequest):
    """POST /api/execution/orders/fill — 成交回填.

    功能:
      1. 幂等: 相同 idempotency_key 只生效一次(UNIQUE 约束, 重复提交返回 success=False)
      2. 创建 execution_fill 记录(每次部分成交独立记录)
      3. 更新 execution_order 累计 actual_amount/actual_shares/fee + 状态:
         - 全部成交(actual >= planned - 1元): confirmed/partially_executed → executed
         - 部分成交(actual < planned - 1元): confirmed → partially_executed
      4. 现金账本流水(成对借贷 + 守恒):
         - BUY: 从 weekly_contribution_committed 取款(fill_amount + fee 都进入外部)
         - SELL: 存入 rebalance_equity_reserve(fill_amount), 扣 fee(取款)
      5. 守恒校验失败时回滚(check_conservation)

    PRD §7.8 验收:
      - 未确认建议不能进入成交状态: 仅 confirmed / partially_executed 状态可被 fill
      - 部分成交后剩余资金身份正确: BUY 剩余仍在 weekly_contribution_committed
      - 手续费进入资金守恒: fee 通过 withdraw 流出系统
      - 重复提交成交回填具备幂等保护: idempotency_key UNIQUE
    """
    # 业务参数校验
    if request.fill_amount <= 0 or request.fill_shares <= 0 or request.fill_price <= 0:
        return {"success": False, "error": "fill_price/fill_shares/fill_amount 必须 > 0"}
    if request.fee < 0:
        return {"success": False, "error": "fee 不能为负"}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        _ensure_execution_order_columns(conn)
        _ensure_execution_fill_table(conn)

        # 1. 订单存在性 + 状态校验(未确认不能进入成交)
        order = _get_order_row(conn, request.order_id)
        if not order:
            return {"success": False, "error": f"订单不存在: {request.order_id}"}
        if order["etf_code"] != request.etf_code:
            return {"success": False, "error": f"ETF 代码不匹配: order={order['etf_code']} vs fill={request.etf_code}"}
        current_status = order["status"]
        if current_status not in ("confirmed", "partially_executed"):
            return {
                "success": False,
                "error": f"订单状态 {current_status} 不允许成交回填, 仅 confirmed/partially_executed 可回填"
            }

        # 2. 幂等检查(显式 SELECT, 给出更友好的错误信息)
        idem_key = (request.idempotency_key or "").strip() or f"fl-{uuid.uuid4().hex[:12]}"
        existing = conn.execute(
            "SELECT id FROM execution_fill WHERE idempotency_key = ?",
            (idem_key,),
        ).fetchone()
        if existing:
            return {
                "success": False,
                "error": "重复提交: 幂等键已存在",
                "idempotencyKey": idem_key,
                "existingFillId": existing["id"],
            }

        # 3. 创建 execution_fill 记录
        fill_id = f"fl-{uuid.uuid4().hex[:12]}"
        now = datetime.now().isoformat()
        conn.execute(
            """INSERT INTO execution_fill
               (id, order_id, etf_code, fill_price, fill_shares, fill_amount,
                fee, fill_time, idempotency_key, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (fill_id, request.order_id, request.etf_code,
             float(request.fill_price), float(request.fill_shares),
             float(request.fill_amount), float(request.fee),
             now, idem_key, now),
        )

        # 4. 累加 actual_amount / actual_shares / fee, 计算新状态
        prev_actual = float(order["actual_amount"] or 0)
        prev_shares = float(order["actual_shares"] or 0)
        prev_fee = float(order["fee"] or 0)
        new_actual = prev_actual + float(request.fill_amount)
        new_shares = prev_shares + float(request.fill_shares)
        new_fee = prev_fee + float(request.fee)
        # 加权平均价(避免除零)
        new_price = (new_actual / new_shares) if new_shares > 0 else float(request.fill_price)

        planned_amount = float(order["planned_amount"] or 0)
        if new_actual >= planned_amount - _FILL_FULL_TOLERANCE:
            new_status = "executed"
        else:
            new_status = "partially_executed"

        conn.execute(
            """UPDATE execution_order SET
                   actual_amount = ?, actual_shares = ?, actual_price = ?,
                   fee = ?, status = ?, filled_at = ?, updated_at = ?
               WHERE id = ?""",
            (round(new_actual, 2), round(new_shares, 4), round(new_price, 4),
             round(new_fee, 2), new_status, now, now, request.order_id),
        )

        # 5. 现金账本流水(成对借贷 + 守恒校验)
        #    BUY: 从 weekly_contribution_committed 取款(fill_amount + fee 都流出系统)
        #    SELL: 存入 rebalance_equity_reserve(fill_amount 流入), 扣 fee(取款)
        ledger_op_results = []
        try:
            from services.cash_ledger_service import (
                deposit as _ledger_deposit,
                withdraw as _ledger_withdraw,
                check_conservation as _check_conservation,
            )
            # 确保子账户表 + ledger 表存在(cash router 也会 ensure, 这里独立保证幂等)
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cash_subaccount (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_type TEXT NOT NULL UNIQUE,
                    balance REAL NOT NULL DEFAULT 0,
                    counts_as_equity_base BOOLEAN NOT NULL DEFAULT 1,
                    description TEXT,
                    updated_at TEXT NOT NULL
                )"""
            )
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cash_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cash_ledger_id TEXT UNIQUE,
                    cash_account_type TEXT NOT NULL,
                    source_event TEXT NOT NULL,
                    source_etf TEXT,
                    amount REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    released_at TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    transfer_id TEXT,
                    entry_type TEXT,
                    reference_id TEXT
                )"""
            )
            # 确保需要的子账户行存在(初始化为 0 余额)
            for acct in ("weekly_contribution_committed", "rebalance_equity_reserve"):
                conn.execute(
                    """INSERT OR IGNORE INTO cash_subaccount
                       (account_type, balance, counts_as_equity_base, description, updated_at)
                       VALUES (?, 0, 1, ?, ?)""",
                    (acct, "V5.0 E8 fill auto-init" if acct == "weekly_contribution_committed"
                     else "再平衡权益备用金", now),
                )

            side = (order["side"] or "buy").lower()
            if side == "buy":
                # BUY 成交: fill_amount 流出 + fee 流出
                if request.fill_amount > 0:
                    tf1 = _ledger_withdraw(
                        conn,
                        from_account="weekly_contribution_committed",
                        amount=float(request.fill_amount),
                        source_event="execution_fill_buy",
                        source_etf=request.etf_code,
                        reference_id=request.order_id,
                    )
                    ledger_op_results.append({"event": "execution_fill_buy", "transfer_id": tf1, "amount": float(request.fill_amount)})
                if request.fee > 0:
                    tf2 = _ledger_withdraw(
                        conn,
                        from_account="weekly_contribution_committed",
                        amount=float(request.fee),
                        source_event="execution_fee_buy",
                        source_etf=request.etf_code,
                        reference_id=request.order_id,
                    )
                    ledger_op_results.append({"event": "execution_fee_buy", "transfer_id": tf2, "amount": float(request.fee)})
            else:
                # SELL 成交: fill_amount 流入 rebalance_equity_reserve, fee 从该账户扣除
                if request.fill_amount > 0:
                    tf1 = _ledger_deposit(
                        conn,
                        to_account="rebalance_equity_reserve",
                        amount=float(request.fill_amount),
                        source_event="execution_fill_sell",
                        source_etf=request.etf_code,
                        reference_id=request.order_id,
                    )
                    ledger_op_results.append({"event": "execution_fill_sell", "transfer_id": tf1, "amount": float(request.fill_amount)})
                if request.fee > 0:
                    tf2 = _ledger_withdraw(
                        conn,
                        from_account="rebalance_equity_reserve",
                        amount=float(request.fee),
                        source_event="execution_fee_sell",
                        source_etf=request.etf_code,
                        reference_id=request.order_id,
                    )
                    ledger_op_results.append({"event": "execution_fee_sell", "transfer_id": tf2, "amount": float(request.fee)})

            # 6. 资金守恒校验(失败回滚, PRD §7.8 验收: 手续费进入资金守恒)
            conservation = _check_conservation(conn)
            if not conservation.get("total_check"):
                conn.rollback()
                logger.error(
                    f"[FILL] conservation failed for order={request.order_id} fill={fill_id}: "
                    f"{conservation}"
                )
                return {
                    "success": False,
                    "error": "资金守恒校验失败, 已回滚",
                    "conservation": conservation,
                }
        except Exception as le:
            # 账本服务异常 — 回滚整笔 fill, 不要让数据进入不一致状态
            conn.rollback()
            logger.exception(f"[FILL] ledger op failed for order={request.order_id}")
            return {"success": False, "error": f"现金账本操作失败: {le}"}

        # 7. 提交
        conn.commit()
        logger.info(
            f"[FILL] order={request.order_id} fill={fill_id} side={order['side']} "
            f"amount=¥{request.fill_amount:.2f} shares={request.fill_shares:.4f} "
            f"fee=¥{request.fee:.2f} new_status={new_status} "
            f"actual_total=¥{new_actual:.2f}/planned=¥{planned_amount:.2f}"
        )
        return {
            "success": True,
            "fill_id": fill_id,
            "order_id": request.order_id,
            "etf_code": request.etf_code,
            "idempotency_key": idem_key,
            "order_status": new_status,
            "actual_amount": round(new_actual, 2),
            "actual_shares": round(new_shares, 4),
            "actual_price": round(new_price, 4),
            "fee_total": round(new_fee, 2),
            "planned_amount": round(planned_amount, 2),
            "fill_time": now,
            "ledger_ops": ledger_op_results,
        }
    except Exception as e:
        conn.rollback()
        logger.exception("[FILL] orders/fill failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.post("/orders/cancel")
async def cancel_order(request: CancelRequest):
    """POST /api/execution/orders/cancel — 撤销订单.

    PRD §7.8: "未成交资金按原身份回退, 不自动改变账户"

    逻辑:
      - 已成交部分保留(execution_fill + actual_*), 状态变 partially_executed
      - 未成交部分取消, 状态 → cancelled
      - 资金不主动转移: 已 committed 的现金仍在原子账户(weekly_contribution_committed
        for BUY; rebalance_equity_reserve for SELL 的待收款), 不自动转回 daily_cash
      - 如有未释放的 release_plan, 暂停(不取消), 等待人工处理
    """
    if not request.order_id:
        return {"success": False, "error": "orderId 不能为空"}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        _ensure_execution_order_columns(conn)
        order = _get_order_row(conn, request.order_id)
        if not order:
            return {"success": False, "error": f"订单不存在: {request.order_id}"}

        current_status = order["status"]
        # 已终态: executed / cancelled / expired / rejected 不可撤
        if current_status in ("executed", "cancelled", "expired", "rejected"):
            return {"success": False, "error": f"订单状态 {current_status} 不可撤销"}
        # pending 也允许撤(等同于 reject), 但通常 pending 走 orders/confirm 流程
        if current_status not in ("pending", "confirmed", "partially_executed"):
            return {"success": False, "error": f"订单状态 {current_status} 不可撤销"}

        actual_amount = float(order["actual_amount"] or 0)
        now = datetime.now().isoformat()
        # 已有部分成交 → 保留并标记为 partially_executed 历史, 然后撤
        # 这里仍把 status 改为 cancelled(便于过滤未撤单), 已成交数据保留在 execution_fill + actual_* 字段
        cancelled_at = now
        # rejected_reason 复用字段记录撤单原因(更直观)
        reason_text = request.reason or "用户撤单"

        conn.execute(
            """UPDATE execution_order SET
                   status = 'cancelled', cancelled_at = ?, rejected_reason = ?,
                   updated_at = ?
               WHERE id = ?""",
            (cancelled_at, reason_text, now, request.order_id),
        )

        # 不主动转移资金 — PRD §7.8 "未成交资金按原身份回退, 不自动改变账户"
        # weekly_contribution_committed / rebalance_equity_reserve 的余额保持不变,
        # 由前端 / 调度任务在下一周计算时按策略重新分配.
        # 如有该订单对应的 release_plan(Sell 触发的备用金释放), 暂停之.
        try:
            existing_plans = conn.execute(
                "SELECT id FROM release_plan WHERE target_etf=? AND plan_type='rebalance_reserve' "
                "AND state IN ('idle', 'releasing')",
                (order["etf_code"],),
            ).fetchall()
            if existing_plans:
                from services.release_plan_service import pause_release as _pause_release
                for p in existing_plans:
                    try:
                        _pause_release(conn, p["id"], reason=f"order_cancelled:{request.order_id}")
                    except Exception as pe:
                        logger.warning(f"[CANCEL] pause release_plan {p['id']} failed: {pe}")
        except Exception as pe:
            logger.warning(f"[CANCEL] release_plan pause check failed (non-blocking): {pe}")

        conn.commit()
        logger.info(
            f"[CANCEL] order={request.order_id} status={current_status}→cancelled "
            f"actual_so_far=¥{actual_amount:.2f} reason={reason_text}"
        )
        return {
            "success": True,
            "order_id": request.order_id,
            "previous_status": current_status,
            "new_status": "cancelled",
            "cancelled_at": cancelled_at,
            "reason": reason_text,
            "actual_amount_before_cancel": round(actual_amount, 2),
        }
    except Exception as e:
        conn.rollback()
        logger.exception("[CANCEL] orders/cancel failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.post("/orders/expire")
async def expire_orders():
    """POST /api/execution/orders/expire — 过期清理.

    PRD §7.8: "支持部分成交、未成交、撤销和过期"

    规则:
      - 超过有效期(默认 7 天)未确认的 pending 订单 → expired
      - 已 confirmed 但 0 成交且超过 7 天 → expired
      - 已 partially_executed 不强制过期(已成交部分需保留, 等待人工处理)
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        _ensure_execution_order_columns(conn)
        now = datetime.now()
        cutoff = (now - timedelta(days=_ORDER_VALIDITY_DAYS)).isoformat()
        now_iso = now.isoformat()

        # 待过期候选: pending / confirmed 且创建时间早于 cutoff 且无成交
        rows = conn.execute(
            """SELECT id, status, etf_code, calculation_id, created_at,
                      COALESCE(actual_amount, 0) AS actual_amount
               FROM execution_order
               WHERE status IN ('pending', 'confirmed')
                 AND created_at < ?
                 AND COALESCE(actual_amount, 0) = 0""",
            (cutoff,),
        ).fetchall()

        expired_ids: list[str] = []
        for r in rows:
            conn.execute(
                """UPDATE execution_order SET
                       status = 'expired', expired_at = ?, updated_at = ?
                   WHERE id = ?""",
                (now_iso, now_iso, r["id"]),
            )
            expired_ids.append(r["id"])

        conn.commit()
        logger.info(f"[EXPIRE] marked {len(expired_ids)} orders as expired (cutoff={cutoff})")
        return {
            "success": True,
            "expired_count": len(expired_ids),
            "expired_ids": expired_ids,
            "cutoff": cutoff,
        }
    except Exception as e:
        conn.rollback()
        logger.exception("[EXPIRE] orders/expire failed")
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


@router.get("/fills")
async def get_fills(
    calculation_id: str = Query("", alias="calculationId",
        description="按计算批次过滤(关联 execution_order.calculation_id)"),
    order_id: str = Query("", alias="orderId", description="按订单ID过滤"),
    limit: int = Query(100, ge=1, le=500),
):
    """GET /api/execution/fills — 成交记录查询.

    返回: {items: [{fillId, orderId, etfCode, fillPrice, fillShares, fillAmount,
                     fee, fillTime, idempotencyKey, createdAt, calculationId}],
           total: int}
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_fill_table(conn)
        _ensure_execution_order_table(conn)

        if order_id:
            rows = conn.execute(
                """SELECT f.*, o.calculation_id AS calculation_id
                   FROM execution_fill f
                   LEFT JOIN execution_order o ON o.id = f.order_id
                   WHERE f.order_id = ?
                   ORDER BY f.created_at DESC
                   LIMIT ?""",
                (order_id, limit),
            ).fetchall()
        elif calculation_id:
            rows = conn.execute(
                """SELECT f.*, o.calculation_id AS calculation_id
                   FROM execution_fill f
                   LEFT JOIN execution_order o ON o.id = f.order_id
                   WHERE o.calculation_id = ?
                   ORDER BY f.created_at DESC
                   LIMIT ?""",
                (calculation_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT f.*, NULL AS calculation_id
                   FROM execution_fill f
                   ORDER BY f.created_at DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()

        items = []
        for r in rows:
            items.append({
                "fillId": r["id"],
                "orderId": r["order_id"],
                "etfCode": r["etf_code"],
                "fillPrice": round(r["fill_price"], 4) if r["fill_price"] is not None else 0,
                "fillShares": round(r["fill_shares"], 4) if r["fill_shares"] is not None else 0,
                "fillAmount": round(r["fill_amount"], 2) if r["fill_amount"] is not None else 0,
                "fee": round(r["fee"], 2) if r["fee"] is not None else 0,
                "fillTime": r["fill_time"],
                "idempotencyKey": r["idempotency_key"],
                "createdAt": r["created_at"],
                "calculationId": r["calculation_id"] or "",
            })
        return {"items": items, "total": len(items)}
    except Exception as e:
        logger.exception("[FILLS] get_fills failed")
        return {"items": [], "total": 0, "error": str(e)}
    finally:
        conn.close()


@router.get("/reconciliation")
async def get_reconciliation(
    calculation_id: str = Query("", alias="calculationId",
        description="按计算批次对账; 不传则返回最近 7 天所有订单的对账"),
):
    """GET /api/execution/reconciliation — 计划 vs 实际对账.

    返回: {items: [{etfCode, orderId, side, status,
                     plannedAmount, plannedShares,
                     actualAmount, actualShares, actualPrice, fee,
                     deviation, deviationPct, status}],
           summary: {totalPlanned, totalActual, totalDeviation, totalDeviationPct}}

    偏差定义:
      deviation = actualAmount - plannedAmount  (负=未完成, 正=超额)
      deviationPct = deviation / plannedAmount × 100  (planned=0 时为 0)
      status: completed (|deviationPct|<=1%) | partial (1%~50%) | under_filled (<-50%)
              | over_filled (>50%) | not_started (actual=0, planned>0)
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_execution_order_table(conn)
        _ensure_execution_order_columns(conn)

        if calculation_id:
            rows = conn.execute(
                """SELECT id, calculation_id, etf_code, side, planned_amount,
                          COALESCE(planned_shares, NULL) AS planned_shares,
                          execution_mode, status,
                          COALESCE(actual_amount, 0) AS actual_amount,
                          COALESCE(actual_shares, 0) AS actual_shares,
                          actual_price,
                          COALESCE(fee, 0) AS fee,
                          filled_at, cancelled_at, expired_at, created_at
                   FROM execution_order
                   WHERE calculation_id = ?
                   ORDER BY etf_code""",
                (calculation_id,),
            ).fetchall()
        else:
            cutoff = (datetime.now() - timedelta(days=7)).isoformat()
            rows = conn.execute(
                """SELECT id, calculation_id, etf_code, side, planned_amount,
                          COALESCE(planned_shares, NULL) AS planned_shares,
                          execution_mode, status,
                          COALESCE(actual_amount, 0) AS actual_amount,
                          COALESCE(actual_shares, 0) AS actual_shares,
                          actual_price,
                          COALESCE(fee, 0) AS fee,
                          filled_at, cancelled_at, expired_at, created_at
                   FROM execution_order
                   WHERE created_at >= ?
                   ORDER BY created_at DESC""",
                (cutoff,),
            ).fetchall()

        items = []
        total_planned = 0.0
        total_actual = 0.0
        for r in rows:
            planned = float(r["planned_amount"] or 0)
            actual = float(r["actual_amount"] or 0)
            deviation = round(actual - planned, 2)
            deviation_pct = (deviation / planned * 100.0) if planned > 0 else 0.0
            deviation_pct = round(deviation_pct, 2)

            # 对账状态分类
            if actual <= 0 and planned > 0:
                recon_status = "not_started"
            elif abs(deviation_pct) <= 1.0:
                recon_status = "completed"
            elif -50.0 <= deviation_pct < -1.0:
                recon_status = "partial"
            elif deviation_pct < -50.0:
                recon_status = "under_filled"
            else:
                recon_status = "over_filled"

            items.append({
                "etfCode": r["etf_code"],
                "orderId": r["id"],
                "calculationId": r["calculation_id"],
                "side": r["side"],
                "orderStatus": r["status"],
                "executionMode": r["execution_mode"],
                "plannedAmount": round(planned, 2),
                "plannedShares": r["planned_shares"],
                "actualAmount": round(actual, 2),
                "actualShares": round(float(r["actual_shares"] or 0), 4),
                "actualPrice": round(float(r["actual_price"] or 0), 4) if r["actual_price"] is not None else None,
                "fee": round(float(r["fee"] or 0), 2),
                "deviation": deviation,
                "deviationPct": deviation_pct,
                "reconciliationStatus": recon_status,
                "filledAt": r["filled_at"],
                "cancelledAt": r["cancelled_at"],
                "expiredAt": r["expired_at"],
                "createdAt": r["created_at"],
            })
            total_planned += planned
            total_actual += actual

        total_deviation = round(total_actual - total_planned, 2)
        total_deviation_pct = (total_deviation / total_planned * 100.0) if total_planned > 0 else 0.0
        return {
            "calculationId": calculation_id,
            "items": items,
            "total": len(items),
            "summary": {
                "totalPlanned": round(total_planned, 2),
                "totalActual": round(total_actual, 2),
                "totalDeviation": total_deviation,
                "totalDeviationPct": round(total_deviation_pct, 2),
            },
        }
    except Exception as e:
        logger.exception("[RECONCILE] reconciliation failed")
        return {
            "calculationId": calculation_id,
            "items": [],
            "total": 0,
            "summary": {
                "totalPlanned": 0, "totalActual": 0,
                "totalDeviation": 0, "totalDeviationPct": 0,
            },
            "error": str(e),
        }
    finally:
        conn.close()
