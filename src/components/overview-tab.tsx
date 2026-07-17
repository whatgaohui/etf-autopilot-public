'use client';

import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload,
  SlidersHorizontal,
  Wallet,
  ShieldCheck,
  Sparkles,
  UserCheck,
  ArrowDownToLine,
  ClipboardCheck,
  Check,
  Circle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  PieChart as PieChartIcon,
  BarChart3,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableFooter,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { FadeInUp } from '@/lib/motion';

import type {
  ApiResponse,
  DashboardData,
  EtfConfigWithSnapshot,
  CashAccountDisplay,
  ExecutionOrderDisplay,
  CashLedgerDisplay,
  ReleasePlanDisplay,
  CalculationLogDisplay,
  QualityStatus,
  OrderStatus,
  ExecutionMode,
  CashAccountType,
  ReleasePlanState,
} from '@/lib/types';

// ============================================================
// Constants & Label Maps
// ============================================================

const WORKFLOW_STEPS = [
  { label: '更新持仓', icon: Upload, tooltip: '拉取券商/基金公司最新持仓快照' },
  { label: '校准数据', icon: SlidersHorizontal, tooltip: '校准估值、溢价、现金等输入数据' },
  { label: '确认注资', icon: Wallet, tooltip: '确认本周注资金额并写入承诺现金账户' },
  { label: '数据门禁', icon: ShieldCheck, tooltip: '检查数据质量五态：正常/降级/过期/冲突/缺失' },
  { label: '生成建议', icon: Sparkles, tooltip: '规则引擎计算各ETF买入/卖出建议' },
  { label: '用户确认', icon: UserCheck, tooltip: '审核并确认/拒绝建议执行单' },
  { label: '成交回填', icon: ArrowDownToLine, tooltip: '回填实际成交价、份额、手续费' },
  { label: '周度复盘', icon: ClipboardCheck, tooltip: '对账、审计、生成本周复盘报告' },
] as const;

const CASH_ACCOUNT_LABELS: Record<CashAccountType, string> = {
  daily_cash: '日常现金',
  weekly_unallocated_cash: '未分配权益现金',
  rebalance_equity_reserve: '再平衡备用金',
  qdii_pending_cash_sp500: 'QDII挂起(标普500)',
  qdii_pending_cash_nasdaq: 'QDII挂起(纳斯达克)',
  manual_cash: '手动指定现金',
  weekly_contribution_committed: '本周承诺注资',
};

const EXECUTION_MODE_LABELS: Record<ExecutionMode, string> = {
  immediate: '立即执行',
  staged: '分批执行',
  wait_pullback: '等待回撤',
  base_only: '仅基础仓',
};

const ORDER_STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; color: string; bgClass: string; textClass: string }
> = {
  draft: { label: '草稿', color: 'gray', bgClass: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', textClass: 'text-gray-500' },
  calculating: { label: '计算中', color: 'gray', bgClass: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', textClass: 'text-gray-500' },
  blocked: { label: '已阻断', color: 'red', bgClass: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', textClass: 'text-red-600 dark:text-red-400' },
  ready_for_review: { label: '待审核', color: 'emerald', bgClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', textClass: 'text-emerald-600 dark:text-emerald-400' },
  confirmed: { label: '已确认', color: 'teal', bgClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300', textClass: 'text-teal-600 dark:text-teal-400' },
  rejected: { label: '已拒绝', color: 'red', bgClass: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', textClass: 'text-red-600 dark:text-red-400' },
  expired: { label: '已过期', color: 'gray', bgClass: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', textClass: 'text-gray-500' },
  partially_executed: { label: '部分成交', color: 'amber', bgClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', textClass: 'text-amber-600 dark:text-amber-400' },
  executed: { label: '已执行', color: 'emerald', bgClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', textClass: 'text-emerald-600 dark:text-emerald-400' },
  cancelled: { label: '已取消', color: 'gray', bgClass: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', textClass: 'text-gray-500' },
  reconciled: { label: '已对账', color: 'teal', bgClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300', textClass: 'text-teal-600 dark:text-teal-400' },
};

const QUALITY_STATUS_CONFIG: Record<
  QualityStatus,
  { label: string; dotClass: string; bgClass: string; textClass: string }
> = {
  valid: { label: '正常', dotClass: 'bg-emerald-500', bgClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', textClass: 'text-emerald-600' },
  degraded: { label: '降级', dotClass: 'bg-amber-500', bgClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', textClass: 'text-amber-600' },
  stale: { label: '过期', dotClass: 'bg-orange-500', bgClass: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300', textClass: 'text-orange-600' },
  conflict: { label: '冲突', dotClass: 'bg-red-500', bgClass: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', textClass: 'text-red-600' },
  missing: { label: '缺失', dotClass: 'bg-gray-400', bgClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', textClass: 'text-gray-500' },
};

const RELEASE_STATE_CONFIG: Record<
  ReleasePlanState,
  { label: string; bgClass: string }
> = {
  idle: { label: '空闲', bgClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  releasing: { label: '释放中', bgClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  paused: { label: '已暂停', bgClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  completed: { label: '已完成', bgClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' },
};

const RELEASE_TYPE_LABELS: Record<string, string> = {
  qdii_premium: 'QDII溢价释放',
  rebalance_reserve: '再平衡备用金释放',
};

const ETF_CHART_COLORS: Record<string, string> = {
  '510300': '#10b981',
  '510500': '#14b8a6',
  '588000': '#06b6d4',
  '513300': '#8b5cf6',
  '513500': '#f59e0b',
  '512890': '#f97316',
};
const CASH_CHART_COLOR = '#6b7280';

const EXECUTION_MODE_BADGE_CLASS: Record<ExecutionMode, string> = {
  immediate: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-0',
  staged: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 border-0',
  wait_pullback: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-0',
  base_only: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 border-0',
};

// ============================================================
// Helper Functions
// ============================================================

function formatMoney(value: number | null | undefined): string {
  if (value == null) return '—';
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(2)}%`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getDeviationColor(deviation: number | null): string {
  if (deviation == null) return 'text-muted-foreground';
  const abs = Math.abs(deviation);
  if (abs <= 2) return 'text-emerald-600 dark:text-emerald-400';
  if (abs <= 5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function getDeviationBadgeClass(deviation: number | null): string {
  if (deviation == null) return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  const abs = Math.abs(deviation);
  if (abs <= 2) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (abs <= 5) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
}

type StepState = 'completed' | 'current' | 'pending' | 'blocked';

interface WorkflowState {
  currentStep: number;
  stepStates: StepState[];
  isBlocked: boolean;
}

function deriveWorkflowState(dashboard: DashboardData | null): WorkflowState {
  const states: StepState[] = Array(8).fill('pending');
  let currentStep = 0;
  let isBlocked = false;

  if (!dashboard) return { currentStep: 0, stepStates: states, isBlocked: false };

  const { latestCalculation, executionOrdersByStatus, dataQualitySummary } = dashboard;
  const orders = executionOrdersByStatus ?? {};

  // Check from the end to find the furthest completed step
  if ((orders.reconciled ?? 0) > 0) {
    currentStep = 7;
  } else if ((orders.executed ?? 0) > 0 || (orders.partially_executed ?? 0) > 0) {
    currentStep = 6;
  } else if ((orders.confirmed ?? 0) > 0) {
    currentStep = 6;
  } else if ((orders.ready_for_review ?? 0) > 0) {
    currentStep = 5;
  } else if (latestCalculation) {
    currentStep = 4;
  } else if (dataQualitySummary && dataQualitySummary.total > 0) {
    const hasBadStatus = (dataQualitySummary.byStatus?.conflict ?? 0) > 0 || (dataQualitySummary.byStatus?.missing ?? 0) > 0;
    if (hasBadStatus) {
      currentStep = 3;
      isBlocked = true;
    } else {
      currentStep = 4;
    }
  } else {
    currentStep = 0;
  }

  // Mark step states
  for (let i = 0; i < 8; i++) {
    if (i < currentStep) {
      states[i] = 'completed';
    } else if (i === currentStep) {
      states[i] = isBlocked ? 'blocked' : 'current';
    } else {
      states[i] = 'pending';
    }
  }

  return { currentStep, stepStates: states, isBlocked };
}

// ============================================================
// Section 1: Weekly Task Status Bar
// ============================================================

function WeeklyTaskStatusBar({ dashboard }: { dashboard: DashboardData | null }) {
  const { stepStates, isBlocked } = deriveWorkflowState(dashboard);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">本周工作流</CardTitle>
        <CardDescription className="text-xs">
          {isBlocked ? '数据门禁未通过，工作流已阻断' : '周度定投执行进度'}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Desktop: horizontal stepper */}
        <div className="hidden md:flex items-center justify-between gap-0">
          {WORKFLOW_STEPS.map((step, idx) => {
            const state = stepStates[idx];
            const Icon = step.icon;
            const isLast = idx === WORKFLOW_STEPS.length - 1;

            return (
              <React.Fragment key={step.label}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1.5 min-w-0 flex-1 cursor-default">
                      <div
                        className={[
                          'relative flex items-center justify-center size-9 rounded-full border-2 transition-all duration-300',
                          state === 'completed'
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : state === 'current'
                              ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400 animate-glow-ring'
                              : state === 'blocked'
                                ? 'border-red-400 bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400'
                                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-500',
                        ].join(' ')}
                      >
                        {state === 'completed' ? (
                          <Check className="size-4" />
                        ) : state === 'blocked' ? (
                          <XCircle className="size-4" />
                        ) : (
                          <Icon className="size-3.5" />
                        )}
                      </div>
                      <span
                        className={[
                          'text-[11px] font-medium text-center leading-tight',
                          state === 'completed' || state === 'current'
                            ? 'text-foreground'
                            : state === 'blocked'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-muted-foreground/60',
                        ].join(' ')}
                      >
                        {step.label}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-[11px]">{step.tooltip}</p>
                  </TooltipContent>
                </Tooltip>
                {!isLast && (
                  <div className="flex-shrink-0 self-start mt-4 -mx-1">
                    <div
                      className={[
                        'h-0.5 w-6 transition-colors duration-300',
                        state === 'completed'
                          ? 'bg-emerald-400'
                          : 'bg-gray-200 dark:bg-gray-700',
                      ].join(' ')}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Mobile: 2-row compact grid */}
        <div className="md:hidden grid grid-cols-4 gap-2">
          {WORKFLOW_STEPS.map((step, idx) => {
            const state = stepStates[idx];
            const Icon = step.icon;

            return (
              <Tooltip key={step.label}>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-2 py-1.5 cursor-default">
                    <div
                      className={[
                        'flex items-center justify-center size-5 rounded-full shrink-0',
                        state === 'completed'
                          ? 'bg-emerald-500 text-white'
                          : state === 'current'
                            ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400 animate-glow-ring-sm'
                            : state === 'blocked'
                              ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
                              : 'bg-gray-100 text-gray-400 dark:bg-gray-800',
                      ].join(' ')}
                    >
                      {state === 'completed' ? (
                        <Check className="size-3" />
                      ) : state === 'blocked' ? (
                        <XCircle className="size-3" />
                      ) : (
                        <Icon className="size-2.5" />
                      )}
                    </div>
                    <span className="text-[10px] font-medium truncate text-muted-foreground">
                      {step.label}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-[11px]">{step.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function WeeklyTaskStatusBarSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-40" />
      </CardHeader>
      <CardContent className="pt-0">
        <div className="hidden md:flex items-center justify-between">
          {Array.from({ length: 8 }).map((_, i) => (
            <React.Fragment key={i}>
              <div className="flex flex-col items-center gap-1.5">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-3 w-10" />
              </div>
              {i < 7 && <Skeleton className="h-0.5 w-6 mt-4" />}
            </React.Fragment>
          ))}
        </div>
        <div className="md:hidden grid grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 rounded-lg" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 2: Data Quality Gate Summary
// ============================================================

interface DataQualitySummaryResponse {
  total: number;
  uniqueEtfCount: number;
  byStatus: Record<string, number>;
  latestPerEtf: { etfCode: string; latestAt: string | null; maxScore: number | null }[];
}

function DataQualityGateCard({
  qualityData,
  etfConfigs,
  isLoading,
  isError,
}: {
  qualityData: DataQualitySummaryResponse | null;
  etfConfigs: EtfConfigWithSnapshot[];
  isLoading: boolean;
  isError: boolean;
}) {
  // Derive per-ETF status counts from latestPerEtf scores
  const etfStatusCounts = useMemo(() => {
    const counts: Record<QualityStatus, number> = {
      valid: 0, degraded: 0, stale: 0, conflict: 0, missing: 0,
    };
    if (qualityData?.latestPerEtf) {
      for (const item of qualityData.latestPerEtf) {
        const status = scoreToStatus(item.maxScore);
        counts[status]++;
      }
    }
    return counts;
  }, [qualityData]);

  const isBlocked = useMemo(() => {
    // Only blocked when there are ETF-level conflict or missing statuses
    return (etfStatusCounts.conflict ?? 0) > 0 || (etfStatusCounts.missing ?? 0) > 0;
  }, [etfStatusCounts]);

  const etfQualityMap = useMemo(() => {
    const map = new Map<string, { score: number | null; latestAt: string | null }>();
    if (qualityData?.latestPerEtf) {
      for (const item of qualityData.latestPerEtf) {
        map.set(item.etfCode, { score: item.maxScore, latestAt: item.latestAt });
      }
    }
    return map;
  }, [qualityData]);

  function scoreToStatus(score: number | null): QualityStatus {
    if (score == null) return 'missing';
    if (score >= 80) return 'valid';
    if (score >= 60) return 'degraded';
    if (score >= 40) return 'stale';
    if (score >= 20) return 'conflict';
    return 'missing';
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="flex gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-16 rounded-full" />
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !qualityData) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">数据门禁摘要</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载数据质量信息</p>
        </CardContent>
      </Card>
    );
  }

  const statusKeys: QualityStatus[] = ['valid', 'degraded', 'stale', 'conflict', 'missing'];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">数据门禁摘要</CardTitle>
            <CardDescription className="text-xs">
              {qualityData.latestPerEtf.length} 只 ETF · {qualityData.total} 条检测记录
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {isBlocked ? (
              <Badge className={`${ORDER_STATUS_CONFIG.blocked.bgClass} border-0 text-[10px]`}>
                <AlertTriangle className="size-3 mr-0.5" />
                未通过
              </Badge>
            ) : qualityData.total > 0 ? (
              <Badge className={`${QUALITY_STATUS_CONFIG.valid.bgClass} border-0 text-[10px]`}>
                <ShieldCheck className="size-3 mr-0.5" />
                已通过
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Per-ETF status distribution badges */}
        <div className="flex flex-wrap gap-1.5">
          {statusKeys.map((status) => {
            const count = etfStatusCounts[status] ?? 0;
            if (count === 0) return null;
            const config = QUALITY_STATUS_CONFIG[status];
            return (
              <span
                key={status}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${config.bgClass}`}
              >
                <span className={`size-1.5 rounded-full ${config.dotClass}`} />
                {config.label}: {count}
              </span>
            );
          })}
          {qualityData.latestPerEtf.length === 0 && (
            <span className="text-[11px] text-muted-foreground">暂无质量记录</span>
          )}
        </div>

        {/* Per-ETF grid with score badge */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {etfConfigs.map((etf) => {
            const quality = etfQualityMap.get(etf.code);
            const score = quality?.score ?? null;
            const status = scoreToStatus(score);
            const config = QUALITY_STATUS_CONFIG[status];

            // Score color: green >= 80, amber >= 60, orange >= 40, red < 40
            const scoreColorClass = score == null
              ? 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
              : score >= 80
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : score >= 60
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : score >= 40
                    ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';

            return (
              <div
                key={etf.code}
                className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
              >
                {/* Prominent score badge */}
                <div className={`flex items-center justify-center size-9 rounded-lg font-bold text-sm font-mono shrink-0 ${scoreColorClass}`}>
                  {score ?? '—'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{etf.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{etf.code}</div>
                </div>
                <span
                  className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium shrink-0 ${config.bgClass}`}
                >
                  <span className={`size-1 rounded-full ${config.dotClass}`} />
                  {config.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Blocking alert */}
        {isBlocked && (
          <Alert variant="destructive" className="py-2.5">
            <AlertTriangle className="size-3.5" />
            <AlertTitle className="text-xs font-semibold">数据门禁未通过</AlertTitle>
            <AlertDescription className="text-xs">
              建议生成已被阻断，请检查数据源质量后重试
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 2.5: Portfolio Allocation Donut Chart
// ============================================================

interface DonutChartDataItem {
  code: string;
  name: string;
  value: number;
  color: string;
  currentPercent: number;
  targetPercent: number;
  actualPercent: number;
  deviation: number | null;
}

interface DonutTooltipPayloadItem {
  name: string;
  value: number;
  payload: DonutChartDataItem;
}

function DonutTooltipContent({ active, payload }: { active?: boolean; payload?: DonutTooltipPayloadItem[] }) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload;
  return (
    <div className="rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-lg">
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
        <span className="text-xs font-medium">{item.name}</span>
      </div>
      <div className="text-[11px] text-muted-foreground mt-1 font-mono">
        {formatMoney(item.value)} · {item.actualPercent.toFixed(2)}%
      </div>
    </div>
  );
}

function PortfolioAllocationDonut({
  etfConfigs,
  cashAccounts,
  isLoading,
}: {
  etfConfigs: EtfConfigWithSnapshot[];
  cashAccounts: CashAccountDisplay[];
  isLoading: boolean;
}) {
  const { chartData, totalPortfolio } = useMemo(() => {
    const activeEtfs = etfConfigs.filter(e => e.latestSnapshot && !e.isBlacklisted);
    const cashTotal = cashAccounts.reduce((sum, a) => sum + (a.balanceYuan ?? 0), 0);
    const equityTotal = activeEtfs.reduce((sum, e) => sum + (e.latestSnapshot!.marketValueYuan), 0);
    const total = equityTotal + cashTotal;

    const data: DonutChartDataItem[] = activeEtfs.map(etf => {
      const currentPct = total > 0 ? (etf.latestSnapshot!.marketValueYuan / total) * 100 : 0;
      const targetPct = etf.targetRatioPercent ?? 0;
      return {
        code: etf.code,
        name: etf.name,
        value: etf.latestSnapshot!.marketValueYuan,
        color: ETF_CHART_COLORS[etf.code] ?? '#6b7280',
        currentPercent: etf.latestSnapshot!.currentRatioPercent ?? 0,
        targetPercent: targetPct,
        actualPercent: currentPct,
        deviation: currentPct - targetPct,
      };
    });

    if (cashTotal > 0) {
      const cashPct = total > 0 ? (cashTotal / total) * 100 : 0;
      data.push({
        code: 'cash',
        name: '现金',
        value: cashTotal,
        color: CASH_CHART_COLOR,
        currentPercent: cashPct,
        targetPercent: 0,
        actualPercent: cashPct,
        deviation: cashPct,
      });
    }

    return { chartData: data, totalPortfolio: total };
  }, [etfConfigs, cashAccounts]);

  if (isLoading) {
    return (
      <FadeInUp>
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-col md:flex-row gap-4">
              <Skeleton className="w-full md:w-[200px] h-[200px] rounded-lg" />
              <div className="flex-1 space-y-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeInUp>
    );
  }

  return (
    <FadeInUp>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <PieChartIcon className="size-4 text-teal-500" />
            资产配置概览
          </CardTitle>
          <CardDescription className="text-xs">当前持仓 vs 目标配比</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {chartData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">暂无持仓数据</p>
          ) : (
            <div className="flex flex-col md:flex-row gap-4 items-center md:items-start">
              {/* Donut Chart */}
              <div className="w-full md:w-[200px] shrink-0">
                <div className="relative">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={chartData}
                        cx="50%"
                        cy="50%"
                        innerRadius="60%"
                        outerRadius="85%"
                        paddingAngle={2}
                        dataKey="value"
                        stroke="none"
                      >
                        {chartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <RechartsTooltip content={<DonutTooltipContent />} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center text */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground">总资产</div>
                      <div className="text-xs font-bold font-mono tabular-nums">
                        {formatMoney(totalPortfolio)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Legend */}
              <div className="flex-1 min-w-0 w-full">
                {/* Header */}
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1.5 px-0.5">
                  <span className="w-2.5 shrink-0" />
                  <span className="flex-1 min-w-0">名称</span>
                  <span className="w-12 text-right font-mono">当前</span>
                  <span className="w-12 text-right font-mono hidden sm:block">目标</span>
                  <span className="w-14 text-right font-mono hidden sm:block">偏离</span>
                </div>
                {/* Rows */}
                <div className="space-y-1">
                  {chartData.map(item => {
                    const devColor = item.deviation == null
                      ? 'text-muted-foreground'
                      : Math.abs(item.deviation) <= 3
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : Math.abs(item.deviation) <= 5
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400';

                    return (
                      <div
                        key={item.code}
                        className="flex items-center gap-2 text-[11px] rounded-md px-0.5 py-1 hover:bg-muted/40 transition-colors"
                      >
                        <span
                          className="size-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="flex-1 min-w-0 truncate font-medium">
                          {item.code === 'cash' ? '现金' : item.name}
                        </span>
                        <span className="w-12 text-right font-mono tabular-nums">
                          {item.actualPercent.toFixed(1)}%
                        </span>
                        <span className="w-12 text-right font-mono tabular-nums text-muted-foreground hidden sm:block">
                          {item.code === 'cash' ? '—' : `${item.targetPercent.toFixed(1)}%`}
                        </span>
                        <span className={`w-14 text-right font-mono tabular-nums font-medium hidden sm:block ${devColor}`}>
                          {item.deviation == null
                            ? '—'
                            : `${item.deviation >= 0 ? '+' : ''}${item.deviation.toFixed(1)}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}

// ============================================================
// Section 3a: Portfolio Holdings Table
// ============================================================

function PortfolioHoldingsTable({
  etfConfigs,
  isLoading,
  isError,
}: {
  etfConfigs: EtfConfigWithSnapshot[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
            <Skeleton className="h-8 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">持仓概览</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载持仓数据</p>
        </CardContent>
      </Card>
    );
  }

  const holdingsWithSnapshots = etfConfigs.filter((e) => e.latestSnapshot && !e.isBlacklisted);
  const totalMarketValue = holdingsWithSnapshots.reduce(
    (sum, e) => sum + (e.latestSnapshot?.marketValueYuan ?? 0),
    0,
  );
  const totalTargetRatio = holdingsWithSnapshots.reduce(
    (sum, e) => sum + (e.targetRatioPercent ?? 0),
    0,
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">持仓概览</CardTitle>
        <CardDescription className="text-xs">
          总市值 {formatMoney(totalMarketValue)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-[11px] h-8">ETF代码</TableHead>
              <TableHead className="text-[11px] h-8">名称</TableHead>
              <TableHead className="text-[11px] h-8 text-right">目标比例</TableHead>
              <TableHead className="text-[11px] h-8 text-right">当前市值</TableHead>
              <TableHead className="text-[11px] h-8 text-right hidden sm:table-cell">实际比例</TableHead>
              <TableHead className="text-[11px] h-8 text-right">偏离</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holdingsWithSnapshots.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-xs text-muted-foreground text-center py-6">
                  暂无持仓数据
                </TableCell>
              </TableRow>
            ) : (
              holdingsWithSnapshots.map((etf) => {
                const snap = etf.latestSnapshot!;
                const deviation = (snap.currentRatioPercent ?? 0) - (etf.targetRatioPercent ?? 0);

                return (
                  <TableRow key={etf.code}>
                    <TableCell className="text-xs font-mono">{etf.code}</TableCell>
                    <TableCell className="text-xs font-medium">{etf.name}</TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {formatPercent(etf.targetRatioPercent)}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono">
                      {formatMoney(snap.marketValueYuan)}
                    </TableCell>
                    <TableCell className="text-xs text-right font-mono hidden sm:table-cell">
                      {formatPercent(snap.currentRatioPercent)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-mono font-medium ${getDeviationBadgeClass(deviation)}`}
                      >
                        {deviation >= 0 ? '+' : ''}
                        {formatPercent(deviation)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
          {holdingsWithSnapshots.length > 0 && (
            <TableFooter>
              <TableRow className="hover:bg-transparent font-semibold">
                <TableCell className="text-[11px]">合计</TableCell>
                <TableCell className="text-[11px]">{holdingsWithSnapshots.length} 只</TableCell>
                <TableCell className="text-[11px] text-right font-mono">
                  {formatPercent(totalTargetRatio)}
                </TableCell>
                <TableCell className="text-[11px] text-right font-mono">
                  {formatMoney(totalMarketValue)}
                </TableCell>
                <TableCell className="hidden sm:table-cell" />
                <TableCell />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 3b: Cash Accounts Summary
// ============================================================

function CashAccountsSummary({
  accounts,
  isLoading,
  isError,
}: {
  accounts: CashAccountDisplay[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">现金子账户</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载现金账户数据</p>
        </CardContent>
      </Card>
    );
  }

  const totalCash = accounts.reduce((sum, a) => sum + (a.balanceYuan ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">现金子账户</CardTitle>
        <CardDescription className="text-xs">
          总现金 {formatMoney(totalCash)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1.5 max-h-96 overflow-y-auto scrollbar-refined">
          {accounts.map((acc) => (
            <div
              key={acc.id}
              className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Wallet className="size-3.5 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">
                    {CASH_ACCOUNT_LABELS[acc.accountType] ?? acc.accountType}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {acc.accountType}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {acc.countsAsEquityBase && (
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-0 text-[9px] px-1.5">
                    EAB
                  </Badge>
                )}
                <span className="text-xs font-mono font-medium tabular-nums">
                  {formatMoney(acc.balanceYuan)}
                </span>
              </div>
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">暂无现金账户</p>
          )}
        </div>
        {/* Total */}
        {accounts.length > 0 && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
            <span className="text-xs font-semibold">合计</span>
            <span className="text-sm font-bold font-mono tabular-nums">
              {formatMoney(totalCash)}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 3.5: Weekly Budget Utilization
// ============================================================

function WeeklyBudgetUtilization({
  dashboard,
  executionOrders,
}: {
  dashboard: DashboardData | null;
  executionOrders: ExecutionOrderDisplay[];
}) {
  const { budget, allocated, unallocated, utilizationPct, barColor } = useMemo(() => {
    const budgetYuan = dashboard?.latestCalculation?.budgetYuan ?? 7000;
    const latestCalcId = dashboard?.latestCalculation?.calculationId;

    // Sum allocated buy amounts from orders for the latest calculation
    const calcOrders = latestCalcId
      ? executionOrders.filter(o => o.calculationId === latestCalcId && o.side === 'buy')
      : [];
    const allocatedYuan = calcOrders.reduce((sum, o) => sum + (o.plannedAmountYuan ?? 0), 0);
    const unallocYuan = budgetYuan - allocatedYuan;
    const pct = budgetYuan > 0 ? (allocatedYuan / budgetYuan) * 100 : 0;

    const color = pct > 100 ? 'bg-red-500' : pct >= 70 ? 'bg-emerald-500' : 'bg-amber-500';

    return {
      budget: budgetYuan,
      allocated: allocatedYuan,
      unallocated: unallocYuan,
      utilizationPct: pct,
      barColor: color,
    };
  }, [dashboard, executionOrders]);

  return (
    <FadeInUp>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <BarChart3 className="size-4 text-emerald-500" />
            本周预算使用
          </CardTitle>
          <CardDescription className="text-xs">
            周预算 {formatMoney(budget)} · 已分配 {formatMoney(allocated)}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {/* Progress bar */}
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                style={{ width: `${Math.min(utilizationPct, 100)}%` }}
              />
            </div>
            {/* Stats row */}
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">
                  已分配 <span className="font-mono font-medium text-foreground">{formatMoney(allocated)}</span>
                </span>
                <span className="text-muted-foreground">
                  未分配{' '}
                  <span className={`font-mono font-medium ${unallocated >= 0 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatMoney(unallocated)}
                  </span>
                </span>
              </div>
              <span
                className={`font-mono font-bold tabular-nums ${
                  utilizationPct > 100
                    ? 'text-red-600 dark:text-red-400'
                    : utilizationPct >= 70
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {utilizationPct.toFixed(1)}%
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </FadeInUp>
  );
}

// ============================================================
// Section 4: Weekly Execution Summary
// ============================================================

function WeeklyExecutionSummary({
  dashboard,
  executionOrders,
  etfConfigs,
  isLoading,
  isError,
}: {
  dashboard: DashboardData | null;
  executionOrders: ExecutionOrderDisplay[];
  etfConfigs: EtfConfigWithSnapshot[];
  isLoading: boolean;
  isError: boolean;
}) {
  const queryClient = useQueryClient();

  const etfNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of etfConfigs) map.set(e.code, e.name);
    return map;
  }, [etfConfigs]);

  const etfConfigMap = useMemo(() => {
    const map = new Map<string, EtfConfigWithSnapshot>();
    for (const e of etfConfigs) map.set(e.code, e);
    return map;
  }, [etfConfigs]);

  const latestCalc = dashboard?.latestCalculation ?? null;
  const latestCalcId = latestCalc?.calculationId ?? null;

  // Filter orders for the latest calculation
  const calcOrders = useMemo(() => {
    if (!latestCalcId) return [];
    return executionOrders.filter((o) => o.calculationId === latestCalcId);
  }, [executionOrders, latestCalcId]);

  // Confirm mutation
  const confirmMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const res = await fetch('/api/execution-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: orderId, status: 'confirmed' }),
      });
      const data: ApiResponse = await res.json();
      if (!data.success) throw new Error(data.error ?? '确认失败');
      return data;
    },
    onSuccess: () => {
      toast.success('执行单已确认');
      queryClient.invalidateQueries({ queryKey: ['execution-orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '确认失败'),
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const res = await fetch('/api/execution-orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: orderId, status: 'rejected', rejectReason: '用户手动拒绝' }),
      });
      const data: ApiResponse = await res.json();
      if (!data.success) throw new Error(data.error ?? '拒绝失败');
      return data;
    },
    onSuccess: () => {
      toast.success('执行单已拒绝');
      queryClient.invalidateQueries({ queryKey: ['execution-orders'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '拒绝失败'),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">本周资金调拨执行单</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载执行单数据</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">本周资金调拨执行单</CardTitle>
            <CardDescription className="text-xs">
              {latestCalc
                ? `计算于 ${formatDateTime(latestCalc.createdAt ?? latestCalc.id)}`
                : '暂无本周计算结果'}
            </CardDescription>
          </div>
          {dashboard?.activeStrategy && (
            <Badge variant="outline" className="text-[10px] font-mono">
              策略 {dashboard.activeStrategy.version}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {latestCalc ? (
          <>
            {/* Calculation metadata */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="text-[10px] text-muted-foreground">权益配置基准 (EAB)</div>
                <div className="text-sm font-bold font-mono tabular-nums mt-0.5">
                  {formatMoney(latestCalc.eabYuan)}
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="text-[10px] text-muted-foreground">周预算</div>
                <div className="text-sm font-bold font-mono tabular-nums mt-0.5">
                  {formatMoney(latestCalc.budgetYuan)}
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="text-[10px] text-muted-foreground">总分配金额</div>
                <div className="text-sm font-bold font-mono tabular-nums mt-0.5 text-emerald-600 dark:text-emerald-400">
                  {formatMoney(latestCalc.totalAllocatedYuan)}
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                <div className="text-[10px] text-muted-foreground">未分配</div>
                <div className="text-sm font-bold font-mono tabular-nums mt-0.5 text-amber-600 dark:text-amber-400">
                  {formatMoney(latestCalc.totalUnallocatedYuan)}
                </div>
              </div>
            </div>

            {/* Per-ETF orders */}
            {calcOrders.length > 0 ? (
              <div className="space-y-2">
                {calcOrders.map((order) => {
                  const statusCfg = ORDER_STATUS_CONFIG[order.status];
                  const etfName = etfNameMap.get(order.etfCode) ?? order.etfCode;
                  const etfConfig = etfConfigMap.get(order.etfCode);
                  const orderDeviation = etfConfig?.latestSnapshot && etfConfig.targetRatioPercent != null
                    ? (etfConfig.latestSnapshot.currentRatioPercent ?? 0) - etfConfig.targetRatioPercent
                    : null;
                  const isActionable = order.status === 'ready_for_review';
                  const isBlocked = order.status === 'blocked';
                  const isExecuted = order.status === 'executed';
                  const isPartiallyExecuted = order.status === 'partially_executed';
                  const isConfirmed = order.status === 'confirmed';

                  // Visual differentiation by status
                  let borderClass: string;
                  let bgClass: string;
                  let StatusIcon: React.ReactNode = null;

                  if (isActionable) {
                    // ready_for_review: dotted border + emerald outline, pulsing dot
                    borderClass = 'border-l-4 border-l-emerald-400 border border-dashed border-emerald-300 dark:border-emerald-700';
                    bgClass = 'bg-emerald-50/30 dark:bg-emerald-950/10';
                    StatusIcon = (
                      <span className="relative flex size-4 shrink-0 items-center justify-center">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40" />
                        <Circle className="size-2.5 text-emerald-500 relative" fill="currentColor" />
                      </span>
                    );
                  } else if (isConfirmed) {
                    // confirmed: solid emerald left border, checkmark icon
                    borderClass = 'border-l-4 border-l-emerald-500 border border-border/40';
                    bgClass = 'bg-muted/20';
                    StatusIcon = <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />;
                  } else if (isExecuted) {
                    // executed: solid emerald left border, checkmark icon
                    borderClass = 'border-l-4 border-l-emerald-500 border border-border/40';
                    bgClass = 'bg-muted/20';
                    StatusIcon = <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />;
                  } else if (isBlocked) {
                    // blocked: solid red left border, XCircle icon, red subtle bg
                    borderClass = 'border-l-4 border-l-red-500 border border-red-200 dark:border-red-800/40';
                    bgClass = 'bg-red-50/50 dark:bg-red-950/20';
                    StatusIcon = <XCircle className="size-4 text-red-500 shrink-0" />;
                  } else if (isPartiallyExecuted) {
                    borderClass = 'border-l-4 border-l-amber-500 border border-border/40';
                    bgClass = 'bg-muted/20';
                    StatusIcon = <CheckCircle2 className="size-4 text-amber-500 shrink-0" />;
                  } else {
                    borderClass = 'border-l-4 border-l-gray-300 dark:border-l-gray-600 border border-border/40';
                    bgClass = 'bg-muted/20';
                  }

                  return (
                    <div
                      key={order.id}
                      className={`rounded-lg px-3 py-2.5 transition-all duration-200 ${borderClass} ${bgClass}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* Status icon */}
                          {StatusIcon}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`text-xs font-medium ${isBlocked ? 'text-red-700 dark:text-red-300' : ''}`}>{etfName}</span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {order.etfCode}
                              </span>
                              {/* Execution mode badge */}
                              <Badge className={`${EXECUTION_MODE_BADGE_CLASS[order.executionMode]} text-[9px] font-mono px-1.5 py-0 h-4`}>
                                {EXECUTION_MODE_LABELS[order.executionMode]}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[11px]">
                              <span className={order.side === 'buy'
                                ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                : 'text-red-600 dark:text-red-400 font-medium'}>
                                {order.side === 'buy' ? '买入' : '卖出'}{' '}
                                <span className="font-mono">{formatMoney(order.plannedAmountYuan)}</span>
                              </span>
                              {order.plannedSharesActual != null && order.plannedSharesActual > 0 && (
                                <span className="font-mono text-muted-foreground">
                                  ≈ {order.plannedSharesActual.toLocaleString('zh-CN')} 份
                                </span>
                              )}
                              {orderDeviation != null && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className={`text-[10px] font-mono ${getDeviationColor(orderDeviation)}`}>
                                      偏离 {orderDeviation >= 0 ? '+' : ''}{orderDeviation.toFixed(2)}%
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-[10px]">当前配比 vs 目标配比</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge className={`${statusCfg.bgClass} border-0 text-[10px]`}>
                            {statusCfg.label}
                          </Badge>
                          {isActionable && (
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                className="h-6 text-[10px] px-2 bg-emerald-600 hover:bg-emerald-700"
                                disabled={confirmMutation.isPending}
                                onClick={() => confirmMutation.mutate(order.id)}
                              >
                                <Check className="size-3" />
                                确认执行
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-[10px] px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                                disabled={rejectMutation.isPending}
                                onClick={() => rejectMutation.mutate(order.id)}
                              >
                                拒绝
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                      {order.rejectReason && (
                        <div className="mt-1.5 text-[11px] text-red-600 dark:text-red-400 flex items-center gap-1">
                          <AlertTriangle className="size-3" />
                          {order.rejectReason}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-xs text-muted-foreground">
                本周计算暂无执行单
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-10 text-xs text-muted-foreground space-y-1">
            <Sparkles className="size-8 mx-auto text-muted-foreground/30 mb-2" />
            <p>暂无本周计算结果</p>
            <p className="text-[10px] text-muted-foreground/60">
              完成工作流前 4 步后自动生成
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 5: Red Line Audit
// ============================================================

function RedLineAuditCard({
  executionOrders,
  etfConfigs,
  isLoading,
}: {
  executionOrders: ExecutionOrderDisplay[];
  etfConfigs: EtfConfigWithSnapshot[];
  isLoading: boolean;
}) {
  const etfNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of etfConfigs) map.set(e.code, e.name);
    return map;
  }, [etfConfigs]);

  const blockedOrders = useMemo(
    () => executionOrders.filter((o) => o.status === 'blocked' || o.status === 'rejected'),
    [executionOrders],
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-40" />
        </CardHeader>
        <CardContent className="pt-0">
          <Skeleton className="h-20 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (blockedOrders.length === 0) return null;

  return (
    <Card className="border-red-200 dark:border-red-900/40">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-red-500" />
          <div>
            <CardTitle className="text-sm text-red-700 dark:text-red-400">风控审计</CardTitle>
            <CardDescription className="text-xs">
              {blockedOrders.length} 条被阻断或拒绝的执行单
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {blockedOrders.map((order) => {
          const etfName = etfNameMap.get(order.etfCode) ?? order.etfCode;
          const statusCfg = ORDER_STATUS_CONFIG[order.status];

          return (
            <Alert key={order.id} variant="destructive" className="py-2.5">
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold">
                      {etfName}
                    </span>
                    <span className="text-[10px] font-mono opacity-80">
                      {order.etfCode}
                    </span>
                    <Badge className={`${statusCfg.bgClass} border-0 text-[9px]`}>
                      {statusCfg.label}
                    </Badge>
                  </div>
                  {order.rejectReason && (
                    <p className="text-[11px] mt-0.5 opacity-80">
                      原因: {order.rejectReason}
                    </p>
                  )}
                </div>
                <div className="text-[11px] font-mono opacity-60 shrink-0">
                  {formatMoney(order.plannedAmountYuan)}
                </div>
              </div>
            </Alert>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 6: Cash Flow
// ============================================================

function CashFlowCard({
  ledgerEntries,
  isLoading,
  isError,
}: {
  ledgerEntries: CashLedgerDisplay[];
  isLoading: boolean;
  isError: boolean;
}) {
  // Only show credit entries to avoid double-counting transfers
  const creditEntries = useMemo(
    () => ledgerEntries.filter((e) => e.entryType === 'credit'),
    [ledgerEntries],
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-40" />
        </CardHeader>
        <CardContent className="pt-0 space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">现金子账户流水</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载流水数据</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">现金子账户流水</CardTitle>
        <CardDescription className="text-xs">
          最近 {creditEntries.length} 条资金流动
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {creditEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">暂无流水记录</p>
        ) : (
          <div className="max-h-96 overflow-y-auto scrollbar-refined">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px] h-7">时间</TableHead>
                  <TableHead className="text-[11px] h-7">流向</TableHead>
                  <TableHead className="text-[11px] h-7 text-right">金额</TableHead>
                  <TableHead className="text-[11px] h-7 hidden sm:table-cell">描述</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-[11px] font-mono text-muted-foreground py-1.5">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell className="text-[11px] py-1.5">
                      <span className="inline-flex items-center gap-1">
                        <span className="text-muted-foreground truncate max-w-[80px] sm:max-w-none">
                          {CASH_ACCOUNT_LABELS[entry.debitAccount] ?? entry.debitAccount}
                        </span>
                        <ArrowRight className="size-3 text-muted-foreground/50 shrink-0" />
                        <span className="font-medium truncate max-w-[80px] sm:max-w-none">
                          {CASH_ACCOUNT_LABELS[entry.creditAccount] ?? entry.creditAccount}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-[11px] text-right font-mono font-medium py-1.5 text-emerald-600 dark:text-emerald-400">
                      +{formatMoney(entry.amountYuan)}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground hidden sm:table-cell py-1.5 truncate max-w-[200px]">
                      {entry.referenceId ?? entry.transferId ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Section 6.5: Calculation History Log
// ============================================================

function CalculationHistoryCard() {
  const { data: logs, isLoading, isError } = useQuery({
    queryKey: ['calculation-logs', 5],
    queryFn: async () => {
      const res = await fetch('/api/calculation-logs?limit=5');
      const data: ApiResponse<CalculationLogDisplay[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch calculation logs');
      return data.data!;
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError || !logs) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Clock className="size-4 text-stone-500" />
            历史计算记录
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载计算历史</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <FadeInUp>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Clock className="size-4 text-stone-500" />
            历史计算记录
          </CardTitle>
          <CardDescription className="text-xs">
            最近 {logs.length} 次计算结果
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">暂无计算记录</p>
          ) : (
            <div className="space-y-2">
              {logs.map((log, idx) => (
                <CalcHistoryItem key={log.id} log={log} index={idx} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}

function CalcHistoryItem({ log, index }: { log: CalculationLogDisplay; index: number }) {
  const [open, setOpen] = useState(false);

  return (
    <FadeInUp delay={index * 0.05}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left">
          <div
            className={`flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium font-mono truncate max-w-[120px]">
                  {log.calculationId.slice(0, 8)}…
                </span>
                {log.strategyVersion && (
                  <Badge variant="outline" className="text-[10px] font-mono">
                    策略 {log.strategyVersion}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px] font-mono">
                  引擎 {log.engineVersion}
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                <span>{formatDateTime(log.createdAt)}</span>
                <span className="text-muted-foreground/40">|</span>
                <span>EAB {formatMoney(log.eabYuan)}</span>
                <span className="text-muted-foreground/40">|</span>
                <span>预算 {formatMoney(log.budgetYuan)}</span>
                <span className="text-muted-foreground/40">|</span>
                <span className="text-emerald-600 dark:text-emerald-400">分配 {formatMoney(log.totalAllocatedYuan)}</span>
                <span className="text-muted-foreground/40">|</span>
                <span className="text-amber-600 dark:text-amber-400">未分配 {formatMoney(log.totalUnallocatedYuan)}</span>
              </div>
            </div>
            <ChevronDown
              className={`size-4 text-muted-foreground shrink-0 ml-2 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 ml-3 rounded-lg border border-dashed border-border/60 bg-muted/10 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground shrink-0">inputsHash</span>
              <code className="text-[10px] font-mono text-muted-foreground/80 bg-muted px-1.5 py-0.5 rounded break-all">
                {log.inputsHash.length > 64 ? log.inputsHash.slice(0, 64) + '…' : log.inputsHash}
              </code>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div><span className="text-muted-foreground">再平衡</span><span className="ml-1 font-mono">{formatMoney(log.totalRebalancedYuan)}</span></div>
              <div><span className="text-muted-foreground">总分配</span><span className="ml-1 font-mono text-emerald-600 dark:text-emerald-400">{formatMoney(log.totalAllocatedYuan)}</span></div>
              <div><span className="text-muted-foreground">未分配</span><span className="ml-1 font-mono text-amber-600 dark:text-amber-400">{formatMoney(log.totalUnallocatedYuan)}</span></div>
              <div><span className="text-muted-foreground">资金去向</span><span className="ml-1 font-mono">{log.cashDestination ?? '—'}</span></div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </FadeInUp>
  );
}

// ============================================================
// Section 7: Release Plans
// ============================================================

function ReleasePlansCard({
  plans,
  isLoading,
  isError,
}: {
  plans: ReleasePlanDisplay[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">释放计划</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">无法加载释放计划数据</p>
        </CardContent>
      </Card>
    );
  }

  const activePlans = plans.filter((p) => p.state !== 'completed');

  if (activePlans.length === 0 && plans.length > 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">释放计划</CardTitle>
          <CardDescription className="text-xs">所有计划已完成</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground text-center py-6">暂无活跃的释放计划</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">释放计划</CardTitle>
        <CardDescription className="text-xs">
          {activePlans.length} 个活跃计划 · QDII溢价 & 再平衡备用金
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {activePlans.length === 0 && plans.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">暂无释放计划</p>
        ) : (
          <div className="space-y-2">
            {(activePlans.length > 0 ? activePlans : plans).map((plan) => {
              const stateCfg = RELEASE_STATE_CONFIG[plan.state];

              return (
                <div
                  key={plan.id}
                  className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium">
                        {RELEASE_TYPE_LABELS[plan.planType] ?? plan.planType}
                      </span>
                      {plan.targetEtf && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          → {plan.targetEtf}
                        </span>
                      )}
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium ${stateCfg.bgClass}`}>
                        {stateCfg.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                      <span>
                        余额 {formatMoney(plan.balanceYuan)}
                      </span>
                      <span className="text-muted-foreground/40">|</span>
                      <span>
                        剩余 {plan.weeksRemaining}/{plan.weeksTotal} 周
                      </span>
                      <span className="text-muted-foreground/40">|</span>
                      <span>
                        每周 {formatMoney(plan.weeklyAmountYuan)}
                      </span>
                    </div>
                    {plan.pausedReason && (
                      <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-2.5" />
                        {plan.pausedReason}
                      </div>
                    )}
                  </div>
                  {/* Mini progress bar */}
                  <div className="shrink-0 ml-3 hidden sm:flex flex-col items-end gap-1">
                    <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                        style={{
                          width: `${plan.weeksTotal > 0 ? ((plan.weeksTotal - plan.weeksRemaining) / plan.weeksTotal) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {plan.weeksTotal > 0 ? Math.round(((plan.weeksTotal - plan.weeksRemaining) / plan.weeksTotal) * 100) : 0}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Main Component: OverviewTab
// ============================================================

export function OverviewTab() {
  // ─── Data Queries ─────────────────────────────────────────
  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      const data: ApiResponse<DashboardData> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch dashboard');
      return data.data!;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const dataQualityQuery = useQuery({
    queryKey: ['data-quality'],
    queryFn: async () => {
      const res = await fetch('/api/data-quality');
      const data: ApiResponse<DataQualitySummaryResponse> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch data quality');
      return data.data!;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const etfConfigsQuery = useQuery({
    queryKey: ['etf-configs'],
    queryFn: async () => {
      const res = await fetch('/api/etf-configs');
      const data: ApiResponse<EtfConfigWithSnapshot[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch ETF configs');
      return data.data!;
    },
    staleTime: 5 * 60_000,
  });

  const cashAccountsQuery = useQuery({
    queryKey: ['cash-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/cash-accounts');
      const data: ApiResponse<CashAccountDisplay[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch cash accounts');
      return data.data!;
    },
    staleTime: 30_000,
  });

  const executionOrdersQuery = useQuery({
    queryKey: ['execution-orders'],
    queryFn: async () => {
      const res = await fetch('/api/execution-orders');
      const data: ApiResponse<ExecutionOrderDisplay[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch execution orders');
      return data.data!;
    },
    staleTime: 15_000,
  });

  const cashLedgerQuery = useQuery({
    queryKey: ['cash-ledger', 10],
    queryFn: async () => {
      const res = await fetch('/api/cash-ledger?limit=10');
      const data: ApiResponse<CashLedgerDisplay[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch cash ledger');
      return data.data!;
    },
    staleTime: 30_000,
  });

  const releasePlansQuery = useQuery({
    queryKey: ['release-plans'],
    queryFn: async () => {
      const res = await fetch('/api/release-plans');
      const data: ApiResponse<ReleasePlanDisplay[]> = await res.json();
      if (!data.success) throw new Error(data.error ?? 'Failed to fetch release plans');
      return data.data!;
    },
    staleTime: 60_000,
  });

  const dashboard = dashboardQuery.data ?? null;
  const etfConfigs = etfConfigsQuery.data ?? [];

  return (
    <div className="space-y-4">
      {/* Section 1: Weekly Task Status Bar */}
      {dashboardQuery.isLoading ? (
        <WeeklyTaskStatusBarSkeleton />
      ) : (
        <WeeklyTaskStatusBar dashboard={dashboard} />
      )}

      {/* Section 2: Data Quality Gate Summary */}
      <DataQualityGateCard
        qualityData={dataQualityQuery.data ?? null}
        etfConfigs={etfConfigs}
        isLoading={dataQualityQuery.isLoading}
        isError={dataQualityQuery.isError}
      />

      {/* Section 2.5: Portfolio Allocation Donut Chart */}
      <PortfolioAllocationDonut
        etfConfigs={etfConfigs}
        cashAccounts={cashAccountsQuery.data ?? []}
        isLoading={etfConfigsQuery.isLoading || cashAccountsQuery.isLoading}
      />

      {/* Section 3: Portfolio Overview — Holdings + Cash side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PortfolioHoldingsTable
          etfConfigs={etfConfigs}
          isLoading={etfConfigsQuery.isLoading}
          isError={etfConfigsQuery.isError}
        />
        <CashAccountsSummary
          accounts={cashAccountsQuery.data ?? []}
          isLoading={cashAccountsQuery.isLoading}
          isError={cashAccountsQuery.isError}
        />
      </div>

      {/* Section 3.5: Weekly Budget Utilization */}
      <WeeklyBudgetUtilization
        dashboard={dashboard}
        executionOrders={executionOrdersQuery.data ?? []}
      />

      {/* Section 4: Weekly Execution Summary */}
      <WeeklyExecutionSummary
        dashboard={dashboard}
        executionOrders={executionOrdersQuery.data ?? []}
        etfConfigs={etfConfigs}
        isLoading={dashboardQuery.isLoading || executionOrdersQuery.isLoading}
        isError={dashboardQuery.isError || executionOrdersQuery.isError}
      />

      {/* Section 5: Red Line Audit — only renders when blocked/rejected orders exist */}
      <RedLineAuditCard
        executionOrders={executionOrdersQuery.data ?? []}
        etfConfigs={etfConfigs}
        isLoading={executionOrdersQuery.isLoading}
      />

      {/* Section 6: Cash Flow */}
      <CashFlowCard
        ledgerEntries={cashLedgerQuery.data ?? []}
        isLoading={cashLedgerQuery.isLoading}
        isError={cashLedgerQuery.isError}
      />

      {/* Section 6.5: Calculation History */}
      <CalculationHistoryCard />

      {/* Section 7: Release Plans */}
      <ReleasePlansCard
        plans={releasePlansQuery.data ?? []}
        isLoading={releasePlansQuery.isLoading}
        isError={releasePlansQuery.isError}
      />
    </div>
  );
}