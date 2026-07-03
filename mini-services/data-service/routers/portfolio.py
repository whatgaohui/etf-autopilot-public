"""V5.0 Portfolio Router — 投资收益追踪 API.

返回格式与前端 `src/lib/api.ts` 的 PortfolioPerformance / PortfolioPerformancePoint 对齐:
  - GET /api/portfolio/performance         → PortfolioPerformance (flat, 含 history)
  - GET /api/portfolio/performance/history → {history: PortfolioPerformancePoint[]}
"""
import logging

from fastapi import APIRouter

from services.portfolio_service import (
    get_portfolio_performance,
    get_portfolio_performance_history,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


@router.get("/performance")
async def get_performance():
    """GET /api/portfolio/performance — 投资收益汇总 (含 history 曲线).

    返回前端期望的 PortfolioPerformance 结构:
      {totalInvested, totalValue, totalReturn, totalReturnPct, annualReturn, vsBenchmark, history}
    """
    try:
        data = get_portfolio_performance()
        return data
    except Exception as e:
        logger.exception("[PORTFOLIO] performance failed")
        # 错误时返回结构化空数据 (前端会优雅降级)
        return {
            "totalInvested": 0,
            "totalValue": 0,
            "totalReturn": 0,
            "totalReturnPct": 0,
            "annualReturn": 0,
            "vsBenchmark": 0,
            "history": [],
            "error": str(e),
        }


@router.get("/performance/history")
async def get_performance_history():
    """GET /api/portfolio/performance/history — 收益历史序列 (用于绘制曲线).

    返回前端期望的 {history: PortfolioPerformancePoint[]} 结构.
    """
    try:
        data = get_portfolio_performance_history()
        return data
    except Exception as e:
        logger.exception("[PORTFOLIO] performance history failed")
        return {"history": [], "error": str(e)}
