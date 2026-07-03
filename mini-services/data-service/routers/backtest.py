"""V5.0 Backtest Router — 回测验证 API.

返回格式与前端 `src/lib/api.ts` 的 BacktestResult / BacktestHistoryItem 对齐:
  - POST /api/backtest/run    → BacktestResult (flat)
  - GET  /api/backtest/history → {history: BacktestHistoryItem[]}
"""
import json
import logging
import sqlite3
from datetime import datetime
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from config import DB_PATH
from services.backtest_service import run_backtest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


# ─── 请求/响应模型 ────────────────────────────────────────────────────────────

class BacktestRequest(BaseModel):
    start_date: str = Field(..., alias="startDate", description="起始日期 YYYY-MM-DD")
    initial_capital: float = Field(100000, alias="initialCapital", description="初始资金")
    weekly_budget: float = Field(40000, alias="weeklyBudget", description="每周定投金额")

    model_config = {"populate_by_name": True}


# ─── helpers ──────────────────────────────────────────────────────────────────

def _strategy_to_frontend(r: dict, include_sharpe: bool = False) -> dict:
    """把 service 层的策略结果转换为前端期望的 BacktestStrategyStats / FullStats.

    前端字段: equityCurve, annualReturn, maxDrawdown, totalReturn, sharpe(可选)
    """
    if not isinstance(r, dict) or "error" in r:
        return {
            "equityCurve": [],
            "annualReturn": 0.0,
            "maxDrawdown": 0.0,
            "totalReturn": 0.0,
            **({"sharpe": 0.0} if include_sharpe else {}),
        }
    out = {
        "equityCurve": r.get("equityCurve", []),
        "annualReturn": r.get("annualizedReturnPct", 0.0),
        "maxDrawdown": r.get("maxDrawdownPct", 0.0),
        "totalReturn": r.get("totalReturnPct", 0.0),
    }
    if include_sharpe:
        out["sharpe"] = r.get("sharpeRatio", 0.0)
    return out


def _save_backtest_log(request: BacktestRequest, result: dict) -> None:
    """把回测结果摘要保存到 backtest_log 表."""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS backtest_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_date TEXT,
                end_date TEXT,
                weeks INTEGER,
                initial_capital REAL,
                weekly_budget REAL,
                strategy_return REAL,
                dca_return REAL,
                buyhold_return REAL,
                strategy_sharpe REAL,
                result_json TEXT,
                created_at TEXT
            )
            """
        )
        meta = result.get("meta", {})
        sr = result.get("strategy_result", {}) or {}
        dr = result.get("dca_result", {}) or {}
        br = result.get("buyhold_result", {}) or {}
        slim = {
            "meta": meta,
            "comparison": result.get("comparison"),
            "strategy_summary": {k: sr.get(k) for k in ("finalValue", "totalInvested", "totalReturnPct", "annualizedReturnPct", "maxDrawdownPct", "sharpeRatio", "weeks") if isinstance(sr, dict)},
            "dca_summary": {k: dr.get(k) for k in ("finalValue", "totalInvested", "totalReturnPct", "annualizedReturnPct", "maxDrawdownPct", "sharpeRatio", "weeks") if isinstance(dr, dict)},
            "buyhold_summary": {k: br.get(k) for k in ("finalValue", "totalInvested", "totalReturnPct", "annualizedReturnPct", "maxDrawdownPct", "sharpeRatio", "weeks") if isinstance(br, dict)},
        }
        conn.execute(
            """
            INSERT INTO backtest_log
                (start_date, end_date, weeks, initial_capital, weekly_budget,
                 strategy_return, dca_return, buyhold_return, strategy_sharpe,
                 result_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                meta.get("startDate"),
                meta.get("endDate"),
                meta.get("weeks"),
                meta.get("initialCapital"),
                meta.get("weeklyBudget"),
                sr.get("totalReturnPct") if isinstance(sr, dict) else None,
                dr.get("totalReturnPct") if isinstance(dr, dict) else None,
                br.get("totalReturnPct") if isinstance(br, dict) else None,
                sr.get("sharpeRatio") if isinstance(sr, dict) else None,
                json.dumps(slim, ensure_ascii=False),
                datetime.now().isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()


# ─── 端点 ────────────────────────────────────────────────────────────────────

@router.post("/run")
async def run_backtest_api(request: BacktestRequest):
    """POST /api/backtest/run
    执行历史回测, 对比3种策略 (本系统策略 / 等额定投 / 买入持有).

    返回前端期望的 BacktestResult 结构:
      {
        strategy: {equityCurve, annualReturn, maxDrawdown, totalReturn, sharpe},
        dca:      {equityCurve, annualReturn, maxDrawdown, totalReturn},
        buyhold:  {equityCurve, annualReturn, maxDrawdown, totalReturn},
        weeklyRecords, startDate, endDate,
        // 额外字段 (前端忽略, 供调试/扩展使用):
        comparison, meta
      }
    """
    try:
        result = await run_backtest(
            start_date=request.start_date,
            initial_capital=request.initial_capital,
            weekly_budget=request.weekly_budget,
        )
        # 错误: 数据不足等情况
        if isinstance(result, dict) and "error" in result:
            return {"error": result["error"]}

        # 持久化 (best-effort)
        try:
            _save_backtest_log(request, result)
        except Exception as e:
            logger.warning(f"[BACKTEST] save log failed (non-blocking): {e}")

        meta = result.get("meta", {}) or {}
        # 转换为前端期望的 flat 结构
        return {
            "strategy": _strategy_to_frontend(result.get("strategy_result", {}), include_sharpe=True),
            "dca": _strategy_to_frontend(result.get("dca_result", {}), include_sharpe=False),
            "buyhold": _strategy_to_frontend(result.get("buyhold_result", {}), include_sharpe=False),
            "weeklyRecords": meta.get("weeks", 0),
            "startDate": meta.get("startDate", ""),
            "endDate": meta.get("endDate", ""),
            # 额外字段 (前端会忽略, 供调试使用)
            "comparison": result.get("comparison"),
            "meta": meta,
        }
    except Exception as e:
        logger.exception("[BACKTEST] run failed")
        return {"error": str(e)}


@router.get("/history")
async def get_backtest_history(limit: int = 20):
    """GET /api/backtest/history — 历史回测列表.

    返回前端期望的 {history: BacktestHistoryItem[]} 结构:
      [{
        calculationId, startDate, endDate, initialCapital, weeklyBudget, weeklyRecords,
        strategyAnnualReturn, strategyMaxDrawdown, dcaAnnualReturn, buyholdAnnualReturn,
        createdAt
      }]
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS backtest_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    start_date TEXT,
                    end_date TEXT,
                    weeks INTEGER,
                    initial_capital REAL,
                    weekly_budget REAL,
                    strategy_return REAL,
                    dca_return REAL,
                    buyhold_return REAL,
                    strategy_sharpe REAL,
                    result_json TEXT,
                    created_at TEXT
                )
                """
            )
            rows = conn.execute(
                "SELECT id, start_date, end_date, weeks, initial_capital, weekly_budget, "
                "strategy_return, dca_return, buyhold_return, strategy_sharpe, created_at, result_json "
                "FROM backtest_log ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()

            history = []
            for r in rows:
                # 从 result_json 提取 maxDrawdown (如果没有则置0)
                strategy_max_dd = 0.0
                try:
                    if r["result_json"]:
                        slim = json.loads(r["result_json"])
                        ss = slim.get("strategy_summary", {}) or {}
                        strategy_max_dd = ss.get("maxDrawdownPct", 0.0) or 0.0
                except (json.JSONDecodeError, TypeError):
                    pass

                history.append({
                    "calculationId": f"bt-{r['id']}",
                    "startDate": r["start_date"] or "",
                    "endDate": r["end_date"] or "",
                    "initialCapital": r["initial_capital"] or 0,
                    "weeklyBudget": r["weekly_budget"] or 0,
                    "weeklyRecords": r["weeks"] or 0,
                    "strategyAnnualReturn": r["strategy_return"] if r["strategy_return"] is not None else 0.0,
                    "strategyMaxDrawdown": strategy_max_dd,
                    "dcaAnnualReturn": r["dca_return"] if r["dca_return"] is not None else 0.0,
                    "buyholdAnnualReturn": r["buyhold_return"] if r["buyhold_return"] is not None else 0.0,
                    "createdAt": r["created_at"] or "",
                })

            return {"history": history}
        finally:
            conn.close()
    except Exception as e:
        logger.exception("[BACKTEST] history failed")
        return {"history": []}
