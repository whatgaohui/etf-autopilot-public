'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { FadeInUp } from '@/lib/motion';
import { getCashAccounts, checkConservation, type CashAccount } from '@/lib/api';

function formatYuan(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

// 子账户展示名映射 (沿用 cash-subaccount-flow-card 同款文案)
const ACCOUNT_LABEL: Record<string, string> = {
  weekly_unallocated_cash: '待投权益现金',
  weekly_contribution_committed: '本周承诺注资',
  rebalance_equity_reserve: '再平衡备用金',
  qdii_pending_cash_sp500: '标普500挂起池',
  qdii_pending_cash_nasdaq: '纳斯达克挂起池',
  daily_cash: '日常现金',
  manual_cash: '手工现金',
};

function accountLabel(type: string): string {
  return ACCOUNT_LABEL[type] ?? type;
}

/**
 * V5.0 E3 现金账本与守恒校验卡
 * 上半: 7 个子账户余额表
 * 下半: 总量守恒 + 逐账户守恒校验结果
 */
export function CashLedgerConservationCard() {
  const accountsQuery = useQuery({
    queryKey: ['cash-accounts'],
    queryFn: getCashAccounts,
    staleTime: 15_000,
  });

  const conservationQuery = useQuery({
    queryKey: ['cash-conservation'],
    queryFn: checkConservation,
    staleTime: 15_000,
  });

  const accounts: CashAccount[] = accountsQuery.data?.accounts ?? [];
  const conservation = conservationQuery.data;
  const isLoading = accountsQuery.isLoading || conservationQuery.isLoading;
  const isError = accountsQuery.isError || conservationQuery.isError;

  const refetchAll = () => {
    accountsQuery.refetch();
    conservationQuery.refetch();
  };

  return (
    <FadeInUp delay={0.14}>
      <Card className="shadow-card overflow-hidden">
        <CardContent className="space-y-4 pt-6">
          {/* 标题行 */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-lg bg-emerald-50/60 dark:bg-emerald-950/40 p-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              <h3 className="text-sm font-semibold">现金账本与守恒</h3>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 rounded-full font-mono text-emerald-700 dark:text-emerald-400 border-emerald-300/70 dark:border-emerald-700/50 bg-emerald-100/40 dark:bg-emerald-900/30"
              >
                V5.0 E3
              </Badge>
            </div>
            <button
              type="button"
              onClick={refetchAll}
              disabled={isLoading}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
              aria-label="刷新现金账本"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>

          {isError && (
            <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />
              现金账本数据加载失败,请稍后重试
            </div>
          )}

          {isLoading && accounts.length === 0 ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full rounded" />
              <Skeleton className="h-8 w-full rounded" />
              <Skeleton className="h-8 w-full rounded" />
            </div>
          ) : (
            <>
              {/* 上半: 子账户余额表 */}
              <div>
                <div className="text-[11px] font-medium text-muted-foreground/80 uppercase tracking-wide mb-1.5">
                  子账户余额 · 共 {accounts.length} 个
                </div>
                <div className="rounded-lg border border-border/60 dark:border-border/40 overflow-hidden">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/40 dark:hover:bg-muted/20 border-b border-border/60">
                        <TableHead className="w-[180px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">账户类型</TableHead>
                        <TableHead className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">描述</TableHead>
                        <TableHead className="text-right w-[120px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">余额</TableHead>
                        <TableHead className="text-center w-[110px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">计入权益基准</TableHead>
                        <TableHead className="text-right w-[80px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">流水数</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {accounts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-xs text-muted-foreground/60 py-4">
                            暂无子账户数据
                          </TableCell>
                        </TableRow>
                      ) : (
                        accounts.map((a) => (
                          <TableRow
                            key={a.account_type}
                            className="border-b border-border/40 dark:border-border/30 last:border-0 hover:bg-accent/30 dark:hover:bg-accent/20"
                          >
                            <TableCell className="text-xs">
                              <div className="font-medium">{accountLabel(a.account_type)}</div>
                              <div className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono">
                                {a.account_type}
                              </div>
                            </TableCell>
                            <TableCell className="text-[11px] text-muted-foreground max-w-[260px]">
                              {a.description || '—'}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs font-bold tabular-nums text-foreground">
                              {formatYuan(a.balance)}
                            </TableCell>
                            <TableCell className="text-center">
                              {a.counts_as_equity_base ? (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1.5 py-0 rounded-full font-mono text-emerald-700 dark:text-emerald-400 border-emerald-300/70 dark:border-emerald-700/50 bg-emerald-100/40 dark:bg-emerald-900/30"
                                >
                                  是
                                </Badge>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/50">否</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                              {a.flow_count ?? 0}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* 下半: 守恒校验 */}
              <div className="pt-1 border-t border-border/40 dark:border-border/30">
                <div className="text-[11px] font-medium text-muted-foreground/80 uppercase tracking-wide mb-1.5">
                  守恒校验
                </div>

                {isLoading && !conservation ? (
                  <Skeleton className="h-12 w-full rounded" />
                ) : conservation ? (
                  <div className="space-y-2">
                    {/* 总量守恒 */}
                    <div
                      className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                        conservation.total_check
                          ? 'border-emerald-300/60 dark:border-emerald-700/40 bg-emerald-50/50 dark:bg-emerald-950/20'
                          : 'border-red-300/60 dark:border-red-700/40 bg-red-50/50 dark:bg-red-950/20'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {conservation.total_check ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                        )}
                        <span className="text-xs font-medium">
                          总量守恒 {conservation.total_check ? '通过' : '失败'}
                        </span>
                      </div>
                      <span className="text-xs font-mono font-bold tabular-nums">
                        总余额 {formatYuan(conservation.total_balance)}
                      </span>
                    </div>

                    {/* 逐账户守恒 */}
                    <div className="rounded-lg border border-border/60 dark:border-border/40 overflow-hidden">
                      <Table className="text-xs">
                        <TableHeader>
                          <TableRow className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/40 dark:hover:bg-muted/20 border-b border-border/60">
                            <TableHead className="w-[150px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">账户</TableHead>
                            <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">期初</TableHead>
                            <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">流入</TableHead>
                            <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">流出</TableHead>
                            <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">期望期末</TableHead>
                            <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">实际期末</TableHead>
                            <TableHead className="text-center w-[70px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">校验</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {conservation.account_checks.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={7} className="text-center text-xs text-muted-foreground/60 py-4">
                                暂无校验数据
                              </TableCell>
                            </TableRow>
                          ) : (
                            conservation.account_checks.map((c) => (
                              <TableRow
                                key={c.account}
                                className={`border-b border-border/40 dark:border-border/30 last:border-0 hover:bg-accent/30 dark:hover:bg-accent/20 ${
                                  !c.pass ? 'bg-red-50/30 dark:bg-red-950/10' : ''
                                }`}
                              >
                                <TableCell className="text-xs">
                                  <div className="font-medium">{accountLabel(c.account)}</div>
                                  <div className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono">
                                    {c.account}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                                  {formatYuan(c.opening)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] text-emerald-600 dark:text-emerald-400 tabular-nums">
                                  {formatYuan(c.inflow)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] text-red-600 dark:text-red-400 tabular-nums">
                                  {formatYuan(c.outflow)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                                  {formatYuan(c.expected_closing)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] font-bold tabular-nums">
                                  {formatYuan(c.actual_closing)}
                                </TableCell>
                                <TableCell className="text-center">
                                  {c.pass ? (
                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 inline-block" />
                                  ) : (
                                    <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 inline-block" />
                                  )}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground/60 py-2">暂无守恒校验数据</div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}
