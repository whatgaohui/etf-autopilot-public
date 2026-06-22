"""Rule engine calculation endpoint."""
import json
import logging
import sqlite3
from datetime import datetime

from fastapi import APIRouter

from config import DB_PATH, TRACKED_ETFS
from models.schemas import CalculateRequest, CalculateResponse
from services.rule_engine import calculate_suggestions

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["calculate"])


def _ensure_calculation_log_table(conn: sqlite3.Connection) -> None:
    """Create the calculation_log audit table if it does not exist.

    V4 策略书§11 要求 16 审计字段。本表将关键字段独立列化以便查询，
    同时保留 input_json/output_json/ai_explanation_json 作为完整快照。
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS calculation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            calculation_id TEXT UNIQUE NOT NULL,
            engine_version TEXT NOT NULL,
            -- V4 §11 审计字段（独立列便于查询）
            holding_snapshot_id TEXT,
            market_data_snapshot_time TEXT,
            rules_config_version TEXT,
            total_budget INTEGER,
            total_allocated INTEGER,
            total_rebalanced INTEGER,
            total_unallocated INTEGER,
            cash_destination TEXT,
            ai_explanation_check_result TEXT,
            source_comparison TEXT,
            rules_hit_summary TEXT,
            data_quality_summary TEXT,
            -- 完整快照
            input_json TEXT,
            output_json TEXT,
            ai_explanation_json TEXT,
            created_at TEXT
        )
        """
    )
    # 为旧表添加缺失列（ALTER TABLE ADD COLUMN 幂等性处理）
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(calculation_log)").fetchall()}
    new_cols = [
        ("holding_snapshot_id", "TEXT"),
        ("market_data_snapshot_time", "TEXT"),
        ("rules_config_version", "TEXT"),
        ("total_budget", "INTEGER"),
        ("total_allocated", "INTEGER"),
        ("total_rebalanced", "INTEGER"),
        ("total_unallocated", "INTEGER"),
        ("cash_destination", "TEXT"),
        ("ai_explanation_check_result", "TEXT"),
        ("source_comparison", "TEXT"),
        ("rules_hit_summary", "TEXT"),
        ("data_quality_summary", "TEXT"),
        ("ai_explanation_json", "TEXT"),
        # V4.2 策略书§15 新增审计字段
        ("strategy_version", "TEXT"),
        ("equity_allocation_base", "REAL"),
        ("base_bucket_amount", "INTEGER"),
        ("value_bucket_amount", "INTEGER"),
        ("rebalance_equity_reserve", "INTEGER"),
        ("weekly_unallocated_cash", "INTEGER"),
        ("qdii_pending_cash_sp500", "INTEGER"),
        ("qdii_pending_cash_nasdaq", "INTEGER"),
        ("cash_movements", "TEXT"),
        ("fallback_triggered", "BOOLEAN"),
        ("fallback_reason", "TEXT"),
        ("macro_prompts", "TEXT"),
    ]
    for col, coltype in new_cols:
        if col not in existing_cols:
            try:
                conn.execute(f"ALTER TABLE calculation_log ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass  # 列已存在
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_calculation_log_created_at
        ON calculation_log(created_at DESC)
        """
    )
    conn.commit()


def _load_market_data_for_calculation(codes: list[str]) -> dict:
    """Load market data from SQLite cache for rule engine calculation.

    Returns dict: code -> {pe_percentile, premium_today, premium_7d_avg, dividend_yield,
                           updated_at, sample_days, ...}

    IMPORTANT: valuation & dividend data are stored under the underlying INDEX code
    (e.g. 159338 -> 000510), while premium & nav are stored under the ETF code directly.
    This mirrors the mapping that /api/cached/summary does, ensuring the rule engine
    reads the SAME pe_percentile the frontend displays (fixes the cache-consistency bug
    where PE showed on the page but the engine saw it as missing).

    sample_days is estimated from the longest available history list. pe_history/pb_history
    are sampled to ~250 points for charting but represent 5+ years of daily data, so we apply
    a 5x multiplier to estimate the true underlying daily count. nav_history is loaded too
    so QDII ETFs (which have empty pe_history) can still pass the sample_days check.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    market_data = {}

    try:
        for code in codes:
            market_data[code] = {}
            estimated_sample_days = 0

            # Resolve the underlying index code for valuation/dividend lookups
            etf_info = TRACKED_ETFS.get(code, {})
            index_code = etf_info.get("index_code") or code

            # Get latest valuation data — stored under INDEX code
            row = conn.execute(
                """
                SELECT data_json, updated_at, date FROM market_data_cache
                WHERE code = ? AND data_type = 'valuation'
                ORDER BY date DESC LIMIT 1
                """,
                (index_code,),
            ).fetchone()
            valuation_updated_at = ""
            if row:
                data = json.loads(row["data_json"])
                market_data[code]["pe_percentile"] = data.get("pe_percentile")
                market_data[code]["pb_percentile"] = data.get("pb_percentile")
                # V4 多周期分位（策略书§3）
                market_data[code]["pe_percentile_1y"] = data.get("pe_percentile_1y")
                market_data[code]["pe_percentile_3y"] = data.get("pe_percentile_3y")
                market_data[code]["pe_percentile_5y"] = data.get("pe_percentile_5y")
                market_data[code]["pe_percentile_10y"] = data.get("pe_percentile_10y")
                market_data[code]["pe_percentile_all"] = data.get("pe_percentile_all")
                market_data[code]["pb_percentile_1y"] = data.get("pb_percentile_1y")
                market_data[code]["pb_percentile_3y"] = data.get("pb_percentile_3y")
                market_data[code]["pb_percentile_5y"] = data.get("pb_percentile_5y")
                market_data[code]["pb_percentile_10y"] = data.get("pb_percentile_10y")
                market_data[code]["pb_percentile_all"] = data.get("pb_percentile_all")
                # 优先用缓存的 sample_days（V4 新增，更准确）
                cached_sample_days = data.get("sample_days")
                if cached_sample_days and isinstance(cached_sample_days, (int, float)) and cached_sample_days > 0:
                    estimated_sample_days = max(estimated_sample_days, int(cached_sample_days))
                # pe_history/pb_history are sampled to max 250 points for charting, but
                # the underlying data spans 5+ years of daily points (~1200 days). Apply a
                # 5x multiplier to approximate the actual daily sample size.
                for hist_key in ("pe_history", "pb_history"):
                    hist = data.get(hist_key) or []
                    if isinstance(hist, list) and len(hist) >= 50:
                        estimated_sample_days = max(estimated_sample_days, len(hist) * 5)
                valuation_updated_at = row["updated_at"] or row["date"] or ""

            # Get latest premium data — stored under ETF code directly
            row = conn.execute(
                """
                SELECT data_json, updated_at, date FROM market_data_cache
                WHERE code = ? AND data_type = 'premium'
                ORDER BY date DESC LIMIT 1
                """,
                (code,),
            ).fetchone()
            premium_updated_at = ""
            if row:
                data = json.loads(row["data_json"])
                market_data[code]["premium_today"] = data.get("premium_today")
                market_data[code]["premium_7d_avg"] = data.get("premium_7d_avg")
                premium_updated_at = row["updated_at"] or row["date"] or ""

            # Get latest NAV data — stored under ETF code directly.
            # Used to estimate sample_days for QDII ETFs that lack PE history.
            row = conn.execute(
                """
                SELECT data_json, updated_at, date FROM market_data_cache
                WHERE code = ? AND data_type = 'nav'
                ORDER BY date DESC LIMIT 1
                """,
                (code,),
            ).fetchone()
            nav_updated_at = ""
            if row:
                data = json.loads(row["data_json"])
                nav_history = data.get("nav_history") or []
                # V4 修复：nav_history 只在估值 sample_days 为空时（QDII 无 PE 历史）作为 fallback，
                # 不应覆盖已有的估值 sample_days（nav 和 PE 是不同数据维度，nav 长不代表估值样本充足）
                if estimated_sample_days == 0 and isinstance(nav_history, list) and len(nav_history) >= 50:
                    estimated_sample_days = len(nav_history) * 3
                nav_updated_at = row["updated_at"] or row["date"] or ""

            # Get latest dividend data — stored under INDEX code
            row = conn.execute(
                """
                SELECT data_json, updated_at, date FROM market_data_cache
                WHERE code = ? AND data_type = 'dividend'
                ORDER BY date DESC LIMIT 1
                """,
                (index_code,),
            ).fetchone()
            dividend_updated_at = ""
            if row:
                data = json.loads(row["data_json"])
                market_data[code]["dividend_yield"] = data.get("dividend_yield")
                dividend_updated_at = row["updated_at"] or row["date"] or ""

            market_data[code]["sample_days"] = estimated_sample_days

            # Pick the latest updated_at across all data types for this code
            candidate_timests = [valuation_updated_at, premium_updated_at, nav_updated_at, dividend_updated_at]
            market_data[code]["updated_at"] = max((t for t in candidate_timests if t), default="")
            market_data[code]["date"] = market_data[code]["updated_at"]

    finally:
        conn.close()

    return market_data


def _load_cash_subaccount_balances() -> dict:
    """V4.2 策略书§3.1: 从 cash_subaccount 表读取所有子账户余额。

    返回 dict: {account_type: balance}
    例: {"rebalance_equity_reserve": 5000, "qdii_pending_cash_sp500": 3000, ...}
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            rows = conn.execute(
                "SELECT account_type, balance FROM cash_subaccount"
            ).fetchall()
            return {row[0]: row[1] for row in rows}
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[CALCULATE] Failed to load cash subaccount balances: {e}")
        return {}


def _get_latest_market_data_cache_time() -> str:
    """Query the SQLite cache for the MAX(updated_at) across all rows.

    Falls back to MAX(date) if updated_at is empty, and finally to current time.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            row = conn.execute(
                "SELECT MAX(updated_at) AS latest FROM market_data_cache"
            ).fetchone()
            latest = row[0] if row and row[0] else ""
            if not latest:
                row = conn.execute(
                    "SELECT MAX(date) AS latest FROM market_data_cache"
                ).fetchone()
                latest = row[0] if row and row[0] else ""
            return latest or datetime.now().isoformat()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[CALCULATE] Failed to query latest market data cache time: {e}")
        return datetime.now().isoformat()


@router.post("/calculate", response_model=CalculateResponse)
async def calculate(request: CalculateRequest):
    """Rule engine calculation endpoint.

    This is a pure Python arithmetic operation - NO AI/LLM calls.
    Produces deterministic output based on holdings, target ratios, rules, and market data.

    Input: holdings, targetRatios, rules, weeklyBudget
    Output: JSON structure as defined in target-gap-v2 spec
    """
    logger.info(f"[CALCULATE] Received calculation request with {len(request.holdings)} holdings")

    # Load market data from cache for all holding codes
    codes = [h.code for h in request.holdings]
    market_data = _load_market_data_for_calculation(codes)

    # If market data is empty (no cache yet), provide defaults from request context
    for code in codes:
        if code not in market_data:
            market_data[code] = {}
        # Ensure all expected keys exist even if null
        market_data[code].setdefault("pe_percentile", None)
        market_data[code].setdefault("pb_percentile", None)
        market_data[code].setdefault("premium_today", None)
        market_data[code].setdefault("premium_7d_avg", None)
        market_data[code].setdefault("dividend_yield", None)
        market_data[code].setdefault("updated_at", "")
        market_data[code].setdefault("sample_days", 0)

    # V4.2 策略书§3.1: 注入现金子账户余额（权益配置基准需要）
    if not request.cash_subaccount_balances:
        request.cash_subaccount_balances = _load_cash_subaccount_balances()

    # Run the rule engine
    result = calculate_suggestions(request, market_data)

    # Populate data_snapshot.marketDataCacheTime from the SQLite cache directly
    # (more authoritative than per-row updated_at values)
    snapshot = dict(result.data_snapshot) if result.data_snapshot else {}
    snapshot["marketDataCacheTime"] = _get_latest_market_data_cache_time()
    snapshot["rulesConfigVersion"] = snapshot.get("rulesConfigVersion", "rules-v3")
    result.data_snapshot = snapshot

    # V4.1 §10.8 / S3-T3: 从 cross_check_log 读最近一次各 code 交叉校验结果，
    # 组合 sourceComparison 字段回填响应体
    result.source_comparison = _build_source_comparison(codes)

    logger.info(
        f"[CALCULATE] Result: id={result.calculation_id}, budget={result.total_budget}, "
        f"allocated={result.total_allocated}, unallocated={result.total_unallocated}"
    )

    # Persist to calculation_log (best-effort; do not fail the request on log error)
    try:
        _persist_calculation_log(request, result)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[CALCULATE] Failed to persist calculation_log: {e}")

    return result


def _build_source_comparison(codes: list[str]) -> dict:
    """V4.1 S3-T3: 从 cross_check_log 读最近一次主备源校验结果，
    组合成 sourceComparison 字段供响应体回填。

    返回结构：
    {
        "primary": "akshare",
        "backup": "tushare",
        "crossValidated": true,
        "totalChecks": 19,
        "passed": 17,
        "inconsistent": 1,
        "failed": 1,
        "lastCheckTime": "...",
        "details": [{"code": ..., "field": ..., "primarySource": ..., ...}, ...]
    }
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            # 索引代码映射（valuation/dividend 存在 index_code 下）
            code_set = set(codes)
            index_codes = set()
            for c in codes:
                info = TRACKED_ETFS.get(c)
                if info:
                    index_codes.add(info["index_code"])
            all_codes = code_set | index_codes

            # 读最近 200 条 cross_check_log，过滤出本次涉及 code 的记录
            rows = conn.execute(
                """SELECT * FROM cross_check_log
                   WHERE code IN (%s)
                   ORDER BY id DESC LIMIT 200""" % ",".join("?" * len(all_codes)),
                tuple(all_codes),
            ).fetchall() if all_codes else []

            # 每个 (code, field) 取最新一条
            seen: dict[tuple[str, str], sqlite3.Row] = {}
            for r in rows:
                key = (r["code"], r["field"])
                if key not in seen:
                    seen[key] = r

            details = []
            passed = 0
            inconsistent = 0
            failed = 0
            primary_sources: set[str] = set()
            backup_sources: set[str] = set()
            last_check_time = ""
            for r in seen.values():
                qs = r["quality_status"] or ""
                if qs == "passed":
                    passed += 1
                elif qs == "source_inconsistent":
                    inconsistent += 1
                elif qs in ("primary_failed", "both_failed", "backup_failed", "no_backup"):
                    failed += 1
                if r["primary_source"]:
                    primary_sources.add(r["primary_source"])
                if r["backup_source"]:
                    backup_sources.add(r["backup_source"])
                if r["fetch_time"] and r["fetch_time"] > last_check_time:
                    last_check_time = r["fetch_time"]
                details.append({
                    "code": r["code"],
                    "field": r["field"],
                    "primarySource": r["primary_source"],
                    "backupSource": r["backup_source"],
                    "primaryValue": r["primary_value"],
                    "backupValue": r["backup_value"],
                    "diffPct": r["diff_pct"],
                    "diffPp": r["diff_pp"],
                    "qualityStatus": qs,
                    "inTolerance": bool(r["in_tolerance"]),
                    "notes": r["notes"] or "",
                    "fetchTime": r["fetch_time"] or "",
                })

            # 主备源取众数（出现频次最高的）
            primary = "akshare"
            backup = "unconfigured"
            if primary_sources:
                # 简单取第一个非空
                primary = sorted(primary_sources)[0]
            if backup_sources:
                backup = sorted(backup_sources)[0]

            return {
                "primary": primary,
                "backup": backup,
                "crossValidated": len(seen) > 0,
                "totalChecks": len(seen),
                "passed": passed,
                "inconsistent": inconsistent,
                "failed": failed,
                "lastCheckTime": last_check_time,
                "details": details,
            }
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[CALCULATE] _build_source_comparison failed: {e}")
        return {
            "primary": "akshare",
            "backup": "unconfigured",
            "crossValidated": False,
            "totalChecks": 0,
            "passed": 0,
            "inconsistent": 0,
            "failed": 0,
            "lastCheckTime": "",
            "details": [],
        }


def _persist_calculation_log(request: CalculateRequest, result: CalculateResponse) -> None:
    """Insert a row into calculation_log for full audit traceability (V4 §11 16字段)."""
    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_calculation_log_table(conn)

        # Build a compact input summary (holdings + targets + rules + budget)
        input_summary = {
            "holdings": [
                {"code": h.code, "name": h.name, "marketValue": h.market_value, "currentRatio": h.current_ratio}
                for h in request.holdings
            ],
            "targetRatios": [
                {"code": tr.code, "targetRatio": tr.target_ratio}
                for tr in request.target_ratios
            ],
            "rules": [
                {
                    "id": r.id,
                    "name": r.name,
                    "type": r.type,
                    "thresholdValue": r.threshold_value,
                    "thresholdValueMax": r.threshold_value_max,
                    "applicableScope": r.applicable_scope,
                    "applicableCodes": r.applicable_codes,
                    "isEnabled": r.is_enabled,
                }
                for r in request.rules
            ],
            "weeklyBudget": request.weekly_budget,
        }

        # Build a compact output summary (含 V4 再平衡 + 现金水池)
        output_summary = {
            "calculationId": result.calculation_id,
            "engineVersion": result.engine_version,
            "calculatedAt": result.calculated_at,
            "allocationStrategy": result.allocation_strategy,
            "dataSnapshot": result.data_snapshot,
            "totalBudget": result.total_budget,
            "totalAllocated": result.total_allocated,
            "totalUnallocated": result.total_unallocated,
            "suggestions": [s.model_dump(by_alias=True) for s in result.suggestions],
            "rebalanceSuggestions": [r.model_dump(by_alias=True) for r in result.rebalance_suggestions],
            "cashPoolSuggestions": [c.model_dump(by_alias=True) for c in result.cash_pool_suggestions],
            "totalRebalanced": result.total_rebalanced,
            "cashPoolInflow": result.cash_pool_inflow,
            "cashDestination": result.cash_destination,
            "externalInflow": result.external_inflow,
            "internalRelease": result.internal_release,
        }

        # V4 §11 审计字段提取（独立列）
        data_snapshot = result.data_snapshot or {}
        holding_snapshot_id = data_snapshot.get("holdingSnapshotId", "")
        market_data_snapshot_time = data_snapshot.get("marketDataCacheTime", "")
        rules_config_version = data_snapshot.get("rulesConfigVersion", "rules-v4")

        # rules_hit_summary: 所有建议的命中规则汇总
        rules_hit_summary = []
        for s in result.suggestions:
            for rh in s.rules_hit:
                rules_hit_summary.append({"code": s.code, "ruleType": rh.rule_type, "ruleName": rh.rule_name, "effect": rh.effect})
        for r in result.rebalance_suggestions:
            for rh in r.rules_hit:
                rules_hit_summary.append({"code": r.code, "ruleType": rh.rule_type, "ruleName": rh.rule_name, "effect": rh.effect})

        # data_quality_summary: 各标的数据质量状态汇总
        data_quality_summary = []
        for s in result.suggestions:
            if s.data_quality:
                data_quality_summary.append({
                    "code": s.code,
                    "qualityStatus": s.data_quality.quality_status,
                    "isStale": s.data_quality.is_stale,
                    "staleLevel": s.data_quality.stale_level,
                    "canCalculate": s.data_quality.can_calculate,
                })

        # source_comparison: V4.1 S3-T3 改为从 result.source_comparison 取真实数据
        # （由 _build_source_comparison 从 cross_check_log 读出后填充）
        source_comparison = result.source_comparison or {
            "primary": "akshare", "backup": "unconfigured", "crossValidated": False
        }

        # ai_explanation_check_result: 占位（advice 路由填充，calculate 阶段无 AI）
        ai_check_result = "pending_advice"

        conn.execute(
            """
            INSERT OR REPLACE INTO calculation_log
                (calculation_id, engine_version,
                 holding_snapshot_id, market_data_snapshot_time, rules_config_version,
                 total_budget, total_allocated, total_rebalanced, total_unallocated,
                 cash_destination, ai_explanation_check_result, source_comparison,
                 rules_hit_summary, data_quality_summary,
                 input_json, output_json, ai_explanation_json, created_at,
                 strategy_version, equity_allocation_base, base_bucket_amount, value_bucket_amount,
                 rebalance_equity_reserve, weekly_unallocated_cash,
                 qdii_pending_cash_sp500, qdii_pending_cash_nasdaq,
                 cash_movements, fallback_triggered, fallback_reason, macro_prompts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                result.calculation_id,
                result.engine_version,
                holding_snapshot_id,
                market_data_snapshot_time,
                rules_config_version,
                result.total_budget,
                result.total_allocated,
                result.total_rebalanced,
                result.total_unallocated,
                result.cash_destination,
                ai_check_result,
                json.dumps(source_comparison, ensure_ascii=False),
                json.dumps(rules_hit_summary, ensure_ascii=False),
                json.dumps(data_quality_summary, ensure_ascii=False),
                json.dumps(input_summary, ensure_ascii=False),
                json.dumps(output_summary, ensure_ascii=False, default=str),
                None,  # ai_explanation_json 由 advice 路由后续填充
                datetime.now().isoformat(),
                # V4.2 新增字段（策略书§15 审计字段）
                result.strategy_version,
                result.equity_allocation_base,
                result.base_bucket_amount,
                result.value_bucket_amount,
                result.rebalance_equity_reserve,
                result.weekly_unallocated_cash,
                result.qdii_pending_cash_sp500,
                result.qdii_pending_cash_nasdaq,
                json.dumps(
                    [cm.model_dump(by_alias=True) for cm in result.cash_movements],
                    ensure_ascii=False,
                    default=str,
                ),
                1 if result.fallback_triggered else 0,
                result.fallback_reason,
                json.dumps(result.macro_prompts, ensure_ascii=False, default=str),
            ),
        )
        conn.commit()
        logger.info(
            f"[CALCULATE] Persisted calculation_log for {result.calculation_id} "
            f"(V4.2 audit fields: strategyVersion={result.strategy_version}, "
            f"equityAllocationBase={result.equity_allocation_base}, "
            f"baseBucketAmount={result.base_bucket_amount}, "
            f"valueBucketAmount={result.value_bucket_amount}, "
            f"fallbackTriggered={result.fallback_triggered})"
        )
    finally:
        conn.close()


@router.get("/calculation-log")
async def list_calculation_logs(limit: int = 20):
    """历史建议回溯（V4 PRD P2 + 策略书§10.3 风险防护"缺少回溯"）。

    返回最近 N 条计算记录的审计摘要。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_calculation_log_table(conn)
        rows = conn.execute(
            """
            SELECT id, calculation_id, engine_version,
                   holding_snapshot_id, market_data_snapshot_time, rules_config_version,
                   total_budget, total_allocated, total_rebalanced, total_unallocated,
                   cash_destination, ai_explanation_check_result,
                   rules_hit_summary, data_quality_summary, source_comparison,
                   created_at
            FROM calculation_log
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        logs = []
        for r in rows:
            def _parse(s):
                if not s:
                    return None
                try:
                    return json.loads(s)
                except Exception:
                    return None
            logs.append({
                "id": r["id"],
                "calculationId": r["calculation_id"],
                "engineVersion": r["engine_version"],
                "holdingSnapshotId": r["holding_snapshot_id"] or "",
                "marketDataSnapshotTime": r["market_data_snapshot_time"] or "",
                "rulesConfigVersion": r["rules_config_version"] or "",
                "totalBudget": r["total_budget"],
                "totalAllocated": r["total_allocated"],
                "totalRebalanced": r["total_rebalanced"] or 0,
                "totalUnallocated": r["total_unallocated"],
                "cashDestination": r["cash_destination"] or "",
                "aiCheckResult": r["ai_explanation_check_result"] or "",
                "rulesHitSummary": _parse(r["rules_hit_summary"]),
                "dataQualitySummary": _parse(r["data_quality_summary"]),
                "sourceComparison": _parse(r["source_comparison"]),
                "createdAt": r["created_at"],
            })
        return {"logs": logs, "count": len(logs)}
    finally:
        conn.close()


@router.get("/calculation-log/{calculation_id}")
async def get_calculation_log(calculation_id: str):
    """获取单条计算记录的完整详情（含 input/output/ai_explanation 完整 JSON）。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_calculation_log_table(conn)
        r = conn.execute(
            "SELECT * FROM calculation_log WHERE calculation_id = ?",
            (calculation_id,),
        ).fetchone()
        if not r:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="calculation_log not found")

        def _parse(s):
            if not s:
                return None
            try:
                return json.loads(s)
            except Exception:
                return None

        return {
            "calculationId": r["calculation_id"],
            "engineVersion": r["engine_version"],
            "holdingSnapshotId": r["holding_snapshot_id"] or "",
            "marketDataSnapshotTime": r["market_data_snapshot_time"] or "",
            "rulesConfigVersion": r["rules_config_version"] or "",
            "totalBudget": r["total_budget"],
            "totalAllocated": r["total_allocated"],
            "totalRebalanced": r["total_rebalanced"] or 0,
            "totalUnallocated": r["total_unallocated"],
            "cashDestination": r["cash_destination"] or "",
            "aiCheckResult": r["ai_explanation_check_result"] or "",
            "rulesHitSummary": _parse(r["rules_hit_summary"]),
            "dataQualitySummary": _parse(r["data_quality_summary"]),
            "sourceComparison": _parse(r["source_comparison"]),
            "inputJson": _parse(r["input_json"]),
            "outputJson": _parse(r["output_json"]),
            "aiExplanationJson": _parse(r["ai_explanation_json"]),
            "createdAt": r["created_at"],
        }
    finally:
        conn.close()


@router.patch("/calculation-log/{calculation_id}/ai-check")
async def update_ai_check(calculation_id: str, body: dict):
    """V4 迭代7：回填 AI 一致性校验结果到 calculation_log（策略书§11）。"""
    from pydantic import BaseModel
    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_calculation_log_table(conn)
        ai_check_result = body.get("aiCheckResult", "unknown")
        ai_explanation_json = body.get("aiExplanationJson")
        conn.execute(
            "UPDATE calculation_log SET ai_explanation_check_result = ?, ai_explanation_json = ? WHERE calculation_id = ?",
            (ai_check_result, ai_explanation_json, calculation_id),
        )
        conn.commit()
        logger.info(f"[CALCULATE] Updated ai_check_result={ai_check_result} for {calculation_id}")
        return {"ok": True, "calculationId": calculation_id, "aiCheckResult": ai_check_result}
    except Exception as e:
        logger.warning(f"[CALCULATE] Failed to update ai_check for {calculation_id}: {e}")
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.get("/portfolio-metrics")
async def get_portfolio_metrics():
    """V4 策略书§10.1: 组合最大回撤监控。

    从 calculation_log 历史记录提取 investedAssetValue 序列，计算最大回撤。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_calculation_log_table(conn)
        rows = conn.execute(
            """
            SELECT calculation_id, output_json, created_at
            FROM calculation_log
            WHERE output_json IS NOT NULL
            ORDER BY created_at ASC
            """,
        ).fetchall()

        values = []
        for r in rows:
            try:
                d = json.loads(r["output_json"])
                ds = d.get("dataSnapshot", {})
                inv = ds.get("investedAssetValue")
                if inv and isinstance(inv, (int, float)) and inv > 0:
                    values.append({
                        "calculationId": d.get("calculationId", r["calculation_id"]),
                        "investedAssetValue": inv,
                        "timestamp": d.get("calculatedAt", r["created_at"]),
                    })
            except Exception:
                continue

        if len(values) < 2:
            return {
                "maxDrawdown": 0,
                "maxDrawdownPct": 0,
                "currentValue": values[-1]["investedAssetValue"] if values else 0,
                "peakValue": values[-1]["investedAssetValue"] if values else 0,
                "troughValue": values[-1]["investedAssetValue"] if values else 0,
                "history": values,
                "message": "历史数据不足，需至少2次计算记录",
            }

        # 计算最大回撤
        peak = values[0]["investedAssetValue"]
        trough = peak
        max_dd = 0
        max_dd_pct = 0
        peak_at = values[0]
        trough_at = values[0]

        for v in values:
            val = v["investedAssetValue"]
            if val > peak:
                peak = val
                peak_at = v
            dd = peak - val
            dd_pct = (dd / peak * 100) if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd
                max_dd_pct = dd_pct
                trough = val
                trough_at = v

        current = values[-1]["investedAssetValue"]
        return {
            "maxDrawdown": round(max_dd, 2),
            "maxDrawdownPct": round(max_dd_pct, 2),
            "currentValue": current,
            "peakValue": peak,
            "troughValue": trough,
            "peakTime": peak_at.get("timestamp", ""),
            "troughTime": trough_at.get("timestamp", ""),
            "history": values,
            "message": f"最大回撤 {max_dd_pct:.2f}%（峰值¥{peak:,.0f}→谷值¥{trough:,.0f}）",
        }
    finally:
        conn.close()


@router.get("/backtest")
async def backtest_rules():
    """V4 PRD§16 P2: 规则回测。

    从 calculation_log 历史记录统计规则命中频率和效果。
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_calculation_log_table(conn)
        rows = conn.execute(
            """
            SELECT calculation_id, rules_hit_summary, total_budget, total_allocated,
                   total_rebalanced, total_unallocated, created_at
            FROM calculation_log
            WHERE rules_hit_summary IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 50
            """,
        ).fetchall()

        if not rows:
            return {"totalRuns": 0, "message": "无历史记录，无法回测"}

        # 统计规则命中频率
        rule_stats = {}
        total_buy = 0
        total_rebalance = 0
        total_unallocated = 0
        total_runs = len(rows)

        for r in rows:
            try:
                hits = json.loads(r["rules_hit_summary"]) if r["rules_hit_summary"] else []
                for h in hits:
                    name = h.get("ruleName", "unknown")
                    rtype = h.get("ruleType", "info")
                    if name not in rule_stats:
                        rule_stats[name] = {"count": 0, "type": rtype}
                    rule_stats[name]["count"] += 1

                total_buy += r["total_allocated"] or 0
                total_rebalance += r["total_rebalanced"] or 0
                total_unallocated += r["total_unallocated"] or 0
            except Exception:
                continue

        # 按命中次数排序
        sorted_rules = sorted(rule_stats.items(), key=lambda x: x[1]["count"], reverse=True)

        return {
            "totalRuns": total_runs,
            "ruleStats": [
                {"ruleName": name, "count": stat["count"], "type": stat["type"], "frequency": f"{stat['count']}/{total_runs}"}
                for name, stat in sorted_rules
            ],
            "summary": {
                "avgBuyPerRun": round(total_buy / total_runs, 0) if total_runs else 0,
                "avgRebalancePerRun": round(total_rebalance / total_runs, 0) if total_runs else 0,
                "avgUnallocatedPerRun": round(total_unallocated / total_runs, 0) if total_runs else 0,
                "totalBuy": total_buy,
                "totalRebalance": total_rebalance,
                "totalUnallocated": total_unallocated,
            },
            "message": f"回测{total_runs}次，最高频规则：{sorted_rules[0][0] if sorted_rules else '无'}",
        }
    finally:
        conn.close()
