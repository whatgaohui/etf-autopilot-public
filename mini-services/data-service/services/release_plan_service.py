"""V5.0 E5: QDII 挂起释放状态机。

状态机:
    idle ──(溢价首次恢复正常)──> releasing
    releasing ──(溢价再次升高)──> paused
    paused ──(溢价恢复)──> releasing
    releasing ──(余额归零)──> completed

约束:
- ``idle``: 挂起池有余额但未开始释放(溢价仍高)
- ``releasing``: 正在按计划释放(溢价恢复正常)
- ``paused``: 暂停释放(溢价再次升高)
- ``completed``: 余额归零, 释放完成

PRD V5.0 E5: 状态机 + 单周释放上限公式:
    planned = balance / max(1, weeks_remaining)
    actual  = min(planned,
                  balance,
                  strategy_weekly_budget * target_ratio * 2.0,
                  max(0, EAB * (target_ratio + 0.05) - current_etf_value))
"""
from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Optional

from config import DB_PATH, QDII_RELEASE_CAP_MULTIPLIER, QDII_RELEASE_PLAN_WEEKS

logger = logging.getLogger(__name__)

# 合法状态枚举
VALID_STATES = ("idle", "releasing", "paused", "completed")

# 合法状态迁移(允许的 from -> to 转换)
_ALLOWED_TRANSITIONS = {
    ("idle", "releasing"),
    ("releasing", "paused"),
    ("paused", "releasing"),
    ("releasing", "completed"),
    # 容错: 已 paused 的计划也可以直接完成(余额归零)
    ("paused", "completed"),
}

# 释放计划类型
PLAN_TYPES = ("qdii_sp500", "qdii_nasdaq", "rebalance_reserve")


def _now() -> str:
    return datetime.now().isoformat()


def _ensure_release_plan_table(conn: sqlite3.Connection) -> None:
    """幂等创建 release_plan 表(若 main.py 已经创建则跳过)。"""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS release_plan (
            id TEXT PRIMARY KEY,
            plan_type TEXT NOT NULL,
            account_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'idle',
            weeks_total INTEGER DEFAULT 8,
            weeks_remaining INTEGER DEFAULT 8,
            balance REAL NOT NULL DEFAULT 0,
            weekly_amount REAL DEFAULT 0,
            target_etf TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            paused_reason TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_release_plan_state "
        "ON release_plan(state, plan_type)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_release_plan_account "
        "ON release_plan(account_id)"
    )


def create_release_plan(
    conn: sqlite3.Connection,
    plan_type: str,
    account_id: str,
    balance: float,
    target_etf: str = "",
    weeks: int = QDII_RELEASE_PLAN_WEEKS,
) -> str:
    """创建释放计划(溢价首次恢复正常时)。

    - 初始状态 ``idle`` (调用方随后调用 ``start_release`` 进入 releasing)
    - weeks 取值范围 [4, 12], 默认 8
    - weekly_amount = balance / max(1, weeks)
    """
    if plan_type not in PLAN_TYPES:
        raise ValueError(f"plan_type must be one of {PLAN_TYPES}, got {plan_type}")
    if balance < 0:
        raise ValueError(f"balance must be >= 0, got {balance}")
    weeks = max(4, min(12, int(weeks)))

    plan_id = f"rp-{uuid.uuid4().hex[:12]}"
    now = _now()
    weekly_amount = balance / max(1, weeks) if balance > 0 else 0.0

    conn.execute(
        """INSERT INTO release_plan
           (id, plan_type, account_id, state, weeks_total, weeks_remaining,
            balance, weekly_amount, target_etf, created_at, updated_at, paused_reason)
           VALUES (?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, NULL)""",
        (plan_id, plan_type, account_id, weeks, weeks,
         float(balance), round(weekly_amount, 2), target_etf, now, now),
    )

    logger.info(
        f"[RELEASE-PLAN] created id={plan_id} type={plan_type} acct={account_id} "
        f"balance=¥{balance:.2f} weeks={weeks} target={target_etf or '-'}"
    )
    return plan_id


def _transition_state(
    conn: sqlite3.Connection,
    plan_id: str,
    target_state: str,
    paused_reason: Optional[str] = None,
) -> dict:
    """通用状态迁移(校验合法转换)。"""
    row = conn.execute(
        "SELECT id, state, paused_reason FROM release_plan WHERE id = ?",
        (plan_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"release plan not found: {plan_id}")
    current_state = row[1]
    if current_state == target_state:
        # 同状态变更视为 no-op
        return {"id": plan_id, "state": current_state, "changed": False}
    if (current_state, target_state) not in _ALLOWED_TRANSITIONS:
        raise ValueError(
            f"illegal state transition: {current_state} -> {target_state} "
            f"(plan_id={plan_id})"
        )

    now = _now()
    if target_state == "paused":
        conn.execute(
            "UPDATE release_plan SET state = ?, paused_reason = ?, updated_at = ? WHERE id = ?",
            (target_state, paused_reason or "", now, plan_id),
        )
    elif target_state == "releasing":
        # 恢复时清空 paused_reason
        conn.execute(
            "UPDATE release_plan SET state = ?, paused_reason = NULL, updated_at = ? WHERE id = ?",
            (target_state, now, plan_id),
        )
    else:
        conn.execute(
            "UPDATE release_plan SET state = ?, updated_at = ? WHERE id = ?",
            (target_state, now, plan_id),
        )

    logger.info(
        f"[RELEASE-PLAN] {plan_id} state: {current_state} -> {target_state}"
        + (f" (reason={paused_reason})" if paused_reason else "")
    )
    return {"id": plan_id, "state": target_state, "changed": True, "previous_state": current_state}


def start_release(conn: sqlite3.Connection, plan_id: str) -> dict:
    """idle -> releasing。"""
    return _transition_state(conn, plan_id, "releasing")


def pause_release(conn: sqlite3.Connection, plan_id: str, reason: str = "") -> dict:
    """releasing -> paused (溢价再次升高)。"""
    return _transition_state(conn, plan_id, "paused", paused_reason=reason)


def resume_release(conn: sqlite3.Connection, plan_id: str) -> dict:
    """paused -> releasing。"""
    return _transition_state(conn, plan_id, "releasing")


def complete_release(conn: sqlite3.Connection, plan_id: str) -> dict:
    """releasing -> completed (余额归零)。"""
    # 强制 balance=0 + weeks_remaining=0 + updated_at
    now = _now()
    row = conn.execute(
        "SELECT state, balance FROM release_plan WHERE id = ?", (plan_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"release plan not found: {plan_id}")
    current_state = row[0]
    if current_state == "completed":
        return {"id": plan_id, "state": "completed", "changed": False}
    # 允许 releasing 或 paused 完成
    if (current_state, "completed") not in _ALLOWED_TRANSITIONS:
        raise ValueError(
            f"illegal state transition: {current_state} -> completed (plan_id={plan_id})"
        )
    conn.execute(
        "UPDATE release_plan SET state = 'completed', balance = 0, "
        "weeks_remaining = 0, weekly_amount = 0, updated_at = ? WHERE id = ?",
        (now, plan_id),
    )
    logger.info(f"[RELEASE-PLAN] {plan_id} completed (balance cleared)")
    return {"id": plan_id, "state": "completed", "changed": True, "previous_state": current_state}


def apply_weekly_release(
    conn: sqlite3.Connection,
    plan_id: str,
    released_amount: float,
) -> dict:
    """记录本周实际释放(由 rule_engine 调用)。

    - 余额递减, weeks_remaining 递减
    - 若余额 <= 0.01 自动进入 completed 状态
    - 若 weeks_remaining == 0 但仍有余额, 把剩余 weeks_remaining 重置为 1
      (避免除零, 让下一周把尾款结清)
    """
    if released_amount < 0:
        raise ValueError("released_amount must be >= 0")
    row = conn.execute(
        "SELECT state, balance, weeks_remaining FROM release_plan WHERE id = ?",
        (plan_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"release plan not found: {plan_id}")
    state, balance, weeks_remaining = row[0], row[1], row[2]
    if state != "releasing":
        raise ValueError(f"plan {plan_id} is not in releasing state (current={state})")

    now = _now()
    new_balance = max(0.0, float(balance) - float(released_amount))
    new_weeks = max(0, int(weeks_remaining) - 1)
    if new_weeks == 0 and new_balance > 0.01:
        new_weeks = 1  # 留一周收尾
    new_weekly = new_balance / max(1, new_weeks) if new_balance > 0 else 0.0

    if new_balance <= 0.01:
        conn.execute(
            "UPDATE release_plan SET balance = 0, weeks_remaining = 0, "
            "weekly_amount = 0, state = 'completed', updated_at = ? WHERE id = ?",
            (now, plan_id),
        )
        new_state = "completed"
    else:
        conn.execute(
            "UPDATE release_plan SET balance = ?, weeks_remaining = ?, "
            "weekly_amount = ?, updated_at = ? WHERE id = ?",
            (round(new_balance, 2), new_weeks, round(new_weekly, 2), now, plan_id),
        )
        new_state = "releasing"

    logger.info(
        f"[RELEASE-PLAN] {plan_id} weekly release: -¥{released_amount:.2f}, "
        f"balance ¥{balance:.2f} -> ¥{new_balance:.2f}, weeks_remaining {weeks_remaining} -> {new_weeks}"
    )
    return {
        "id": plan_id,
        "released_amount": round(float(released_amount), 2),
        "balance": round(new_balance, 2),
        "weeks_remaining": new_weeks,
        "weekly_amount": round(new_weekly, 2),
        "state": new_state,
    }


def get_weekly_release(
    conn: sqlite3.Connection,
    plan_id: str,
    strategy_weekly_budget: float = 40000.0,
    target_ratio: float = 0.0,
    equity_asset_base: float = 0.0,
    current_etf_value: float = 0.0,
) -> dict:
    """计算本周释放金额。

    planned = balance / max(1, weeks_remaining)
    actual  = min(planned,
                  balance,
                  strategy_weekly_budget * target_ratio * QDII_RELEASE_CAP_MULTIPLIER,
                  max(0, EAB * (target_ratio + 0.05) - current_etf_value))

    返回 {plan_id, state, planned, actual, balance, weeks_remaining}
    若 plan 不存在或状态非 releasing, actual=0。
    """
    row = conn.execute(
        "SELECT state, balance, weeks_remaining, weekly_amount, target_etf "
        "FROM release_plan WHERE id = ?",
        (plan_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"release plan not found: {plan_id}")
    state, balance, weeks_remaining, weekly_amount, target_etf = (
        row[0], row[1], row[2], row[3], row[4]
    )
    if state != "releasing":
        return {
            "plan_id": plan_id,
            "state": state,
            "planned": 0.0,
            "actual": 0.0,
            "balance": round(float(balance), 2),
            "weeks_remaining": int(weeks_remaining),
            "target_etf": target_etf or "",
            "reason": f"state is {state}, not releasing",
        }

    balance_f = float(balance)
    weeks = max(1, int(weeks_remaining))
    planned = balance_f / weeks

    cap1 = balance_f
    cap2 = float(strategy_weekly_budget) * float(target_ratio) * QDII_RELEASE_CAP_MULTIPLIER
    gap = max(0.0, float(equity_asset_base) * (float(target_ratio) + 0.05) - float(current_etf_value))
    actual = min(planned, cap1, cap2, gap)
    if actual < 0:
        actual = 0.0

    return {
        "plan_id": plan_id,
        "state": state,
        "planned": round(planned, 2),
        "actual": round(actual, 2),
        "balance": round(balance_f, 2),
        "weeks_remaining": weeks,
        "weekly_amount": round(float(weekly_amount or 0), 2),
        "target_etf": target_etf or "",
        "caps": {
            "cap1_balance": round(cap1, 2),
            "cap2_strategy_budget": round(cap2, 2),
            "cap3_gap": round(gap, 2),
        },
    }


def get_plan(conn: sqlite3.Connection, plan_id: str) -> Optional[dict]:
    """获取单个释放计划。"""
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM release_plan WHERE id = ?", (plan_id,),
    ).fetchone()
    return dict(row) if row else None


def get_active_plans(conn: sqlite3.Connection) -> list[dict]:
    """获取所有非 completed 的释放计划(按 updated_at DESC)。"""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM release_plan WHERE state != 'completed' ORDER BY updated_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_all_plans(conn: sqlite3.Connection) -> list[dict]:
    """获取所有释放计划(含历史, 按 created_at DESC)。"""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM release_plan ORDER BY created_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]
