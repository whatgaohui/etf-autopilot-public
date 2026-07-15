"""V5.0 Sprint2 E5 — Release Plan Router (QDII 挂起释放状态机).

状态机: idle -> releasing -> paused -> releasing -> completed

Endpoints:
  - GET  /api/release-plans                — 所有释放计划(含历史)
  - GET  /api/release-plans/active         — 活跃的释放计划(非 completed)
  - GET  /api/release-plans/{id}           — 单个释放计划详情
  - POST /api/release-plans                — 创建释放计划(默认 idle)
  - POST /api/release-plans/{id}/start     — idle -> releasing
  - POST /api/release-plans/{id}/pause     — releasing -> paused
  - POST /api/release-plans/{id}/resume    — paused -> releasing
  - POST /api/release-plans/{id}/complete  — releasing/paused -> completed
  - POST /api/release-plans/{id}/weekly    — 计算本周释放金额(不修改状态)
"""
from __future__ import annotations

import logging
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import DB_PATH
from services import release_plan_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/release-plans", tags=["release-plan-v5"])


# ─── Pydantic 请求模型 ─────────────────────────────────────────────────────────


class CreatePlanRequest(BaseModel):
    """创建释放计划请求。"""
    plan_type: str = Field(..., alias="planType",
                           description="qdii_sp500 | qdii_nasdaq | rebalance_reserve")
    account_id: str = Field(..., alias="accountId",
                            description="关联现金子账户类型, 如 qdii_pending_cash_sp500")
    balance: float = Field(..., ge=0, alias="balance", description="挂起池余额(元)")
    target_etf: str = Field("", alias="targetEtf", description="目标ETF代码, 如 513500")
    weeks: int = Field(8, ge=4, le=12, alias="weeks", description="分批周数(4-12, 默认8)")

    model_config = {"populate_by_name": True}


class PausePlanRequest(BaseModel):
    reason: str = Field("", alias="reason", description="暂停原因(如 QDII溢价再次升高)")

    model_config = {"populate_by_name": True}


class WeeklyReleaseRequest(BaseModel):
    """计算本周释放金额请求(只读, 不修改状态)。"""
    strategy_weekly_budget: float = Field(40000.0, alias="strategyWeeklyBudget",
                                          description="策略周预算(默认 40000)")
    target_ratio: float = Field(0.0, ge=0, le=1, alias="targetRatio",
                                description="目标ETF占比(如 0.24)")
    equity_asset_base: float = Field(0.0, ge=0, alias="equityAssetBase",
                                     description="权益资产基准(EAB)")
    current_etf_value: float = Field(0.0, ge=0, alias="currentEtfValue",
                                     description="当前该ETF持仓市值")

    model_config = {"populate_by_name": True}


# ─── helpers ──────────────────────────────────────────────────────────────────


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ─── 路由 ─────────────────────────────────────────────────────────────────────


@router.get("")
async def get_plans(active_only: bool = Query(False, alias="active"),
                    state: Optional[str] = Query(None, description="按状态过滤")):
    """GET /api/release-plans — 所有释放计划。

    Query 参数:
    - active=true  — 只返回活跃计划(非 completed)
    - state=releasing — 只返回指定状态的计划
    """
    try:
        conn = _conn()
        try:
            if active_only:
                plans = svc.get_active_plans(conn)
            else:
                plans = svc.get_all_plans(conn)
            if state:
                plans = [p for p in plans if p.get("state") == state]
            return {"total": len(plans), "items": plans}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[RELEASE] get_plans error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/active")
async def get_active_plans():
    """GET /api/release-plans/active — 活跃的释放计划(非 completed)。"""
    try:
        conn = _conn()
        try:
            plans = svc.get_active_plans(conn)
            return {"total": len(plans), "items": plans}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[RELEASE] get_active_plans error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{plan_id}")
async def get_plan(plan_id: str):
    """GET /api/release-plans/{id} — 单个释放计划详情。"""
    try:
        conn = _conn()
        try:
            plan = svc.get_plan(conn, plan_id)
            if not plan:
                raise HTTPException(status_code=404, detail=f"释放计划不存在: {plan_id}")
            return plan
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[RELEASE] get_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("")
async def create_plan(req: CreatePlanRequest):
    """POST /api/release-plans — 创建释放计划(初始 idle)。"""
    try:
        conn = _conn()
        try:
            plan_id = svc.create_release_plan(
                conn,
                plan_type=req.plan_type,
                account_id=req.account_id,
                balance=req.balance,
                target_etf=req.target_etf,
                weeks=req.weeks,
            )
            conn.commit()
            plan = svc.get_plan(conn, plan_id)
            logger.info(f"[RELEASE] created plan {plan_id} type={req.plan_type}")
            return {"success": True, "id": plan_id, "plan": plan}
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] create_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{plan_id}/start")
async def start_plan(plan_id: str):
    """POST /api/release-plans/{id}/start — idle -> releasing。"""
    try:
        conn = _conn()
        try:
            result = svc.start_release(conn, plan_id)
            conn.commit()
            return {"success": True, **result}
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] start_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{plan_id}/pause")
async def pause_plan(plan_id: str, req: Optional[PausePlanRequest] = None):
    """POST /api/release-plans/{id}/pause — releasing -> paused。

    body 可选, 如 {reason: "QDII溢价再次升高"}
    """
    reason = req.reason if req else ""
    try:
        conn = _conn()
        try:
            result = svc.pause_release(conn, plan_id, reason=reason)
            conn.commit()
            return {"success": True, **result}
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] pause_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{plan_id}/resume")
async def resume_plan(plan_id: str):
    """POST /api/release-plans/{id}/resume — paused -> releasing。"""
    try:
        conn = _conn()
        try:
            result = svc.resume_release(conn, plan_id)
            conn.commit()
            return {"success": True, **result}
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] resume_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{plan_id}/complete")
async def complete_plan(plan_id: str):
    """POST /api/release-plans/{id}/complete — releasing/paused -> completed。"""
    try:
        conn = _conn()
        try:
            result = svc.complete_release(conn, plan_id)
            conn.commit()
            return {"success": True, **result}
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] complete_plan error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{plan_id}/weekly")
async def weekly_release(plan_id: str, req: Optional[WeeklyReleaseRequest] = None):
    """POST /api/release-plans/{id}/weekly — 计算本周释放金额(只读)。

    根据策略周预算/目标比例/EAB/当前持仓, 返回本周应释放金额(不修改状态)。
    """
    payload = req or WeeklyReleaseRequest()
    try:
        conn = _conn()
        try:
            result = svc.get_weekly_release(
                conn,
                plan_id,
                strategy_weekly_budget=payload.strategy_weekly_budget,
                target_ratio=payload.target_ratio,
                equity_asset_base=payload.equity_asset_base,
                current_etf_value=payload.current_etf_value,
            )
            return result
        finally:
            conn.close()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[RELEASE] weekly_release error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
