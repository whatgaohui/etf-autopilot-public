"""V5.0 Sprint1 E1 — Strategy Version & Frozen Snapshot Router.

策略书V5.0 §策略版本管理: 引入策略版本化与计算输入冻结快照,
保证"相同输入+相同策略版本→相同输出"的确定性可复算语义。

Endpoints:
- GET  /api/strategy/versions           — 列出所有策略版本
- POST /api/strategy/versions           — 创建新策略版本(draft)
- POST /api/strategy/versions/{id}/activate  — 激活策略版本(同时retire其他active, 目标比例和必须=100%)
- GET  /api/strategy/versions/active    — 获取当前active策略版本
- POST /api/strategy/snapshot           — 冻结计算输入快照(计算各输入hash并保存)
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import DB_PATH

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/strategy", tags=["strategy-v5"])


# ─── Pydantic 请求模型 ─────────────────────────────────────────────────────────


class CreateVersionRequest(BaseModel):
    """创建新策略版本请求体。"""
    version: str = Field(..., description="版本号, 如 v5.1")
    parameters: dict = Field(..., description="策略参数快照(目标比例/预算/规则阈值等)")
    docRef: Optional[str] = Field(None, description="策略文档引用")
    createdReason: Optional[str] = Field(None, description="创建原因")
    confirmedBy: str = Field("user", description="确认人")
    status: str = Field("draft", description="初始状态: draft/active/retired")


class FreezeSnapshotRequest(BaseModel):
    """冻结计算输入快照请求体。"""
    calculationId: str = Field(..., description="本次计算ID")
    strategyVersionId: str = Field(..., description="使用的策略版本ID")
    holdings: list[dict] = Field(default_factory=list, description="持仓列表")
    cashBalances: dict = Field(default_factory=dict, description="现金子账户余额")
    marketData: dict = Field(default_factory=dict, description="市场数据快照")


# ─── helpers ──────────────────────────────────────────────────────────────────


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _hash_inputs(payload: Any) -> str:
    """对任意 JSON-serializable 输入计算 sha256 hash(前16位)."""
    s = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    # parameters 是 JSON 字符串, 反序列化为 dict
    params_raw = d.get("parameters")
    if isinstance(params_raw, str):
        try:
            d["parameters"] = json.loads(params_raw)
        except (TypeError, ValueError):
            pass
    return d


# ─── 路由 ─────────────────────────────────────────────────────────────────────


@router.get("/versions")
async def list_versions():
    """GET /api/strategy/versions — 列出所有策略版本(按 created_at DESC)."""
    try:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT * FROM strategy_version ORDER BY created_at DESC"
            ).fetchall()
            return {
                "total": len(rows),
                "items": [_row_to_dict(r) for r in rows],
            }
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[STRATEGY] list_versions error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/versions")
async def create_version(req: CreateVersionRequest):
    """POST /api/strategy/versions — 创建新策略版本(draft 默认)。

    body: {version, parameters, docRef, createdReason, confirmedBy, status}
    """
    # 版本号唯一性校验
    try:
        conn = _conn()
        try:
            existing = conn.execute(
                "SELECT id FROM strategy_version WHERE version = ?",
                (req.version,),
            ).fetchone()
            if existing:
                raise HTTPException(
                    status_code=409,
                    detail=f"策略版本号 {req.version} 已存在(id={existing['id']})",
                )

            # 若 status=active, 则需校验 target_ratios 和=100% 并 retire 其他 active
            params = req.parameters or {}
            target_ratios = params.get("target_ratios") or {}
            if req.status == "active":
                total = sum(float(v) for v in target_ratios.values())
                if abs(total - 1.0) > 0.0001:
                    raise HTTPException(
                        status_code=400,
                        detail=f"激活策略版本要求 target_ratios 之和=100%, 当前={total*100:.2f}%",
                    )

            new_id = f"sv-{uuid.uuid4().hex[:12]}"
            now = datetime.now().isoformat()
            conn.execute(
                """INSERT INTO strategy_version
                   (id, version, status, parameters, doc_ref, effective_at,
                    created_reason, confirmed_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    new_id,
                    req.version,
                    req.status,
                    json.dumps(params, ensure_ascii=False),
                    req.docRef,
                    now if req.status == "active" else None,
                    req.createdReason or "",
                    req.confirmedBy,
                    now,
                ),
            )

            # 若 status=active, retire 其他 active
            if req.status == "active":
                conn.execute(
                    """UPDATE strategy_version
                       SET status = 'retired'
                       WHERE status = 'active' AND id != ?""",
                    (new_id,),
                )

            conn.commit()
            row = conn.execute(
                "SELECT * FROM strategy_version WHERE id = ?", (new_id,)
            ).fetchone()
            logger.info(
                f"[STRATEGY] Created strategy version id={new_id} version={req.version} status={req.status}"
            )
            return {
                "success": True,
                "id": new_id,
                "version": _row_to_dict(row),
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[STRATEGY] create_version error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/versions/{version_id}/activate")
async def activate_version(version_id: str):
    """POST /api/strategy/versions/{id}/activate — 激活策略版本。

    要求:
    1. 版本必须存在且非 retired
    2. parameters.target_ratios 之和必须 = 100% (允许 0.0001 误差)
    3. 激活后, 其他 active 版本自动转为 retired
    """
    try:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT * FROM strategy_version WHERE id = ?", (version_id,)
            ).fetchone()
            if not row:
                raise HTTPException(
                    status_code=404,
                    detail=f"策略版本不存在: id={version_id}",
                )
            if row["status"] == "retired":
                raise HTTPException(
                    status_code=400,
                    detail=f"已退役的策略版本不能再次激活: id={version_id}",
                )

            # 校验 target_ratios 和=100%
            params_raw = row["parameters"] or "{}"
            try:
                params = json.loads(params_raw) if isinstance(params_raw, str) else params_raw
            except (TypeError, ValueError):
                params = {}
            target_ratios = params.get("target_ratios") or {}
            total = sum(float(v) for v in target_ratios.values())
            if abs(total - 1.0) > 0.0001:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"激活策略版本要求 target_ratios 之和=100%, "
                        f"当前={total*100:.2f}%, version={row['version']}"
                    ),
                )

            now = datetime.now().isoformat()
            # retire 其他 active
            conn.execute(
                """UPDATE strategy_version
                   SET status = 'retired'
                   WHERE status = 'active' AND id != ?""",
                (version_id,),
            )
            # 激活当前
            conn.execute(
                """UPDATE strategy_version
                   SET status = 'active', effective_at = ?
                   WHERE id = ?""",
                (now, version_id),
            )
            conn.commit()

            updated = conn.execute(
                "SELECT * FROM strategy_version WHERE id = ?", (version_id,)
            ).fetchone()
            logger.info(
                f"[STRATEGY] Activated strategy version id={version_id} version={row['version']}"
            )
            return {
                "success": True,
                "id": version_id,
                "version": _row_to_dict(updated),
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[STRATEGY] activate_version error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/versions/active")
async def get_active_version():
    """GET /api/strategy/versions/active — 获取当前 active 策略版本。

    若有多个 active(异常情况), 返回 created_at 最新的那个;
    若没有 active, 返回 404 + 空提示。
    """
    try:
        conn = _conn()
        try:
            row = conn.execute(
                """SELECT * FROM strategy_version
                   WHERE status = 'active'
                   ORDER BY created_at DESC LIMIT 1"""
            ).fetchone()
            if not row:
                raise HTTPException(
                    status_code=404,
                    detail="当前没有 active 策略版本, 请先激活一个版本",
                )
            return _row_to_dict(row)
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[STRATEGY] get_active_version error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/snapshot")
async def freeze_snapshot(req: FreezeSnapshotRequest):
    """POST /api/strategy/snapshot — 冻结计算输入快照。

    body: {calculationId, strategyVersionId, holdings, cashBalances, marketData}
    计算各输入的 sha256 hash 并保存到 calculation_snapshot 表。
    用于"相同输入一定产生相同 hash"的确定性复算验证。
    """
    try:
        conn = _conn()
        try:
            # 校验策略版本存在
            sv = conn.execute(
                "SELECT id, version, status FROM strategy_version WHERE id = ?",
                (req.strategyVersionId,),
            ).fetchone()
            if not sv:
                raise HTTPException(
                    status_code=404,
                    detail=f"strategy_version_id 不存在: {req.strategyVersionId}",
                )

            # 计算各输入 hash
            holdings_hash = _hash_inputs(req.holdings)
            cash_hash = _hash_inputs(req.cashBalances)
            market_hash = _hash_inputs(req.marketData)

            snapshot_id = f"snap-{uuid.uuid4().hex[:12]}"
            now = datetime.now().isoformat()

            # 幂等: 若同 calculation_id 已有快照, 更新; 否则插入
            existing = conn.execute(
                "SELECT id FROM calculation_snapshot WHERE calculation_id = ?",
                (req.calculationId,),
            ).fetchone()
            if existing:
                conn.execute(
                    """UPDATE calculation_snapshot
                       SET strategy_version_id = ?, holdings_hash = ?,
                           cash_hash = ?, market_hash = ?, frozen_at = ?
                       WHERE calculation_id = ?""",
                    (req.strategyVersionId, holdings_hash, cash_hash,
                     market_hash, now, req.calculationId),
                )
                snapshot_id = existing["id"]
                action = "updated"
            else:
                conn.execute(
                    """INSERT INTO calculation_snapshot
                       (id, calculation_id, strategy_version_id,
                        holdings_hash, cash_hash, market_hash, frozen_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (snapshot_id, req.calculationId, req.strategyVersionId,
                     holdings_hash, cash_hash, market_hash, now),
                )
                action = "created"

            conn.commit()
            logger.info(
                f"[STRATEGY] Snapshot {action} id={snapshot_id} calc={req.calculationId} "
                f"sv={req.strategyVersionId} h={holdings_hash} c={cash_hash} m={market_hash}"
            )
            return {
                "success": True,
                "action": action,
                "snapshotId": snapshot_id,
                "calculationId": req.calculationId,
                "strategyVersionId": req.strategyVersionId,
                "strategyVersion": sv["version"],
                "holdingsHash": holdings_hash,
                "cashHash": cash_hash,
                "marketHash": market_hash,
                "frozenAt": now,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[STRATEGY] freeze_snapshot error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
