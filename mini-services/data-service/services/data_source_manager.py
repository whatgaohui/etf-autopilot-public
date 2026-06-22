"""Data Source Manager — V4 策略书§4 数据源统一管理模块.

设计原则（策略书§4.1）：
    主源 + 备源 + 交叉校验 + 数据质量评分

本模块是数据源的"唯一管理入口"，所有 fetch_* 调用都应通过本模块，以获得：
1. 字段级主备源配置（PE/PB/NAV/premium/dividend 各自定义主源/备源优先级）
2. 自动 fallback：主源失败/数据异常时切换备源
3. 交叉校验：主备源同时拉取，比对差异，超阈值标记 quality='source_inconsistent'
4. 数据血缘：每次取数记录 source/source_api/raw_value/clean_value/fetch_time
5. 强制切源：人工指定某字段使用某源（覆盖默认优先级）

适配器分层（不破坏现有 akshare_service）：
    - AkshareLeguAdapter      → 乐咕乐股 PE/PB（5年历史，akshare 内部子源）
    - AkshareCSIndexAdapter   → 中证指数 PE/股息率（akshare 内部子源）
    - AkshareEastmoneyAdapter → 东方财富 ETF 行情/净值（akshare 内部子源）
    - AkshareSinaAdapter      → 新浪行情（akshare 内部子源）
    - AkshareUSIndexAdapter   → 新浪美股指数（akshare 内部子源）
    - TushareAdapter          → Tushare Pro（需 token，独立备源）

字段→源默认配置（策略书§4.3）：
    valuation : primary=akshare(lg/csindex 自动选择)  backup=[tushare]
    premium   : primary=akshare(eastmoney)            backup=[tushare]
    nav       : primary=akshare(eastmoney)            backup=[tushare]
    dividend  : primary=akshare(csindex)              backup=[tushare]
    price     : primary=akshare(sina)                 backup=[tushare]
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any, Optional

from config import DB_PATH, TRACKED_ETFS

logger = logging.getLogger(__name__)


# ─── 双源校验容忍阈值（策略书§4.4）──────────────────────────────────────────────
CROSS_CHECK_THRESHOLDS: dict[str, dict[str, float]] = {
    # 字段 → {threshold_type: "pct"|"pp", max_diff: float, unit: str}
    "etf_close_price":  {"type": "pct", "max_diff": 0.1, "unit": "%"},
    "fund_nav":          {"type": "pct", "max_diff": 0.3, "unit": "%"},
    "qdii_premium":      {"type": "pp",  "max_diff": 0.5, "unit": "pp"},
    "pe_pb_raw":         {"type": "pct", "max_diff": 2.0, "unit": "%"},
    "pe_pb_percentile":  {"type": "pp",  "max_diff": 5.0, "unit": "pp"},
    "dividend_yield":    {"type": "pp",  "max_diff": 0.2, "unit": "pp"},
}


# ─── 字段→数据源默认配置（策略书§4.3 + V4.1 §10.2 多源冗余）──────────────────
# 注意：primary/backup 用适配器名称，DataSourceManager 会按顺序尝试
# V4.1: 新增 efinance 作为免费免 Token 备源，置于 tushare 之前作为第二备源
# （tushare 需 Token，未配置时自动跳过；efinance 免 Token 优先降级）
DEFAULT_FIELD_CONFIG: dict[str, dict[str, list[str]]] = {
    "valuation": {"primary": ["akshare"], "backup": ["tushare", "efinance"]},
    "premium":   {"primary": ["akshare"], "backup": ["efinance", "tushare"]},
    "nav":       {"primary": ["akshare"], "backup": ["efinance", "tushare"]},
    "dividend":  {"primary": ["akshare"], "backup": ["tushare", "efinance"]},
    "price":     {"primary": ["akshare"], "backup": ["efinance", "tushare"]},
}

# 适配器元信息（用于前端展示）
ADAPTER_METADATA: dict[str, dict[str, str]] = {
    "akshare": {
        "name": "AkShare",
        "role": "primary",
        "description": "主数据源：聚合乐咕乐股/中证指数/东方财富/新浪（免费，无需 token）",
        "sub_sources": "lg,csindex,eastmoney,sina",
        "needs_token": "false",
    },
    "tushare": {
        "name": "Tushare Pro",
        "role": "backup",
        "description": "备源：指数行情/基金净值/指数指标（需 token，积分制）",
        "sub_sources": "fund_daily,fund_nav,index_dailybasic",
        "needs_token": "true",
    },
    "efinance": {
        "name": "Efinance",
        "role": "backup",
        "description": "免费免 Token 备源：ETF 行情/基金净值（独立端点，主源限流时降级）",
        "sub_sources": "fund.eastmoney,stock.eastmoney",
        "needs_token": "false",
    },
    "csindex_direct": {
        "name": "中证指数官网",
        "role": "reference",
        "description": "权威校验源：指数估值/股息率/样本（直连，不依赖 akshare）",
        "sub_sources": "csindex.com.cn",
        "needs_token": "false",
    },
    "eastmoney_direct": {
        "name": "东方财富 Web",
        "role": "reference",
        "description": "权威校验源：ETF 行情/净值/折溢价（直连，不依赖 akshare）",
        "sub_sources": "push2.eastmoney.com",
        "needs_token": "false",
    },
}

# V4.1 §10.4 / S2-T2: AkShare 子源元数据（设计层与实现层对齐）
AKSHARE_SUB_SOURCE_METADATA: dict[str, dict[str, str]] = {
    "akshare_lg": {
        "name": "AkShare · 乐咕乐股",
        "parent": "akshare",
        "description": "AkShare 子源：A股宽基指数 PE/PB 5年历史（stock_index_pe_lg / pb_lg）",
        "supports": "valuation(A股宽基)",
    },
    "akshare_csindex": {
        "name": "AkShare · 中证指数",
        "parent": "akshare",
        "description": "AkShare 子源：中证指数估值/股息率（index_value_hist_info_es）",
        "supports": "valuation,dividend",
    },
    "akshare_eastmoney": {
        "name": "AkShare · 东方财富",
        "parent": "akshare",
        "description": "AkShare 子源：ETF 实时行情/折溢价（fund_etf_spot_em）",
        "supports": "premium,nav,price",
    },
    "akshare_sina": {
        "name": "AkShare · 新浪财经",
        "parent": "akshare",
        "description": "AkShare 子源：ETF K线/宽基指数行情（fund_etf_hist_sina）",
        "supports": "price,kline",
    },
    "akshare_usindex": {
        "name": "AkShare · 美股指数",
        "parent": "akshare",
        "description": "AkShare 子源：美股指数估值（指数缺失时用估算值兜底）",
        "supports": "valuation(US)",
    },
}


# ─── 数据模型 ─────────────────────────────────────────────────────────────────

@dataclass
class FetchResult:
    """单源拉取结果。"""
    source: str                  # 适配器名（akshare/tushare/...）
    source_api: str              # 具体接口（akshare:lg / tushare:index_dailybasic）
    data: dict                   # 原始返回数据
    success: bool
    latency_ms: int = 0
    error: str = ""
    fetch_time: str = field(default_factory=lambda: datetime.now().isoformat())
    # V4.1 §10.9 / S2-T5: 单源场景标记 — 该字段仅有此源可用时，限制强再平衡
    single_source_warning: bool = False

    @property
    def is_valid(self) -> bool:
        """数据是否有效（非空且 clean_value 不为 None）。"""
        if not self.success:
            return False
        # valuation 看 pe，premium 看 premium_today，nav 看 nav，dividend 看 dividend_yield
        for k in ("pe", "premium_today", "nav", "dividend_yield", "close"):
            if k in self.data and self.data[k] is not None:
                return True
        return False


@dataclass
class CrossCheckResult:
    """交叉校验结果。"""
    field: str                   # valuation/premium/nav/dividend/price
    code: str                    # ETF 代码或指数代码
    primary_source: str
    backup_source: str
    primary_value: Optional[float]
    backup_value: Optional[float]
    diff_abs: Optional[float]    # 绝对差
    diff_pct: Optional[float]    # 百分比差（%）
    diff_pp: Optional[float]     # 百分点差（pp）
    threshold_type: str          # pct / pp
    threshold_max: float         # 容忍上限
    in_tolerance: bool           # 是否在容忍范围内
    quality_status: str          # passed / source_inconsistent / primary_failed / backup_failed / both_failed / no_backup
    trade_date: str = ""
    fetch_time: str = field(default_factory=lambda: datetime.now().isoformat())
    notes: str = ""
    # V4.1 §10.9 / S2-T8: 主备源冲突熔断标志 — 主备源差异超阈值时为 True，
    # 触发规则引擎 source_conflict veto（阻断强买入/强再平衡，需人工确认）
    source_conflict: bool = False
    # V4.1 §10.9 / S2-T5: 单源场景标记 — 仅有此源可用（no_backup / 双源都失败 / 备源不可用）
    single_source_warning: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class FallbackResult:
    """V4.1 §10.9 / S2-T3: 熔断降级链路结果。

    三级降级：主源 → 备源 → 最近有效缓存（stale=true）→ 阻断（blocked=true）

    状态矩阵：
        source_fallback=False, stale=False, blocked=False → 主源成功
        source_fallback=True,  stale=False, blocked=False → 主源失败，备源成功
        source_fallback=True,  stale=True,  blocked=False → 主备源均失败，用缓存
        source_fallback=True,  stale=True,  blocked=True  → 缓存过期或无缓存，阻断
    """
    data: dict
    source: str                  # 实际采用的源（akshare/tushare/efinance/cache）
    source_api: str = ""
    source_fallback: bool = False  # 是否触发了源降级（主源失败）
    stale: bool = False            # 是否使用了过期缓存
    stale_age_days: int = 0        # 缓存过期天数（stale=True 时有效）
    blocked: bool = False          # 是否完全阻断（无任何可用数据）
    single_source_warning: bool = False  # 单源场景标记
    source_conflict: bool = False  # 主备源冲突标记
    reason: str = ""               # 状态原因说明
    cross_check: Optional[CrossCheckResult] = None  # 附带的交叉校验结果
    fetch_time: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        d = asdict(self)
        # cross_check 单独序列化（避免 asdict 对 None 的处理）
        return d


# ─── 数据库初始化 ─────────────────────────────────────────────────────────────

def _ensure_manager_tables(conn: sqlite3.Connection) -> None:
    """幂等创建数据源管理所需的表（cross_check_log + field_source_config + source_compare_result + data_fetch_log + data_source + data_source_capability）。"""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS cross_check_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fetch_time TEXT NOT NULL,
            field TEXT NOT NULL,
            code TEXT NOT NULL,
            primary_source TEXT,
            backup_source TEXT,
            primary_value REAL,
            backup_value REAL,
            diff_abs REAL,
            diff_pct REAL,
            diff_pp REAL,
            threshold_type TEXT,
            threshold_max REAL,
            in_tolerance INTEGER,
            quality_status TEXT,
            trade_date TEXT,
            notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cross_check_time ON cross_check_log(fetch_time);
        CREATE INDEX IF NOT EXISTS idx_cross_check_field ON cross_check_log(field, code);

        CREATE TABLE IF NOT EXISTS field_source_config (
            field TEXT PRIMARY KEY,
            primary_sources TEXT NOT NULL,   -- JSON array
            backup_sources TEXT NOT NULL,    -- JSON array
            forced_source TEXT,              -- 强制使用的源（覆盖优先级），NULL 表示按默认
            updated_at TEXT NOT NULL
        );

        -- V4.1 PRD§13.7: source_compare_result 标准化交叉校验结果表
        CREATE TABLE IF NOT EXISTS source_compare_result (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            trade_date TEXT,
            metric_type TEXT NOT NULL,
            primary_source TEXT,
            backup_source TEXT,
            primary_value REAL,
            backup_value REAL,
            diff_value REAL,
            diff_pct REAL,
            threshold REAL,
            compare_status TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_source_compare_code ON source_compare_result(code, metric_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_source_compare_status ON source_compare_result(compare_status, created_at DESC);

        -- V4.1 PRD§13.9: data_fetch_log 数据拉取日志表
        CREATE TABLE IF NOT EXISTS data_fetch_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT,
            source_id TEXT,
            metric_type TEXT,
            code TEXT,
            start_date TEXT,
            end_date TEXT,
            status TEXT,
            row_count INTEGER,
            latency_ms INTEGER,
            error_message TEXT,
            fetch_time TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_data_fetch_log_time ON data_fetch_log(fetch_time DESC);
        CREATE INDEX IF NOT EXISTS idx_data_fetch_log_source ON data_fetch_log(source_id, status);
        CREATE INDEX IF NOT EXISTS idx_data_fetch_log_request ON data_fetch_log(request_id);

        -- V4.1 PRD§13.3 / S5-T1: data_source 数据源注册表
        -- 统一管理所有数据源的元信息、优先级、限流、加密 token、支持指标
        CREATE TABLE IF NOT EXISTS data_source (
            id TEXT PRIMARY KEY,                      -- 适配器名（akshare/tushare/efinance/csindex_direct/eastmoney_direct）
            name TEXT NOT NULL,                       -- 展示名
            role TEXT NOT NULL,                       -- primary | backup | reference | validator
            description TEXT,
            sub_sources TEXT,                         -- 子源列表（逗号分隔）
            needs_token INTEGER DEFAULT 0,            -- 是否需要 token（0/1）
            priority INTEGER DEFAULT 100,             -- 优先级（数字越小越优先）
            rate_limit_per_min INTEGER DEFAULT 60,    -- 每分钟限流次数
            api_key_encrypted TEXT,                   -- 加密后的 token（Fernet）
            supported_metrics TEXT,                   -- 支持指标 JSON array（valuation/premium/nav/dividend/price）
            is_enabled INTEGER DEFAULT 1,             -- 是否启用（0/1）— S5-T3 启用/停用开关
            homepage TEXT,                            -- 数据源官网
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_data_source_role ON data_source(role, is_enabled);
        CREATE INDEX IF NOT EXISTS idx_data_source_priority ON data_source(priority, is_enabled);

        -- V4.1 PRD§13.4 / S5-T2: data_source_capability 数据源能力表
        -- 三角色：is_primary / is_backup / is_validator + asset_scope 资产范围
        CREATE TABLE IF NOT EXISTS data_source_capability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT NOT NULL,                  -- 关联 data_source.id
            metric_type TEXT NOT NULL,                -- valuation/premium/nav/dividend/price
            is_primary INTEGER DEFAULT 0,             -- 是否主源（0/1）
            is_backup INTEGER DEFAULT 0,              -- 是否备源（0/1）
            is_validator INTEGER DEFAULT 0,           -- 是否校验源（0/1）— S5-T9/T10 csindex_direct/eastmoney_direct
            asset_scope TEXT,                         -- 资产范围：domestic/overseas/all/specific_codes
            notes TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(source_id, metric_type)
        );
        CREATE INDEX IF NOT EXISTS idx_capability_source ON data_source_capability(source_id);
        CREATE INDEX IF NOT EXISTS idx_capability_metric ON data_source_capability(metric_type, is_primary, is_backup);
        """
    )


def _log_fetch(
    source_id: str, metric_type: str, code: str,
    status: str, row_count: int, latency_ms: int,
    error_message: str = "", request_id: str = "",
) -> None:
    """V4.1 PRD§13.9: 记录数据拉取日志到 data_fetch_log 表。"""
    try:
        conn = _get_db()
        try:
            conn.execute(
                """INSERT INTO data_fetch_log
                   (request_id, source_id, metric_type, code, start_date, end_date,
                    status, row_count, latency_ms, error_message, fetch_time)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (request_id or f"{source_id}-{datetime.now().isoformat()}",
                 source_id, metric_type, code, "", "",
                 status, row_count, latency_ms, error_message,
                 datetime.now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[DS-MGR] Failed to log fetch: {e}")


def _get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    _ensure_manager_tables(conn)
    return conn


# ─── 适配器实现 ───────────────────────────────────────────────────────────────

class BaseAdapter:
    """数据源适配器抽象基类。"""
    name: str = "base"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        raise NotImplementedError

    def is_available(self) -> bool:
        """是否可用（如 tushare 需要 token）。"""
        return True


class AkshareAdapter(BaseAdapter):
    """AkShare 适配器（主源）。

    包装现有 akshare_service 的 fetch_* 函数，根据 data_type 分发。
    内部已聚合多源（lg/csindex/eastmoney/sina），但作为一个逻辑源对外。
    """
    name = "akshare"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type == "valuation":
                index_name = kwargs.get("index_name", "")
                data = await akshare_service.fetch_index_valuation(code, index_name)
                api = f"akshare:valuation(lg/csindex/us)"
            elif data_type == "premium":
                # V4.1 BUG-2026-06-PREMIUM-AVG: 必须带历史，否则 3d/7d 均值全部回退成 today
                data = await akshare_service.fetch_etf_premium(code, include_history=True)
                api = "akshare:premium(eastmoney)"
            elif data_type == "nav":
                data = await akshare_service.fetch_etf_nav(code)
                api = "akshare:nav(eastmoney)"
            elif data_type == "dividend":
                data = await akshare_service.fetch_dividend_yield(code)
                api = "akshare:dividend(csindex)"
            elif data_type == "price":
                data = await akshare_service.fetch_etf_kline(code)
                api = "akshare:price(sina)"
            else:
                _log_fetch(self.name, data_type, code, "error", 0, 0, f"unknown data_type: {data_type}")
                return FetchResult(source=self.name, source_api="unknown", data={},
                                   success=False, error=f"unknown data_type: {data_type}")
            latency = int((datetime.now() - start).total_seconds() * 1000)
            # V4.1 §13.9: 记录拉取日志
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(
                source=self.name, source_api=api, data=data,
                success=True, latency_ms=latency,
            )
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api=f"akshare:{data_type}",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class TushareAdapter(BaseAdapter):
    """Tushare Pro 适配器（备源，需 token）。"""
    name = "tushare"

    def is_available(self) -> bool:
        from services import tushare_service
        return tushare_service.TUSHARE_AVAILABLE and bool(tushare_service._get_tushare_token())

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import tushare_service
        start = datetime.now()
        if not self.is_available():
            _log_fetch(self.name, data_type, code, "error", 0, 0, "tushare 未配置 token 或未安装")
            return FetchResult(source=self.name, source_api="tushare:unavailable",
                               data={}, success=False, error="tushare 未配置 token 或未安装")
        try:
            if data_type == "valuation":
                data = await tushare_service.fetch_index_valuation(code)
                api = "tushare:index_dailybasic"
            elif data_type == "premium":
                data = await tushare_service.fetch_etf_premium(code)
                api = "tushare:fund_daily+fund_nav"
            elif data_type == "nav":
                data = await tushare_service.fetch_etf_nav(code)
                api = "tushare:fund_nav"
            elif data_type == "dividend":
                data = await tushare_service.fetch_dividend_yield(code)
                api = "tushare:index_dailybasic(dv_ratio)"
            else:
                _log_fetch(self.name, data_type, code, "error", 0, 0, f"tushare does not support {data_type}")
                return FetchResult(source=self.name, source_api="tushare:unsupported",
                                   data={}, success=False,
                                   error=f"tushare does not support {data_type}")
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api=api, data=data,
                               success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api=f"tushare:{data_type}",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class EfinanceAdapter(BaseAdapter):
    """Efinance 适配器（V4.1 §10.2 免费免 Token 备源）。

    V4.1 S2-T1: 主源 akshare 失败时优先降级至此（无需 Token）。
    支持：
      - nav      : ef.fund.get_quote_history（基金净值历史）
      - premium  : close / nav 计算（依赖 ef.stock + ef.fund）
      - price    : ef.stock.get_quote_history（K线收盘价，可能被限流）
      - valuation: efinance 不支持，返回 None 让管理器跳过
      - dividend : efinance 不支持，返回 None 让管理器跳过
    """
    name = "efinance"

    def is_available(self) -> bool:
        from services import efinance_service
        return efinance_service.is_available()

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import efinance_service
        start = datetime.now()
        if not self.is_available():
            _log_fetch(self.name, data_type, code, "error", 0, 0, "efinance 未安装")
            return FetchResult(source=self.name, source_api="efinance:unavailable",
                               data={}, success=False, error="efinance 未安装")
        try:
            if data_type == "nav":
                data = await efinance_service.fetch_etf_nav(code)
                api = "efinance:fund.get_quote_history"
            elif data_type == "premium":
                data = await efinance_service.fetch_etf_premium(code)
                api = "efinance:stock+fund"
            elif data_type == "price":
                data = await efinance_service.fetch_etf_close_price(code)
                api = "efinance:stock.get_quote_history"
            elif data_type == "valuation":
                # efinance 不支持指数估值，返回空让管理器跳过
                data = await efinance_service.fetch_index_valuation(code)
                api = "efinance:unsupported(valuation)"
            elif data_type == "dividend":
                data = await efinance_service.fetch_dividend_yield(code)
                api = "efinance:unsupported(dividend)"
            else:
                _log_fetch(self.name, data_type, code, "error", 0, 0, f"efinance does not support {data_type}")
                return FetchResult(source=self.name, source_api="efinance:unsupported",
                                   data={}, success=False,
                                   error=f"efinance does not support {data_type}")

            latency = int((datetime.now() - start).total_seconds() * 1000)
            # 判断是否拿到有效值（efinance 可能返回 source=efinance(no_data)/error）
            has_value = any(v is not None for k, v in data.items()
                           if k in ("nav", "premium_today", "close", "pe", "dividend_yield"))
            if has_value:
                _log_fetch(self.name, data_type, code, "success", 1, latency)
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=True, latency_ms=latency)
            else:
                _log_fetch(self.name, data_type, code, "no_data", 0, latency,
                          data.get("source", "no_data"))
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=False, latency_ms=latency,
                                   error=data.get("source", "no data from efinance"))
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api=f"efinance:{data_type}",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


# ─── V4.1 §10.4 / S2-T2: AkShare 子源适配器（设计层与实现层对齐）─────────────
# 这些子适配器作为 "akshare" 主适配器的内部子源存在，独立暴露用于：
# 1. 前端数据源列表展示"akshare 的子源有哪些"
# 2. fetch_with_fallback 在子源层面降级（如 lg 失败时切 csindex）
# 3. 子源级别的健康检查
# 注意：子适配器不直接注册到 _ADAPTERS（避免污染主路径），通过 get_sub_adapters() 暴露

class _AkshareSubAdapterBase(BaseAdapter):
    """AkShare 子源适配器基类。

    子源共享 akshare_service 内部函数，但通过 source_api 字段区分实际使用的子源。
    """
    parent_name = "akshare"

    def is_available(self) -> bool:
        from services import akshare_service
        return True  # akshare 子源都默认可用


class AkshareLeguAdapter(_AkshareSubAdapterBase):
    """AkShare · 乐咕乐股子源（A股宽基指数 PE/PB 5年历史）。"""
    name = "akshare_lg"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type != "valuation":
                return FetchResult(source=self.name, source_api="akshare_lg:unsupported",
                                   data={}, success=False,
                                   error=f"akshare_lg only supports valuation, got {data_type}")
            index_name = kwargs.get("index_name", "")
            lg_index_name = kwargs.get("lg_index_name")
            if not lg_index_name:
                # 通过 ETF 代码反查 lg_index_name
                from config import TRACKED_ETFS
                for etf_code, info in TRACKED_ETFS.items():
                    if info.get("index_code") == code:
                        lg_index_name = info.get("lg_index_name")
                        break
            if not lg_index_name:
                return FetchResult(source=self.name, source_api="akshare_lg:no_mapping",
                                   data={}, success=False,
                                   error=f"index {code} has no lg_index_name mapping")
            data = await akshare_service._fetch_lg_index_valuation(code, index_name, lg_index_name)
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api="akshare:stock_index_pe_lg",
                               data=data, success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api="akshare_lg:error",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class AkshareCSIndexAdapter(_AkshareSubAdapterBase):
    """AkShare · 中证指数子源（指数估值/股息率）。"""
    name = "akshare_csindex"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type == "valuation":
                index_name = kwargs.get("index_name", "")
                data = await akshare_service._fetch_csindex_valuation(code, index_name)
                api = "akshare:index_value_hist_info_es"
            elif data_type == "dividend":
                data = await akshare_service.fetch_dividend_yield(code)
                api = "akshare:index_value_hist_info_es(dv)"
            else:
                return FetchResult(source=self.name, source_api="akshare_csindex:unsupported",
                                   data={}, success=False,
                                   error=f"akshare_csindex supports valuation/dividend, got {data_type}")
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api=api,
                               data=data, success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api="akshare_csindex:error",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class AkshareEastmoneyAdapter(_AkshareSubAdapterBase):
    """AkShare · 东方财富子源（ETF 实时行情/折溢价/净值）。"""
    name = "akshare_eastmoney"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type == "premium":
                # V4.1 BUG-2026-06-PREMIUM-AVG: 必须带历史，否则 3d/7d 均值全部回退成 today
                data = await akshare_service.fetch_etf_premium(code, include_history=True)
                api = "akshare:fund_etf_spot_em"
            elif data_type == "nav":
                data = await akshare_service.fetch_etf_nav(code)
                api = "akshare:fund_etf_spot_em(nav)"
            else:
                return FetchResult(source=self.name, source_api="akshare_eastmoney:unsupported",
                                   data={}, success=False,
                                   error=f"akshare_eastmoney supports premium/nav, got {data_type}")
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api=api,
                               data=data, success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api="akshare_eastmoney:error",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class AkshareSinaAdapter(_AkshareSubAdapterBase):
    """AkShare · 新浪财经子源（ETF K线/行情价）。"""
    name = "akshare_sina"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type != "price":
                return FetchResult(source=self.name, source_api="akshare_sina:unsupported",
                                   data={}, success=False,
                                   error=f"akshare_sina only supports price, got {data_type}")
            data = await akshare_service.fetch_etf_kline(code)
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api="akshare:fund_etf_hist_sina",
                               data=data, success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api="akshare_sina:error",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


class AkshareUSIndexAdapter(_AkshareSubAdapterBase):
    """AkShare · 美股指数子源（美股指数估值兜底估算）。"""
    name = "akshare_usindex"

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import akshare_service
        start = datetime.now()
        try:
            if data_type != "valuation":
                return FetchResult(source=self.name, source_api="akshare_usindex:unsupported",
                                   data={}, success=False,
                                   error=f"akshare_usindex only supports valuation, got {data_type}")
            index_name = kwargs.get("index_name", "")
            data = await akshare_service._fetch_us_index_valuation(code, index_name)
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "success", 1, latency)
            return FetchResult(source=self.name, source_api="akshare:us_index_estimated",
                               data=data, success=True, latency_ms=latency)
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api="akshare_usindex:error",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


# ─── V4.1 §10.2 / S5-T9: csindex_direct 校验源适配器 ──────────────────────────

class CsindexDirectAdapter(BaseAdapter):
    """csindex_direct 适配器 — 直连中证指数官网 OSS（不依赖 akshare）。

    V4.1 PRD §10.2 / S5-T9:
        作为权威校验源（validator role），直连中证指数官网 xls 静态资源，
        与 akshare 的 csindex 子源解耦，避免 akshare 失效时同步失去校验能力。

    支持指标：
        - valuation : 指数 PE / 股息率（20 日历史，无 PB）
        - dividend  : 股息率
    不支持的指标（premium/nav/price）返回 success=False，让上层 fallback。

    限流：内部每次调用 sleep 1s（csindex 限流严格）。
    """
    name = "csindex_direct"

    def is_available(self) -> bool:
        """依赖 httpx + pandas 已装即视为可用。"""
        try:
            from services import csindex_direct_service
            return csindex_direct_service.is_available()
        except Exception:
            return False

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import csindex_direct_service
        start = datetime.now()
        if not self.is_available():
            _log_fetch(self.name, data_type, code, "error", 0, 0, "csindex_direct 依赖未就绪")
            return FetchResult(source=self.name, source_api="csindex_direct:unavailable",
                               data={}, success=False, error="csindex_direct 依赖未就绪")
        try:
            if data_type == "valuation":
                index_name = kwargs.get("index_name", "")
                data = await csindex_direct_service.fetch_index_valuation(code, index_name)
                api = "csindex_direct:indicator.xls"
            elif data_type == "dividend":
                data = await csindex_direct_service.fetch_dividend_yield(code)
                api = "csindex_direct:indicator.xls(dividend)"
            else:
                # csindex_direct 仅支持 valuation + dividend，其他类型不参与主链路
                _log_fetch(self.name, data_type, code, "skipped", 0, 0,
                          f"csindex_direct does not support {data_type}")
                return FetchResult(source=self.name, source_api="csindex_direct:unsupported",
                                   data={}, success=False,
                                   error=f"csindex_direct does not support {data_type}")

            latency = int((datetime.now() - start).total_seconds() * 1000)
            # 判断是否拉到有效值（pe / dividend_yield）
            has_value = any(data.get(k) is not None for k in ("pe", "dividend_yield"))
            if has_value:
                _log_fetch(self.name, data_type, code, "success", 1, latency)
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=True, latency_ms=latency)
            else:
                _log_fetch(self.name, data_type, code, "no_data", 0, latency,
                          data.get("source", "no_data"))
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=False, latency_ms=latency,
                                   error=data.get("source", "no data from csindex_direct"))
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api=f"csindex_direct:{data_type}",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


# ─── V4.1 §10.2 / S5-T10: eastmoney_direct 校验源适配器 ────────────────────────

class EastmoneyDirectAdapter(BaseAdapter):
    """eastmoney_direct 适配器 — 直连东方财富 push2/fund API（不依赖 akshare）。

    V4.1 PRD §10.2 / S5-T10:
        作为权威校验源（validator role），直连东方财富 push2 行情端点 + fund.eastmoney.com
        净值端点，与 akshare 的 eastmoney 子源解耦，避免 akshare 失效时同步失去校验能力。

    支持指标：
        - premium : close / nav - 1（依赖 close + nav 都拉到）
        - nav     : 基金净值历史（api.fund.eastmoney.com/f10/lsjz）
        - price   : ETF 实时最新价（push2.eastmoney.com → push2delay 降级）
    不支持的指标（valuation/dividend）返回 success=False，让上层 fallback。

    限流：内部每次调用 sleep 0.5s（eastmoney 限流相对宽松）。
    """
    name = "eastmoney_direct"

    def is_available(self) -> bool:
        """依赖 httpx 已装即视为可用。"""
        try:
            from services import eastmoney_direct_service
            return eastmoney_direct_service.is_available()
        except Exception:
            return False

    async def fetch(self, data_type: str, code: str, **kwargs) -> FetchResult:
        from services import eastmoney_direct_service
        start = datetime.now()
        if not self.is_available():
            _log_fetch(self.name, data_type, code, "error", 0, 0, "eastmoney_direct 依赖未就绪")
            return FetchResult(source=self.name, source_api="eastmoney_direct:unavailable",
                               data={}, success=False, error="eastmoney_direct 依赖未就绪")
        try:
            if data_type == "premium":
                data = await eastmoney_direct_service.fetch_etf_premium(code)
                api = "eastmoney_direct:push2+lsjz"
            elif data_type == "nav":
                data = await eastmoney_direct_service.fetch_etf_nav(code)
                api = "eastmoney_direct:api.fund.eastmoney.com/f10/lsjz"
            elif data_type == "price":
                data = await eastmoney_direct_service.fetch_etf_close_price(code)
                api = "eastmoney_direct:push2/push2delay/qt/stock/get"
            else:
                # eastmoney_direct 仅支持 premium + nav + price
                _log_fetch(self.name, data_type, code, "skipped", 0, 0,
                          f"eastmoney_direct does not support {data_type}")
                return FetchResult(source=self.name, source_api="eastmoney_direct:unsupported",
                                   data={}, success=False,
                                   error=f"eastmoney_direct does not support {data_type}")

            latency = int((datetime.now() - start).total_seconds() * 1000)
            # 判断是否拉到有效值（close / nav / premium_today）
            has_value = any(data.get(k) is not None for k in ("close", "nav", "premium_today"))
            if has_value:
                _log_fetch(self.name, data_type, code, "success", 1, latency)
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=True, latency_ms=latency)
            else:
                _log_fetch(self.name, data_type, code, "no_data", 0, latency,
                          data.get("source", "no_data"))
                return FetchResult(source=self.name, source_api=api, data=data,
                                   success=False, latency_ms=latency,
                                   error=data.get("source", "no data from eastmoney_direct"))
        except Exception as e:
            latency = int((datetime.now() - start).total_seconds() * 1000)
            _log_fetch(self.name, data_type, code, "error", 0, latency, str(e)[:200])
            return FetchResult(source=self.name, source_api=f"eastmoney_direct:{data_type}",
                               data={}, success=False, latency_ms=latency, error=str(e)[:200])


# 适配器注册表（主路径）
_ADAPTERS: dict[str, BaseAdapter] = {
    "akshare": AkshareAdapter(),
    "tushare": TushareAdapter(),
    "efinance": EfinanceAdapter(),
    "csindex_direct": CsindexDirectAdapter(),        # V4.1 S5-T9
    "eastmoney_direct": EastmoneyDirectAdapter(),    # V4.1 S5-T10
}

# V4.1 §10.4 / S2-T2: AkShare 子源注册表（用于前端展示 + 子源降级）
_AKSHARE_SUB_ADAPTERS: dict[str, _AkshareSubAdapterBase] = {
    "akshare_lg": AkshareLeguAdapter(),
    "akshare_csindex": AkshareCSIndexAdapter(),
    "akshare_eastmoney": AkshareEastmoneyAdapter(),
    "akshare_sina": AkshareSinaAdapter(),
    "akshare_usindex": AkshareUSIndexAdapter(),
}


# ─── 核心管理器 ───────────────────────────────────────────────────────────────

class DataSourceManager:
    """数据源管理器：字段级主备源调度 + 交叉校验 + 数据血缘。"""

    def __init__(self):
        self._adapters = _ADAPTERS
        self._field_config: dict[str, dict[str, list[str]]] = self._load_field_config()

    # ── 字段配置 ──
    def _load_field_config(self) -> dict[str, dict[str, list[str]]]:
        """从数据库加载字段配置（覆盖默认）。"""
        config = {k: {"primary": list(v["primary"]), "backup": list(v["backup"])}
                  for k, v in DEFAULT_FIELD_CONFIG.items()}
        try:
            conn = _get_db()
            try:
                rows = conn.execute(
                    "SELECT field, primary_sources, backup_sources, forced_source FROM field_source_config"
                ).fetchall()
                for field, prim_json, backup_json, forced in rows:
                    config[field] = {
                        "primary": json.loads(prim_json),
                        "backup": json.loads(backup_json),
                    }
                    if forced:
                        config[field]["forced"] = [forced]
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[DS-MGR] Failed to load field config: {e}")
        return config

    def get_field_config(self) -> list[dict]:
        """返回字段配置列表（前端展示用）。"""
        self._field_config = self._load_field_config()  # 重新加载
        result = []
        for field, cfg in self._field_config.items():
            forced = cfg.get("forced")
            result.append({
                "field": field,
                "field_label": _field_label(field),
                "primary_sources": cfg["primary"],
                "backup_sources": cfg["backup"],
                "forced_source": forced[0] if forced else None,
                "available_adapters": list(self._adapters.keys()),
                "adapter_status": {name: {"available": adj.is_available(), **ADAPTER_METADATA.get(name, {})}
                                   for name, adj in self._adapters.items()},
            })
        return result

    def update_field_config(self, field: str, primary: list[str], backup: list[str]) -> bool:
        """更新某字段的主备源配置。"""
        conn = _get_db()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO field_source_config (field, primary_sources, backup_sources, forced_source, updated_at) "
                "VALUES (?, ?, ?, NULL, ?)",
                (field, json.dumps(primary, ensure_ascii=False),
                 json.dumps(backup, ensure_ascii=False), datetime.now().isoformat()),
            )
            conn.commit()
            self._field_config[field] = {"primary": primary, "backup": backup}
            return True
        except Exception as e:
            logger.error(f"[DS-MGR] Failed to update field config: {e}")
            return False
        finally:
            conn.close()

    def force_switch_source(self, field: str, source: Optional[str]) -> bool:
        """强制某字段使用指定源（NULL 清除强制，恢复默认优先级）。"""
        conn = _get_db()
        try:
            # 确保 field 存在
            row = conn.execute(
                "SELECT field FROM field_source_config WHERE field = ?", (field,)
            ).fetchone()
            now = datetime.now().isoformat()
            if row:
                conn.execute(
                    "UPDATE field_source_config SET forced_source = ?, updated_at = ? WHERE field = ?",
                    (source, now, field),
                )
            else:
                cfg = DEFAULT_FIELD_CONFIG.get(field, {"primary": [], "backup": []})
                conn.execute(
                    "INSERT INTO field_source_config (field, primary_sources, backup_sources, forced_source, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (field, json.dumps(cfg["primary"]), json.dumps(cfg["backup"]), source, now),
                )
            conn.commit()
            # 更新内存
            if source:
                self._field_config[field]["forced"] = [source]
            else:
                self._field_config[field].pop("forced", None)
            return True
        except Exception as e:
            logger.error(f"[DS-MGR] Failed to force switch: {e}")
            return False
        finally:
            conn.close()

    # ── 核心取数 + 交叉校验 ──
    async def fetch_with_cross_check(
        self, data_type: str, code: str, **kwargs
    ) -> tuple[dict, CrossCheckResult]:
        """主源拉取 + 备源交叉校验。

        返回 (final_data, cross_check_result)。
        final_data 是最终采用的数据（主源优先，主源失败/异常则用备源）。
        """
        cfg = self._field_config.get(data_type, {"primary": ["akshare"], "backup": []})
        # forced 覆盖优先级
        if cfg.get("forced"):
            sources_to_try = cfg["forced"] + cfg["backup"]
        else:
            sources_to_try = cfg["primary"] + cfg["backup"]

        # 拉主源
        primary_result = await self._fetch_from(data_type, code, sources_to_try[0], **kwargs)
        # 拉备源（如果有，且主源成功才做交叉校验；主源失败时备源作为 fallback）
        backup_result: Optional[FetchResult] = None
        if len(sources_to_try) > 1:
            backup_name = sources_to_try[1]
            backup_result = await self._fetch_from(data_type, code, backup_name, **kwargs)

        # 决定最终数据 + 构造交叉校验结果
        final_data, check_result = self._resolve(
            data_type, code, primary_result, backup_result, kwargs
        )
        # 记录交叉校验日志
        self._record_cross_check(check_result)
        return final_data, check_result

    async def _fetch_from(self, data_type: str, code: str, source_name: str, **kwargs) -> FetchResult:
        adapter = self._adapters.get(source_name)
        if not adapter:
            return FetchResult(source=source_name, source_api="unknown", data={},
                               success=False, error=f"adapter {source_name} not registered")
        # V4.1 S5-T3: 检查数据源是否启用（停用的源跳过）
        if not is_data_source_enabled(source_name):
            _log_fetch(source_name, data_type, code, "skipped", 0, 0, "source disabled by user")
            return FetchResult(source=source_name, source_api="disabled", data={},
                               success=False, error=f"adapter {source_name} disabled by user")
        if not adapter.is_available():
            return FetchResult(source=source_name, source_api="unavailable", data={},
                               success=False, error=f"adapter {source_name} not available")
        return await adapter.fetch(data_type, code, **kwargs)

    def _resolve(
        self, data_type: str, code: str,
        primary: FetchResult, backup: Optional[FetchResult], kwargs: dict,
    ) -> tuple[dict, CrossCheckResult]:
        """根据主备源结果决定最终数据 + 构造交叉校验结果。"""
        threshold_key = _threshold_key_for(data_type)
        threshold = CROSS_CHECK_THRESHOLDS.get(threshold_key, {"type": "pct", "max_diff": 5.0, "unit": "%"})
        value_field = _value_field_for(data_type)

        primary_value = _extract_value(primary.data, data_type) if primary.success else None
        backup_value = _extract_value(backup.data, data_type) if (backup and backup.success) else None

        # V4.1 §10.9 / S2-T5: 单源场景判定
        # - 无备源配置
        # - 备源未注册 / 不可用 / 拉取失败
        # - 双源都失败时不算单源（那是 blocked）
        no_backup_configured = backup is None
        backup_failed = backup is not None and backup_value is None
        single_source = (no_backup_configured or backup_failed) and primary_value is not None

        # 主源失败 → 用备源
        if primary_value is None:
            if backup_value is not None:
                quality = "primary_failed"
                final_data = backup.data
                # 主源失败、备源成功：仍是单源场景（主源不可用，只剩备源）
                single_source = True
            else:
                quality = "both_failed"
                final_data = primary.data if primary.data else (backup.data if backup else {})
                single_source = False  # both failed 不算单源，是 blocked
        elif backup_value is None:
            # 主源成功，备源失败/无备源
            quality = "no_backup" if backup is None else "backup_failed"
            final_data = primary.data
        else:
            # 双源都成功 → 交叉校验
            diff_abs, diff_pct, diff_pp = _calc_diff(primary_value, backup_value, threshold["type"])
            in_tol = diff_pct <= threshold["max_diff"] if threshold["type"] == "pct" else diff_pp <= threshold["max_diff"]
            quality = "passed" if in_tol else "source_inconsistent"
            # V4.1 §10.9 / S2-T8: 主备源冲突熔断标志 — 主备源差异超阈值
            source_conflict = not in_tol
            # 即使不一致，仍以主源为准（策略书§4.4：不自动生成强买卖建议，但主源数据优先）
            final_data = primary.data

            check = CrossCheckResult(
                field=data_type, code=code,
                primary_source=primary.source, backup_source=backup.source,
                primary_value=primary_value, backup_value=backup_value,
                diff_abs=diff_abs, diff_pct=diff_pct, diff_pp=diff_pp,
                threshold_type=threshold["type"], threshold_max=threshold["max_diff"],
                in_tolerance=in_tol, quality_status=quality,
                trade_date=str(primary.data.get("date", "")),
                notes=_build_notes(data_type, primary_value, backup_value, diff_pct, diff_pp, in_tol),
                source_conflict=source_conflict,
                single_source_warning=False,  # 双源都成功，不是单源
            )
            return final_data, check

        # 主源或备源失败的情况
        check = CrossCheckResult(
            field=data_type, code=code,
            primary_source=primary.source,
            backup_source=backup.source if backup else "none",
            primary_value=primary_value, backup_value=backup_value,
            diff_abs=None, diff_pct=None, diff_pp=None,
            threshold_type=threshold["type"], threshold_max=threshold["max_diff"],
            in_tolerance=False, quality_status=quality,
            trade_date=str(primary.data.get("date", "") if primary.data else ""),
            notes=_build_failure_notes(primary, backup, quality),
            source_conflict=False,
            single_source_warning=single_source,
        )
        return final_data, check

    # ── V4.1 §10.9 / S2-T3: 熔断降级链路 ──
    async def fetch_with_fallback(
        self, data_type: str, code: str, **kwargs
    ) -> FallbackResult:
        """三级熔断降级：主源 → 备源 → 最近有效缓存（stale=true）→ 阻断。

        与 fetch_with_cross_check 的区别：
        - fetch_with_cross_check: 主源+备源同时拉取，做交叉校验（用于数据质量评估）
        - fetch_with_fallback:    按优先级顺序尝试，主源失败才拉备源（节省请求 + 自动降级）

        V4.1 §10.9 完整降级链路：
            1. 主源 → 成功即返回
            2. 主源失败 → 依次尝试所有备源
            3. 所有源失败 → 读最近缓存，stale=true
            4. 缓存过期 (>3 日) 或无缓存 → blocked=true，规则引擎不出建议

        返回 FallbackResult，含 source_fallback/stale/blocked/single_source_warning/source_conflict 标志。
        """
        cfg = self._field_config.get(data_type, {"primary": ["akshare"], "backup": []})
        # forced 覆盖优先级
        if cfg.get("forced"):
            sources_to_try = list(cfg["forced"]) + list(cfg["backup"])
        else:
            sources_to_try = list(cfg["primary"]) + list(cfg["backup"])

        # 去重保持顺序
        seen = set()
        ordered_sources: list[str] = []
        for s in sources_to_try:
            if s not in seen:
                seen.add(s)
                ordered_sources.append(s)

        if not ordered_sources:
            return FallbackResult(
                data={}, source="none", blocked=True,
                reason="无数据源配置（primary/backup 均为空）",
            )

        # 1. 按优先级尝试每个源
        primary_source_name = ordered_sources[0]
        tried_results: list[FetchResult] = []
        for idx, source_name in enumerate(ordered_sources):
            result = await self._fetch_from(data_type, code, source_name, **kwargs)
            tried_results.append(result)
            if result.is_valid:
                # 成功！构造 FallbackResult
                is_fallback = idx > 0  # 不是第一个源就是 fallback
                # 单源场景：如果这是最后一个可用源，标记 single_source_warning
                # 检查剩余源是否都不可用
                remaining_have_valid = False
                for j in range(idx + 1, len(ordered_sources)):
                    later_name = ordered_sources[j]
                    later_adapter = self._adapters.get(later_name)
                    if later_adapter and later_adapter.is_available():
                        # 不实际拉取（避免请求浪费），仅基于 adapter.is_available() 估计
                        remaining_have_valid = True
                        break
                single_source = not remaining_have_valid

                reason_parts: list[str] = []
                if is_fallback:
                    failed_names = [ordered_sources[k] for k in range(idx)]
                    reason_parts.append(f"主源 {'/'.join(failed_names)} 失败，降级至 {source_name}")
                if single_source:
                    reason_parts.append("仅此源可用（单源场景）")

                return FallbackResult(
                    data=result.data,
                    source=result.source,
                    source_api=result.source_api,
                    source_fallback=is_fallback,
                    stale=False,
                    blocked=False,
                    single_source_warning=single_source,
                    source_conflict=False,
                    reason="；".join(reason_parts) if reason_parts else "主源成功",
                )

        # 2. 所有源都失败 → 读最近缓存
        last_errors = [r.error[:60] for r in tried_results if r.error]
        cache_data, cache_age_days, cache_source = self._read_latest_cache(code, data_type)

        if cache_data and cache_age_days <= 3:
            # 缓存可接受（<=3 日），返回 stale=true
            return FallbackResult(
                data=cache_data,
                source=f"cache:{cache_source}",
                source_api="cache:market_data_cache",
                source_fallback=True,
                stale=True,
                stale_age_days=cache_age_days,
                blocked=False,
                single_source_warning=True,  # 缓存降级时也是单源场景
                source_conflict=False,
                reason=f"所有源失败({'；'.join(last_errors)[:120]})，使用 {cache_age_days} 日前缓存",
            )

        # 3. 缓存过期或无缓存 → 阻断
        if cache_data:
            return FallbackResult(
                data=cache_data,  # 仍返回过期缓存供前端展示
                source=f"cache:{cache_source}",
                source_api="cache:market_data_cache",
                source_fallback=True,
                stale=True,
                stale_age_days=cache_age_days,
                blocked=True,
                single_source_warning=True,
                source_conflict=False,
                reason=f"所有源失败且缓存过期({cache_age_days} 日)，阻断强规则",
            )
        # 完全无数据
        return FallbackResult(
            data={}, source="none", blocked=True,
            single_source_warning=False,
            reason=f"所有源失败且无缓存：{'；'.join(last_errors)[:150]}",
        )

    def _read_latest_cache(self, code: str, data_type: str) -> tuple[dict, int, str]:
        """读取 market_data_cache 中最近的缓存数据。

        返回 (data_dict, age_days, source_name)。无缓存返回 ({}, 999, "")。
        """
        try:
            conn = _get_db()
            conn.row_factory = sqlite3.Row
            try:
                row = conn.execute(
                    """SELECT data_json, updated_at, source FROM market_data_cache
                       WHERE code = ? AND data_type = ?
                       ORDER BY updated_at DESC LIMIT 1""",
                    (code, data_type),
                ).fetchone()
                if not row or not row["data_json"]:
                    return {}, 999, ""
                import json as _json
                data = _json.loads(row["data_json"])
                # 计算过期天数
                updated_at = row["updated_at"] or ""
                age_days = 999
                if updated_at:
                    try:
                        updated_dt = datetime.fromisoformat(updated_at)
                        age_days = (datetime.now() - updated_dt).days
                    except (ValueError, TypeError):
                        pass
                return data, age_days, row["source"] or "unknown"
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[DS-MGR] _read_latest_cache({code},{data_type}) error: {e}")
            return {}, 999, ""

    # ── V4.1 §10.4 / S2-T2: 子源管理 ──
    def get_sub_adapters(self) -> list[dict]:
        """返回 AkShare 子源列表（用于前端展开展示）。"""
        result = []
        for name, adapter in _AKSHARE_SUB_ADAPTERS.items():
            meta = AKSHARE_SUB_SOURCE_METADATA.get(name, {})
            result.append({
                "name": name,
                "display_name": meta.get("name", name),
                "parent": meta.get("parent", "akshare"),
                "description": meta.get("description", ""),
                "supports": meta.get("supports", ""),
                "available": adapter.is_available(),
            })
        return result

    # ── 交叉校验日志 ──
    def _record_cross_check(self, result: CrossCheckResult) -> None:
        try:
            conn = _get_db()
            try:
                # 1. 写 cross_check_log（老表，保留兼容）
                conn.execute(
                    """INSERT INTO cross_check_log
                       (fetch_time, field, code, primary_source, backup_source,
                        primary_value, backup_value, diff_abs, diff_pct, diff_pp,
                        threshold_type, threshold_max, in_tolerance, quality_status,
                        trade_date, notes)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (result.fetch_time, result.field, result.code,
                     result.primary_source, result.backup_source,
                     result.primary_value, result.backup_value,
                     result.diff_abs, result.diff_pct, result.diff_pp,
                     result.threshold_type, result.threshold_max,
                     1 if result.in_tolerance else 0, result.quality_status,
                     result.trade_date, result.notes),
                )
                # 2. V4.1 §13.7: 写 source_compare_result（标准化表，PRD schema）
                diff_value = result.diff_abs
                diff_pct_for_table = result.diff_pct if result.diff_pct is not None else result.diff_pp
                conn.execute(
                    """INSERT INTO source_compare_result
                       (code, trade_date, metric_type, primary_source, backup_source,
                        primary_value, backup_value, diff_value, diff_pct,
                        threshold, compare_status, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (result.code, result.trade_date, result.field,
                     result.primary_source, result.backup_source,
                     result.primary_value, result.backup_value,
                     diff_value, diff_pct_for_table,
                     result.threshold_max, result.quality_status,
                     result.fetch_time),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[DS-MGR] Failed to record cross check log: {e}")

    # ── 数据血缘 ──
    def get_lineage(self, code: str, data_type: str) -> dict:
        """查询某条数据的数据血缘（从 market_data_cache）。"""
        try:
            conn = _get_db()
            conn.row_factory = sqlite3.Row
            try:
                row = conn.execute(
                    """SELECT date, code, data_type, data_json, updated_at,
                              raw_value, clean_value, source, source_api, is_valid,
                              abnormal_reason, sample_days, percentile_window, percentile,
                              trade_date, fetch_time
                       FROM market_data_cache
                       WHERE code = ? AND data_type = ?
                       ORDER BY updated_at DESC LIMIT 1""",
                    (code, data_type),
                ).fetchone()
                if not row:
                    return {"found": False, "message": f"no cache for {code}/{data_type}"}
                return {
                    "found": True,
                    "code": code,
                    "data_type": data_type,
                    "date": row["date"],
                    "raw_value": row["raw_value"],
                    "clean_value": row["clean_value"],
                    "source": row["source"],
                    "source_api": row["source_api"],
                    "is_valid": bool(row["is_valid"]) if row["is_valid"] is not None else True,
                    "abnormal_reason": row["abnormal_reason"] or "",
                    "sample_days": row["sample_days"] or 0,
                    "percentile_window": row["percentile_window"] or "",
                    "percentile": row["percentile"],
                    "trade_date": row["trade_date"] or "",
                    "fetch_time": row["fetch_time"] or row["updated_at"],
                    "data_json": row["data_json"],
                }
            finally:
                conn.close()
        except Exception as e:
            logger.error(f"[DS-MGR] get_lineage error: {e}")
            return {"found": False, "message": str(e)}

    # ── 交叉校验历史查询 ──
    def get_cross_check_history(self, limit: int = 50, field: Optional[str] = None,
                                 code: Optional[str] = None) -> list[dict]:
        try:
            conn = _get_db()
            conn.row_factory = sqlite3.Row
            try:
                sql = """SELECT fetch_time, field, code, primary_source, backup_source,
                                primary_value, backup_value, diff_abs, diff_pct, diff_pp,
                                threshold_type, threshold_max, in_tolerance, quality_status,
                                trade_date, notes
                         FROM cross_check_log WHERE 1=1"""
                params: list = []
                if field:
                    sql += " AND field = ?"
                    params.append(field)
                if code:
                    sql += " AND code = ?"
                    params.append(code)
                sql += " ORDER BY fetch_time DESC LIMIT ?"
                params.append(limit)
                rows = conn.execute(sql, params).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()
        except Exception as e:
            logger.error(f"[DS-MGR] get_cross_check_history error: {e}")
            return []

    def get_cross_check_stats(self) -> dict:
        """交叉校验统计（用于前端概览）。"""
        try:
            conn = _get_db()
            try:
                total = conn.execute("SELECT COUNT(*) FROM cross_check_log").fetchone()[0]
                passed = conn.execute("SELECT COUNT(*) FROM cross_check_log WHERE quality_status='passed'").fetchone()[0]
                inconsistent = conn.execute("SELECT COUNT(*) FROM cross_check_log WHERE quality_status='source_inconsistent'").fetchone()[0]
                primary_failed = conn.execute("SELECT COUNT(*) FROM cross_check_log WHERE quality_status='primary_failed'").fetchone()[0]
                backup_failed = conn.execute("SELECT COUNT(*) FROM cross_check_log WHERE quality_status='backup_failed'").fetchone()[0]
                both_failed = conn.execute("SELECT COUNT(*) FROM cross_check_log WHERE quality_status='both_failed'").fetchone()[0]
                last = conn.execute("SELECT MAX(fetch_time) FROM cross_check_log").fetchone()[0] or ""
                return {
                    "total": total, "passed": passed, "inconsistent": inconsistent,
                    "primary_failed": primary_failed, "backup_failed": backup_failed,
                    "both_failed": both_failed, "last_check_time": last,
                    "pass_rate": round(passed / total * 100, 1) if total > 0 else 0,
                }
            finally:
                conn.close()
        except Exception as e:
            logger.error(f"[DS-MGR] get_cross_check_stats error: {e}")
            return {"total": 0, "passed": 0, "inconsistent": 0, "primary_failed": 0,
                    "backup_failed": 0, "both_failed": 0, "last_check_time": "",
                    "pass_rate": 0}

    # ── 数据源状态汇总 ──
    def get_sources_overview(self) -> list[dict]:
        """所有适配器状态概览（前端数据源列表用）。"""
        result = []
        for name, adapter in self._adapters.items():
            meta = ADAPTER_METADATA.get(name, {})
            result.append({
                "name": name,
                "display_name": meta.get("name", name),
                "role": meta.get("role", "reference"),
                "description": meta.get("description", ""),
                "sub_sources": meta.get("sub_sources", ""),
                "needs_token": meta.get("needs_token", "false") == "true",
                "available": adapter.is_available(),
                "status": "active" if adapter.is_available() else "unconfigured",
            })
        # 加上未实现的 reference 源（csindex_direct / eastmoney_direct）
        for name, meta in ADAPTER_METADATA.items():
            if name not in self._adapters:
                result.append({
                    "name": name,
                    "display_name": meta.get("name", name),
                    "role": meta.get("role", "reference"),
                    "description": meta.get("description", ""),
                    "sub_sources": meta.get("sub_sources", ""),
                    "needs_token": meta.get("needs_token") == "true",
                    "available": False,
                    "status": "planned",
                })
        return result


# ─── 辅助函数 ─────────────────────────────────────────────────────────────────

def _field_label(field: str) -> str:
    return {
        "valuation": "指数估值 PE/PB",
        "premium": "ETF 溢价率",
        "nav": "基金净值",
        "dividend": "股息率",
        "price": "ETF 行情价",
    }.get(field, field)


def _threshold_key_for(data_type: str) -> str:
    return {
        "valuation": "pe_pb_raw",
        "premium": "qdii_premium",
        "nav": "fund_nav",
        "dividend": "dividend_yield",
        "price": "etf_close_price",
    }.get(data_type, "pe_pb_raw")


def _value_field_for(data_type: str) -> str:
    return {
        "valuation": "pe",
        "premium": "premium_today",
        "nav": "nav",
        "dividend": "dividend_yield",
        "price": "close",
    }.get(data_type, "value")


def _extract_value(data: dict, data_type: str) -> Optional[float]:
    """从 fetch 结果里提取用于交叉校验的标量值。"""
    if not data:
        return None
    key = _value_field_for(data_type)
    v = data.get(key)
    if v is None:
        return None
    try:
        x = float(v)
        if math.isnan(x) or math.isinf(x) or abs(x) >= 999999:
            return None
        return x
    except (TypeError, ValueError):
        return None


def _calc_diff(primary: float, backup: float, threshold_type: str) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """计算绝对差 / 百分比差 / 百分点差。"""
    diff_abs = abs(primary - backup)
    if threshold_type == "pct":
        diff_pct = round(diff_abs / abs(primary) * 100, 4) if primary != 0 else None
        diff_pp = None
    else:  # pp
        diff_pct = None
        diff_pp = round(diff_abs, 4)
    return round(diff_abs, 4), diff_pct, diff_pp


def _build_notes(data_type: str, primary: float, backup: float,
                 diff_pct: Optional[float], diff_pp: Optional[float], in_tol: bool) -> str:
    if in_tol:
        return f"主备源一致（差异在容忍范围内）"
    if diff_pct is not None:
        return f"主备源差异 {diff_pct}% 超阈值，建议人工确认"
    if diff_pp is not None:
        return f"主备源差异 {diff_pp}pp 超阈值，建议人工确认"
    return "主备源不一致"


def _build_failure_notes(primary: FetchResult, backup: Optional[FetchResult], quality: str) -> str:
    if quality == "both_failed":
        return f"主源({primary.source})与备源({backup.source if backup else 'none'})均失败"
    if quality == "primary_failed":
        return f"主源({primary.source})失败: {primary.error[:80]}，已切备源({backup.source if backup else 'none'})"
    if quality == "backup_failed":
        return f"备源({backup.source if backup else 'none'})失败: {(backup.error[:80] if backup else '')}，仅用主源"
    if quality == "no_backup":
        return "无备源配置，仅用主源"
    return ""


# ─── 单例 ─────────────────────────────────────────────────────────────────────

_manager: Optional[DataSourceManager] = None


def get_manager() -> DataSourceManager:
    """获取全局 DataSourceManager 单例。"""
    global _manager
    if _manager is None:
        _manager = DataSourceManager()
    return _manager


# ─── V4.1 §13.3 / S5-T1: data_source 注册表初始化 + 迁移 ──────────────────────

# 默认注册表数据（从 ADAPTER_METADATA 派生）
_DEFAULT_DATA_SOURCE_ROWS: list[dict] = [
    {
        "id": "akshare", "name": "AkShare", "role": "primary",
        "description": "主数据源：聚合乐咕乐股/中证指数/东方财富/新浪（免费，无需 token）",
        "sub_sources": "lg,csindex,eastmoney,sina", "needs_token": 0,
        "priority": 10, "rate_limit_per_min": 60, "api_key_encrypted": None,
        "supported_metrics": '["valuation","premium","nav","dividend","price"]',
        "is_enabled": 1, "homepage": "https://akshare.akfamily.xyz/",
    },
    {
        "id": "tushare", "name": "Tushare Pro", "role": "backup",
        "description": "备源：指数行情/基金净值/指数指标（需 token，积分制）",
        "sub_sources": "fund_daily,fund_nav,index_dailybasic", "needs_token": 1,
        "priority": 30, "rate_limit_per_min": 120, "api_key_encrypted": None,
        "supported_metrics": '["valuation","premium","nav","dividend"]',
        "is_enabled": 1, "homepage": "https://tushare.pro/",
    },
    {
        "id": "efinance", "name": "Efinance", "role": "backup",
        "description": "免费免 Token 备源：ETF 行情/基金净值（独立端点，主源限流时降级）",
        "sub_sources": "fund.eastmoney,stock.eastmoney", "needs_token": 0,
        "priority": 20, "rate_limit_per_min": 60, "api_key_encrypted": None,
        "supported_metrics": '["premium","nav","price"]',
        "is_enabled": 1, "homepage": "https://github.com/Micro-sheep/efinance",
    },
    {
        "id": "csindex_direct", "name": "中证指数官网", "role": "validator",
        "description": "权威校验源：指数估值/股息率/样本（直连，不依赖 akshare）",
        "sub_sources": "csindex.com.cn", "needs_token": 0,
        "priority": 40, "rate_limit_per_min": 30, "api_key_encrypted": None,
        "supported_metrics": '["valuation","dividend"]',
        "is_enabled": 1, "homepage": "https://www.csindex.com.cn/",
    },
    {
        "id": "eastmoney_direct", "name": "东方财富 Web", "role": "validator",
        "description": "权威校验源：ETF 行情/净值/折溢价（直连，不依赖 akshare）",
        "sub_sources": "push2.eastmoney.com", "needs_token": 0,
        "priority": 50, "rate_limit_per_min": 60, "api_key_encrypted": None,
        "supported_metrics": '["premium","nav","price"]',
        "is_enabled": 1, "homepage": "https://push2.eastmoney.com/",
    },
]


def _init_data_source_registry() -> None:
    """S5-T1: 初始化 data_source 注册表（幂等，仅插入缺失行，不覆盖已有 token）。"""
    try:
        conn = _get_db()
        now = datetime.now().isoformat()
        try:
            for row in _DEFAULT_DATA_SOURCE_ROWS:
                # 检查是否已存在
                existing = conn.execute(
                    "SELECT id FROM data_source WHERE id = ?", (row["id"],)
                ).fetchone()
                if existing:
                    # 已存在：只更新非敏感字段（保留 api_key_encrypted / is_enabled 等用户配置）
                    conn.execute(
                        """UPDATE data_source SET
                           name = ?, role = ?, description = ?, sub_sources = ?,
                           needs_token = ?, priority = ?, rate_limit_per_min = ?,
                           supported_metrics = ?, homepage = ?, updated_at = ?
                           WHERE id = ?""",
                        (row["name"], row["role"], row["description"], row["sub_sources"],
                         row["needs_token"], row["priority"], row["rate_limit_per_min"],
                         row["supported_metrics"], row["homepage"], now, row["id"]),
                    )
                else:
                    # 新增
                    conn.execute(
                        """INSERT INTO data_source
                           (id, name, role, description, sub_sources, needs_token,
                            priority, rate_limit_per_min, api_key_encrypted,
                            supported_metrics, is_enabled, homepage, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (row["id"], row["name"], row["role"], row["description"],
                         row["sub_sources"], row["needs_token"], row["priority"],
                         row["rate_limit_per_min"], row["api_key_encrypted"],
                         row["supported_metrics"], row["is_enabled"], row["homepage"],
                         now, now),
                    )
            conn.commit()
            logger.info("[DS-MGR] data_source registry initialized/updated")
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] _init_data_source_registry failed: {e}")


def _init_data_source_capability() -> None:
    """S5-T2: 初始化 data_source_capability 表（从 DEFAULT_FIELD_CONFIG 派生三角色配置）。"""
    try:
        conn = _get_db()
        now = datetime.now().isoformat()
        try:
            # 从 DEFAULT_FIELD_CONFIG 派生 primary/backup 角色
            for metric_type, cfg in DEFAULT_FIELD_CONFIG.items():
                for primary_src in cfg["primary"]:
                    # upsert：标记 is_primary
                    conn.execute(
                        """INSERT INTO data_source_capability
                           (source_id, metric_type, is_primary, is_backup, is_validator, asset_scope, notes, created_at)
                           VALUES (?, ?, 1, 0, 0, 'all', 'primary from DEFAULT_FIELD_CONFIG', ?)
                           ON CONFLICT(source_id, metric_type) DO UPDATE SET
                             is_primary = 1, asset_scope = 'all'""",
                        (primary_src, metric_type, now),
                    )
                for backup_src in cfg["backup"]:
                    conn.execute(
                        """INSERT INTO data_source_capability
                           (source_id, metric_type, is_primary, is_backup, is_validator, asset_scope, notes, created_at)
                           VALUES (?, ?, 0, 1, 0, 'all', 'backup from DEFAULT_FIELD_CONFIG', ?)
                           ON CONFLICT(source_id, metric_type) DO UPDATE SET
                             is_backup = 1, asset_scope = 'all'""",
                        (backup_src, metric_type, now),
                    )
            # validator 角色：csindex_direct → valuation+dividend, eastmoney_direct → premium+nav+price
            for metric_type in ("valuation", "dividend"):
                conn.execute(
                    """INSERT INTO data_source_capability
                       (source_id, metric_type, is_primary, is_backup, is_validator, asset_scope, notes, created_at)
                       VALUES ('csindex_direct', ?, 0, 0, 1, 'domestic', 'validator for domestic index valuation', ?)
                       ON CONFLICT(source_id, metric_type) DO UPDATE SET is_validator = 1""",
                    (metric_type, now),
                )
            for metric_type in ("premium", "nav", "price"):
                conn.execute(
                    """INSERT INTO data_source_capability
                       (source_id, metric_type, is_primary, is_backup, is_validator, asset_scope, notes, created_at)
                       VALUES ('eastmoney_direct', ?, 0, 0, 1, 'all', 'validator for ETF market data', ?)
                       ON CONFLICT(source_id, metric_type) DO UPDATE SET is_validator = 1""",
                    (metric_type, now),
                )
            conn.commit()
            logger.info("[DS-MGR] data_source_capability initialized/updated")
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] _init_data_source_capability failed: {e}")


# ─── V4.1 §13.3 / S5-T11: Fernet 加密工具 ─────────────────────────────────────

_fernet_key: Optional[bytes] = None


def _get_fernet_key() -> bytes:
    """获取 Fernet 加密密钥（从环境变量 DATA_SERVICE_FERNET_KEY 读，不存在则生成并缓存到本地文件）。"""
    global _fernet_key
    if _fernet_key is not None:
        return _fernet_key

    # 1. 优先从环境变量读
    env_key = os.environ.get("DATA_SERVICE_FERNET_KEY", "")
    if env_key:
        try:
            _fernet_key = env_key.encode("utf-8")
            return _fernet_key
        except Exception:
            pass

    # 2. 从本地文件读（持久化避免重启后密钥变化导致旧密文无法解密）
    key_file = os.path.join(os.path.dirname(DB_PATH), ".fernet_key")
    try:
        if os.path.exists(key_file):
            with open(key_file, "rb") as f:
                _fernet_key = f.read().strip()
                if _fernet_key:
                    return _fernet_key

        # 生成新密钥
        from cryptography.fernet import Fernet
        new_key = Fernet.generate_key()
        # 文件权限 600
        with open(key_file, "wb") as f:
            f.write(new_key)
        try:
            os.chmod(key_file, 0o600)
        except Exception:
            pass
        _fernet_key = new_key
        logger.info(f"[DS-MGR] Generated new Fernet key at {key_file}")
        return _fernet_key
    except ImportError:
        logger.warning("[DS-MGR] cryptography not installed, token encryption disabled")
        _fernet_key = b""
        return _fernet_key
    except Exception as e:
        logger.error(f"[DS-MGR] _get_fernet_key failed: {e}")
        _fernet_key = b""
        return _fernet_key


def encrypt_token(plaintext: str) -> str:
    """加密 token，返回密文字符串。失败时返回原文（向后兼容）。"""
    if not plaintext:
        return ""
    key = _get_fernet_key()
    if not key:
        return plaintext  # 加密不可用，返回原文
    try:
        from cryptography.fernet import Fernet
        f = Fernet(key)
        return f.encrypt(plaintext.encode("utf-8")).decode("utf-8")
    except Exception as e:
        logger.warning(f"[DS-MGR] encrypt_token failed: {e}")
        return plaintext


def decrypt_token(ciphertext: str) -> str:
    """解密 token，返回明文字符串。失败时返回原文（向后兼容）。"""
    if not ciphertext:
        return ""
    key = _get_fernet_key()
    if not key:
        return ciphertext  # 加密不可用，返回原文
    try:
        from cryptography.fernet import Fernet
        f = Fernet(key)
        return f.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except Exception as e:
        # 解密失败可能是旧明文 token，直接返回
        logger.warning(f"[DS-MGR] decrypt_token failed (returning raw): {e}")
        return ciphertext


def is_token_encrypted(value: str) -> bool:
    """判断字符串是否是 Fernet 加密格式（以 gAAAA 开头的 base64）。"""
    if not value:
        return False
    return value.startswith("gAAAA") and len(value) > 50


# ─── V4.1 §13.3 / S5-T1: data_source 注册表 CRUD ──────────────────────────────

def list_data_sources() -> list[dict]:
    """列出所有数据源（含 capability 信息）。"""
    _init_data_source_registry()
    _init_data_source_capability()
    try:
        conn = _get_db()
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT * FROM data_source ORDER BY priority ASC, id ASC"
            ).fetchall()
            result = []
            for r in rows:
                # 解析 supported_metrics JSON
                metrics = []
                try:
                    import json as _json
                    metrics = _json.loads(r["supported_metrics"]) if r["supported_metrics"] else []
                except Exception:
                    metrics = []
                # 读 capability
                caps = conn.execute(
                    "SELECT metric_type, is_primary, is_backup, is_validator, asset_scope FROM data_source_capability WHERE source_id = ?",
                    (r["id"],),
                ).fetchall()
                result.append({
                    "id": r["id"],
                    "name": r["name"],
                    "role": r["role"],
                    "description": r["description"] or "",
                    "sub_sources": r["sub_sources"] or "",
                    "needs_token": bool(r["needs_token"]),
                    "priority": r["priority"],
                    "rate_limit_per_min": r["rate_limit_per_min"],
                    "has_token": bool(r["api_key_encrypted"]),
                    "supported_metrics": metrics,
                    "is_enabled": bool(r["is_enabled"]),
                    "homepage": r["homepage"] or "",
                    "capabilities": [
                        {
                            "metric_type": c["metric_type"],
                            "is_primary": bool(c["is_primary"]),
                            "is_backup": bool(c["is_backup"]),
                            "is_validator": bool(c["is_validator"]),
                            "asset_scope": c["asset_scope"] or "",
                        }
                        for c in caps
                    ],
                    # 最近拉取状态（从 data_source_status 读，S5-T5）
                    "last_status": _get_latest_status_for_source(r["id"]),
                })
            return result
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] list_data_sources error: {e}")
        return []


def _get_latest_status_for_source(source_id: str) -> dict:
    """S5-T5: 从 data_source_status 表读最近拉取状态。

    data_source_status.source_name 历史用 display_name（"AkShare"），
    新写日志用 adapter id（"akshare"），故同时按 id + display_name 兜底查询。
    """
    # 拿到 display_name 兜底
    display_name = ""
    meta = ADAPTER_METADATA.get(source_id, {})
    if meta:
        display_name = meta.get("name", "")
    candidates = [source_id]
    if display_name and display_name != source_id:
        candidates.append(display_name)
    try:
        conn = _get_db()
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join(["?"] * len(candidates))
            row = conn.execute(
                f"""SELECT last_fetch_time, last_success_time, status, error_message, latency_ms
                   FROM data_source_status WHERE source_name IN ({placeholders})
                   ORDER BY created_at DESC LIMIT 1""",
                candidates,
            ).fetchone()
            if row:
                return {
                    "last_fetch_time": row["last_fetch_time"] or "",
                    "last_success_time": row["last_success_time"] or "",
                    "status": row["status"] or "",
                    "error_message": row["error_message"] or "",
                    "latency_ms": row["latency_ms"] or 0,
                }
            return {}
        finally:
            conn.close()
    except Exception:
        return {}


def set_data_source_enabled(source_id: str, enabled: bool) -> bool:
    """S5-T3: 启用/停用数据源。"""
    _init_data_source_registry()
    try:
        conn = _get_db()
        now = datetime.now().isoformat()
        try:
            cur = conn.execute(
                "UPDATE data_source SET is_enabled = ?, updated_at = ? WHERE id = ?",
                (1 if enabled else 0, now, source_id),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] set_data_source_enabled error: {e}")
        return False


def set_data_source_token(source_id: str, token_plaintext: str) -> bool:
    """S5-T11: 设置数据源 token（加密存储）。"""
    _init_data_source_registry()
    try:
        conn = _get_db()
        now = datetime.now().isoformat()
        encrypted = encrypt_token(token_plaintext) if token_plaintext else ""
        try:
            cur = conn.execute(
                "UPDATE data_source SET api_key_encrypted = ?, updated_at = ? WHERE id = ?",
                (encrypted, now, source_id),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] set_data_source_token error: {e}")
        return False


def get_data_source_token(source_id: str) -> str:
    """S5-T11: 读取数据源 token（解密返回明文）。供 tushare_service 调用。"""
    _init_data_source_registry()
    try:
        conn = _get_db()
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT api_key_encrypted FROM data_source WHERE id = ?",
                (source_id,),
            ).fetchone()
            if not row or not row["api_key_encrypted"]:
                return ""
            return decrypt_token(row["api_key_encrypted"])
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"[DS-MGR] get_data_source_token error: {e}")
        return ""


def is_data_source_enabled(source_id: str) -> bool:
    """检查数据源是否启用（供 fetch_with_fallback 用，跳过禁用的源）。"""
    try:
        conn = _get_db()
        try:
            row = conn.execute(
                "SELECT is_enabled FROM data_source WHERE id = ?",
                (source_id,),
            ).fetchone()
            if row is None:
                # 表里没有 → 默认启用（向后兼容）
                return True
            return bool(row[0])
        finally:
            conn.close()
    except Exception:
        return True

