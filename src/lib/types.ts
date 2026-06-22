// ─── ETF Data Types ───

export interface MarketDataSummary {
  code: string;
  name: string;
  category: string;
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  premiumToday: number | null;
  premium7dAvg: number | null;
  // V4.1 S4-T6: 3日溢价均值（PRD v4.1 §10.8）
  premium3dAvg?: number | null;
  nav: number | null;
  dividendYield: number | null;
  valuationDate: string;
  premiumDate: string;
  navDate: string;
  dividendDate: string;
  isEstimated?: boolean;
}

export interface SummaryResponse {
  items: MarketDataSummary[];
  lastUpdated: string;
}

export interface PEHistoryPoint {
  date: string;
  value: number | null;
}

export interface PremiumHistoryPoint {
  date: string;
  premium: number | null;
}

export interface NAVHistoryPoint {
  date: string;
  nav: number | null;
}

export interface DividendYieldHistoryPoint {
  date: string;
  value: number | null;
}

export interface CachedValuation {
  code: string;
  name: string;
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  peHistory: PEHistoryPoint[];
  pbHistory: PEHistoryPoint[];
  date: string;
  // V4 多周期分位（PRD§8.2）
  pePercentile1y?: number | null;
  pePercentile3y?: number | null;
  pePercentile5y?: number | null;
  pePercentile10y?: number | null;
  pePercentileAll?: number | null;
  pbPercentile1y?: number | null;
  pbPercentile3y?: number | null;
  pbPercentile5y?: number | null;
  pbPercentile10y?: number | null;
  pbPercentileAll?: number | null;
  sampleDays?: number;
  source?: string;
  isEstimated?: boolean;
  // V4.1 BUG-2026-06-A500-PB: PB 数据来源标注
  // 可能值: csindex / 沪深300代理 / multpl.com / 标普500代理 / csindex(无PB) / csindex(error) / csindex(无PB,代理失败:...)
  pbSource?: string | null;
  // V4.1 BUG-2026-06-A500-PE: PE 数据来源标注
  // 可能值: csindex / 沪深300代理 / multpl.com / 标普500代理 / csindex(无PE) / csindex(error)
  peSource?: string | null;
}

export interface CachedPremium {
  code: string;
  name: string;
  premiumToday: number | null;
  premium7dAvg: number | null;
  // V4.1 S4-T6: 3日溢价均值（PRD v4.1 §10.8）
  premium3dAvg?: number | null;
  premium30d: PremiumHistoryPoint[];
  date: string;
}

export interface CachedNav {
  code: string;
  name: string;
  nav: number | null;
  navHistory: NAVHistoryPoint[];
  date: string;
}

export interface CachedDividend {
  code: string;
  name: string;
  dividendYield: number | null;
  dividendYieldPercentile: number | null;
  dividendYieldHistory: DividendYieldHistoryPoint[];
  date: string;
}

export interface KlinePoint {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface CachedKline {
  code: string;
  name: string;
  klineHistory: KlinePoint[];
  date: string;
  // V4.1 BUG-2026-06-A500-KLINE: K线数据来源 + 是否净值代理
  source?: string;
  isNavProxy?: boolean;
}

// ─── Market Index Types (broad market indices for Trends page) ───

export interface PriceHistoryPoint {
  date: string;
  value: number | null;
}

export interface MarketIndexData {
  code: string;
  name: string;
  category: string;
  currentValue: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  ma20: number | null;
  ma60: number | null;
  priceHistory: PriceHistoryPoint[];
  date: string;
}

// ─── App Data Types (used by Overview page) ───

export interface EtfConfig {
  id: string;
  code: string;
  name: string;
  category: string;
  targetRatio: number;
  isBlacklisted: boolean;
  isInvestmentTarget: boolean;
  sortOrder: number;
}

export interface HoldingSnapshot {
  id: string;
  snapshotDate: string;
  etfCode: string;
  etfName: string;
  shares: number;
  costPrice: number;
  marketValue: number;
  currentRatio: number;
}

export interface OcrResult {
  name: string;
  code: string;
  shares: number | null;
  costPrice: number | null;
  marketValue: number | null;
  profitLoss: number | null;
}

export interface MarketDataItem {
  code: string;
  name: string;
  category: string;
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  premiumToday: number | null;
  premium7dAvg: number | null;
  // V4.1 S4-T6: 3日溢价均值（PRD v4.1 §10.8）
  premium3dAvg?: number | null;
  nav: number | null;
  dividendYield: number | null;
  valuationDate: string;
  premiumDate: string;
  navDate: string;
  dividendDate: string;
}

export interface CachedSummaryResponse {
  valuationDate?: string;
  premiumDate?: string;
  navDate?: string;
  dividendDate?: string;
  data?: MarketDataItem[];
  items?: MarketDataItem[];
  lastUpdated?: string;
}

// ─── Structured Rule Hit (audit-friendly) ───

export interface RuleHit {
  ruleType: string; // veto | reduce | boost | info
  ruleName: string;
  conditionText: string;
  actualValue: string;
  threshold: string;
  effect: string;
}

// ─── Data Quality audit ───

export interface DataQuality {
  source: string;
  sampleDays: number;
  requiredSampleDays: number;
  isSampleEnough: boolean;
  missingCount: number;
  outlierCount: number;
  canCalculate: boolean;
  updatedAt: string;
  // V4 §5.3 五状态 + §5.4 缓存过期 + §4.5 数据血缘
  qualityStatus?: 'passed' | 'minor_abnormal' | 'serious_abnormal' | 'insufficient' | 'source_inconsistent';
  abnormalReason?: string;
  isStale?: boolean;
  staleLevel?: 'red' | 'yellow' | '';
  staleReason?: string;
  percentileWindow?: string;
  rawValue?: number | null;
  cleanValue?: number | null;
  isValid?: boolean;
  // V4.1 §10.8 数据质量评分 0-100
  qualityScore?: number | null;
  canUseForRule?: boolean;
  canUseForStrongRule?: boolean;
  // V4.1 §10.9 / S2-T5: 单源场景标记 — 该指标仅有此源可用，限制强再平衡
  singleSourceWarning?: boolean;
  // V4.1 §10.9 / S2-T8: 主备源冲突熔断 — 主备源差异超阈值，阻断强买入/强再平衡，需人工确认
  sourceConflict?: boolean;
}

export interface AdviceSuggestion {
  code: string;
  name: string;
  amount: number;
  targetRatio: number;
  currentRatio: number;
  deviation: number;
  currentValue: number;
  targetValueAfterBudget: number;
  gapAmount: number;
  baseGapAmount: number;
  pePercentile: number | null;
  pbPercentile: number | null;
  premiumToday: number | null;
  premium7dAvg: number | null;
  dividendYield: number | null;
  // V4 多周期估值分位（策略书§3）
  pePercentile1y?: number | null;
  pePercentile3y?: number | null;
  pePercentile5y?: number | null;
  pePercentile10y?: number | null;
  pePercentileAll?: number | null;
  pbPercentile1y?: number | null;
  pbPercentile3y?: number | null;
  pbPercentile5y?: number | null;
  pbPercentile10y?: number | null;
  pbPercentileAll?: number | null;
  dataQuality: DataQuality | null;
  vetoed: boolean;
  multiplier: number;
  rulesHit: RuleHit[]; // CHANGED from string[] (was string[] in v1; RuleHit[] in v2)
  preCapAmount: number;
  reasonSummary: string;
  logic?: string;
  // V4.2 策略书§4/§5: 桶类型 + 软风控级别
  bucketType?: string; // base_bucket | value_bucket | base+value | none
  softWindControl?: string; // none | reduce | forbid_enhancement | minimal_base | pause_all
}

export interface AdviceResponse {
  calculationId: string;
  engineVersion: string;
  calculatedAt: string;
  allocationStrategy: string;
  dataSnapshot: {
    marketDataCacheTime: string;
    rulesConfigVersion: string;
    [key: string]: unknown;
  };
  totalBudget: number;
  totalAllocated: number;
  totalUnallocated: number;
  suggestions: AdviceSuggestion[];
  // V4 新增：再平衡 + 现金水池
  rebalanceSuggestions?: RebalanceSuggestion[];
  cashPoolSuggestions?: CashPoolSuggestion[];
  totalRebalanced?: number;
  cashPoolInflow?: number;
  cashDestination?: string;
  externalInflow?: number;
  internalRelease?: number;
  // V4 迭代7：AI 一致性校验结果
  aiCheckResult?: string;
  aiCheckSummary?: { passed: number; replaced: number; total: number };
  macroSummary?: string;
  generatedAt: string;
  // V4.2 动态资金流修正字段(策略书§4-§9)
  equityAllocationBase?: number;       // 权益配置基准(含挂起资金)
  baseBucketAmount?: number;           // 基础定投仓金额(40%)
  valueBucketAmount?: number;          // 估值增强仓金额(60%)
  rebalanceEquityReserve?: number;     // 再平衡权益备用金余额
  weeklyUnallocatedCash?: number;      // 本周未分配权益现金
  qdiiPendingCashSp500?: number;       // 标普500挂起资金余额
  qdiiPendingCashNasdaq?: number;      // 纳斯达克挂起资金余额
  fallbackTriggered?: boolean;         // 是否触发全否决兜底
  fallbackReason?: string;             // 兜底原因说明
  cashMovements?: Array<{              // 现金台账条目
    cashAccountType: string;
    sourceEvent: string;
    sourceEtf?: string;
    amount: number;
    status: string;
  }>;
}

// ─── V4: Rebalance Suggestion (strategy doc §7) ───
export interface RebalanceSuggestion {
  code: string;
  name: string;
  triggerType: 'a_share_pe' | 'dividend_yield' | 'us_pe' | 'us_qdii_premium';
  triggerLevel: 'level1' | 'level2';
  valuationMetric: string;
  valuationValue: number | null;
  valuationThreshold: string;
  targetRatio: number;
  currentRatio: number;
  deviationPp: number;
  overConcentrationPp: number;
  currentValue: number;
  targetValue: number;
  excessValue: number;
  sellRatio: number;
  sellAmount: number;
  cashDestination: string;
  reasonSummary: string;
  rulesHit: RuleHit[];
}

// ─── V4: Cash Pool Suggestion (strategy doc §8 / V4.2 §9 现金子账户) ───
export interface CashPoolSuggestion {
  code: string;
  name: string;
  inflowType: 'unallocated' | 'rebalance_release' | 'qdii_blocked';
  inflowAmount: number;
  description: string;
  // V4.2 §9 现金子账户路由
  subaccountType?: string;       // weekly_unallocated_cash | rebalance_equity_reserve | qdii_pending_cash_sp500 | qdii_pending_cash_nasdaq | ...
  countsAsEquityBase?: boolean;  // 是否计入权益配置基准
}

export interface HoldingsResponse {
  snapshotDate: string | null;
  totalAssets: number;
  investmentAssets?: number;
  holdings: HoldingSnapshot[];
  // V4 策略书§10.3: 持仓异常变化检测
  abnormalChanges?: Array<{ etfCode: string; etfName: string; previousValue: number; currentValue: number; changePct: number }>;
  hasPreviousSnapshot?: boolean;
}

export interface ManualHoldingInput {
  etfCode: string;
  etfName: string;
  shares: string;
  costPrice: string;
  marketValue: number;
}

// Default 8 ETFs for manual input (aligned with PRD)
export const DEFAULT_ETF_LIST = [
  { code: '159338', name: '中证A500ETF' },
  { code: '510880', name: '红利ETF' },
  { code: '510330', name: '沪深300ETF' },
  { code: '588000', name: '科创50ETF' },
  { code: '513500', name: '标普500ETF' },
  { code: '513300', name: '纳斯达克ETF' },
  { code: '518880', name: '黄金ETF华安' },
  { code: '511990', name: '华宝添益ETF' },
];

// ─── Rule Config Types ───

export interface RuleConfig {
  id: string;
  name: string;
  type: string; // 'veto' | 'reduce' | 'boost'
  triggerCondition: string;
  thresholdValue: number;
  thresholdValueMax: number | null;
  applicableScope: string;
  applicableCodes: string | null;
  reason: string;
  isEnabled: boolean;
  sortOrder: number;
}

export type RuleStatus = '正常' | '减量' | '加量' | '否决';

export interface ETFStaticInfo {
  code: string;
  name: string;
  category: string;
}
