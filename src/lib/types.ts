// ============================================================
// ETF Autopilot V5 — Shared TypeScript Types & Interfaces
// ============================================================

import type {
  StrategyStatus,
  CashAccountType,
  ReleasePlanState,
  ReleasePlanType,
  OrderSide,
  ExecutionMode,
  OrderStatus,
  EntryType,
  CashLedgerStatus,
  QualityStatus,
  DataSourceType,
} from "@prisma/client";

// Re-export Prisma enums for convenience
export type {
  StrategyStatus,
  CashAccountType,
  ReleasePlanState,
  ReleasePlanType,
  OrderSide,
  ExecutionMode,
  OrderStatus,
  EntryType,
  CashLedgerStatus,
  QualityStatus,
  DataSourceType,
};

// ============================================================
// API Response Helpers
// ============================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total?: number;
  limit?: number;
  offset?: number;
}

// ============================================================
// ETF Config
// ============================================================

export interface EtfConfigWithSnapshot {
  id: string;
  code: string;
  name: string;
  category: string;
  targetRatioBps: number;
  targetRatioPercent: number;
  isBlacklisted: boolean;
  isInvestmentTarget: boolean;
  sortOrder: number;
  assetClass: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  latestSnapshot: {
    id: string;
    snapshotDate: string;
    shares: number;
    sharesActual: number;
    costPer10k: number;
    marketValueFen: number;
    marketValueYuan: number;
    currentRatioBps: number;
    currentRatioPercent: number;
    source: string;
    ocrConfidence: number | null;
    isManualCorrected: boolean;
  } | null;
}

// ============================================================
// Holding Snapshot (display-friendly)
// ============================================================

export interface HoldingSnapshotDisplay {
  id: string;
  snapshotDate: string;
  etfCode: string;
  shares: number;
  sharesActual: number;
  costPer10k: number;
  marketValueFen: number;
  marketValueYuan: number;
  currentRatioBps: number;
  currentRatioPercent: number;
  source: string;
  ocrConfidence: number | null;
  isManualCorrected: boolean;
}

// ============================================================
// Strategy Version
// ============================================================

export interface StrategyVersionDisplay {
  id: string;
  version: string;
  status: StrategyStatus;
  parameters: Record<string, unknown>;
  docRef: string | null;
  effectiveAt: string | null;
  createdReason: string | null;
  confirmedBy: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Cash Account
// ============================================================

export interface CashAccountDisplay {
  id: string;
  accountType: CashAccountType;
  balanceFen: number;
  balanceYuan: number;
  countsAsEquityBase: boolean;
  description: string | null;
  updatedAt: string;
  totalInflowFen: number;
  totalInflowYuan: number;
  totalOutflowFen: number;
  totalOutflowYuan: number;
}

// ============================================================
// Cash Ledger
// ============================================================

export interface CashLedgerDisplay {
  id: string;
  debitAccount: CashAccountType;
  creditAccount: CashAccountType;
  amountFen: number;
  amountYuan: number;
  transferId: string | null;
  entryType: EntryType;
  referenceId: string | null;
  occurredAt: string;
  status: CashLedgerStatus;
  createdAt: string;
}

// ============================================================
// Execution Order
// ============================================================

export interface ExecutionOrderDisplay {
  id: string;
  calculationId: string;
  snapshotId: string | null;
  etfCode: string;
  side: OrderSide;
  plannedAmountFen: number;
  plannedAmountYuan: number;
  plannedShares: number;
  plannedSharesActual: number;
  executionMode: ExecutionMode;
  status: OrderStatus;
  rejectReason: string | null;
  actualAmountFen: number | null;
  actualAmountYuan: number | null;
  actualShares: number | null;
  actualSharesActual: number | null;
  createdAt: string;
  updatedAt: string;
  fills: ExecutionFillDisplay[];
}

export interface ExecutionFillDisplay {
  id: string;
  orderId: string;
  priceFen: number;
  shares: number;
  sharesActual: number;
  amountFen: number;
  amountYuan: number;
  feeFen: number;
  feeYuan: number;
  executedAt: string;
  idempotencyKey: string;
  createdAt: string;
}

// ============================================================
// Calculation Log
// ============================================================

export interface CalculationLogDisplay {
  id: string;
  calculationId: string;
  strategyVersion: string | null;
  engineVersion: string;
  inputsHash: string;
  eabFen: number;
  eabYuan: number;
  budgetFen: number;
  budgetYuan: number;
  totalAllocatedFen: number;
  totalAllocatedYuan: number;
  totalRebalancedFen: number;
  totalRebalancedYuan: number;
  totalUnallocatedFen: number;
  totalUnallocatedYuan: number;
  cashDestination: string | null;
  rulesHitSummary: unknown | null;
  dataQualitySummary: unknown | null;
  resultsJson: unknown | null;
  aiExplanationResult: string | null;
  inputJson: unknown | null;
  createdAt: string;
}

// ============================================================
// Data Quality
// ============================================================

export interface DataQualityLogDisplay {
  id: string;
  etfCode: string;
  metricName: string;
  qualityStatus: QualityStatus;
  score: number;
  freshnessScore: number | null;
  consistencyScore: number | null;
  completenessScore: number | null;
  abnormalScore: number | null;
  sourceHealthScore: number | null;
  canUseForRule: boolean;
  canUseForStrongRule: boolean;
  reason: string | null;
  createdAt: string;
}

export interface DataQualitySummary {
  total: number;
  byStatus: Record<QualityStatus, number>;
}

// ============================================================
// Release Plan
// ============================================================

export interface ReleasePlanDisplay {
  id: string;
  planType: ReleasePlanType;
  accountId: string;
  state: ReleasePlanState;
  weeksTotal: number;
  weeksRemaining: number;
  balanceFen: number;
  balanceYuan: number;
  weeklyAmountFen: number;
  weeklyAmountYuan: number;
  targetEtf: string | null;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Dashboard
// ============================================================

export interface DashboardData {
  activeStrategy: StrategyVersionDisplay | null;
  totalPortfolioValueYuan: number;
  cashTotals: {
    totalYuan: number;
    byAccountType: Record<CashAccountType, number>;
  };
  latestCalculation: CalculationLogDisplay | null;
  executionOrdersByStatus: Partial<Record<OrderStatus, number>>;
  dataQualitySummary: DataQualitySummary;
  releasePlansByState: Partial<Record<ReleasePlanState, number>>;
}

// ============================================================
// Rule Config
// ============================================================

export interface RuleConfigDisplay {
  id: string;
  ruleGroup: string;
  ruleName: string;
  ruleValue: string;
  description: string | null;
  ruleType: string;
  triggerCondition: string | null;
  thresholdValue: number;
  thresholdValueBps: number;
  thresholdValueMax: number | null;
  applicableScope: string;
  applicableCodes: string | null;
  conditionMetric: string | null;
  percentileWindow: string | null;
  operator: string | null;
  priority: number;
  isEnabled: boolean;
  sortOrder: number;
  effect: string | null;
  displayText: string | null;
  strategyDocRef: string | null;
}

// ============================================================
// System Config
// ============================================================

export type SystemConfigMap = Record<string, string>;

// ============================================================
// Conversion Utilities
// ============================================================

/** Convert fen (分/cents) to yuan (元) */
export function fenToYuan(fen: number | null | undefined): number | null {
  if (fen == null) return null;
  return fen / 100;
}

/** Convert bps (万分之) to percentage (e.g. 2000 bps → 20.00) */
export function bpsToPercent(bps: number | null | undefined): number | null {
  if (bps == null) return null;
  return bps / 100;
}

/** Convert shares×10000 to actual shares */
export function sharesX10000ToActual(shares: number | null | undefined): number | null {
  if (shares == null) return null;
  return shares / 10000;
}