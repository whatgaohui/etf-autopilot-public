"""FastAPI application entry point for the data-service microservice.

Runs on port 3031 with CORS enabled for all origins.
Includes all routers and starts APScheduler on startup.
"""
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import DB_DIR, DB_PATH, SERVICE_HOST, SERVICE_PORT
from routers import cached, calculate, data_quality, data_source, health, refresh
from scheduler.jobs import setup_scheduler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Scheduler reference
_scheduler = None


def _init_db():
    """Initialize the SQLite database and create tables if they don't exist."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS market_data_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                code TEXT NOT NULL,
                data_type TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(date, code, data_type)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_market_data_code_type
            ON market_data_cache(code, data_type)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_market_data_date
            ON market_data_cache(date DESC)
            """
        )
        # V4 PRD§12.4: data_source_status 表 — 记录数据源拉取状态
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS data_source_status (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_name TEXT NOT NULL,
                source_type TEXT NOT NULL,
                last_fetch_time TEXT,
                last_success_time TEXT,
                status TEXT,
                error_message TEXT,
                latency_ms INTEGER,
                created_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_data_source_status_name
            ON data_source_status(source_name, created_at DESC)
            """
        )

        # V4.1 PRD §13.5: market_data_raw 表 — 原始数据存储（含 raw_json 完整快照）
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS market_data_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                trade_date TEXT,
                metric_type TEXT NOT NULL,
                source_id TEXT,
                source_api TEXT,
                raw_value TEXT,
                raw_json TEXT,
                fetch_time TEXT NOT NULL,
                request_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_market_data_raw_code ON market_data_raw(code, metric_type, fetch_time DESC);
            CREATE INDEX IF NOT EXISTS idx_market_data_raw_request ON market_data_raw(request_id);
            """
        )

        # V4.1 PRD §13.6: market_data_clean 表 — 清洗后数据（规则引擎只读此表 clean_value）
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS market_data_clean (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                trade_date TEXT,
                metric_type TEXT NOT NULL,
                clean_value REAL,
                source_id TEXT,
                is_valid BOOLEAN,
                abnormal_reason TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(code, trade_date, metric_type, source_id)
            );
            CREATE INDEX IF NOT EXISTS idx_market_data_clean_code ON market_data_clean(code, metric_type, updated_at DESC);
            """
        )

        # V4.1 PRD §13.9: data_fetch_log 表 — 数据拉取日志（request_id 追踪）
        conn.executescript(
            """
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
            """
        )

        # V4.1 PRD §13.7: source_compare_result 表 — 主备源交叉校验结果（标准化）
        conn.executescript(
            """
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
            """
        )

        # V4.1 PRD §13.8: data_quality_result 表由 services/data_quality_score.py 管理（幂等建表）

        # V4.2 策略书§3.1/§15: 现金子账户表
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cash_subaccount (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_type TEXT NOT NULL UNIQUE,
                balance REAL NOT NULL DEFAULT 0,
                counts_as_equity_base BOOLEAN NOT NULL DEFAULT 1,
                description TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cash_subaccount_type ON cash_subaccount(account_type);
            """
        )

        # V4.2 策略书§15: 现金台账表
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cash_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cash_ledger_id TEXT UNIQUE,
                cash_account_type TEXT NOT NULL,
                source_event TEXT NOT NULL,
                source_etf TEXT,
                amount REAL NOT NULL,
                created_at TEXT NOT NULL,
                released_at TEXT,
                status TEXT NOT NULL DEFAULT 'active'
            );
            CREATE INDEX IF NOT EXISTS idx_cash_ledger_type ON cash_ledger(cash_account_type, status);
            CREATE INDEX IF NOT EXISTS idx_cash_ledger_status ON cash_ledger(status, created_at DESC);
            """
        )

        # V4.2: 初始化默认子账户(如果不存在)
        for acct_type in ("daily_cash", "weekly_unallocated_cash", "rebalance_equity_reserve",
                          "qdii_pending_cash_sp500", "qdii_pending_cash_nasdaq", "manual_cash"):
            conn.execute(
                "INSERT OR IGNORE INTO cash_subaccount (account_type, balance, counts_as_equity_base, description, updated_at) VALUES (?, 0, ?, ?, ?)",
                (acct_type,
                 0 if acct_type in ("daily_cash", "manual_cash") else 1,
                 {"daily_cash": "日常现金", "weekly_unallocated_cash": "本周未分配权益现金",
                  "rebalance_equity_reserve": "再平衡权益备用金",
                  "qdii_pending_cash_sp500": "标普500QDII挂起资金",
                  "qdii_pending_cash_nasdaq": "纳斯达克QDII挂起资金",
                  "manual_cash": "用户手动指定现金"}.get(acct_type, ""),
                 datetime.now().isoformat())
            )

        conn.commit()
        logger.info(f"[DB] Database initialized at {DB_PATH} (V4.2 schema: cash_subaccount/cash_ledger)")
    finally:
        conn.close()

    # V4.1 S5-T1/T2: 初始化 data_source 注册表 + capability 表（在 _init_db 之后）
    try:
        from services.data_source_manager import _init_data_source_registry, _init_data_source_capability
        _init_data_source_registry()
        _init_data_source_capability()
    except Exception as e:
        logger.warning(f"[STARTUP] data_source registry init failed (non-blocking): {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown.

    V4: APScheduler 启动放 try-except，失败不影响 HTTP 服务稳定性。
    """
    global _scheduler

    # Startup
    logger.info("[STARTUP] Initializing data-service...")
    _init_db()

    # APScheduler 启动（失败不阻塞 HTTP 服务）
    # V4: 环境不稳定时禁用 APScheduler 确保 HTTP 服务优先（ENABLE_SCHEDULER=1 启用）
    enable_scheduler = os.environ.get("ENABLE_SCHEDULER", "0") == "1"
    if enable_scheduler:
        try:
            _scheduler = setup_scheduler()
            _scheduler.start()
            logger.info("[STARTUP] APScheduler started with daily jobs")
        except Exception as e:
            logger.warning(f"[STARTUP] APScheduler failed to start (HTTP service continues): {e}")
            _scheduler = None
    else:
        logger.info("[STARTUP] APScheduler disabled (ENABLE_SCHEDULER!=1), HTTP service only")

    yield

    # Shutdown
    if _scheduler:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:
            pass
    logger.info("[SHUTDOWN] Shutting down data-service...")


# Create FastAPI app
app = FastAPI(
    title="ETF Data Service",
    description="Python FastAPI microservice for ETF data caching and rule engine calculation",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router)
app.include_router(cached.router)
app.include_router(refresh.router)
app.include_router(calculate.router)
app.include_router(data_source.router)
app.include_router(data_quality.router)


if __name__ == "__main__":
    import uvicorn

    logger.info(f"[MAIN] Starting data-service on {SERVICE_HOST}:{SERVICE_PORT}")
    uvicorn.run(
        app,
        host=SERVICE_HOST,
        port=SERVICE_PORT,
        reload=False,
        log_level="info",
    )
