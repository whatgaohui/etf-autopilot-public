'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { History, ChevronDown, ChevronRight, FileText, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getCalculationLogs, getPortfolioMetrics, type CalculationLogItem } from '@/lib/api';
import { TrendingDown, ArrowDownRight } from 'lucide-react';
import { FadeInUp, staggerContainer, StaggerItem, motion, AnimatePresence, EASE } from '@/lib/motion';

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatYuan(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

export function HistoryLogCard() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['calculation-logs'],
    queryFn: () => getCalculationLogs(20),
    enabled: isOpen, // 只在展开时加载
  });

  const { data: metrics } = useQuery({
    queryKey: ['portfolio-metrics'],
    queryFn: getPortfolioMetrics,
    enabled: isOpen,
  });

  const logs = data?.logs ?? [];

  return (
    <FadeInUp delay={0.05}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <Card className="shadow-card overflow-hidden">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/30 dark:hover:bg-muted/20 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center rounded-lg bg-violet-50/60 dark:bg-violet-950/40 p-1.5">
                    <History className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                  </span>
                  <CardTitle className="text-sm font-semibold">历史建议回溯</CardTitle>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full font-mono text-violet-700 dark:text-violet-400 border-violet-300 dark:border-violet-700/50 bg-violet-50/60 dark:bg-violet-950/30">
                    审计日志
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  {logs.length > 0 && (
                    <span className="text-[11px]">最近 {logs.length} 条</span>
                  )}
                  <motion.span
                    animate={{ rotate: isOpen ? 0 : 0 }}
                    className="inline-flex"
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </motion.span>
                </div>
              </div>
              <CardDescription className="text-xs">
                每次生成建议均记录完整审计字段（策略书§11）：计算批次、引擎版本、持仓快照、规则命中、数据质量、AI校验结果
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="overflow-hidden"
            >
              <CardContent className="pt-0">
                {/* V4 策略书§10.1: 组合最大回撤监控 */}
                {metrics && metrics.maxDrawdownPct > 0 && (
                  <div className={`mb-3 rounded-md border p-2.5 text-xs ${
                    metrics.maxDrawdownPct > 15
                      ? 'bg-red-50/70 dark:bg-red-950/30 border-red-300 dark:border-red-800/50 text-red-800 dark:text-red-300'
                      : metrics.maxDrawdownPct > 8
                      ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800/50 text-amber-800 dark:text-amber-300'
                      : 'bg-muted/30 dark:bg-muted/20 border-border text-muted-foreground'
                  }`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <TrendingDown className={`h-3.5 w-3.5 ${metrics.maxDrawdownPct > 8 ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'}`} />
                      <span className="font-medium">组合最大回撤</span>
                      <span className={`font-mono font-bold ml-auto ${metrics.maxDrawdownPct > 15 ? 'text-red-700 dark:text-red-400' : metrics.maxDrawdownPct > 8 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                        -{metrics.maxDrawdownPct.toFixed(2)}%
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                      <span>峰值 ¥{metrics.peakValue.toLocaleString('zh-CN')}</span>
                      <ArrowDownRight className="h-3 w-3" />
                      <span>谷值 ¥{metrics.troughValue.toLocaleString('zh-CN')}</span>
                      <span className="ml-auto">当前 ¥{metrics.currentValue.toLocaleString('zh-CN')}</span>
                    </div>
                    {metrics.maxDrawdownPct > 15 && (
                      <div className="text-[10px] text-red-700 dark:text-red-400 mt-1">⚠ 回撤超过15%，建议关注A股美股相关性风险</div>
                    )}
                  </div>
                )}
                {isLoading ? (
                  <div className="text-xs text-muted-foreground py-4 text-center">加载中...</div>
                ) : logs.length === 0 ? (
                  <div className="text-xs text-muted-foreground/60 italic py-4 text-center">
                    暂无历史记录，生成建议后将自动记录
                  </div>
                ) : (
                  <motion.div
                    variants={staggerContainer(0.04)}
                    initial="hidden"
                    animate="show"
                    className="space-y-1.5 max-h-96 overflow-y-auto"
                  >
                    {logs.map((log) => (
                      <HistoryLogItem
                        key={log.id}
                        log={log}
                        isExpanded={selectedId === log.calculationId}
                        onToggle={() => setSelectedId(selectedId === log.calculationId ? null : log.calculationId)}
                      />
                    ))}
                  </motion.div>
                )}
              </CardContent>
            </motion.div>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </FadeInUp>
  );
}

function HistoryLogItem({
  log,
  isExpanded,
  onToggle,
}: {
  log: CalculationLogItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const rebalanced = log.totalRebalanced ?? 0;
  const hasRebalance = rebalanced > 0;

  // AI 校验结果状态
  const aiStatus = log.aiCheckResult;
  const aiOk = aiStatus === 'passed' || aiStatus === 'pending_advice';

  // 数据质量汇总
  const dqSummary = log.dataQualitySummary ?? [];
  const dqIssues = dqSummary.filter(d => d.qualityStatus !== 'passed');

  return (
    <StaggerItem className="rounded-md border bg-card/50 dark:bg-card/30 overflow-hidden hover:shadow-soft hover:border-border transition-all duration-200 ease-out-expo">
      {/* 摘要行 */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2.5 hover:bg-muted/30 dark:hover:bg-muted/20 transition-colors text-left"
      >
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono text-[11px] text-muted-foreground truncate shrink-0 min-w-[120px]">
          {log.calculationId}
        </span>
        <span className="text-[11px] text-muted-foreground/70 shrink-0 hidden sm:inline">
          <Clock className="h-3 w-3 inline mr-0.5" />
          {formatDateTime(log.createdAt)}
        </span>
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <Badge variant="outline" className="text-[9px] px-1 py-0 rounded-full font-mono">
            {log.engineVersion.includes('v4') ? 'v4' : 'v2'}
          </Badge>
          {hasRebalance && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 rounded-full text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-950/30">
              再平衡¥{rebalanced.toLocaleString()}
            </Badge>
          )}
          {dqIssues.length > 0 && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 rounded-full text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30">
              {dqIssues.length}异常
            </Badge>
          )}
          {aiOk ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
          )}
        </div>
      </button>

      {/* 展开详情 */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 space-y-2 border-t bg-muted/10 dark:bg-muted/5">
              {/* 金额四元组 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded border bg-background dark:bg-card p-1.5">
                  <div className="text-[9px] text-muted-foreground">总预算</div>
                  <div className="font-mono text-xs font-bold">{formatYuan(log.totalBudget)}</div>
                </div>
                <div className="rounded border bg-background dark:bg-card p-1.5">
                  <div className="text-[9px] text-muted-foreground">已分配</div>
                  <div className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400">{formatYuan(log.totalAllocated)}</div>
                </div>
                <div className="rounded border bg-background dark:bg-card p-1.5">
                  <div className="text-[9px] text-muted-foreground">再平衡</div>
                  <div className="font-mono text-xs font-bold text-orange-700 dark:text-orange-400">{formatYuan(log.totalRebalanced)}</div>
                </div>
                <div className="rounded border bg-background dark:bg-card p-1.5">
                  <div className="text-[9px] text-muted-foreground">未投入</div>
                  <div className="font-mono text-xs font-bold text-amber-700 dark:text-amber-400">{formatYuan(log.totalUnallocated)}</div>
                </div>
              </div>

              {/* 审计元信息 */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span>引擎: <span className="font-mono">{log.engineVersion}</span></span>
                <span>规则版本: <span className="font-mono">{log.rulesConfigVersion}</span></span>
                <span>资金去向: <span className="font-mono">{log.cashDestination}</span></span>
                {log.marketDataSnapshotTime && (
                  <span>数据时间: <span className="font-mono">{formatDateTime(log.marketDataSnapshotTime)}</span></span>
                )}
              </div>

              {/* AI 校验结果 */}
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">AI校验:</span>
                <Badge
                  variant="outline"
                  className={`text-[9px] px-1 py-0 rounded-full ${
                    aiOk
                      ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 dark:bg-emerald-950/30'
                      : 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-700/50 bg-red-50 dark:bg-red-950/30'
                  }`}
                >
                  {aiStatus || 'unknown'}
                </Badge>
              </div>

              {/* 规则命中摘要 */}
              {log.rulesHitSummary && log.rulesHitSummary.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-medium text-muted-foreground">
                    命中规则 ({log.rulesHitSummary.length})
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {log.rulesHitSummary.slice(0, 12).map((rh, i) => (
                      <Badge
                        key={i}
                        variant="outline"
                        className={`text-[9px] px-1 py-0 rounded-full ${
                          rh.ruleType === 'veto'
                            ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-700/50 bg-red-50 dark:bg-red-950/30'
                            : rh.ruleType === 'rebalance'
                            ? 'text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-950/30'
                            : rh.ruleType === 'reduce'
                            ? 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30'
                            : rh.ruleType === 'boost'
                            ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 dark:bg-emerald-950/30'
                            : 'text-muted-foreground'
                        }`}
                        title={`${rh.code} · ${rh.effect}`}
                      >
                        {rh.code} {rh.ruleName}
                      </Badge>
                    ))}
                    {log.rulesHitSummary.length > 12 && (
                      <span className="text-[9px] text-muted-foreground/60">+{log.rulesHitSummary.length - 12}</span>
                    )}
                  </div>
                </div>
              )}

              {/* 数据质量摘要 */}
              {dqSummary.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-medium text-muted-foreground">
                    数据质量 ({dqSummary.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {dqSummary.map((dq, i) => (
                      <Badge
                        key={i}
                        variant="outline"
                        className={`text-[9px] px-1 py-0 rounded-full ${
                          dq.qualityStatus === 'passed'
                            ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 dark:bg-emerald-950/30'
                            : dq.qualityStatus === 'insufficient'
                            ? 'text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-950/30'
                            : dq.qualityStatus === 'serious_abnormal'
                            ? 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-700/50 bg-red-50 dark:bg-red-950/30'
                            : 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-950/30'
                        }`}
                        title={`${dq.code} · ${dq.qualityStatus}${dq.isStale ? ` · ${dq.staleLevel}` : ''}`}
                      >
                        {dq.code} {dq.qualityStatus}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* 数据源对比 */}
              {log.sourceComparison && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>数据源: 主源={log.sourceComparison.primary}</span>
                  <span>备源={log.sourceComparison.backup}</span>
                  <Badge variant="outline" className={`text-[9px] px-1 py-0 rounded-full ${log.sourceComparison.crossValidated ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700/50' : 'text-muted-foreground'}`}>
                    {log.sourceComparison.crossValidated ? '已交叉校验' : '单源'}
                  </Badge>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </StaggerItem>
  );
}
