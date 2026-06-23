'use client';

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Wallet,
  Repeat,
  Ban,
  ArrowRight,
  Layers,
  PiggyBank,
  Hourglass,
  Landmark,
} from 'lucide-react';
import type { AdviceResponse, CashPoolSuggestion } from '@/lib/types';
import { FadeInUp } from '@/lib/motion';

// V4.2 §9: inflowType → 文案 + 图标映射
const INFLOW_TYPE_MAP: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  unallocated: {
    label: '未分配预算',
    icon: Wallet,
    color: 'text-amber-600 dark:text-amber-400',
  },
  rebalance_release: {
    label: '再平衡释放',
    icon: Repeat,
    color: 'text-orange-600 dark:text-orange-400',
  },
  qdii_blocked: {
    label: 'QDII溢价阻断',
    icon: Ban,
    color: 'text-red-600 dark:text-red-400',
  },
};

// V4.2 §9: subaccountType → 子账户展示名 + 图标映射
const SUBACCOUNT_MAP: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  weekly_unallocated_cash: {
    label: '待投权益现金',
    icon: Wallet,
    color: 'text-amber-600 dark:text-amber-400',
  },
  rebalance_equity_reserve: {
    label: '再平衡备用金',
    icon: PiggyBank,
    color: 'text-orange-600 dark:text-orange-400',
  },
  qdii_pending_cash_sp500: {
    label: '标普500挂起池',
    icon: Hourglass,
    color: 'text-red-600 dark:text-red-400',
  },
  qdii_pending_cash_nasdaq: {
    label: '纳斯达克挂起池',
    icon: Hourglass,
    color: 'text-red-600 dark:text-red-400',
  },
  daily_cash: {
    label: '日常现金',
    icon: Landmark,
    color: 'text-sky-600 dark:text-sky-400',
  },
  manual_cash: {
    label: '手工现金',
    icon: Landmark,
    color: 'text-muted-foreground',
  },
};

function formatYuan(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

interface CashSubaccountFlowCardProps {
  advice: AdviceResponse;
}

/**
 * V4.2 §9 现金子账户流向卡 — 展示 cashPoolSuggestions 数组
 * 在结论卡下方、持仓明细表上方渲染
 */
export function CashSubaccountFlowCard({ advice }: CashSubaccountFlowCardProps) {
  const suggestions: CashPoolSuggestion[] = advice.cashPoolSuggestions ?? [];
  // V4.2 §9 兜底: 若 cashPoolSuggestions 为空但 cashMovements 有数据, 用 cashMovements 兜底
  const movements = advice.cashMovements ?? [];

  // 过滤掉金额为 0 的条目(避免噪音)
  const visibleSuggestions = suggestions.filter(
    (s) => (s.inflowAmount ?? 0) > 0
  );
  const visibleMovements = movements.filter((m) => (m.amount ?? 0) > 0);

  // 双空时不出卡
  if (visibleSuggestions.length === 0 && visibleMovements.length === 0) {
    return null;
  }

  return (
    <FadeInUp delay={0.12}>
      <Card className="shadow-card overflow-hidden">
        <CardContent className="space-y-3 pt-6">
          {/* 标题行 */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-lg bg-violet-50/60 dark:bg-violet-950/40 p-1.5">
                <Layers className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </span>
              <h3 className="text-sm font-semibold">现金子账户流向</h3>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 rounded-full font-mono text-violet-600 dark:text-violet-400 border-violet-300/70 dark:border-violet-700/50 bg-violet-100/40 dark:bg-violet-900/30"
              >
                V4.2 §9
              </Badge>
            </div>
            <span className="text-[11px] text-muted-foreground/70">
              {visibleSuggestions.length > 0
                ? `本周共 ${visibleSuggestions.length} 笔资金流向`
                : `本周共 ${visibleMovements.length} 笔台账记录`}
            </span>
          </div>

          {/* 流向表格 */}
          {visibleSuggestions.length > 0 ? (
            <div className="rounded-lg border border-border/60 dark:border-border/40 overflow-hidden">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/40 dark:hover:bg-muted/20 border-b border-border/60">
                    <TableHead className="w-[140px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">来源</TableHead>
                    <TableHead className="w-[40px] text-center text-[11px] font-medium text-muted-foreground"></TableHead>
                    <TableHead className="w-[160px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">现金子账户</TableHead>
                    <TableHead className="text-right w-[110px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">金额</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">备注</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleSuggestions.map((s, i) => {
                    const inflow = INFLOW_TYPE_MAP[s.inflowType] ?? {
                      label: s.inflowType || '未知',
                      icon: Wallet,
                      color: 'text-muted-foreground',
                    };
                    const InflowIcon = inflow.icon;
                    const sub = SUBACCOUNT_MAP[s.subaccountType ?? ''] ?? {
                      label: s.subaccountType || '未分类',
                      icon: Landmark,
                      color: 'text-muted-foreground',
                    };
                    const SubIcon = sub.icon;
                    return (
                      <TableRow
                        key={`flow-${i}-${s.code ?? 'na'}`}
                        className="border-b border-border/40 dark:border-border/30 last:border-0 hover:bg-accent/30 dark:hover:bg-accent/20"
                      >
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <InflowIcon className={`h-3.5 w-3.5 shrink-0 ${inflow.color}`} />
                            <span className="font-medium">{inflow.label}</span>
                          </div>
                          {s.name && (
                            <div className="text-[10px] text-muted-foreground/70 mt-0.5 pl-5">
                              {s.name}({s.code})
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-center align-middle">
                          <ArrowRight className="h-3 w-3 text-muted-foreground/60 inline-block" />
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <SubIcon className={`h-3.5 w-3.5 shrink-0 ${sub.color}`} />
                            <span className="font-medium">{sub.label}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground/70 mt-0.5 pl-5 font-mono">
                            {s.subaccountType || '—'}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold tabular-nums text-foreground">
                          {formatYuan(s.inflowAmount)}
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground max-w-[220px]">
                          {s.description ? (
                            <span className="line-clamp-2">{s.description}</span>
                          ) : s.countsAsEquityBase ? (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 rounded-full font-mono text-emerald-700 dark:text-emerald-400 border-emerald-300/70 dark:border-emerald-700/50 bg-emerald-100/40 dark:bg-emerald-900/30"
                            >
                              计入权益基准
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            // V4.2 §9 兜底: cashPoolSuggestions 为空时显示 cashMovements 台账
            <div className="rounded-lg border border-border/60 dark:border-border/40 overflow-hidden">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/40 dark:hover:bg-muted/20 border-b border-border/60">
                    <TableHead className="w-[160px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">来源事件</TableHead>
                    <TableHead className="w-[180px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">现金子账户</TableHead>
                    <TableHead className="w-[120px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">关联ETF</TableHead>
                    <TableHead className="text-right w-[110px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">金额</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMovements.map((m, i) => {
                    const sub = SUBACCOUNT_MAP[m.cashAccountType] ?? {
                      label: m.cashAccountType,
                      icon: Landmark,
                      color: 'text-muted-foreground',
                    };
                    const SubIcon = sub.icon;
                    return (
                      <TableRow
                        key={`mv-${i}`}
                        className="border-b border-border/40 dark:border-border/30 last:border-0 hover:bg-accent/30 dark:hover:bg-accent/20"
                      >
                        <TableCell className="text-xs font-medium">{m.sourceEvent || '—'}</TableCell>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <SubIcon className={`h-3.5 w-3.5 shrink-0 ${sub.color}`} />
                            <span>{sub.label}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground font-mono">
                          {m.sourceEtf || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold tabular-nums text-foreground">
                          {formatYuan(m.amount)}
                        </TableCell>
                        <TableCell className="text-[11px]">
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 rounded-full font-mono ${
                              m.status === 'pending'
                                ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/40 dark:bg-amber-900/30'
                                : m.status === 'released'
                                ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/40 dark:bg-emerald-900/30'
                                : 'border-border text-muted-foreground bg-muted/40 dark:bg-muted/20'
                            }`}
                          >
                            {m.status || '—'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* 子账户余额汇总(来自 AdviceResponse 顶层 V4.2 字段) */}
          {(advice.weeklyUnallocatedCash !== undefined ||
            advice.rebalanceEquityReserve !== undefined ||
            advice.qdiiPendingCashSp500 !== undefined ||
            advice.qdiiPendingCashNasdaq !== undefined) && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground pt-1 border-t border-border/40 dark:border-border/30">
              <span className="text-muted-foreground/70 font-medium">子账户余额:</span>
              {advice.weeklyUnallocatedCash !== undefined && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full font-mono text-amber-700 dark:text-amber-400 border-amber-300/70 dark:border-amber-700/50 bg-amber-100/40 dark:bg-amber-900/30">
                  待投权益 {formatYuan(advice.weeklyUnallocatedCash)}
                </Badge>
              )}
              {advice.rebalanceEquityReserve !== undefined && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full font-mono text-orange-700 dark:text-orange-400 border-orange-300/70 dark:border-orange-700/50 bg-orange-100/40 dark:bg-orange-900/30">
                  再平衡备用 {formatYuan(advice.rebalanceEquityReserve)}
                </Badge>
              )}
              {advice.qdiiPendingCashSp500 !== undefined && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full font-mono text-red-700 dark:text-red-400 border-red-300/70 dark:border-red-700/50 bg-red-100/40 dark:bg-red-900/30">
                  标普挂起 {formatYuan(advice.qdiiPendingCashSp500)}
                </Badge>
              )}
              {advice.qdiiPendingCashNasdaq !== undefined && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full font-mono text-red-700 dark:text-red-400 border-red-300/70 dark:border-red-700/50 bg-red-100/40 dark:bg-red-900/30">
                  纳斯达克挂起 {formatYuan(advice.qdiiPendingCashNasdaq)}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}
