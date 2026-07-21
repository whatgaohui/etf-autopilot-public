'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { staggerContainer, fadeIn, EASE } from '@/lib/motion';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronUp,
  Download,
  CheckCircle2,
  CircleDot,
  Circle,
  ArrowRight,
  Ban,
  Wallet,
} from 'lucide-react';
import type {
  HoldingSnapshot,
  EtfConfig,
  CachedSummaryResponse,
  AdviceResponse,
  AdviceSuggestion,
  RuleHit,
  DataQuality,
} from '@/lib/types';

// Professional color palette (no indigo/blue)
const CHART_COLORS = [
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
];

// Codes excluded from investment ratio (cash reserve + gold)
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

const STEP_LABELS = [
  '读取数据中...',
  '规则计算中...',
  'AI生成说明...',
  '完成',
];

interface UnifiedHoldingsTableProps {
  holdings: HoldingSnapshot[];
  totalAssets: number;
  investmentAssets?: number;
  etfConfigs: EtfConfig[];
  marketData: CachedSummaryResponse | null;
  advice: AdviceResponse | null;
  isGeneratingAdvice: boolean;
  generationStep: number;
  onGenerateAdvice: () => void;
}

// ─── Indicator helpers ───

function getPercentileDot(p: number | null): string {
  if (p === null || p === undefined) return '⚪';
  if (p < 20) return '🟢';
  if (p < 80) return '🟡';
  return '🔴';
}

function getPercentileColor(p: number | null): string {
  if (p === null || p === undefined) return 'text-muted-foreground';
  if (p < 20) return 'text-emerald-600 dark:text-emerald-400';
  if (p < 80) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function getPremiumDot(v: number | null): string {
  if (v === null || v === undefined) return '⚪';
  if (v < 2) return '🟢';
  if (v < 3) return '🟡';
  return '🔴';
}

function getPremiumColor(v: number | null): string {
  if (v === null || v === undefined) return 'text-muted-foreground';
  if (v < 2) return 'text-emerald-600 dark:text-emerald-400';
  if (v < 3) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatPercent(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(decimals)}%`;
}

// Backward-compat helper: accept both string[] (v1) and RuleHit[] (v2).
function normalizeRuleHits(hits: Array<RuleHit | string> | undefined | null): RuleHit[] {
  if (!hits || !Array.isArray(hits)) return [];
  return hits.map((r) => {
    if (typeof r === 'string') {
      return { ruleType: 'info', ruleName: r, conditionText: '', actualValue: '', threshold: '', effect: '' };
    }
    return r as RuleHit;
  });
}

function getRuleName(r: RuleHit | string): string {
  return typeof r === 'string' ? r : r.ruleName;
}

// ─── V4.2 §4/§5: 桶类型 + 软风控展示辅助 ───────────────────────────────────

function getBucketTypeLabel(t: string | undefined | null): string {
  switch (t) {
    case 'base_bucket':
      return '基础仓';
    case 'value_bucket':
      return '增强仓';
    case 'base+value':
      return '基础+增强';
    default:
      return '—';
  }
}

function getBucketTypeBadgeClass(t: string | undefined | null): string {
  switch (t) {
    case 'base_bucket':
      return 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40';
    case 'value_bucket':
      return 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40';
    case 'base+value':
      return 'border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-400 bg-violet-100/60 dark:bg-violet-900/40';
    default:
      return 'border-border text-muted-foreground bg-muted/40 dark:bg-muted/20';
  }
}

function getSoftWindControlLabel(t: string | undefined | null): string {
  switch (t) {
    case 'reduce':
      return '减量';
    case 'forbid_enhancement':
      return '禁增强';
    case 'minimal_base':
      return '仅基础';
    case 'pause_all':
      return '暂停';
    default:
      return '—';
  }
}

function getSoftWindControlBadgeClass(t: string | undefined | null): string {
  switch (t) {
    case 'reduce':
      return 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40';
    case 'forbid_enhancement':
    case 'minimal_base':
      return 'border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-900/40';
    case 'pause_all':
      return 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40';
    default:
      return 'border-border text-muted-foreground bg-muted/40 dark:bg-muted/20';
  }
}

// ─── V5.0 Sprint3 E6: 技术状态展示辅助 ─────────────────────────────────────────
// 技术状态7态: strong/conflict/very_weak/improving/weak/neutral/unavailable
// 执行模式4种: immediate/staged/wait_pullback/base_only

function getTechnicalStateLabel(s: string | undefined | null): string {
  switch (s) {
    case 'strong': return '强势';
    case 'conflict': return '冲突';
    case 'very_weak': return '极弱';
    case 'improving': return '改善';
    case 'weak': return '弱势';
    case 'neutral': return '中性';
    case 'unavailable': return '无数据';
    default: return '—';
  }
}

function getTechnicalStateBadgeClass(s: string | undefined | null): string {
  switch (s) {
    case 'strong':
      return 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40';
    case 'conflict':
      return 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40';
    case 'very_weak':
      return 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40';
    case 'improving':
      return 'border-sky-300 dark:border-sky-700 text-sky-700 dark:text-sky-400 bg-sky-100/60 dark:bg-sky-900/40';
    case 'weak':
      return 'border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-900/40';
    case 'neutral':
    case 'unavailable':
    default:
      return 'border-border text-muted-foreground bg-muted/40 dark:bg-muted/20';
  }
}

function getTechnicalModeShortLabel(m: string | undefined | null): string {
  switch (m) {
    case 'immediate': return '立即';
    case 'staged': return '分批';
    case 'wait_pullback': return '等回调';
    case 'base_only': return '仅基础';
    default: return '';
  }
}

function formatYuan(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined) return '—';
  return `¥${v.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatDataTime(iso: string | undefined): string {
  if (!iso) return '';
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

// ─── Status badge ───

function getStatusBadge(status: 'over' | 'under' | 'balanced' | 'none', text: string) {
  if (status === 'none') {
    return (
      <Badge variant="outline" className="rounded-full text-[10px] px-1.5 py-0 font-mono font-medium">
        非定投标的
      </Badge>
    );
  }
  if (status === 'under') {
    return (
      <Badge className="rounded-full bg-amber-50/70 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/40 hover:bg-amber-100/80 dark:hover:bg-amber-950/50 text-[10px] px-1.5 py-0 font-mono font-medium transition-colors duration-150">
        🟡{text}
      </Badge>
    );
  }
  if (status === 'over') {
    return (
      <Badge className="rounded-full bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 border-red-200/60 dark:border-red-800/40 hover:bg-red-100/80 dark:hover:bg-red-950/50 text-[10px] px-1.5 py-0 font-mono font-medium transition-colors duration-150">
        🔴{text}
      </Badge>
    );
  }
  return (
    <Badge className="rounded-full bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/40 hover:bg-emerald-100/80 dark:hover:bg-emerald-950/50 text-[10px] px-1.5 py-0 font-mono font-medium transition-colors duration-150">
      🟢{text}
    </Badge>
  );
}

// ─── Inline calculation detail panel (rendered inside an expanded row) ───

// ─── V4 多周期估值分位条（策略书§3） ───
// 展示 1y/3y/5y/10y/all 五个周期 PE/PB 分位，标注买入侧(5y)和再平衡侧(10y)
function getPercentileColorClass(p: number | null | undefined): string {
  if (p === null || p === undefined) return 'text-muted-foreground/50 bg-muted/40 dark:bg-muted/20 border-border/60';
  if (p > 80) return 'text-red-700 dark:text-red-300 bg-red-100/70 dark:bg-red-950/30 border-red-300/60 dark:border-red-800/40';
  if (p > 60) return 'text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-950/30 border-amber-300/60 dark:border-amber-800/40';
  if (p < 20) return 'text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-950/30 border-emerald-300/60 dark:border-emerald-800/40';
  return 'text-sky-700 dark:text-sky-300 bg-sky-100/70 dark:bg-sky-950/30 border-sky-300/60 dark:border-sky-800/40';
}

function MultiPeriodPercentileBar({ suggestion }: { suggestion: AdviceSuggestion }) {
  const periods: Array<{ key: keyof AdviceSuggestion; label: string; role: string }> = [
    { key: 'pePercentile1y', label: '近1年', role: '情绪参考' },
    { key: 'pePercentile3y', label: '近3年', role: '辅助' },
    { key: 'pePercentile5y', label: '近5年', role: '买入侧主判' },
    { key: 'pePercentile10y', label: '近10年', role: '再平衡侧主判' },
    { key: 'pePercentileAll', label: '全历史', role: '再平衡备选' },
  ];

  const peValues = periods.map((p) => suggestion[p.key] as number | null | undefined);
  const hasAny = peValues.some((v) => v !== null && v !== undefined);

  if (!hasAny) {
    return <span className="text-muted-foreground text-[11px] italic">样本不足，暂无多周期分位</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {periods.map((p) => {
        const v = suggestion[p.key] as number | null | undefined;
        const isBuySide = p.key === 'pePercentile5y';
        const isRebalSide = p.key === 'pePercentile10y' || p.key === 'pePercentileAll';
        return (
          <div
            key={p.key}
            className={`inline-flex flex-col items-center rounded-md border px-2 py-1 transition-all duration-200 ease-out-expo ${getPercentileColorClass(v)} ${
              isBuySide ? 'ring-1 ring-emerald-400/70 dark:ring-emerald-500/50 ring-offset-1 dark:ring-offset-background shadow-xs' : ''
            } ${isRebalSide ? 'ring-1 ring-orange-400/70 dark:ring-orange-500/50 ring-offset-1 dark:ring-offset-background shadow-xs' : ''}`}
            title={`${p.label} PE分位 · ${p.role}`}
          >
            <span className="text-[9px] font-medium opacity-70">{p.label}</span>
            <span className="font-mono text-xs font-bold tabular-nums">
              {v !== null && v !== undefined ? `${v.toFixed(1)}%` : '—'}
            </span>
            <span className="text-[8px] opacity-60">{p.role}</span>
          </div>
        );
      })}
    </div>
  );
}


// ─── V4 数据质量详情（策略书§5.3 五状态 + §5.4 缓存过期 + §4.5 数据血缘） ───
const QUALITY_STATUS_MAP: Record<string, { label: string; color: string; bg: string; border: string }> = {
  passed: { label: '通过', color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-100/70 dark:bg-emerald-950/30', border: 'border-emerald-300/60 dark:border-emerald-800/40' },
  minor_abnormal: { label: '轻微异常', color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-100/70 dark:bg-amber-950/30', border: 'border-amber-300/60 dark:border-amber-800/40' },
  serious_abnormal: { label: '严重异常', color: 'text-red-700 dark:text-red-300', bg: 'bg-red-100/70 dark:bg-red-950/30', border: 'border-red-300/60 dark:border-red-800/40' },
  insufficient: { label: '数据不足', color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-100/70 dark:bg-orange-950/30', border: 'border-orange-300/60 dark:border-orange-800/40' },
  source_inconsistent: { label: '源不一致', color: 'text-purple-700 dark:text-purple-300', bg: 'bg-purple-100/70 dark:bg-purple-950/30', border: 'border-purple-300/60 dark:border-purple-800/40' },
};

// ─── V4 文档范围外增强: 盈利趋势辅助（PE/PB相对变化推断ROE趋势） ───
function EarningsTrendHint({ suggestion }: { suggestion: AdviceSuggestion }) {
  const pe = suggestion.pePercentile;
  const pb = suggestion.pbPercentile;
  const pe1y = suggestion.pePercentile1y;
  const pb1y = suggestion.pbPercentile1y;
  const pe5y = suggestion.pePercentile5y ?? pe;
  const pb5y = suggestion.pbPercentile5y ?? pb;

  // 用 PE/PB 分位差异推断盈利趋势：
  // PE分位 > PB分位 → 价格相对盈利贵（E小）→ 盈利可能承压
  // PE分位 < PB分位 → 价格相对净资产贵但盈利好（E大）→ 盈利改善
  if (pe5y == null || pb5y == null) {
    return <span className="text-muted-foreground text-[11px] italic">PE/PB数据不足，无法推断盈利趋势</span>;
  }

  const diff = pe5y - pb5y;
  let trend = '';
  let color = '';
  let hint = '';

  if (diff > 15) {
    trend = '盈利承压';
    color = 'text-red-700 dark:text-red-300 bg-red-50/70 dark:bg-red-950/30 border-red-200/60 dark:border-red-800/40';
    hint = 'PE分位显著高于PB，盈利(E)相对净资产(B)偏小，可能处于盈利下行周期';
  } else if (diff < -15) {
    trend = '盈利改善';
    color = 'text-emerald-700 dark:text-emerald-300 bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/40';
    hint = 'PE分位显著低于PB，盈利(E)相对净资产(B)偏大，盈利能力可能改善';
  } else {
    trend = '盈利稳定';
    color = 'text-sky-700 dark:text-sky-300 bg-sky-50/70 dark:bg-sky-950/30 border-sky-200/60 dark:border-sky-800/40';
    hint = 'PE与PB分位接近，盈利趋势相对稳定';
  }

  // 近1年变化
  let recentChange = '';
  if (pe1y != null && pb1y != null) {
    const recentDiff = pe1y - pb1y;
    if (recentDiff > diff + 5) {
      recentChange = '（近期盈利进一步承压）';
    } else if (recentDiff < diff - 5) {
      recentChange = '（近期盈利有改善迹象）';
    }
  }

  return (
    <div className={`rounded-md border px-2 py-1.5 text-[11px] transition-colors duration-200 ${color}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{trend}</span>
        <span className="font-mono text-[10px] tabular-nums">
          PE分位{pe5y.toFixed(0)}% {diff > 0 ? '>' : '<'} PB分位{pb5y.toFixed(0)}%（差{Math.abs(diff).toFixed(0)}pp）
        </span>
      </div>
      <div className="text-[10px] mt-0.5 opacity-80">{hint}{recentChange}</div>
      <div className="text-[9px] mt-0.5 opacity-60 italic">
        辅助指标：用PE/PB分位差异间接推断ROE变化趋势（非直接ROE数据）
      </div>
    </div>
  );
}


function DataQualityDetail({ dq }: { dq: NonNullable<AdviceSuggestion['dataQuality']> }) {
  const status = dq.qualityStatus ?? (dq.canCalculate ? 'passed' : 'insufficient');
  const sm = QUALITY_STATUS_MAP[status] ?? QUALITY_STATUS_MAP.insufficient;
  const staleBadge = dq.isStale && dq.staleLevel ? (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium font-mono ${
      dq.staleLevel === 'red' ? 'bg-red-100/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-300/60 dark:border-red-800/40' : 'bg-amber-100/70 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-300/60 dark:border-amber-800/40'
    }`}>
      {dq.staleLevel === 'red' ? '🔴' : '🟡'} {dq.staleReason || '数据过期'}
    </span>
  ) : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* 状态徽章 */}
      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold font-mono border ${sm.color} ${sm.bg} ${sm.border}`}>
        {sm.label}
      </span>
      {staleBadge}
      {/* 异常原因 */}
      {dq.abnormalReason && (
        <span className="text-[10px] text-muted-foreground italic">{dq.abnormalReason}</span>
      )}
      {/* 数据血缘明细 */}
      <span className="text-muted-foreground text-[10px] ml-1 font-mono">
        来源:{dq.source || 'akshare'} · 样本:{dq.sampleDays}天
        {dq.isSampleEnough ? '' : '·不足'} · 缺失{dq.missingCount} · 异常{dq.outlierCount}
        {dq.percentileWindow ? ` · 窗口:${dq.percentileWindow}` : ''}
        {dq.isValid === false ? ' · 无效' : ''}
      </span>
    </div>
  );
}


function CalculationDetailPanel({
  row,
  advice,
  investmentAssets,
}: {
  row: ReturnType<typeof buildRow> extends infer T ? T : never;
  advice: AdviceResponse | null;
  investmentAssets: number;
}) {
  // Pull the full suggestion from advice for the audit fields
  const suggestion: AdviceSuggestion | undefined = advice?.suggestions?.find(
    (s) => s.code === row.etfCode
  );

  if (!suggestion) {
    return (
      <div className="m-3 rounded-xl border border-dashed border-border/60 bg-muted/20 dark:bg-muted/10 px-4 py-3 text-xs text-muted-foreground/70 italic">
        本周无计算记录
      </div>
    );
  }

  const dq: DataQuality | null = suggestion.dataQuality ?? null;
  const weeklyBudget = advice?.totalBudget ?? 40000;
  const rulesList = normalizeRuleHits(
    suggestion.rulesHit as Array<RuleHit | string> | undefined
  );
  const multiplier = suggestion.multiplier ?? 1;
  const isCapped =
    suggestion.preCapAmount !== undefined &&
    suggestion.preCapAmount !== null &&
    suggestion.amount !== undefined &&
    suggestion.amount !== null &&
    suggestion.preCapAmount > suggestion.amount &&
    suggestion.amount > 0;

  const steps: Array<{ label: string; value: React.ReactNode; muted?: boolean }> = [
    {
      label: '1. 当前市值',
      value: <span className="font-mono">{formatYuan(suggestion.currentValue, 2)}</span>,
    },
    {
      label: '2. 占比',
      value: (
        <span className="font-mono">
          当前 {(suggestion.currentRatio * 100)?.toFixed(1)}%{' '}
          <span className="text-muted-foreground">|</span> 目标{' '}
          {(suggestion.targetRatio * 100)?.toFixed(1)}%
        </span>
      ),
    },
    {
      label: '3. 预算后目标市值',
      value: (
        <span className="font-mono">
          {formatYuan(suggestion.targetValueAfterBudget, 2)}{' '}
          <span className="text-muted-foreground text-[10px]">
            = (定投资产 {formatYuan(investmentAssets, 0)} + 周预算 {formatYuan(weeklyBudget, 0)}) ×{' '}
            {(suggestion.targetRatio * 100)?.toFixed(1)}%
          </span>
        </span>
      ),
    },
    {
      label: '4. 目标缺口',
      value: (
        <span className="font-mono">
          {formatYuan(suggestion.gapAmount, 2)}{' '}
          <span className="text-muted-foreground">→</span> 基础可买:{' '}
          {formatYuan(suggestion.baseGapAmount, 2)}
        </span>
      ),
    },
    {
      label: '5. 数据质量',
      value: dq ? <DataQualityDetail dq={dq} /> : (
        <span className="text-muted-foreground">未提供</span>
      ),
    },
    {
      label: '5.5 多周期估值分位',
      value: <MultiPeriodPercentileBar suggestion={suggestion} />,
    },
    {
      label: '5.6 盈利趋势辅助',
      value: <EarningsTrendHint suggestion={suggestion} />,
    },
    {
      label: '6. 命中规则',
      value: rulesList.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rulesList.map((r, i) => (
            <Badge
              key={i}
              variant="outline"
              className={`rounded-full text-[10px] px-1.5 py-0 font-mono font-medium transition-colors duration-150 ${
                r.ruleType === 'veto'
                  ? 'border-red-300/60 dark:border-red-800/40 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                  : r.ruleType === 'reduce'
                  ? 'border-amber-300/60 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300'
                  : r.ruleType === 'boost'
                  ? 'border-emerald-300/60 dark:border-emerald-800/40 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'border-border bg-muted/50 dark:bg-muted/20 text-muted-foreground'
              }`}
              title={r.conditionText || r.ruleName}
            >
              {r.ruleName}
              {r.actualValue && r.threshold ? ` ${r.actualValue}>${r.threshold}` : ''}
            </Badge>
          ))}
          <span className="text-[10px] text-muted-foreground ml-1">
            倍率{' '}
            <span className="font-mono font-semibold">
              {multiplier === 0.5 ? '0.5' : multiplier === 2 ? '2' : '1'}
            </span>
          </span>
          {suggestion.vetoed && (
            <Badge variant="destructive" className="rounded-full text-[10px] px-1.5 py-0 font-mono font-medium">
              ⛔ 一票否决
            </Badge>
          )}
        </div>
      ) : (
        <span className="text-muted-foreground text-[10px]">无</span>
      ),
    },
    {
      label: '7. 缺口封顶',
      value: (
        <span className={isCapped ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-muted-foreground'}>
          {isCapped ? '是' : '否'}
          {!isCapped && (
            <span className="text-muted-foreground text-[10px] ml-2 font-mono">
              (preCap {formatYuan(suggestion.preCapAmount, 0)})
            </span>
          )}
        </span>
      ),
    },
    {
      label: '8. 最终建议',
      value: suggestion.vetoed ? (
        <span className="font-mono font-bold text-red-600 dark:text-red-400">不买入 ¥0</span>
      ) : suggestion.amount > 0 ? (
        <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
          {formatYuan(suggestion.amount, 0)}
        </span>
      ) : (
        <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
          不补仓 {formatYuan(suggestion.amount, 0)}
        </span>
      ),
    },
    {
      label: '9. 超额市值',
      value: (() => {
        const rebalSuggestion = advice?.rebalanceSuggestions?.find(r => r.code === suggestion.code);
        if (rebalSuggestion) {
          return (
            <span className="font-mono text-orange-600 dark:text-orange-400 font-medium">
              {formatYuan(rebalSuggestion.excessValue, 0)}
              <span className="text-[10px] text-muted-foreground ml-1">（超配部分）</span>
            </span>
          );
        }
        return <span className="text-muted-foreground text-[11px]">无超配</span>;
      })(),
    },
    {
      label: '10. 再平衡金额',
      value: (() => {
        const rebalSuggestion = advice?.rebalanceSuggestions?.find(r => r.code === suggestion.code);
        if (rebalSuggestion) {
          return (
            <span className="font-mono font-bold text-orange-600 dark:text-orange-400">
              -¥{rebalSuggestion.sellAmount.toLocaleString('zh-CN')}
              <span className="text-[10px] text-muted-foreground ml-1 font-normal">
                （卖{Math.round(rebalSuggestion.sellRatio * 100)}%超额→华宝添益）
              </span>
            </span>
          );
        }
        return <span className="text-muted-foreground text-[11px]">无再平衡</span>;
      })(),
    },
    {
      label: '11. 数据源对比',
      value: (() => {
        const dq = suggestion.dataQuality;
        if (!dq) return <span className="text-muted-foreground text-[11px]">未提供</span>;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="rounded-full text-[9px] px-1.5 py-0 font-mono text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-800/40 bg-emerald-50/70 dark:bg-emerald-950/30">
              主源: {dq.source || 'akshare'}
            </Badge>
            <Badge variant="outline" className="rounded-full text-[9px] px-1.5 py-0 font-mono text-muted-foreground border-border/60">
              备源: 未配置
            </Badge>
            <Badge variant="outline" className={`rounded-full text-[9px] px-1.5 py-0 font-mono ${
              dq.qualityStatus === 'passed' ? 'text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-800/40 bg-emerald-50/70 dark:bg-emerald-950/30' :
              dq.qualityStatus === 'source_inconsistent' ? 'text-purple-700 dark:text-purple-300 border-purple-300/60 dark:border-purple-800/40 bg-purple-50/70 dark:bg-purple-950/30' :
              'text-amber-700 dark:text-amber-300 border-amber-300/60 dark:border-amber-800/40 bg-amber-50/70 dark:bg-amber-950/30'
            }`}>
              {dq.qualityStatus === 'passed' ? '双源一致' :
               dq.qualityStatus === 'source_inconsistent' ? '源不一致' :
               '单源(未交叉校验)'}
            </Badge>
          </div>
        );
      })(),
    },
  ];

  return (
    <div className="m-3 rounded-xl border border-border/60 bg-muted/20 dark:bg-muted/10 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        <span className="inline-block h-1 w-1 rounded-full bg-primary" />
        计算过程
      </div>
      <ol className="relative space-y-1.5">
        {/* 时间线竖线 */}
        <div
          className="absolute left-[13px] top-3 bottom-3 w-px bg-gradient-to-b from-border via-border/50 to-transparent pointer-events-none"
          aria-hidden
        />
        {steps.map((step, i) => {
          const isFinal = step.label.startsWith('8.');
          const isRule = step.label.startsWith('6.');
          const firstSpace = step.label.indexOf(' ');
          const stepNum =
            firstSpace > 0 ? step.label.slice(0, firstSpace).replace(/\.$/, '') : String(i + 1);
          const stepTitle =
            firstSpace > 0 ? step.label.slice(firstSpace + 1) : step.label;
          return (
            <li
              key={i}
              className={`relative flex items-start gap-2.5 rounded-lg pl-1 pr-2 py-1.5 transition-colors duration-150 ${
                isFinal
                  ? 'bg-primary/5 dark:bg-primary/10 border border-primary/20 dark:border-primary/30'
                  : isRule
                  ? 'bg-amber-50/40 dark:bg-amber-950/20 border border-amber-200/40 dark:border-amber-800/30'
                  : 'hover:bg-muted/40 dark:hover:bg-muted/20 border border-transparent'
              }`}
            >
              <span
                className={`relative z-10 shrink-0 size-5 rounded-full flex items-center justify-center text-[10px] font-bold tabular-nums ${
                  isFinal
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : isRule
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'
                    : 'bg-primary/10 text-primary dark:bg-primary/20'
                }`}
              >
                {stepNum}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div
                  className={`text-xs font-semibold ${
                    isFinal ? 'text-primary' : 'text-foreground'
                  }`}
                >
                  {stepTitle}
                </div>
                <div className="text-[11px] text-muted-foreground break-words mt-0.5">
                  {step.value}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {suggestion.reasonSummary && (
        <div className="pt-3 border-t border-border/40 text-[11px] text-muted-foreground italic">
          <span className="text-foreground/70 mr-1 not-italic font-medium">原因:</span>
          {suggestion.reasonSummary}
        </div>
      )}
    </div>
  );
}

// ─── Row builder (typed return for use in CalculationDetailPanel) ───

function buildRow(
  h: HoldingSnapshot,
  configMap: Map<string, EtfConfig>,
  marketMap: Map<string, any>,
  adviceMap: Map<string, AdviceSuggestion>
) {
  const config = configMap.get(h.etfCode);
  const isInvestment = config?.isInvestmentTarget ?? false;
  const market = marketMap.get(h.etfCode);
  const adviceItem = adviceMap.get(h.etfCode);

  const targetRatio = config ? config.targetRatio * 100 : 0;
  const deviation = h.currentRatio - targetRatio;

  let status: 'over' | 'under' | 'balanced' | 'none' = 'balanced';
  let statusText = '均衡';
  if (!isInvestment) {
    status = 'none';
    statusText = '非定投';
  } else if (Math.abs(deviation) > 5) {
    status = deviation > 0 ? 'over' : 'under';
    statusText = deviation > 0 ? '超配' : '欠配';
  } else if (Math.abs(deviation) > 2) {
    status = deviation > 0 ? 'over' : 'under';
    statusText = deviation > 0 ? '偏多' : '欠配';
  }

  return {
    ...h,
    isInvestment,
    targetRatio,
    deviation,
    status,
    statusText,
    pePercentile: market?.pePercentile ?? null,
    pe: market?.pe ?? null,
    pb: market?.pb ?? null,
    premiumToday: market?.premiumToday ?? null,
    premium7dAvg: market?.premium7dAvg ?? null,
    dividendYield: market?.dividendYield ?? null,
    adviceAmount: adviceItem?.amount ?? null,
    adviceRulesHit: normalizeRuleHits(
      adviceItem?.rulesHit as Array<RuleHit | string> | undefined
    ),
    adviceVetoed: adviceItem?.vetoed ?? false,
    adviceLogic: adviceItem?.logic ?? '',
    adviceMultiplier: adviceItem?.multiplier ?? null,
    adviceReasonSummary: adviceItem?.reasonSummary ?? '',
    // V4.2 §4/§5: 桶类型 + 软风控
    adviceBucketType: adviceItem?.bucketType ?? 'none',
    adviceSoftWindControl: adviceItem?.softWindControl ?? 'none',
    // V5.0 Sprint3 E6: 技术状态 + 执行模式
    adviceTechnicalState: adviceItem?.technicalState ?? null,
    adviceTechnicalMode: adviceItem?.technicalMode ?? null,
    adviceTechnicalCoefficient: adviceItem?.technicalCoefficient ?? null,
  };
}

// ─── Main Component ───

export function UnifiedHoldingsTable({
  holdings,
  totalAssets,
  investmentAssets,
  etfConfigs,
  marketData,
  advice,
  isGeneratingAdvice,
  generationStep,
  onGenerateAdvice,
}: UnifiedHoldingsTableProps) {
  const [macroOpen, setMacroOpen] = useState(false);
  const [expandedLogic, setExpandedLogic] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [pieScope, setPieScope] = useState<'total' | 'investment'>('total');

  const configMap = new Map(etfConfigs.map((c) => [c.code, c]));
  // Market data lookup by ETF code
  const marketMap = new Map<string, any>();
  const items = marketData?.items || marketData?.data || [];
  for (const item of items) {
    marketMap.set(item.code, item);
  }

  // Pie chart data — toggle between 总资产 (all) and 定投资产 (6 ETFs only)
  const pieHoldings =
    pieScope === 'total'
      ? holdings
      : holdings.filter((h) => !NON_INVESTMENT_CODES.has(h.etfCode));
  const pieTotal = pieHoldings.reduce((sum, h) => sum + h.marketValue, 0) || 1;

  const pieData = pieHoldings.map((h, i) => {
    const isNonInvest = NON_INVESTMENT_CODES.has(h.etfCode);
    return {
      name: h.etfName,
      value: h.marketValue,
      code: h.etfCode,
      color: CHART_COLORS[i % CHART_COLORS.length],
      isNonInvest,
      percent: (h.marketValue / pieTotal) * 100,
    };
  });

  // Build unified table rows: merge holdings + market data + advice
  const adviceMap = new Map<string, AdviceSuggestion>();
  if (advice?.suggestions) {
    for (const s of advice.suggestions) {
      adviceMap.set(s.code, s);
    }
  }

  // Sort holdings: investment targets first (by sortOrder), then non-investment
  const sortedHoldings = [...holdings].sort((a, b) => {
    const ca = configMap.get(a.etfCode);
    const cb = configMap.get(b.etfCode);
    const aInvest = ca?.isInvestmentTarget ? 0 : 1;
    const bInvest = cb?.isInvestmentTarget ? 0 : 1;
    if (aInvest !== bInvest) return aInvest - bInvest;
    return (ca?.sortOrder ?? 999) - (cb?.sortOrder ?? 999);
  });

  const tableRows = sortedHoldings.map((h) =>
    buildRow(h, configMap, marketMap, adviceMap)
  );

  const toggleRow = (code: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const handleExport = () => {
    if (!advice) return;
    const lines: string[] = [];
    lines.push(`📊 本周定投建议 (${new Date(advice.generatedAt).toLocaleDateString('zh-CN')})`);
    lines.push('');
    lines.push(`总预算: ¥${advice.totalBudget.toLocaleString()}`);
    lines.push(`已分配: ¥${advice.totalAllocated.toLocaleString()}`);
    lines.push(`未分配: ¥${advice.totalUnallocated.toLocaleString()} (建议转入华宝添益)`);
    if (advice.engineVersion) lines.push(`引擎版本: ${advice.engineVersion}`);
    if (advice.calculationId) lines.push(`计算ID: ${advice.calculationId}`);
    if (advice.dataSnapshot?.marketDataCacheTime) {
      lines.push(`数据缓存时间: ${advice.dataSnapshot.marketDataCacheTime}`);
    }
    lines.push('');
    lines.push('--- 建议明细 ---');
    advice.suggestions.forEach((s) => {
      const rulesList = (s.rulesHit || []).map((r) => getRuleName(r)).filter(Boolean);
      lines.push(`${s.name}(${s.code}): 买入 ¥${s.amount.toLocaleString()}`);
      if (s.reasonSummary) lines.push(`  原因: ${s.reasonSummary}`);
      if (s.logic) lines.push(`  逻辑: ${s.logic}`);
      lines.push(`  触发规则: ${rulesList.join(', ') || '无'}`);
    });
    if (advice.macroSummary) {
      lines.push('');
      lines.push('--- 宏观环境 ---');
      lines.push(advice.macroSummary);
    }
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `定投建议_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const dataTime =
    advice?.dataSnapshot?.marketDataCacheTime || advice?.calculatedAt || '';

  return (
    <div className="space-y-6">
      {/* ─── 资产配置（饼图左 + 图例右） + 资产概览（下方） ─── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">资产配置</CardTitle>
            <ToggleGroup
              type="single"
              value={pieScope}
              onValueChange={(v) => {
                if (v === 'total' || v === 'investment') setPieScope(v);
              }}
              size="sm"
              variant="outline"
              className="scale-90 origin-right"
            >
              <ToggleGroupItem value="total" className="text-[10px] px-2 h-6">
                总资产
              </ToggleGroupItem>
              <ToggleGroupItem value="investment" className="text-[10px] px-2 h-6">
                定投资产
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <CardDescription className="text-xs">
            {pieScope === 'total' ? '全部持仓市值分布' : '6 只定投 ETF 市值分布'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 饼图左 + 图例右 — 同一行 */}
          <div className="flex items-center gap-4">
            {/* 饼图 */}
            <div className="h-[140px] w-[140px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={65}
                    paddingAngle={2}
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const p = payload[0].payload as {
                        name: string;
                        value: number;
                        code: string;
                        percent: number;
                        isNonInvest: boolean;
                      };
                      return (
                        <div className="rounded-lg border border-border/60 bg-background/95 dark:bg-background/90 backdrop-blur px-2.5 py-1.5 text-xs shadow-pop">
                          <div className="font-medium">{p.name}</div>
                          <div className="font-mono text-muted-foreground tabular-nums">
                            {formatYuan(p.value, 2)}
                          </div>
                          <div className="font-mono text-muted-foreground tabular-nums">
                            占比 {p.percent.toFixed(1)}%
                          </div>
                          <div
                            className={`text-[10px] mt-0.5 ${
                              p.isNonInvest ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
                            }`}
                          >
                            {p.isNonInvest ? '不参与定投' : '参与定投'}
                          </div>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* 图例右侧 */}
            <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-0.5 max-h-[140px] overflow-y-auto pr-1">
              {pieData.map((entry, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-1.5 text-[11px] transition-colors duration-150 ${
                    entry.isNonInvest ? 'opacity-60' : ''
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-sm shrink-0"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span
                    className={`truncate min-w-0 ${
                      entry.isNonInvest
                        ? 'line-through text-muted-foreground'
                        : 'text-foreground'
                    }`}
                  >
                    {entry.name}
                  </span>
                  <span className="font-mono text-muted-foreground tabular-nums ml-auto shrink-0">
                    {entry.percent.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 资产概览 — 饼图下方紧凑一行 */}
          <div className="mt-3 pt-3 border-t border-border/40 dark:border-border/30 grid grid-cols-4 gap-3">
            <div className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground">总资产</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                ¥{totalAssets.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground">定投资产</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                ¥{(investmentAssets ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground">本周预算</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                ¥{advice?.totalBudget?.toLocaleString() ?? '40,000'}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground">持仓标的</div>
              <div className="text-sm font-mono font-semibold tabular-nums">
                {holdings.length}<span className="text-[10px] text-muted-foreground ml-0.5 font-sans font-normal">只</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>


      {/* ─── Unified Holdings + Monitoring + Advice Table ─── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle className="text-base">持仓明细 · 监控指标 · 定投建议</CardTitle>
              <CardDescription className="text-xs mt-1">
                注：定投标的"当前占比"基于定投资产总额计算（已剔除华宝添益和黄金），可直接与目标占比对比。点击行首箭头查看计算过程
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {advice && (
                <Button variant="outline" size="sm" onClick={handleExport}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  导出
                </Button>
              )}
              <Button
                size="sm"
                onClick={onGenerateAdvice}
                disabled={isGeneratingAdvice}
              >
                {isGeneratingAdvice ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    生成中
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                    {advice ? '重新生成建议' : '生成本周定投建议'}
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Generation Progress */}
          {isGeneratingAdvice && (
            <div className="mt-3 space-y-2">
              <Progress value={(generationStep / STEP_LABELS.length) * 100} className="h-1.5" />
              <div className="flex items-center gap-2 flex-wrap">
                {STEP_LABELS.map((label, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    {i < generationStep ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : i === generationStep ? (
                      <CircleDot className="h-3.5 w-3.5 text-amber-500 animate-pulse" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground/30" />
                    )}
                    <span
                      className={`text-[11px] ${
                        i < generationStep
                          ? 'text-emerald-600'
                          : i === generationStep
                          ? 'text-amber-600 font-medium'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="px-2 sm:px-4">
          {/* Macro Summary Collapsible */}
          {advice?.macroSummary && !isGeneratingAdvice && (
            <Collapsible open={macroOpen} onOpenChange={setMacroOpen} className="mb-3">
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                {macroOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                宏观环境快照
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="text-xs text-muted-foreground bg-muted/40 dark:bg-muted/20 rounded-lg border border-border/40 dark:border-border/30 p-3 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
                  {advice.macroSummary}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* The unified table - horizontally scrollable on small screens */}
          <div className="overflow-x-auto">
            <Table className="min-w-[1360px]">
              <TableHeader>
                <TableRow className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/40 dark:hover:bg-muted/20 border-b border-border/60">
                  <TableHead className="w-[40px] text-center text-[11px] font-medium text-muted-foreground uppercase tracking-wide">展开</TableHead>
                  <TableHead className="w-[120px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">标的</TableHead>
                  <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">持仓市值</TableHead>
                  <TableHead className="text-right w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">当前/目标占比</TableHead>
                  <TableHead className="text-right w-[60px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">偏离度</TableHead>
                  <TableHead className="text-center w-[55px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">PE分位</TableHead>
                  <TableHead className="text-center w-[90px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">溢价/股息</TableHead>
                  <TableHead className="text-center w-[65px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">配置状态</TableHead>
                  <TableHead className="text-center w-[70px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">资金桶</TableHead>
                  <TableHead className="text-center w-[70px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">软风控</TableHead>
                  <TableHead className="text-center w-[78px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">技术状态</TableHead>
                  <TableHead className="text-right w-[100px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">本周建议</TableHead>
                  <TableHead className="w-[380px] max-w-[440px] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">买入逻辑</TableHead>
                </TableRow>
              </TableHeader>
              <motion.tbody
                data-slot="table-body"
                className="[&_tr:last-child]:border-0"
                variants={staggerContainer(0.04)}
                initial="hidden"
                animate="show"
              >
                {tableRows.map((row) => {
                  const isOverseas =
                    row.premiumToday !== null &&
                    row.premiumToday !== undefined &&
                    !NON_INVESTMENT_CODES.has(row.etfCode) &&
                    configMap.get(row.etfCode)?.category === 'overseas';
                  const isExpanded = expandedRows.has(row.etfCode);
                  return (
                    <React.Fragment key={row.etfCode}>
                      <motion.tr
                        variants={fadeIn}
                        data-slot="table-row"
                        className={
                          'border-b transition-colors duration-150 hover:bg-accent/40 dark:hover:bg-accent/30 ' +
                          (row.adviceVetoed
                            ? 'bg-red-50/40 dark:bg-red-950/20'
                            : row.adviceAmount === 0 &&
                              row.isInvestment &&
                              advice &&
                              !row.adviceVetoed
                            ? 'bg-amber-50/30 dark:bg-amber-950/15'
                            : !row.isInvestment
                            ? 'bg-muted/30 dark:bg-muted/20 font-medium border-t-2 border-border/60'
                            : '')
                        }
                      >
                        {/* Chevron toggle */}
                        <TableCell className="text-center align-middle">
                          {row.isInvestment ? (
                            <button
                              type="button"
                              onClick={() => toggleRow(row.etfCode)}
                              className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 ease-out-expo"
                              aria-label={isExpanded ? '收起' : '展开计算过程'}
                            >
                              <ChevronDown
                                className={`h-3.5 w-3.5 transition-transform duration-200 ease-out-expo ${
                                  isExpanded ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                          ) : (
                            <span className="text-muted-foreground/30 text-[10px]">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium leading-tight">{row.etfName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground leading-tight">{row.etfCode}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          ¥{row.marketValue.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </TableCell>
                        {/* 当前/目标占比合并列 */}
                        <TableCell className="text-right font-mono text-xs">
                          {row.isInvestment ? (
                            <div className="flex flex-col items-end leading-tight">
                              <span className="font-medium">{row.currentRatio.toFixed(1)}%</span>
                              <span className="text-muted-foreground text-[10px]">目标 {row.targetRatio.toFixed(0)}%</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* 偏离度 */}
                        <TableCell
                          className={`text-right font-mono text-xs font-medium tabular-nums ${
                            row.isInvestment
                              ? row.deviation > 2
                                ? 'text-red-600 dark:text-red-400'
                                : row.deviation < -2
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-emerald-600 dark:text-emerald-400'
                              : 'text-muted-foreground'
                          }`
                        }>
                          {row.isInvestment
                            ? `${row.deviation > 0 ? '+' : ''}${row.deviation.toFixed(1)}%`
                            : '—'}
                        </TableCell>
                        {/* PE分位 */}
                        <TableCell className="text-center">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium font-mono ${
                              row.pePercentile === null || row.pePercentile === undefined
                                ? 'bg-muted/40 dark:bg-muted/20'
                                : row.pePercentile < 20
                                ? 'bg-emerald-50/70 dark:bg-emerald-950/30'
                                : row.pePercentile < 80
                                ? 'bg-amber-50/70 dark:bg-amber-950/30'
                                : 'bg-red-50/70 dark:bg-red-950/30'
                            } ${getPercentileColor(row.pePercentile)}`}
                            title={row.pe !== null ? `PE=${row.pe.toFixed(1)}` : ''}
                          >
                            {getPercentileDot(row.pePercentile)}
                            {row.pePercentile !== null && row.pePercentile !== undefined ? `${row.pePercentile.toFixed(0)}%` : '—'}
                          </span>
                        </TableCell>
                        {/* 溢价率/股息率合并列: QDII显示溢价+7日均, 红利显示股息率, 其他显示— */}
                        <TableCell className="text-center">
                          {isOverseas ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium font-mono ${
                                  row.premiumToday === null || row.premiumToday === undefined
                                    ? 'bg-muted/40 dark:bg-muted/20'
                                    : row.premiumToday < 2
                                    ? 'bg-emerald-50/70 dark:bg-emerald-950/30'
                                    : row.premiumToday < 3
                                    ? 'bg-amber-50/70 dark:bg-amber-950/30'
                                    : 'bg-red-50/70 dark:bg-red-950/30'
                                } ${getPremiumColor(row.premiumToday)}`}
                              >
                                {getPremiumDot(row.premiumToday)}
                                {formatPercent(row.premiumToday, 2)}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                                7日均 {formatPercent(row.premium7dAvg, 2)}
                              </span>
                            </div>
                          ) : row.etfCode === '510880' && row.dividendYield !== null && row.dividendYield !== undefined ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span
                                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium font-mono ${
                                  row.dividendYield > 4
                                    ? 'bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                                    : row.dividendYield > 3
                                    ? 'bg-amber-50/70 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400'
                                    : 'bg-red-50/70 dark:bg-red-950/30 text-red-600 dark:text-red-400'
                                }`}
                              >
                                {row.dividendYield.toFixed(2)}%
                              </span>
                              <span className="text-[10px] text-muted-foreground">股息率</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* 配置状态 */}
                        <TableCell className="text-center">
                          {getStatusBadge(row.status, row.statusText)}
                        </TableCell>
                        {/* V4.2 §4 资金桶: base_bucket / value_bucket / base+value / none */}
                        <TableCell className="text-center">
                          {row.isInvestment && row.adviceBucketType && row.adviceBucketType !== 'none' ? (
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 rounded-full font-mono ${getBucketTypeBadgeClass(row.adviceBucketType)}`}
                              title={`V4.2 资金桶: ${getBucketTypeLabel(row.adviceBucketType)}`}
                            >
                              {getBucketTypeLabel(row.adviceBucketType)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* V4.2 §5 软风控: none / reduce / forbid_enhancement / minimal_base / pause_all */}
                        <TableCell className="text-center">
                          {row.isInvestment && row.adviceSoftWindControl && row.adviceSoftWindControl !== 'none' ? (
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 rounded-full font-mono ${getSoftWindControlBadgeClass(row.adviceSoftWindControl)}`}
                              title={`V4.2 软风控: ${getSoftWindControlLabel(row.adviceSoftWindControl)}`}
                            >
                              {getSoftWindControlLabel(row.adviceSoftWindControl)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* V5.0 Sprint3 E6 技术状态: 7态Badge + 执行模式小字 */}
                        <TableCell className="text-center">
                          {row.isInvestment && row.adviceTechnicalState ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Badge
                                variant="outline"
                                className={`text-[10px] px-1.5 py-0 rounded-full font-mono ${getTechnicalStateBadgeClass(row.adviceTechnicalState)}`}
                                title={`V5.0 技术状态: ${getTechnicalStateLabel(row.adviceTechnicalState)}${
                                  row.adviceTechnicalCoefficient
                                    ? ` (${row.adviceTechnicalCoefficient.toFixed(1)}x)`
                                    : ''
                                }`}
                              >
                                {getTechnicalStateLabel(row.adviceTechnicalState)}
                              </Badge>
                              {row.adviceTechnicalMode && (
                                <span className="text-[9px] text-muted-foreground font-mono">
                                  {getTechnicalModeShortLabel(row.adviceTechnicalMode)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* 本周建议金额 */}
                        <TableCell className="text-right">
                          {row.isInvestment && row.adviceAmount !== null ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span
                                className={`font-mono text-sm font-bold tabular-nums ${
                                  row.adviceVetoed
                                    ? 'text-red-600 dark:text-red-400'
                                    : row.adviceAmount > 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-amber-600 dark:text-amber-400'
                                }`}
                                title={row.adviceReasonSummary || undefined}
                              >
                                {row.adviceVetoed ? (
                                  <span className="inline-flex items-center gap-0.5">
                                    <Ban className="h-3 w-3" />
                                    不买入
                                  </span>
                                ) : row.adviceAmount > 0 ? (
                                  `¥${row.adviceAmount.toLocaleString()}`
                                ) : (
                                  '不补仓'
                                )}
                              </span>
                              {row.adviceReasonSummary && (
                                <span
                                  className="text-[9px] text-muted-foreground/80 leading-tight max-w-[140px] text-right line-clamp-1"
                                  title={row.adviceReasonSummary}
                                >
                                  {row.adviceReasonSummary}
                                </span>
                              )}
                              {row.adviceRulesHit.length > 0 && (
                                <div className="flex flex-wrap gap-0.5 justify-end max-w-[120px]">
                                  {row.adviceRulesHit.slice(0, 2).map((rule, i) => (
                                    <Badge
                                      key={i}
                                      variant="secondary"
                                      className="rounded-full text-[9px] px-1.5 py-0 h-3.5 font-mono"
                                      title={typeof rule === 'string' ? rule : rule.conditionText}
                                    >
                                      {getRuleName(rule)}
                                    </Badge>
                                  ))}
                                  {row.adviceRulesHit.length > 2 && (
                                    <Badge variant="secondary" className="rounded-full text-[9px] px-1.5 py-0 h-3.5 font-mono">
                                      +{row.adviceRulesHit.length - 2}
                                    </Badge>
                                  )}
                                </div>
                              )}
                              {row.adviceVetoed && (
                                <Badge variant="destructive" className="rounded-full text-[9px] px-1.5 py-0 h-3.5 font-mono">
                                  一票否决
                                </Badge>
                              )}
                            </div>
                          ) : row.isInvestment && !advice ? (
                            <span className="text-muted-foreground/50 italic text-[11px]">待生成</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* 买入逻辑 - 放宽列宽 V4.2 P7 */}
                        <TableCell className="text-xs text-muted-foreground max-w-[380px]">
                          {row.adviceLogic ? (
                            <div
                              className="cursor-pointer break-words whitespace-normal"
                              onClick={(e) => {
                                e.stopPropagation();
                                const next = new Set(expandedLogic);
                                if (next.has(row.etfCode)) {
                                  next.delete(row.etfCode);
                                } else {
                                  next.add(row.etfCode);
                                }
                                setExpandedLogic(next);
                              }}
                            >
                              <div className={expandedLogic.has(row.etfCode) ? 'whitespace-pre-wrap' : 'line-clamp-4'}>
                                {row.adviceLogic}
                              </div>
                              <span className="text-[10px] text-primary hover:underline mt-1 inline-block">
                                {expandedLogic.has(row.etfCode) ? '收起' : '展开全部'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                      </motion.tr>

                      {/* Expanded calculation detail row */}
                      <AnimatePresence initial={false}>
                        {isExpanded && row.isInvestment && (
                          <motion.tr
                            key={`${row.etfCode}-detail`}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3, ease: EASE }}
                            className="bg-muted/10 dark:bg-muted/5"
                          >
                            <TableCell colSpan={13} className="p-0">
                              <CalculationDetailPanel
                                row={row}
                                advice={advice}
                                investmentAssets={investmentAssets ?? 0}
                              />
                            </TableCell>
                          </motion.tr>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })}
              </motion.tbody>
            </Table>
          </div>

          {/* Advice summary footer */}
          {advice && !isGeneratingAdvice && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-muted/40 dark:bg-muted/20 border border-border/40 dark:border-border/30 rounded-lg px-4 py-3 mt-3">
              <div className="flex items-center gap-4 text-xs flex-wrap">
                <div>
                  <span className="text-muted-foreground">总预算</span>
                  <span className="ml-2 font-mono font-medium tabular-nums">
                    ¥{advice.totalBudget.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">已分配</span>
                  <span className="ml-2 font-mono font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    ¥{advice.totalAllocated.toLocaleString()}
                  </span>
                </div>
                <div className="inline-flex items-center gap-1.5">
                  <span className="text-muted-foreground">未投入</span>
                  <span className="font-mono font-medium tabular-nums text-amber-600 dark:text-amber-400">
                    ¥{advice.totalUnallocated.toLocaleString()}
                  </span>
                  <ArrowRight className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <Wallet className="h-3 w-3" />
                    建议转入华宝添益
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-[10px] text-muted-foreground">
                <span>
                  生成于 {new Date(advice.generatedAt).toLocaleString('zh-CN')}
                </span>
                {advice.engineVersion && (
                  <span className="font-mono text-muted-foreground/80 tabular-nums">
                    {advice.engineVersion}
                    {advice.calculationId ? ` · ${advice.calculationId}` : ''}
                  </span>
                )}
                {dataTime && (
                  <span className="font-mono text-muted-foreground/70 tabular-nums">
                    数据 {formatDataTime(dataTime)}
                    {advice.dataSnapshot?.rulesConfigVersion
                      ? ` · ${advice.dataSnapshot.rulesConfigVersion}`
                      : ''}
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
