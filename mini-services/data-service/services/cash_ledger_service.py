"""V5.0 E3: 现金账本服务 — 成对借贷 + 守恒校验。

PRD要求:
- 每个账户保存期初、流入、流出和期末
- 账户转换生成成对借贷流水(一笔转账=两条记录: 借方+贷方)
- 流水不可直接覆盖, 只能冲正
- 总量和逐账户守恒均通过后才能发布

设计要点:
1. ``transfer`` 生成同一 ``transfer_id`` 关联的两条流水:
   - 借方(debit, amount<0): ``from_account`` 余额减少
   - 贷方(credit, amount>0): ``to_account`` 余额增加
2. ``deposit`` / ``withdraw`` 处理外部资金注入/退出(单边流水, 不是转账):
   - 注入示例: 每周注资到达、分红到账、手动 top-up
   - 退出示例: 用户提现、扣费
   单边流水共享同一 ``transfer_id`` 但只有一条 entry(deposit=credit, withdraw=debit),
   不违反守恒(系统总余额随之增减)。
3. ``reverse_transfer`` 生成反向成对流水并将原流水标记为 ``reversed``,
   不删除原流水, 满足"流水不可直接覆盖, 只能冲正"的审计要求。
4. ``check_conservation`` 同时校验:
   - 总量守恒: sum(active amount) == sum(subaccount.balance)
   - 逐账户守恒: 每个账户 balance == sum(active amount for that account)
"""
from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Optional

from config import DB_PATH

logger = logging.getLogger(__name__)

# V5.0 E3: 现金子账户类型(7种, 第7种 weekly_contribution_committed 为V5.0新增)
ACCOUNT_TYPES = [
    "daily_cash",                       # 日常现金, 不打算投权益
    "weekly_unallocated_cash",          # 本周未分配但仍计划未来投向权益
    "rebalance_equity_reserve",         # 再平衡卖出后暂存, 等待重新配置
    "qdii_pending_cash_sp500",          # 标普500 QDII溢价暂缓买入的钱
    "qdii_pending_cash_nasdaq",         # 纳斯达克 QDII溢价暂缓买入的钱
    "manual_cash",                      # 用户手动指定不参与本系统
    "weekly_contribution_committed",    # V5.0新增: 本周承诺注资(待分配)
]

# 金额比较浮点容差(元)
_CONSERVATION_TOLERANCE = 0.01


def _now() -> str:
    return datetime.now().isoformat()


def transfer(
    conn: sqlite3.Connection,
    from_account: str,
    to_account: str,
    amount: float,
    source_event: str,
    source_etf: str = "",
    reference_id: str = "",
) -> str:
    """V5.0 E3: 成对借贷转账。

    生成两条 cash_ledger 记录:
    - 借方(debit): from_account 余额减少 (amount 记为负数)
    - 贷方(credit): to_account 余额增加 (amount 记为正数)

    同时更新 cash_subaccount 余额。两条流水共享同一 ``transfer_id`` 以便审计关联。
    返回 transfer_id。
    """
    if amount <= 0:
        raise ValueError(f"transfer amount must be > 0, got {amount}")
    if from_account == to_account:
        raise ValueError("from_account and to_account must differ")

    transfer_id = f"tf-{uuid.uuid4().hex[:12]}"
    now = _now()

    # 借方流水(from_account 余额减少, 金额记负)
    conn.execute(
        """INSERT INTO cash_ledger
           (cash_ledger_id, cash_account_type, source_event, source_etf, amount,
            created_at, released_at, status, transfer_id, entry_type, reference_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, 'debit', ?)""",
        (f"{transfer_id}-dr", from_account, source_event, source_etf, -amount,
         now, transfer_id, reference_id),
    )

    # 贷方流水(to_account 余额增加, 金额记正)
    conn.execute(
        """INSERT INTO cash_ledger
           (cash_ledger_id, cash_account_type, source_event, source_etf, amount,
            created_at, released_at, status, transfer_id, entry_type, reference_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, 'credit', ?)""",
        (f"{transfer_id}-cr", to_account, source_event, source_etf, amount,
         now, transfer_id, reference_id),
    )

    # 更新子账户余额
    conn.execute(
        "UPDATE cash_subaccount SET balance = balance - ?, updated_at = ? WHERE account_type = ?",
        (amount, now, from_account),
    )
    conn.execute(
        "UPDATE cash_subaccount SET balance = balance + ?, updated_at = ? WHERE account_type = ?",
        (amount, now, to_account),
    )

    logger.info(
        f"[LEDGER] transfer {transfer_id}: {from_account} -> {to_account} "
        f"¥{amount:.2f} ({source_event}{(' ' + source_etf) if source_etf else ''})"
    )
    return transfer_id


def deposit(
    conn: sqlite3.Connection,
    to_account: str,
    amount: float,
    source_event: str,
    source_etf: str = "",
    reference_id: str = "",
) -> str:
    """V5.0 E3: 外部资金注入(单边贷方流水)。

    用于: 每周注资到达、分红到账、用户手动 top-up 等外部资金流入。
    生成单条 active 流水(entry_type='credit', amount>0), transfer_id=`dp-xxx`。
    """
    if amount <= 0:
        raise ValueError(f"deposit amount must be > 0, got {amount}")

    transfer_id = f"dp-{uuid.uuid4().hex[:12]}"
    now = _now()

    conn.execute(
        """INSERT INTO cash_ledger
           (cash_ledger_id, cash_account_type, source_event, source_etf, amount,
            created_at, released_at, status, transfer_id, entry_type, reference_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, 'credit', ?)""",
        (f"{transfer_id}-cr", to_account, source_event, source_etf, amount,
         now, transfer_id, reference_id),
    )
    conn.execute(
        "UPDATE cash_subaccount SET balance = balance + ?, updated_at = ? WHERE account_type = ?",
        (amount, now, to_account),
    )

    logger.info(
        f"[LEDGER] deposit {transfer_id}: -> {to_account} ¥{amount:.2f} ({source_event})"
    )
    return transfer_id


def withdraw(
    conn: sqlite3.Connection,
    from_account: str,
    amount: float,
    source_event: str,
    source_etf: str = "",
    reference_id: str = "",
) -> str:
    """V5.0 E3: 外部资金退出(单边借方流水)。

    用于: 用户提现、扣费等外部资金流出。
    生成单条 active 流水(entry_type='debit', amount<0), transfer_id=`wd-xxx`。
    """
    if amount <= 0:
        raise ValueError(f"withdraw amount must be > 0, got {amount}")

    transfer_id = f"wd-{uuid.uuid4().hex[:12]}"
    now = _now()

    conn.execute(
        """INSERT INTO cash_ledger
           (cash_ledger_id, cash_account_type, source_event, source_etf, amount,
            created_at, released_at, status, transfer_id, entry_type, reference_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, 'debit', ?)""",
        (f"{transfer_id}-dr", from_account, source_event, source_etf, -amount,
         now, transfer_id, reference_id),
    )
    conn.execute(
        "UPDATE cash_subaccount SET balance = balance - ?, updated_at = ? WHERE account_type = ?",
        (amount, now, from_account),
    )

    logger.info(
        f"[LEDGER] withdraw {transfer_id}: {from_account} -> ¥{amount:.2f} ({source_event})"
    )
    return transfer_id


def reverse_transfer(conn: sqlite3.Connection, transfer_id: str, reason: str = "") -> bool:
    """冲正一笔转账(生成反向成对流水, 不删除原流水)。

    反向流水与原流水方向相反:
    - 原 debit(from_account, amount=-X) → 反向为 credit(from_account, amount=+X)
    - 原 credit(to_account,   amount=+X) → 反向为 debit(to_account,   amount=-X)
    同时将原流水 status 标记为 ``reversed``。
    """
    rows = conn.execute(
        "SELECT cash_account_type, amount, entry_type, source_etf "
        "FROM cash_ledger WHERE transfer_id = ? AND status = 'active'",
        (transfer_id,),
    ).fetchall()
    if not rows:
        logger.warning(f"[LEDGER] reverse_transfer: no active rows for transfer_id={transfer_id}")
        return False

    now = _now()
    reverse_id = f"rv-{uuid.uuid4().hex[:12]}"
    reverse_event = f"reverse:{reason}" if reason else "reverse"

    for acct_type, amount, entry_type, source_etf in rows:
        # 反向流水: amount 取反, entry_type 取反
        reverse_amount = -amount
        reverse_entry = "credit" if entry_type == "debit" else "debit"
        conn.execute(
            """INSERT INTO cash_ledger
               (cash_ledger_id, cash_account_type, source_event, source_etf, amount,
                created_at, released_at, status, transfer_id, entry_type, reference_id)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 'reversed', ?, ?, ?)""",
            (f"{reverse_id}-{reverse_entry[0:2]}", acct_type, reverse_event,
             source_etf or "", reverse_amount, now, reverse_id, reverse_entry, transfer_id),
        )
        # 反向更新余额: 直接加上反向流水金额即可
        # (反向流水金额正负号已经反映了对该账户余额的影响方向)
        conn.execute(
            "UPDATE cash_subaccount SET balance = balance + ?, updated_at = ? WHERE account_type = ?",
            (reverse_amount, now, acct_type),
        )

    # 标记原流水为 reversed
    conn.execute(
        "UPDATE cash_ledger SET status = 'reversed' WHERE transfer_id = ? AND status = 'active'",
        (transfer_id,),
    )

    logger.info(f"[LEDGER] reversed {transfer_id} (reverse_id={reverse_id}): {reason}")
    return True


def check_conservation(conn: sqlite3.Connection) -> dict:
    """V5.0 E3: 资金守恒校验。

    校验规则(基于 active 流水):
    1. 逐账户守恒: 每个账户的当前余额 == 该账户所有 active 流水金额之和
       (期初=0, 因为初始化时 balance=0; 任何余额变化都应来自成对借贷流水)
    2. 总量守恒: 所有子账户余额之和 == 所有 active 流水金额之和
       (因为每笔转账借+贷=0, 总和应恒等于注入系统的净额)

    返回结构:
        {
          "total_check": bool,
          "per_account_check": bool,
          "total_balance": float,
          "total_ledger_sum": float,
          "account_checks": [
            {"account": str, "opening": 0, "inflow": float, "outflow": float,
             "expected_closing": float, "actual_closing": float, "pass": bool}
          ]
        }
    """
    result: dict = {
        "total_check": True,
        "per_account_check": True,
        "total_balance": 0.0,
        "total_ledger_sum": 0.0,
        "account_checks": [],
    }

    accounts = conn.execute(
        "SELECT account_type, balance FROM cash_subaccount ORDER BY account_type"
    ).fetchall()

    total_balance = 0.0
    total_ledger_sum = 0.0

    for acct_type, balance in accounts:
        flows = conn.execute(
            "SELECT amount FROM cash_ledger WHERE cash_account_type = ? AND status = 'active'",
            (acct_type,),
        ).fetchall()
        amounts = [f[0] for f in flows]
        inflow = sum(a for a in amounts if a > 0)
        outflow = sum(abs(a) for a in amounts if a < 0)
        ledger_sum = sum(amounts)  # 该账户的 active 流水净额
        # 期初=0, 期末期望 = 0 + inflow - outflow = ledger_sum
        expected_closing = ledger_sum
        actual_closing = balance
        acct_pass = abs(expected_closing - actual_closing) < _CONSERVATION_TOLERANCE

        result["account_checks"].append({
            "account": acct_type,
            "opening": 0,
            "inflow": round(inflow, 2),
            "outflow": round(outflow, 2),
            "expected_closing": round(expected_closing, 2),
            "actual_closing": round(actual_closing, 2),
            "flow_count": len(amounts),
            "pass": acct_pass,
        })

        if not acct_pass:
            result["per_account_check"] = False
            result["total_check"] = False

        total_balance += balance
        total_ledger_sum += ledger_sum

    result["total_balance"] = round(total_balance, 2)
    result["total_ledger_sum"] = round(total_ledger_sum, 2)
    # 总量守恒: 所有账户余额之和 == 所有 active 流水净额之和
    total_diff = abs(total_balance - total_ledger_sum)
    if total_diff >= _CONSERVATION_TOLERANCE:
        result["total_check"] = False

    result["total_diff"] = round(total_diff, 2)
    return result


def get_account_summary(conn: sqlite3.Connection) -> list[dict]:
    """获取所有子账户余额 + 流水数 + 是否计入权益基准。"""
    accounts = conn.execute(
        "SELECT account_type, balance, counts_as_equity_base, description "
        "FROM cash_subaccount ORDER BY account_type"
    ).fetchall()
    result: list[dict] = []
    for acct_type, balance, counts, desc in accounts:
        flow_count = conn.execute(
            "SELECT COUNT(*) FROM cash_ledger WHERE cash_account_type = ? AND status = 'active'",
            (acct_type,),
        ).fetchone()[0]
        result.append({
            "account_type": acct_type,
            "balance": round(balance, 2),
            "counts_as_equity_base": bool(counts),
            "description": desc or "",
            "flow_count": flow_count,
        })
    return result


def get_ledger_entries(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    """获取最近 N 条流水(按 created_at DESC, 不区分 active/reversed)。"""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT cash_ledger_id, cash_account_type, source_event, source_etf,
                  amount, created_at, released_at, status,
                  transfer_id, entry_type, reference_id
           FROM cash_ledger
           ORDER BY created_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_transfers(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    """获取最近 N 笔转账(按 transfer_id 聚合, 含 debit+credit 配对)。

    返回每条转账包含 from_account / to_account / amount:
    - 成对借贷(tf-xxx): amount = credit 金额(>0) = |debit 金额|
    - 单边注入(dp-xxx): from_account=None, amount = credit 金额
    - 单边退出(wd-xxx): to_account=None,   amount = |debit 金额|
    """
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT transfer_id, source_event, source_etf,
                  MIN(created_at) AS created_at,
                  SUM(amount)     AS net_amount,
                  COUNT(*)        AS entry_count,
                  MIN(status)     AS status
           FROM cash_ledger
           WHERE transfer_id IS NOT NULL AND transfer_id != ''
           GROUP BY transfer_id
           ORDER BY created_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    transfers: list[dict] = []
    for r in rows:
        d = dict(r)
        # 拿到该 transfer 的借贷双方
        entries = conn.execute(
            """SELECT cash_account_type, amount, entry_type
               FROM cash_ledger WHERE transfer_id = ?
               ORDER BY entry_type""",
            (d["transfer_id"],),
        ).fetchall()
        debit_acct = None
        credit_acct = None
        credit_amount = 0.0
        debit_amount = 0.0
        for e in entries:
            if e["entry_type"] == "debit":
                debit_acct = e["cash_account_type"]
                debit_amount = abs(float(e["amount"]))
            elif e["entry_type"] == "credit":
                credit_acct = e["cash_account_type"]
                credit_amount = float(e["amount"])
        d["from_account"] = debit_acct
        d["to_account"] = credit_acct
        # 成对转账取 credit 金额; 单边注入/退出取其唯一金额
        d["amount"] = round(credit_amount or debit_amount, 2)
        transfers.append(d)
    return transfers
