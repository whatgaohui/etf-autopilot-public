"""V4.2 PRD§11.13 宏观温度计 API 路由。

GET /api/macro/temperature — 4个执行层指标(当前值+周变化+月变化+状态)
GET /api/macro/prompts — 本周宏观提示文案(阈值触发)
GET /api/macro/history — 宏观指标历史序列(可选 ?metric_type=&days=90)
GET /api/macro/research — 低频研究层(占位,返回空列表+说明)
GET /api/macro/config — 阈值配置
PUT /api/macro/config — 更新阈值配置
"""
import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from config import DB_PATH
from services.macro_service import (
    ALL_MACRO_METRICS, METRIC_CN_10Y_BOND, METRIC_US_10Y_TREASURY,
    METRIC_USD_CNH, METRIC_VIX,
    _ensure_macro_tables, _get_latest_metric, _get_metric_n_days_ago,
    get_macro_history, refresh_all_macro,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/macro", tags=["macro"])

# 指标元信息
METRIC_META = {
    METRIC_CN_10Y_BOND: {"name": "中国10年国债收益率", "unit": "%", "affects": "红利ETF、A股估值", "direction": "up_negative"},
    METRIC_US_10Y_TREASURY: {"name": "美国10年国债收益率", "unit": "%", "affects": "标普500、纳斯达克、科创50", "direction": "up_negative"},
    METRIC_USD_CNH: {"name": "USD/CNH离岸人民币", "unit": "", "affects": "A股宽基、QDII人民币收益", "direction": "up_negative"},
    METRIC_VIX: {"name": "VIX恐慌指数", "unit": "", "affects": "全球风险偏好、现金水池战略价值", "direction": "up_negative"},
}


@router.get("/temperature")
async def get_temperature():
    """获取4个执行层宏观温度计指标(当前值+周变化+月变化+状态)。"""
    items = []
    for mt in ALL_MACRO_METRICS:
        latest = _get_latest_metric(mt)
        week_ago = _get_metric_n_days_ago(mt, 7)
        month_ago = _get_metric_n_days_ago(mt, 30)
        meta = METRIC_META.get(mt, {})
        current = latest.get("clean_value") if latest else None
        weekly_change = None
        monthly_change = None
        if current is not None and week_ago and week_ago.get("clean_value") is not None:
            weekly_change = round(current - week_ago["clean_value"], 4)
        if current is not None and month_ago and month_ago.get("clean_value") is not None:
            monthly_change = round(current - month_ago["clean_value"], 4)
        items.append({
            "metric_type": mt,
            "name": meta.get("name", mt),
            "current_value": current,
            "unit": meta.get("unit", ""),
            "weekly_change": weekly_change,
            "monthly_change": monthly_change,
            "trade_date": latest.get("trade_date") if latest else None,
            "source": latest.get("source_id") if latest else None,
            "quality_status": latest.get("quality_status") if latest else "unavailable",
            "affects": meta.get("affects", ""),
            "updated_at": latest.get("updated_at") if latest else None,
        })
    return {"items": items, "updated_at": datetime.now().isoformat()}


@router.get("/prompts")
async def get_prompts():
    """获取本周宏观提示文案(基于阈值触发)。
    
    V4.2 PRD§11.5: 只在剧烈变化时提示, 无异常返回"本周无明显宏观异常"。
    """
    prompts = []
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_macro_tables(conn)
            configs = conn.execute("SELECT * FROM macro_config WHERE enabled=1").fetchall()
            for mt in ALL_MACRO_METRICS:
                latest = _get_latest_metric(mt)
                if not latest or latest.get("clean_value") is None:
                    continue
                current = latest["clean_value"]
                week_ago = _get_metric_n_days_ago(mt, 7)
                if not week_ago or week_ago.get("clean_value") is None:
                    continue
                weekly_change = current - week_ago["clean_value"]
                meta = METRIC_META.get(mt, {})
                # 遍历该指标的阈值配置
                for cfg in configs:
                    if cfg["metric_type"] != mt:
                        continue
                    triggered = False
                    change_str = ""
                    threshold = cfg["threshold_value"]
                    unit = cfg["threshold_unit"]
                    severity = cfg["severity"]
                    if unit == "bp" and abs(weekly_change * 100) >= threshold:
                        triggered = True
                        change_str = f"{weekly_change*100:+.1f}bp"
                    elif unit == "pct" and mt == METRIC_VIX and "上升" in (cfg["trigger_name"] or ""):
                        # VIX 单周上升百分比: weekly_change/week_ago
                        pct_change = (weekly_change / week_ago["clean_value"]) * 100 if week_ago["clean_value"] else 0
                        if pct_change >= threshold:
                            triggered = True
                            change_str = f"+{pct_change:.1f}%"
                    elif unit == "pct" and abs(weekly_change / week_ago["clean_value"] * 100) >= threshold:
                        triggered = True
                        change_str = f"{weekly_change/week_ago['clean_value']*100:+.1f}%"
                    elif unit == "level" and current >= threshold:
                        triggered = True
                        change_str = f"当前{current:.1f}"
                    if triggered:
                        # 生成提示文案
                        if mt == METRIC_CN_10Y_BOND:
                            text = f"本周中国10年国债收益率{'上行' if weekly_change>0 else '下行'}{abs(weekly_change)*100:.1f}bp，红利资产相对债券的吸引力边际{'下降' if weekly_change>0 else '上升'}。本提示不改变买入金额，仅作为风险说明。"
                        elif mt == METRIC_US_10Y_TREASURY:
                            text = f"本周美国10年国债收益率{'上行' if weekly_change>0 else '下行'}{abs(weekly_change)*100:.1f}bp，海外成长股短期波动风险{'加大' if weekly_change>0 else '缓解'}。系统仍按目标缺口、估值分位和QDII溢价规则计算买入金额。"
                        elif mt == METRIC_USD_CNH:
                            text = f"本周离岸人民币{'走弱' if weekly_change>0 else '走强'}({abs(weekly_change/week_ago['clean_value']*100):.1f}%)，A股宽基短期可能{'承压' if weekly_change>0 else '受益'}。本提示不改变买入金额。"
                        elif mt == METRIC_VIX:
                            if unit == "level":
                                text = f"本周VIX突破{threshold:.0f}，全球风险偏好明显下降。系统不会因此自动卖出，仅提示高波动环境。"
                            else:
                                text = f"本周VIX{'上升' if weekly_change>0 else '下降'}{abs(weekly_change/week_ago['clean_value']*100):.1f}%，市场隐含波动率{'上升' if weekly_change>0 else '下降'}。"
                        else:
                            text = cfg["display_text"] or ""
                        prompts.append({
                            "prompt_id": str(uuid.uuid4())[:12],
                            "metric_type": mt,
                            "metric_name": meta.get("name", mt),
                            "trigger_type": cfg["trigger_name"],
                            "current_value": current,
                            "weekly_change": round(weekly_change, 4),
                            "threshold": threshold,
                            "severity": severity,
                            "prompt_text": text,
                            "affects": meta.get("affects", ""),
                        })
            # 持久化提示到 macro_prompt_log
            for p in prompts:
                conn.execute(
                    "INSERT OR REPLACE INTO macro_prompt_log (prompt_id, metric_type, trigger_type, current_value, weekly_change, threshold, prompt_text, severity, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (p["prompt_id"], p["metric_type"], p["trigger_type"], p["current_value"], p["weekly_change"], p["threshold"], p["prompt_text"], p["severity"], datetime.now().isoformat()),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[MACRO] get_prompts error: {e}")
    
    if not prompts:
        return {"prompts": [], "summary": "宏观温度计：本周无明显宏观异常。", "has_alert": False}
    return {"prompts": prompts, "summary": f"本周有{len(prompts)}条宏观提示", "has_alert": True}


@router.get("/history")
async def get_history(metric_type: str = Query(...), days: int = Query(90, ge=1, le=365)):
    """获取宏观指标历史序列。"""
    history = get_macro_history(metric_type, days)
    return {"metric_type": metric_type, "days": days, "history": history}


@router.get("/research")
async def get_research():
    """低频研究层(占位)。V4.2 PRD§11.12: 月频指标只进入研究层,不进入每周执行单。"""
    return {
        "items": [],
        "message": "研究层指标(社融/M1M2/PMI/CPI/PPI等)待P2接入,当前仅执行层4指标可用。",
        "research_metrics": ["社融", "M1/M2", "PMI", "CPI/PPI", "工业企业利润", "社零", "地产销售/投资", "非农", "失业率", "核心PCE", "ISM PMI", "信用利差", "商品价格"],
    }


@router.get("/config")
async def get_config():
    """获取宏观阈值配置。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            _ensure_macro_tables(conn)
            rows = conn.execute("SELECT * FROM macro_config ORDER BY metric_type, severity").fetchall()
            return {"configs": [dict(r) for r in rows]}
        finally:
            conn.close()
    except Exception as e:
        return {"configs": [], "error": str(e)}


class ConfigUpdate(BaseModel):
    id: str
    threshold_value: Optional[float] = None
    enabled: Optional[bool] = None


@router.put("/config")
async def update_config(update: ConfigUpdate):
    """更新宏观阈值配置。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            _ensure_macro_tables(conn)
            if update.threshold_value is not None:
                conn.execute("UPDATE macro_config SET threshold_value=?, updated_at=? WHERE id=?", (update.threshold_value, datetime.now().isoformat(), update.id))
            if update.enabled is not None:
                conn.execute("UPDATE macro_config SET enabled=?, updated_at=? WHERE id=?", (1 if update.enabled else 0, datetime.now().isoformat(), update.id))
            conn.commit()
            return {"success": True, "id": update.id}
        finally:
            conn.close()
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/refresh")
async def refresh_macro():
    """手动触发宏观指标刷新。"""
    results = await refresh_all_macro()
    success_count = sum(1 for v in results.values() if v is not None)
    return {"success": True, "message": f"刷新完成, {success_count}/{len(ALL_MACRO_METRICS)} 个指标成功", "results": results}
