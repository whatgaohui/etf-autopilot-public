'use client';

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Sparkles, ArrowRight, CheckCircle2, Ban, TrendingUp, Wallet, ArrowDownToLine, Repeat, ShieldCheck, AlertTriangle, PiggyBank, Layers, Hourglass } from 'lucide-react';
import type { AdviceResponse, AdviceSuggestion, RebalanceSuggestion } from '@/lib/types';
import { FadeInUp, staggerContainer, StaggerItem, motion } from '@/lib/motion';

// Codes excluded from investment decisions (cash reserve + gold)
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

// V4.1 S4-T3: 从 calculate 响应体的 dataQualitySummary 字段聚合质量分
// dataQualitySummary 结构：{ [code]: { qualityScore, qualityStatus, ... } }
interface DataQualityEntry {
  qualityScore?: number | null;
  qualityStatus?: string;
  canUseForRule?: boolean;
  canUseForStrongRule?: boolean;
}

function extractQualityScore(advice: AdviceResponse): number | null {
  const dq = (advice as AdviceResponse & { dataQualitySummary?: Record<string, DataQualityEntry> }).dataQualitySummary;
  if (!dq || typeof dq !== 'object') return null;
  const entries = Object.values(dq).filter(
    (e) => e && typeof e.qualityScore === 'number' && !Number.isNaN(e.qualityScore)
  ) as DataQualityEntry[];
  if (entries.length === 0) return null;
  const sum = entries.reduce(
    (acc, e) => acc + (typeof e.qualityScore === 'number' ? e.qualityScore : 0),
    0
  );
  return Math.round((sum / entries.length) * 10) / 10;
}

function getScoreBadgeClass(score: number): string {
  if (score >= 90) {
    return 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40';
  }
  if (score >= 75) {
    return 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40';
  }
  if (score >= 60) {
    return 'border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-900/40';
  }
  return 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40';
}

interface WeeklyConclusionCardProps {
  advice: AdviceResponse | null;
  isGenerating?: boolean;
  onGenerateAdvice?: () => void;
  /** V5.0: 点击"确认执行"按钮时触发，由父组件打开执行确认弹窗 */
  onConfirmExecution?: () => void;
}

// Extract a concise reason from a possibly long reasonSummary.
// Strategy: take the first clause (up to first comma/period/semicolon),
// then truncate to ~14 chars with an ellipsis if longer.
function getShortReason(reasonSummary: string): string {
  if (!reasonSummary) return '';
  const firstClause = reasonSummary.split(/[，。；,.;]/)[0] || '';
  const trimmed = firstClause.trim();
  if (!trimmed) return reasonSummary.slice(0, 14);
  if (trimmed.length <= 16) return trimmed;
  return trimmed.slice(0, 12) + '…';
}

function formatYuan(v: number): string {
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

function formatDataTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function WeeklyConclusionCard({
  advice,
  isGenerating = false,
  onGenerateAdvice,
  onConfirmExecution,
}: WeeklyConclusionCardProps) {
  // No advice yet → muted placeholder with a small generate button.
  if (!advice) {
    return (
      <FadeInUp delay={0.05}>
        <Card className="shadow-card overflow-hidden">
          <CardContent className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-6">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center rounded-lg bg-emerald-50/60 dark:bg-emerald-950/40 p-1.5">
                  <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div className="text-sm font-semibold text-muted-foreground">
                  本周定投建议
                </div>
              </div>
              <div className="text-xs text-muted-foreground/70 pl-8">
                点击下方『生成本周定投建议』查看本周结论
              </div>
            </div>
            {onGenerateAdvice && (
              <Button
                size="sm"
                variant="outline"
                onClick={onGenerateAdvice}
                disabled={isGenerating}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                {isGenerating ? '生成中...' : '生成本周定投建议'}
              </Button>
            )}
          </CardContent>
        </Card>
      </FadeInUp>
    );
  }

  // Filter to investment-target suggestions (exclude 511990 华宝添益 + 518880 黄金ETF)
  const investSuggestions: AdviceSuggestion[] = (advice.suggestions || []).filter(
    (s) => !NON_INVESTMENT_CODES.has(s.code)
  );

  const buyList = investSuggestions.filter((s) => (s.amount ?? 0) > 0);
  const noBuyList = investSuggestions.filter((s) => (s.amount ?? 0) === 0);
  // Within no-buy: vetoed items get red, over-allocated (non-veto) get amber.
  const vetoedList = noBuyList.filter((s) => s.vetoed);
  const overAllocatedList = noBuyList.filter((s) => !s.vetoed);

  const totalBudget = advice.totalBudget ?? 0;
  const totalAllocated = advice.totalAllocated ?? 0;
  const totalUnallocated = advice.totalUnallocated ?? 0;
  const rebalanceList: RebalanceSuggestion[] = advice.rebalanceSuggestions ?? [];
  const totalRebalanced = advice.totalRebalanced ?? 0;
  const cashPoolInflow = advice.cashPoolInflow ?? 0;
  const engineVersion = advice.engineVersion || '';
  const calculationId = advice.calculationId || '';
  const dataTime = advice.dataSnapshot?.marketDataCacheTime || advice.calculatedAt || '';
  // V5.0 E1/E4: 策略版本号 + 确定性复算指纹（从 dataSnapshot 读取）
  const dataSnapshot = (advice.dataSnapshot ?? {}) as {
    strategyVersion?: unknown;
    inputsHash?: unknown;
  };
  const strategyVersion =
    typeof dataSnapshot.strategyVersion === 'string' ? dataSnapshot.strategyVersion : '';
  const inputsHash =
    typeof dataSnapshot.inputsHash === 'string' ? dataSnapshot.inputsHash : '';
  // V4.1 S4-T3: 从 dataQualitySummary 聚合数据质量得分
  const qualityScore = extractQualityScore(advice);
  // V4.2 资金流字段(策略书§4-§9)
  const equityAllocationBase = advice.equityAllocationBase;
  const baseBucketAmount = advice.baseBucketAmount;
  const valueBucketAmount = advice.valueBucketAmount;
  const rebalanceEquityReserve = advice.rebalanceEquityReserve;
  const weeklyUnallocatedCash = advice.weeklyUnallocatedCash;
  const qdiiPendingCashSp500 = advice.qdiiPendingCashSp500;
  const qdiiPendingCashNasdaq = advice.qdiiPendingCashNasdaq;
  const fallbackTriggered = advice.fallbackTriggered === true;
  const fallbackReason = advice.fallbackReason || '';
  // 是否展示 V4.2 资金流区块(至少一个字段有值)
  const hasV42Flow =
    equityAllocationBase !== undefined ||
    baseBucketAmount !== undefined ||
    valueBucketAmount !== undefined ||
    weeklyUnallocatedCash !== undefined ||
    qdiiPendingCashSp500 !== undefined ||
    qdiiPendingCashNasdaq !== undefined;

  // V4 策略书§8: 现金占比提示（华宝添益占总资产比例）
  const allSuggestions = advice.suggestions || [];
  const cashHolding = allSuggestions.find((s) => s.code === '511990');
  const cashValue = cashHolding?.currentValue ?? 0;
  const totalAssets = allSuggestions.reduce((sum, s) => sum + (s.currentValue ?? 0), 0);
  const cashRatio = totalAssets > 0 ? (cashValue / totalAssets) * 100 : 0;
  const cashWarning = cashRatio > 30;
  const cashCaution = cashRatio > 20 && cashRatio <= 30;

  return (
    <FadeInUp delay={0.05}>
      <Card className="shadow-card overflow-hidden">
        <CardContent className="space-y-4 pt-6">
          {/* Header row: title + engine version badge */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-lg bg-emerald-50/60 dark:bg-emerald-950/40 p-1.5">
                <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              <h3 className="text-sm font-semibold">本周定投建议</h3>
            </div>
            {engineVersion && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 rounded-full font-mono text-muted-foreground"
              >
                {engineVersion}
              </Badge>
            )}
          </div>

          {/* Big numbers row — V4 三段式：建议投入 / 再平衡释放 / 暂不投入→华宝添益 */}
          <motion.div
            variants={staggerContainer(0.08, 0)}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          >
            {/* 建议投入 */}
            <StaggerItem className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/60 dark:bg-emerald-950/30 px-4 py-3 shadow-soft hover:-translate-y-0.5 hover:shadow-hover transition-all duration-200 ease-out-expo">
              <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 mb-1">
                <span className="inline-flex items-center justify-center rounded-md bg-emerald-100/70 dark:bg-emerald-900/50 p-0.5">
                  <CheckCircle2 className="h-3 w-3" />
                </span>
                <span>建议投入</span>
              </div>
              <div className="font-mono text-2xl font-bold text-emerald-700 dark:text-emerald-400 leading-tight">
                {formatYuan(totalAllocated)}
                <span className="text-sm font-normal text-muted-foreground ml-1.5">
                  / {formatYuan(totalBudget)}
                </span>
              </div>
            </StaggerItem>

            {/* 再平衡释放 (V4 新增) */}
            <StaggerItem className={`rounded-lg border px-4 py-3 shadow-soft hover:-translate-y-0.5 hover:shadow-hover transition-all duration-200 ease-out-expo ${totalRebalanced > 0 ? 'border-orange-300 dark:border-orange-800/50 bg-orange-50/60 dark:bg-orange-950/30' : 'border-border bg-muted/30 dark:bg-muted/20'}`}>
              <div className="flex items-center gap-1.5 text-xs text-orange-700 dark:text-orange-400 mb-1">
                <span className="inline-flex items-center justify-center rounded-md bg-orange-100/70 dark:bg-orange-900/50 p-0.5">
                  <Repeat className="h-3 w-3" />
                </span>
                <span>再平衡释放</span>
              </div>
              <div className={`font-mono text-2xl font-bold leading-tight ${totalRebalanced > 0 ? 'text-orange-700 dark:text-orange-400' : 'text-muted-foreground/50'}`}>
                {formatYuan(totalRebalanced)}
              </div>
              <div className="flex items-center gap-1 text-[11px] text-orange-700/80 dark:text-orange-400/80 mt-1">
                <ArrowRight className="h-3 w-3" />
                <span>卖出超配部分→华宝添益</span>
              </div>
            </StaggerItem>

            {/* 暂不投入 → 华宝添益 */}
            <StaggerItem className="rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/30 px-4 py-3 shadow-soft hover:-translate-y-0.5 hover:shadow-hover transition-all duration-200 ease-out-expo">
              <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 mb-1">
                <span className="inline-flex items-center justify-center rounded-md bg-amber-100/70 dark:bg-amber-900/50 p-0.5">
                  <Wallet className="h-3 w-3" />
                </span>
                <span>暂不投入</span>
              </div>
              <div className="font-mono text-2xl font-bold text-amber-700 dark:text-amber-400 leading-tight">
                {formatYuan(totalUnallocated)}
              </div>
              <div className="flex items-center gap-1 text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1">
                <ArrowRight className="h-3 w-3" />
                <span>建议转入华宝添益(511990)</span>
              </div>
            </StaggerItem>
          </motion.div>

        {/* V4.2 资金流区块(策略书§4-§9): 权益配置基准 / 基础仓+增强仓分桶 / QDII挂起 / 未分配资金 */}
        {hasV42Flow && (
          <div className="rounded-lg border border-violet-200/70 dark:border-violet-800/40 bg-violet-50/40 dark:bg-violet-950/20 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
              <Layers className="h-3.5 w-3.5" />
              <span>V4.2 资金流</span>
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 rounded-full font-mono text-violet-600 dark:text-violet-400 border-violet-300/70 dark:border-violet-700/50 bg-violet-100/40 dark:bg-violet-900/30">
                分桶 + 子账户
              </Badge>
            </div>

            {/* Row 1: 权益配置基准 + 基础仓 + 增强仓 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-violet-200/50 dark:border-violet-800/30 px-2 py-1.5">
                <TrendingUp className="h-3 w-3 text-violet-600 dark:text-violet-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">权益配置基准<span className="text-violet-600/70 dark:text-violet-400/70">（含挂起资金）</span></div>
                  <div className="font-mono font-bold text-violet-700 dark:text-violet-300 leading-tight">
                    {equityAllocationBase !== undefined ? formatYuan(equityAllocationBase) : '—'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-violet-200/50 dark:border-violet-800/30 px-2 py-1.5">
                <PiggyBank className="h-3 w-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">基础定投仓<span className="text-muted-foreground/70">（40%）</span></div>
                  <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 leading-tight">
                    {baseBucketAmount !== undefined ? formatYuan(baseBucketAmount) : '—'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-violet-200/50 dark:border-violet-800/30 px-2 py-1.5">
                <Sparkles className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">估值增强仓<span className="text-muted-foreground/70">（60%）</span></div>
                  <div className="font-mono font-bold text-amber-700 dark:text-amber-400 leading-tight">
                    {valueBucketAmount !== undefined ? formatYuan(valueBucketAmount) : '—'}
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: QDII挂起 + 未分配资金 + 再平衡备用金 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-red-200/50 dark:border-red-800/30 px-2 py-1.5">
                <Hourglass className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">QDII挂起资金</div>
                  <div className="font-mono font-bold text-red-700 dark:text-red-400 leading-tight text-[11px]">
                    {qdiiPendingCashSp500 !== undefined || qdiiPendingCashNasdaq !== undefined
                      ? `标普 ${qdiiPendingCashSp500 !== undefined ? formatYuan(qdiiPendingCashSp500) : '—'} · 纳斯达克 ${qdiiPendingCashNasdaq !== undefined ? formatYuan(qdiiPendingCashNasdaq) : '—'}`
                      : '—'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-amber-200/50 dark:border-amber-800/30 px-2 py-1.5">
                <Wallet className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">未分配资金<span className="text-muted-foreground/70"> → 待投权益现金</span></div>
                  <div className="font-mono font-bold text-amber-700 dark:text-amber-400 leading-tight">
                    {weeklyUnallocatedCash !== undefined ? formatYuan(weeklyUnallocatedCash) : (totalUnallocated ? formatYuan(totalUnallocated) : '—')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 rounded-md bg-background/60 dark:bg-background/30 border border-orange-200/50 dark:border-orange-800/30 px-2 py-1.5">
                <Repeat className="h-3 w-3 text-orange-600 dark:text-orange-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground leading-tight">再平衡权益备用金</div>
                  <div className="font-mono font-bold text-orange-700 dark:text-orange-400 leading-tight">
                    {rebalanceEquityReserve !== undefined ? formatYuan(rebalanceEquityReserve) : '—'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* V4.2 §6.5 全否决兜底提示 */}
        {fallbackTriggered && (
          <Alert className="border-amber-300 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/30">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <AlertTitle className="text-amber-800 dark:text-amber-300 font-semibold text-xs">
              全否决兜底已触发
            </AlertTitle>
            <AlertDescription className="text-amber-800/90 dark:text-amber-300/80 text-xs leading-relaxed">
              {fallbackReason || '本周所有定投标的均触发硬否决或软风控，预算已按 V4.2 §6.5 兜底规则路由至对应现金子账户，请人工复核。'}
            </AlertDescription>
          </Alert>
        )}

        {/* 华宝添益资金流向汇总 (V4 §8 现金水池) */}
        {cashPoolInflow > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200/70 dark:border-sky-800/50 text-xs">
            <ArrowDownToLine className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
            <span className="text-sky-800 dark:text-sky-300">
              华宝添益(511990)本周流入合计
              <span className="font-mono font-bold text-sky-700 dark:text-sky-400 mx-1">{formatYuan(cashPoolInflow)}</span>
              <span className="text-sky-700/70 dark:text-sky-500/70">
                （暂不投入 {formatYuan(totalUnallocated)} + 再平衡释放 {formatYuan(totalRebalanced)}）
              </span>
            </span>
          </div>
        )}

        {/* V4 策略书§8: 现金占比提示 */}
        {cashValue > 0 && totalAssets > 0 && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs border ${
            cashWarning
              ? 'bg-red-50/70 dark:bg-red-950/30 border-red-300 dark:border-red-800/50 text-red-800 dark:text-red-300'
              : cashCaution
              ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800/50 text-amber-800 dark:text-amber-300'
              : 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300'
          }`}>
            <Wallet className={`h-3.5 w-3.5 shrink-0 ${cashWarning ? 'text-red-600 dark:text-red-400' : cashCaution ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
            <span>
              现金占比
              <span className={`font-mono font-bold mx-1 ${cashWarning ? 'text-red-700 dark:text-red-400' : cashCaution ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                {cashRatio.toFixed(1)}%
              </span>
              <span className="text-muted-foreground">
                （华宝添益 {formatYuan(cashValue)} / 总资产 {formatYuan(totalAssets)}）
              </span>
              {cashWarning && <span className="font-medium ml-1">⚠ 可能存在长期现金拖累，建议复核阈值</span>}
              {cashCaution && <span className="font-medium ml-1">⚠ 现金占比偏高，建议关注</span>}
              {!cashWarning && !cashCaution && <span className="text-emerald-700/70 dark:text-emerald-400/70">✓ 正常区间</span>}
            </span>
          </div>
        )}

        {/* 本周总动作摘要（PRD§7.3） */}
        <div className="rounded-lg border border-primary/20 dark:border-primary/30 bg-primary/5 dark:bg-primary/10 px-3 py-2.5">
          <div className="flex items-start gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
            <div className="text-xs leading-relaxed">
              <span className="font-semibold text-foreground">本周动作：</span>
              <span className="text-muted-foreground">
                {buyList.length > 0
                  ? `买入${buyList.map((s) => s.name).join('、')}`
                  : '本周无建议买入标的'}
                {'；'}
                {vetoedList.length > 0
                  ? `暂停买入${vetoedList.map((s) => s.name).join('、')}`
                  : ''}
                {vetoedList.length > 0 && rebalanceList.length > 0 ? '；' : ''}
                {rebalanceList.length > 0
                  ? `${rebalanceList.map((r) => `${r.name}触发${r.triggerLevel === 'level2' ? '二级' : '一级'}再平衡`).join('、')}`
                  : ''}
                {'。'}
              </span>
            </div>
          </div>
        </div>

        {/* 建议买入 + 暂不买入 — 紧凑卡片网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* 建议买入 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>建议买入 ({buyList.length})</span>
            </div>
            {buyList.length === 0 ? (
              <div className="text-xs text-muted-foreground/60 italic px-2 py-2">
                本周无建议买入标的
              </div>
            ) : (
              <motion.div
                variants={staggerContainer(0.04)}
                initial="hidden"
                animate="show"
                className="grid grid-cols-2 gap-1.5"
              >
                {buyList.map((s) => (
                  <StaggerItem
                    key={s.code}
                    className="flex flex-col rounded-md border border-emerald-200/70 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-950/20 px-2 py-1.5 hover:-translate-y-0.5 hover:shadow-soft hover:border-emerald-300 dark:hover:border-emerald-700 transition-all duration-200 ease-out-expo"
                    title={s.reasonSummary}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium text-foreground truncate min-w-0">
                        {s.name}
                      </span>
                      <span className="font-mono text-xs font-bold text-emerald-700 dark:text-emerald-400 shrink-0">
                        {formatYuan(s.amount)}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted-foreground/70 truncate">
                      {getShortReason(s.reasonSummary)}
                    </span>
                    {onConfirmExecution && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 mt-1 px-1.5 text-[10px] self-end text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100/70 dark:hover:bg-emerald-900/40"
                        onClick={(e) => {
                          e.stopPropagation();
                          onConfirmExecution();
                        }}
                      >
                        <CheckCircle2 className="h-3 w-3 mr-0.5" />
                        确认执行
                      </Button>
                    )}
                  </StaggerItem>
                ))}
              </motion.div>
            )}
          </div>

          {/* 暂不买入 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400">
              <Ban className="h-3.5 w-3.5" />
              <span>暂不买入 ({noBuyList.length})</span>
            </div>
            {noBuyList.length === 0 ? (
              <div className="text-xs text-muted-foreground/60 italic px-2 py-2">
                本周无暂不买入标的
              </div>
            ) : (
              <motion.div
                variants={staggerContainer(0.04)}
                initial="hidden"
                animate="show"
                className="grid grid-cols-2 gap-1.5"
              >
                {vetoedList.map((s) => (
                  <StaggerItem
                    key={s.code}
                    className="flex flex-col rounded-md border border-red-200/70 dark:border-red-800/40 bg-red-50/40 dark:bg-red-950/20 px-2 py-1.5 hover:-translate-y-0.5 hover:shadow-soft hover:border-red-300 dark:hover:border-red-700 transition-all duration-200 ease-out-expo"
                    title={s.reasonSummary}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium text-foreground truncate min-w-0">
                        {s.name}
                      </span>
                      <Ban className="h-3 w-3 text-red-500 dark:text-red-400 shrink-0" />
                    </div>
                    <span className="text-[9px] text-red-700/70 dark:text-red-400/70 truncate">
                      {getShortReason(s.reasonSummary)}
                    </span>
                  </StaggerItem>
                ))}
                {overAllocatedList.map((s) => (
                  <StaggerItem
                    key={s.code}
                    className="flex flex-col rounded-md border border-amber-200/70 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-950/20 px-2 py-1.5 hover:-translate-y-0.5 hover:shadow-soft hover:border-amber-300 dark:hover:border-amber-700 transition-all duration-200 ease-out-expo"
                    title={s.reasonSummary}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium text-foreground truncate min-w-0">
                        {s.name}
                      </span>
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400 shrink-0" />
                    </div>
                    <span className="text-[9px] text-amber-700/70 dark:text-amber-400/70 truncate">
                      {getShortReason(s.reasonSummary)}
                    </span>
                  </StaggerItem>
                ))}
              </motion.div>
            )}
          </div>
        </div>

        {/* 再平衡建议清单 (V4 §7) */}
        {rebalanceList.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-orange-700 dark:text-orange-400">
              <Repeat className="h-3.5 w-3.5" />
              <span>再平衡建议 ({rebalanceList.length})</span>
            </div>
            <motion.div
              variants={staggerContainer(0.04)}
              initial="hidden"
              animate="show"
              className="grid grid-cols-2 md:grid-cols-3 gap-1.5"
            >
              {rebalanceList.map((r) => (
                <StaggerItem
                  key={r.code}
                  className="flex flex-col rounded-md border border-orange-200/70 dark:border-orange-800/40 bg-orange-50/40 dark:bg-orange-950/20 px-2 py-1.5 hover:-translate-y-0.5 hover:shadow-soft hover:border-orange-300 dark:hover:border-orange-700 transition-all duration-200 ease-out-expo"
                  title={r.reasonSummary}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium text-foreground truncate min-w-0">
                      {r.name}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] px-1 py-0 rounded-full shrink-0 ${
                        r.triggerLevel === 'level2'
                          ? 'border-orange-400 dark:border-orange-600 text-orange-700 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-900/40'
                          : 'border-orange-300/70 dark:border-orange-700/50 text-orange-600 dark:text-orange-400 bg-orange-50/40 dark:bg-orange-950/30'
                      }`}
                    >
                      {r.triggerLevel === 'level2' ? '二级' : '一级'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <span className="font-mono text-xs font-bold text-orange-700 dark:text-orange-400">
                      -{formatYuan(r.sellAmount)}
                    </span>
                    <span className="text-[9px] text-orange-700/70 dark:text-orange-400/70">
                      卖{Math.round(r.sellRatio * 100)}%超额
                    </span>
                  </div>
                </StaggerItem>
              ))}
            </motion.div>
          </div>
        )}

        {/* Footer: calculationId + data time + quality score */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono min-w-0">
              <span className="text-muted-foreground/60 shrink-0">计算批次</span>
              <span
                className="truncate max-w-[180px] sm:max-w-[300px] text-muted-foreground"
                title={calculationId}
              >
                {calculationId || '—'}
              </span>
              {qualityScore !== null && (
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 rounded-full font-mono shrink-0 inline-flex items-center gap-1 ${getScoreBadgeClass(qualityScore)}`}
                  title={`数据质量得分 ${qualityScore} 分`}
                >
                  <ShieldCheck className="size-3" />
                  数据质量 {qualityScore.toFixed(1)} 分
                </Badge>
              )}
            </div>
            {/* V5.0 E1/E4: 引擎 / 策略版本 / 复算指纹 */}
            {(engineVersion || strategyVersion || inputsHash) && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70 font-mono">
                {engineVersion && (
                  <span>
                    引擎: <span className="text-muted-foreground">{engineVersion}</span>
                  </span>
                )}
                {strategyVersion && (
                  <>
                    <span className="text-muted-foreground/40">|</span>
                    <span>
                      策略: <span className="text-muted-foreground">{strategyVersion}</span>
                    </span>
                  </>
                )}
                {inputsHash && (
                  <>
                    <span className="text-muted-foreground/40">|</span>
                    <span title="V5.0 确定性复算指纹（相同输入→相同 hash）">
                      复算指纹: <span className="text-muted-foreground">{inputsHash}</span>
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          {dataTime && (
            <div className="text-[10px] text-muted-foreground/80 font-mono shrink-0">
              数据时间 {formatDataTime(dataTime)}
            </div>
          )}
        </div>
        </CardContent>
      </Card>
    </FadeInUp>
  );
}
