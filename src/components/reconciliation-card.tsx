'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Scale,
  RefreshCw,
  CheckCircle2,
  Clock,
  Pause,
  XCircle,
  Hourglass,
  AlertCircle,
} from 'lucide-react';
import { getReconciliation, type ReconciliationItem } from '@/lib/api';

// V5.0 Sprint4 E8: 计划 vs 实际对账卡片
//
// 仅 advice 存在时由 overview.tsx 渲染。
// 用 useQuery 拉 GET /api/execution?type=reconciliation&calculationId={advice.calculationId}
// 展示表格: ETF名称 | 计划金额 | 实际金额 | 偏差金额 | 偏差% | 状态Badge
// 底部: 总计划 vs 总实际汇总
// 无数据时显示"暂无成交回填记录"

interface EtfInfo {
  code: string;
  name: string;
}

export interface ReconciliationCardProps {
  calculationId: string;
  etfInfos?: EtfInfo[];
  /** 外部触发刷新(例如 FillOrderDialog 回填成功后) */
  refreshKey?: number;
}

function formatYuan(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

function formatPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function getEtfName(code: string, etfInfos?: EtfInfo[]): string {
  if (!etfInfos || etfInfos.length === 0) return code;
  const hit = etfInfos.find((e) => e.code === code);
  return hit?.name || code;
}

// orderStatus → 图标 + 文案 + 颜色
function getStatusMeta(status: string): {
  label: string;
  className: string;
  icon: React.ComponentType<{ className?: string }>;
} {
  switch (status) {
    case 'executed':
      return {
        label: '已成交',
        className:
          'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40',
        icon: CheckCircle2,
      };
    case 'partially_executed':
      return {
        label: '部分成交',
        className:
          'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40',
        icon: Clock,
      };
    case 'confirmed':
      return {
        label: '待回填',
        className:
          'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-slate-100/60 dark:bg-slate-900/40',
        icon: Pause,
      };
    case 'pending':
      return {
        label: '待确认',
        className:
          'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-slate-100/60 dark:bg-slate-900/40',
        icon: Pause,
      };
    case 'cancelled':
      return {
        label: '已撤销',
        className:
          'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40',
        icon: XCircle,
      };
    case 'expired':
      return {
        label: '已过期',
        className:
          'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 bg-slate-100/40 dark:bg-slate-900/30',
        icon: Hourglass,
      };
    case 'rejected':
      return {
        label: '已拒绝',
        className:
          'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40',
        icon: XCircle,
      };
    default:
      return {
        label: status || '—',
        className: 'border-border text-muted-foreground bg-muted/40',
        icon: AlertCircle,
      };
  }
}

// 偏差颜色: 负偏差(未完成) 红, |pct|<=1% 绿, 其余 黄
function getDeviationPctClass(pct: number, status: string): string {
  if (status === 'cancelled' || status === 'expired' || status === 'rejected') {
    return 'text-muted-foreground';
  }
  if (pct === 0) return 'text-muted-foreground';
  if (pct > 0) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= -1) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= -50) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export function ReconciliationCard({
  calculationId,
  etfInfos,
  refreshKey = 0,
}: ReconciliationCardProps) {
  const query = useQuery({
    queryKey: ['execution-reconciliation', calculationId, refreshKey],
    queryFn: () => getReconciliation(calculationId),
    enabled: !!calculationId,
    staleTime: 15_000,
  });

  const items: ReconciliationItem[] = query.data?.items ?? [];
  const summary = query.data?.summary;
  const isLoading = query.isLoading;
  const isError = query.isError;
  const hasErrorPayload = !!query.data?.error;

  // 排序: executed 在最上, 其次 partially_executed, 然后 confirmed/pending, 最后 cancelled/expired/rejected
  const statusOrder: Record<string, number> = {
    executed: 0,
    partially_executed: 1,
    confirmed: 2,
    pending: 3,
    cancelled: 4,
    expired: 5,
    rejected: 6,
  };
  const sortedItems = [...items].sort((a, b) => {
    const sa = statusOrder[a.orderStatus] ?? 99;
    const sb = statusOrder[b.orderStatus] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.etfCode.localeCompare(b.etfCode);
  });

  return (
    <Card className="shadow-card overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center justify-center rounded-lg bg-emerald-50/60 dark:bg-emerald-950/40 p-1.5 shrink-0">
              <Scale className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-sm">计划vs实际对账</CardTitle>
              <CardDescription className="text-[11px] mt-0.5 truncate">
                本批次执行单的实际成交回填情况
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] text-muted-foreground"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            title="刷新对账数据"
          >
            <RefreshCw
              className={`size-3 mr-1 ${query.isFetching ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : isError || hasErrorPayload ? (
          <div className="flex flex-col items-center justify-center text-muted-foreground text-xs gap-2 py-6">
            <AlertCircle className="size-4 text-amber-500" />
            <span>对账数据加载失败,请稍后重试</span>
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-muted-foreground text-xs gap-2 py-6">
            <Scale className="size-4 text-muted-foreground/60" />
            <span>暂无成交回填记录</span>
            <span className="text-[10px] text-muted-foreground/60">
              (在执行确认弹窗中确认订单后,即可回填成交)
            </span>
          </div>
        ) : (
          <>
            <div className="rounded-md border max-h-[28rem] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur z-10">
                  <TableRow>
                    <TableHead className="text-xs whitespace-nowrap">ETF</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">计划金额</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">实际金额</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">偏差金额</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">偏差%</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedItems.map((o) => {
                    const meta = getStatusMeta(o.orderStatus);
                    const Icon = meta.icon;
                    return (
                      <TableRow key={o.orderId}>
                        <TableCell className="text-xs align-middle">
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-medium truncate">
                              {getEtfName(o.etfCode, etfInfos)}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {o.etfCode}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                          {formatYuan(o.plannedAmount)}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                          {o.actualAmount > 0 ? formatYuan(o.actualAmount) : '—'}
                        </TableCell>
                        <TableCell
                          className={`text-xs font-mono text-right align-middle whitespace-nowrap ${
                            o.deviation > 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : o.deviation < 0
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {o.actualAmount > 0
                            ? `${o.deviation > 0 ? '+' : ''}${formatYuan(o.deviation)}`
                            : '—'}
                        </TableCell>
                        <TableCell
                          className={`text-xs font-mono text-right align-middle whitespace-nowrap ${getDeviationPctClass(
                            o.deviationPct,
                            o.orderStatus
                          )}`}
                        >
                          {o.actualAmount > 0 ? formatPct(o.deviationPct) : '—'}
                        </TableCell>
                        <TableCell className="text-xs align-middle text-center">
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-mono ${meta.className}`}
                          >
                            <Icon className="size-2.5" />
                            {meta.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* 汇总 */}
            {summary && (
              <div className="flex flex-wrap items-center gap-2 text-xs px-1">
                <Badge variant="outline" className="text-[11px] font-mono">
                  总计划 {formatYuan(summary.totalPlanned)}
                </Badge>
                <Badge
                  variant="outline"
                  className={`text-[11px] font-mono ${
                    summary.totalActual > 0
                      ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/40 dark:bg-emerald-900/30'
                      : ''
                  }`}
                >
                  总实际 {formatYuan(summary.totalActual)}
                </Badge>
                <Badge
                  variant="outline"
                  className={`text-[11px] font-mono ${
                    summary.totalDeviation > 0
                      ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/40 dark:bg-emerald-900/30'
                      : summary.totalDeviation < 0
                      ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/40 dark:bg-red-900/30'
                      : ''
                  }`}
                >
                  偏差{' '}
                  {summary.totalDeviation > 0 ? '+' : ''}
                  {formatYuan(summary.totalDeviation)} ({formatPct(summary.totalDeviationPct)})
                </Badge>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
