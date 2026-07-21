"""V5.0 E6: 技术执行API."""
from fastapi import APIRouter, Query
from services.technical_service import get_technical_for_etf, classify_technical

router = APIRouter(prefix="/api/technical", tags=["technical"])


@router.get("/classify")
async def classify_etf(code: str = Query(..., description="ETF代码")):
    """GET /api/technical/classify?code=159338 — 获取ETF的技术分类."""
    return get_technical_for_etf(code)


@router.get("/classify/all")
async def classify_all():
    """GET /api/technical/classify/all — 获取6只ETF的技术分类."""
    from config import TRACKED_ETFS
    results = {}
    for code in TRACKED_ETFS:
        results[code] = get_technical_for_etf(code)
    return {"items": results}
