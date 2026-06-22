"""Configuration for the data-service microservice."""
import os

# Service
SERVICE_PORT = 3031
SERVICE_HOST = "0.0.0.0"

# Database
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, "db")
DB_PATH = os.path.join(DB_DIR, "market_data.db")

# Akshare settings
AKSHARE_ENABLED = True

# Tushare settings (backup data source)
TUSHARE_ENABLED = False
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "")

# Scheduler jobs
SCHEDULED_JOBS = [
    {"id": "valuation_update", "hour": 15, "minute": 30, "description": "Update index PE/PB and percentile data"},
    {"id": "premium_update", "hour": 15, "minute": 30, "description": "Update ETF premium rate data"},
    {"id": "nav_update", "hour": 20, "minute": 0, "description": "Update ETF NAV data"},
    {"id": "dividend_update", "hour": 15, "minute": 30, "description": "Update dividend yield data"},
    {"id": "market_index_update", "hour": 15, "minute": 30, "description": "Update broad market index data"},
    {"id": "history_backfill", "hour": 21, "minute": 0, "description": "Backfill missing historical data"},
    # V4.1 BUG-2026-06-A500-KLINE: 新增 K线定时任务（每日 18:30 收盘后拉 ETF K线/净值历史）
    {"id": "kline_update", "hour": 18, "minute": 30, "description": "Update ETF K-line (OHLCV) data for charts"},
]

# ETF / Index codes tracked by the system
# lg_index_name: 乐咕乐股 index name for PE/PB history (None if not available)
TRACKED_ETFS = {
    "159338": {"name": "中证A500ETF", "category": "domestic", "index_code": "000510", "index_name": "中证A500", "lg_index_name": None},
    "510880": {"name": "红利ETF", "category": "domestic", "index_code": "000015", "index_name": "红利指数", "lg_index_name": "上证红利"},
    "510330": {"name": "沪深300ETF", "category": "domestic", "index_code": "000300", "index_name": "沪深300", "lg_index_name": "沪深300"},
    "588000": {"name": "科创50ETF", "category": "domestic", "index_code": "000688", "index_name": "科创50", "lg_index_name": None},
    "513500": {"name": "标普500ETF", "category": "overseas", "index_code": "SPI", "index_name": "标普500", "lg_index_name": None},
    "513300": {"name": "纳斯达克ETF", "category": "overseas", "index_code": "IXIC", "index_name": "纳斯达克", "lg_index_name": None},
}

# Broad market indices for macro environment monitoring (shown on Trends page)
# These provide market context for investment decisions
MARKET_INDICES = {
    "000001": {
        "name": "上证指数",
        "category": "A股",
        "sina_symbol": "sh000001",
        "reason": "A股大盘风向标，定投国内ETF时参考整体市场温度",
    },
    "399006": {
        "name": "创业板指",
        "category": "A股",
        "sina_symbol": "sz399006",
        "reason": "成长板块代表，与科创50形成对比，判断成长风格强弱",
    },
    "000300": {
        "name": "沪深300",
        "category": "A股",
        "sina_symbol": "sh000300",
        "reason": "大盘蓝筹代表，与沪深300ETF直接相关",
    },
    "HSI": {
        "name": "恒生指数",
        "category": "港股",
        "sina_symbol": "HSI",
        "reason": "港股大盘走势，海外配置参考，反映亚太市场情绪",
    },
}

# Default target ratios
DEFAULT_TARGET_RATIOS = {
    "159338": 0.18,
    "510880": 0.18,
    "510330": 0.12,
    "588000": 0.12,
    "513500": 0.24,
    "513300": 0.16,
}

# Default weekly budget
DEFAULT_WEEKLY_BUDGET = 40000.0

# V4.2 策略书§4: 每周预算分桶比例
BASE_BUCKET_RATIO = 0.40  # 基础定投仓 40%, 只避开硬否决
VALUE_BUCKET_RATIO = 0.60  # 估值增强仓 60%, 受估值/溢价约束
# V4.2 策略书§4.1: base_bucket_ratio 可调范围 30%~50%
BASE_BUCKET_RATIO_MIN = 0.30
BASE_BUCKET_RATIO_MAX = 0.50

# V4.2 策略书§7.3: 单只ETF单周买入上限占本周预算的比例
MAX_SINGLE_ETF_BUY_RATIO = 0.70

# V4.2 策略书§8.4: QDII挂起资金释放计划
QDII_RELEASE_PLAN_WEEKS = 8  # 默认8周分批释放
QDII_RELEASE_PLAN_WEEKS_MIN = 4
QDII_RELEASE_PLAN_WEEKS_MAX = 12
QDII_RELEASE_CAP_MULTIPLIER = 2.0  # 单周释放上限 = min(余额/剩余周数, 正常周预算×2)

# V4.2 策略书§8.1: QDII硬否决条件 — 当日溢价>3% 且 3日均值>2.5%
QDII_PREMIUM_HARD_VETO_TODAY = 3.0  # 当日溢价红线
QDII_PREMIUM_HARD_VETO_3D_AVG = 2.5  # 3日均值确认线

# V4.2 策略书§8.5: 连续N周溢价阻断则提示场外基金
QDII_CONSECUTIVE_BLOCK_WEEKS_THRESHOLD = 4

# V4.2 策略书§3.1: 华宝添益现金子账户类型
CASH_SUBACCOUNT_TYPES = [
    "daily_cash",                    # 日常现金, 不打算投权益
    "weekly_unallocated_cash",       # 本周未分配但仍计划未来投向权益
    "rebalance_equity_reserve",     # 再平衡卖出后暂存, 等待重新配置
    "qdii_pending_cash_sp500",      # 标普500 QDII溢价暂缓买入的钱
    "qdii_pending_cash_nasdaq",     # 纳斯达克 QDII溢价暂缓买入的钱
    "manual_cash",                   # 用户手动指定不参与本系统
]

# Default rules
DEFAULT_RULES = [
    {
        "id": "veto_qdii_premium_redline",
        "name": "QDII溢价红线",
        "type": "veto",
        "thresholdValue": 3.0,
        "thresholdValueMax": None,
        "applicableScope": "specific",
        "applicableCodes": ["513500", "513300"],
        "isEnabled": True,
    },
    # V4.2 策略书§5: PE/PB高估不再硬否决, 改为软风控4档
    # 硬否决只保留: 黑名单 / 数据严重异常 / QDII溢价红线(当日>3%且3日均>2.5%) / 停牌
    {
        "id": "veto_blacklist",
        "name": "资产黑名单",
        "type": "veto",
        "thresholdValue": None,
        "thresholdValueMax": None,
        "applicableScope": "specific",
        "applicableCodes": ["518880"],
        "isEnabled": True,
    },
    {
        "id": "reduce_qdii_premium_warning",
        "name": "QDII溢价预警",
        "type": "reduce",
        "thresholdValue": 2.0,
        "thresholdValueMax": 3.0,
        "applicableScope": "specific",
        "applicableCodes": ["513500", "513300"],
        "isEnabled": True,
    },
    # V4.2 策略书§5.2: 软风控4档(影响增强仓, 不影响基础仓)
    # 第1档 60-80%: 增强仓减量×0.5 (沿用原 reduce 规则)
    {
        "id": "reduce_high_pe_percentile",
        "name": "估值偏高分位(60-80%)",
        "type": "reduce",
        "thresholdValue": 60.0,
        "thresholdValueMax": 80.0,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    # 第2档 80-90%: 禁止增强仓, 仅允许基础仓 (新规则类型 soft_veto_enhancement)
    {
        "id": "soft_pe_high_80_90",
        "name": "估值高估(80-90%禁增强仓)",
        "type": "soft_veto_enhancement",
        "thresholdValue": 80.0,
        "thresholdValueMax": 90.0,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    # 第3档 90-95%: 仅严重欠配时允许极小额基础仓
    {
        "id": "soft_pe_very_high_90_95",
        "name": "估值极高(90-95%仅严重欠配极小额)",
        "type": "soft_veto_enhancement",
        "thresholdValue": 90.0,
        "thresholdValueMax": 95.0,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    # 第4档 >95%: 暂停新增(基础仓+增强仓都停), 除非策略手动允许
    {
        "id": "soft_pe_extreme_95",
        "name": "估值极端(>95%暂停新增)",
        "type": "soft_veto_all",
        "thresholdValue": 95.0,
        "thresholdValueMax": None,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    {
        "id": "reduce_over_concentrated",
        "name": "持仓过度集中",
        "type": "reduce",
        "thresholdValue": 1.5,
        "thresholdValueMax": None,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    {
        "id": "boost_very_low_pe",
        "name": "估值极度低估",
        "type": "boost",
        "thresholdValue": 20.0,
        "thresholdValueMax": None,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
    {
        "id": "boost_large_negative_deviation",
        "name": "负偏离过大",
        "type": "boost",
        "thresholdValue": 0.5,
        "thresholdValueMax": None,
        "applicableScope": "all",
        "applicableCodes": [],
        "isEnabled": True,
    },
]
