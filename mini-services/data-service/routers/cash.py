"""V5.0 Sprint2 E3 — Cash Ledger Router.

现金账本成对借贷 + 守恒校验 API:
  - GET  /api/cash/accounts       — 子账户余额 + 流水数
  - GET  /api/cash/ledger         — 最近流水(含成对借贷标记)
  - GET  /api/cash/transfers      — 最近转账(按 transfer_id 聚合)
  - GET  /api/cash/conservation   — 守恒校验结果(总量 + 逐账户)
  - POST /api/cash/deposit        — 外部资金注入(单边贷方流水)
  - POST /api/cash/withdraw       — 外部资金退出(单边借方流水)
  - POST /api/cash/transfer       — 人工转账(成对借贷)
  - POST /api/cash/reverse        — 冲正一笔转账/注入/退出
"""
from __future__ import annotations

import logging
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import DB_PATH
from services import cash_ledger_service as svc
from services.cash_ledger_service import ACCOUNT_TYPES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cash", tags=["cash-ledger-v5"])


# ─── Pydantic 请求模型 ─────────────────────────────────────────────────────────


class ManualTransferRequest(BaseModel):
    """人工转账请求(成对借贷)。"""
    from_account: str = Field(..., alias="fromAccount", description="借方子账户")
    to_account: str = Field(..., alias="toAccount", description="贷方子账户")
    amount: float = Field(..., gt=0, alias="amount", description="转账金额(必须>0)")
    source_event: str = Field("manual", alias="sourceEvent",
                              description="来源事件: manual / weekly_unallocated / qdii_blocked 等")
    source_etf: str = Field("", alias="sourceEtf", description="来源ETF(可选)")
    reference_id: str = Field("", alias="referenceId",
                              description="业务关联ID(如 calculation_id, 可选)")
    confirmed: bool = Field(False, alias="confirmed",
                            description="必须为 true 才会真正执行(防误操作)")

    model_config = {"populate_by_name": True}


class DepositRequest(BaseModel):
    """外部资金注入请求(单边贷方流水)。"""
    to_account: str = Field(..., alias="toAccount", description="贷方子账户(接收注资)")
    amount: float = Field(..., gt=0, alias="amount", description="注入金额(必须>0)")
    source_event: str = Field("external_deposit", alias="sourceEvent",
                              description="来源事件: weekly_contribution / dividend / manual_topup 等")
    source_etf: str = Field("", alias="sourceEtf", description="来源ETF(可选)")
    reference_id: str = Field("", alias="referenceId", description="业务关联ID(可选)")
    confirmed: bool = Field(False, alias="confirmed", description="必须为 true 才会真正执行")

    model_config = {"populate_by_name": True}


class WithdrawRequest(BaseModel):
    """外部资金退出请求(单边借方流水)。"""
    from_account: str = Field(..., alias="fromAccount", description="借方子账户(扣减余额)")
    amount: float = Field(..., gt=0, alias="amount", description="退出金额(必须>0)")
    source_event: str = Field("external_withdraw", alias="sourceEvent",
                              description="来源事件: withdrawal / fee / manual_out 等")
    source_etf: str = Field("", alias="sourceEtf", description="来源ETF(可选)")
    reference_id: str = Field("", alias="referenceId", description="业务关联ID(可选)")
    confirmed: bool = Field(False, alias="confirmed", description="必须为 true 才会真正执行")

    model_config = {"populate_by_name": True}


class ReverseTransferRequest(BaseModel):
    """冲正转账请求。"""
    transfer_id: str = Field(..., alias="transferId", description="要冲正的转账 ID")
    reason: str = Field("", alias="reason", description="冲正原因")
    confirmed: bool = Field(False, alias="confirmed", description="必须为 true 才会真正执行")

    model_config = {"populate_by_name": True}


# ─── helpers ──────────────────────────────────────────────────────────────────


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ─── 路由 ─────────────────────────────────────────────────────────────────────


@router.get("/accounts")
async def get_accounts():
    """GET /api/cash/accounts — 子账户余额 + 流水数 + 是否计入权益基准。"""
    try:
        conn = _conn()
        try:
            accounts = svc.get_account_summary(conn)
            return {
                "total": len(accounts),
                "total_balance": round(sum(a["balance"] for a in accounts), 2),
                "items": accounts,
            }
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[CASH] get_accounts error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ledger")
async def get_ledger(limit: int = Query(50, ge=1, le=500)):
    """GET /api/cash/ledger — 最近流水(按 created_at DESC, 含成对借贷字段)。"""
    try:
        conn = _conn()
        try:
            entries = svc.get_ledger_entries(conn, limit=limit)
            return {"total": len(entries), "items": entries}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[CASH] get_ledger error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/transfers")
async def get_transfers(limit: int = Query(50, ge=1, le=500)):
    """GET /api/cash/transfers — 最近转账(按 transfer_id 聚合, 含 from/to 账户)。"""
    try:
        conn = _conn()
        try:
            transfers = svc.get_transfers(conn, limit=limit)
            return {"total": len(transfers), "items": transfers}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[CASH] get_transfers error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/conservation")
async def check_conservation():
    """GET /api/cash/conservation — 资金守恒校验(总量 + 逐账户)。

    返回结构:
        {
          "total_check": bool,         # 总量守恒是否通过
          "per_account_check": bool,   # 逐账户守恒是否通过
          "total_balance": float,      # 所有子账户余额之和
          "total_ledger_sum": float,   # 所有 active 流水净额之和(应等于 total_balance)
          "total_diff": float,         # 总量偏差(应≈0)
          "account_checks": [...]
        }
    """
    try:
        conn = _conn()
        try:
            result = svc.check_conservation(conn)
            return result
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[CASH] check_conservation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transfer")
async def manual_transfer(req: ManualTransferRequest):
    """POST /api/cash/transfer — 人工转账(成对借贷)。

    要求:
    1. confirmed=true (防误操作)
    2. from_account / to_account 必须在 ACCOUNT_TYPES 中且不能相同
    3. amount > 0
    4. from_account 余额必须 >= amount (否则守恒失败, 拒绝)
    """
    if not req.confirmed:
        raise HTTPException(
            status_code=400,
            detail="confirmed 必须=true 才会真正执行转账(防误操作)",
        )
    if req.from_account not in ACCOUNT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"from_account 非法: {req.from_account}, 合法值: {ACCOUNT_TYPES}",
        )
    if req.to_account not in ACCOUNT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"to_account 非法: {req.to_account}, 合法值: {ACCOUNT_TYPES}",
        )
    if req.from_account == req.to_account:
        raise HTTPException(
            status_code=400,
            detail="from_account 与 to_account 不能相同",
        )

    try:
        conn = _conn()
        try:
            # 余额检查
            row = conn.execute(
                "SELECT balance FROM cash_subaccount WHERE account_type = ?",
                (req.from_account,),
            ).fetchone()
            if not row:
                raise HTTPException(
                    status_code=404,
                    detail=f"子账户不存在: {req.from_account}",
                )
            current_balance = float(row["balance"])
            if current_balance < req.amount:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"余额不足: {req.from_account} 当前余额¥{current_balance:.2f} "
                        f"< 转账金额¥{req.amount:.2f}"
                    ),
                )

            transfer_id = svc.transfer(
                conn,
                from_account=req.from_account,
                to_account=req.to_account,
                amount=req.amount,
                source_event=req.source_event,
                source_etf=req.source_etf,
                reference_id=req.reference_id,
            )
            conn.commit()

            # 校验守恒(转账后立即校验, 若失败回滚)
            conservation = svc.check_conservation(conn)
            if not conservation["total_check"]:
                # 冲正回滚
                svc.reverse_transfer(conn, transfer_id, reason="conservation-failed-rollback")
                conn.commit()
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"转账后守恒校验失败, 已自动冲正回滚。"
                        f"conservation={conservation}"
                    ),
                )

            logger.info(
                f"[CASH] manual transfer {transfer_id}: {req.from_account} -> {req.to_account} "
                f"¥{req.amount:.2f} ({req.source_event})"
            )
            return {
                "success": True,
                "transfer_id": transfer_id,
                "from_account": req.from_account,
                "to_account": req.to_account,
                "amount": round(req.amount, 2),
                "source_event": req.source_event,
                "conservation": conservation,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[CASH] manual_transfer error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/deposit")
async def deposit(req: DepositRequest):
    """POST /api/cash/deposit — 外部资金注入(单边贷方流水)。

    用于: 每周注资到达、分红到账、用户手动 top-up 等外部资金流入。
    生成单条 active 流水(entry_type='credit', amount>0), transfer_id=`dp-xxx`。
    """
    if not req.confirmed:
        raise HTTPException(
            status_code=400,
            detail="confirmed 必须=true 才会真正执行注入(防误操作)",
        )
    if req.to_account not in ACCOUNT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"to_account 非法: {req.to_account}, 合法值: {ACCOUNT_TYPES}",
        )

    try:
        conn = _conn()
        try:
            transfer_id = svc.deposit(
                conn,
                to_account=req.to_account,
                amount=req.amount,
                source_event=req.source_event,
                source_etf=req.source_etf,
                reference_id=req.reference_id,
            )
            conn.commit()
            conservation = svc.check_conservation(conn)
            if not conservation["total_check"]:
                svc.reverse_transfer(conn, transfer_id, reason="conservation-failed-rollback")
                conn.commit()
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"注入后守恒校验失败, 已自动冲正回滚。"
                        f"conservation={conservation}"
                    ),
                )
            logger.info(
                f"[CASH] deposit {transfer_id}: -> {req.to_account} "
                f"¥{req.amount:.2f} ({req.source_event})"
            )
            return {
                "success": True,
                "transfer_id": transfer_id,
                "to_account": req.to_account,
                "amount": round(req.amount, 2),
                "source_event": req.source_event,
                "conservation": conservation,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[CASH] deposit error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/withdraw")
async def withdraw(req: WithdrawRequest):
    """POST /api/cash/withdraw — 外部资金退出(单边借方流水)。

    用于: 用户提现、扣费等外部资金流出。
    生成单条 active 流水(entry_type='debit', amount<0), transfer_id=`wd-xxx`。
    """
    if not req.confirmed:
        raise HTTPException(
            status_code=400,
            detail="confirmed 必须=true 才会真正执行退出(防误操作)",
        )
    if req.from_account not in ACCOUNT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"from_account 非法: {req.from_account}, 合法值: {ACCOUNT_TYPES}",
        )

    try:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT balance FROM cash_subaccount WHERE account_type = ?",
                (req.from_account,),
            ).fetchone()
            if not row:
                raise HTTPException(
                    status_code=404,
                    detail=f"子账户不存在: {req.from_account}",
                )
            current_balance = float(row["balance"])
            if current_balance < req.amount:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"余额不足: {req.from_account} 当前余额¥{current_balance:.2f} "
                        f"< 退出金额¥{req.amount:.2f}"
                    ),
                )

            transfer_id = svc.withdraw(
                conn,
                from_account=req.from_account,
                amount=req.amount,
                source_event=req.source_event,
                source_etf=req.source_etf,
                reference_id=req.reference_id,
            )
            conn.commit()
            conservation = svc.check_conservation(conn)
            if not conservation["total_check"]:
                svc.reverse_transfer(conn, transfer_id, reason="conservation-failed-rollback")
                conn.commit()
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"退出后守恒校验失败, 已自动冲正回滚。"
                        f"conservation={conservation}"
                    ),
                )
            logger.info(
                f"[CASH] withdraw {transfer_id}: {req.from_account} -> "
                f"¥{req.amount:.2f} ({req.source_event})"
            )
            return {
                "success": True,
                "transfer_id": transfer_id,
                "from_account": req.from_account,
                "amount": round(req.amount, 2),
                "source_event": req.source_event,
                "conservation": conservation,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[CASH] withdraw error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reverse")
async def reverse_transfer(req: ReverseTransferRequest):
    """POST /api/cash/reverse — 冲正一笔转账(生成反向成对流水)。"""
    if not req.confirmed:
        raise HTTPException(
            status_code=400,
            detail="confirmed 必须=true 才会真正执行冲正(防误操作)",
        )
    try:
        conn = _conn()
        try:
            ok = svc.reverse_transfer(conn, req.transfer_id, reason=req.reason)
            if not ok:
                raise HTTPException(
                    status_code=404,
                    detail=f"未找到可冲正的 active 流水: transfer_id={req.transfer_id}",
                )
            conn.commit()
            conservation = svc.check_conservation(conn)
            return {
                "success": True,
                "transfer_id": req.transfer_id,
                "reason": req.reason,
                "conservation": conservation,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[CASH] reverse_transfer error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
