'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ComposedChart,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Customized,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  AlertCircle,
  Activity,
  XCircle,
  ShieldAlert,
  ShieldMinus,
  ShieldPlus,
  Info,
  Database,
  BarChart3,
  DollarSign,
  Globe,
  RefreshCw,
  Thermometer,
} from 'lucide-react';
import type {
  MarketDataSummary,
  SummaryResponse,
  CachedValuation,
  CachedPremium,
  CachedKline,
  CachedNav,
  CachedDividend,
  MarketIndexData,
  PEHistoryPoint,
  PremiumHistoryPoint,
  KlinePoint,
} from '@/lib/types';
import { TrendLineagePopover } from '@/components/trend-lineage-popover';
import {
  getFieldConfigs,
  getQualityByCode,
  getMacroTemperature,
  getMacroPrompts,
  refreshMacro,
  getTechnicalClass,
  type FieldSourceConfig,
  type QualityScoreItem,
  type MacroMetricItem,
  type MacroPrompt,
  type TechnicalClassification,
} from '@/lib/api';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

// ─── Types ───

interface RuleConfig {
  id: string;
  name: string;
  type: string;
  triggerCondition: string;
  thresholdValue: number;
  thresholdValueMax: number | null;
  applicableScope: string;
  applicableCodes: string | null;
  reason: string;
  isEnabled: boolean;
  sortOrder: number;
}

type RuleLevel = 'veto' | 'reduce' | 'boost' | 'normal' | 'unknown';

interface RuleImpact {
  level: RuleLevel;
  text: string;
  ruleName?: string;
}

// ─── Constants ───

const ETF_LIST = [
  { code: '159338', name: '中证A500ETF', category: 'domestic', shortName: '中证A500' },
  { code: '510880', name: '红利ETF', category: 'domestic', shortName: '红利' },
  { code: '510330', name: '沪深300ETF', category: 'domestic', shortName: '沪深300' },
  { code: '588000', name: '科创50ETF', category: 'domestic', shortName: '科创50' },
  { code: '513500', name: '标普500ETF', category: 'overseas', shortName: '标普500' },
  { code: '513300', name: '纳斯达克ETF', category: 'overseas', shortName: '纳斯达克' },
];

const CHART_TYPES = [
  { label: '日K', value: 'daily' },
  { label: '周K', value: 'weekly' },
  { label: '月K', value: 'monthly' },
] as const;

const TIME_RANGES = [
  { label: '近1月', months: 1 },
  { label: '近3月', months: 3 },
  { label: '近6月', months: 6 },
  { label: '近1年', months: 12 },
  { label: '近5年', months: 60 },
] as const;

// ─── Helper Functions ───

function getPercentileColor(percentile: number | null): string {
  if (percentile === null) return 'text-muted-foreground';
  if (percentile < 20) return 'text-emerald-600';
  if (percentile < 80) return 'text-amber-600';
  return 'text-red-600';
}

function getPercentileDot(percentile: number | null): string {
  if (percentile === null) return '⚪';
  if (percentile < 20) return '🟢';
  if (percentile < 80) return '🟡';
  return '🔴';
}

function getPremiumColor(value: number | null): string {
  if (value === null) return 'text-muted-foreground';
  if (value < 2) return 'text-emerald-600';
  if (value < 3) return 'text-amber-600';
  return 'text-red-600';
}

function getPremiumDot(value: number | null): string {
  if (value === null) return '⚪';
  if (value < 2) return '🟢';
  if (value < 3) return '🟡';
  return '🔴';
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(1)}%`;
}

function formatValue(value: number | null, decimals = 2): string {
  if (value === null) return '—';
  return value.toFixed(decimals);
}

function filterHistoryByMonths<T extends { date: string }>(
  history: T[],
  months: number
): T[] {
  if (!history.length) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return history.filter((item) => item.date >= cutoffStr);
}

// ─── Moving Average Computation ───

function computeMA(
  data: Array<{ date: string; value?: number | null }>,
  period: number
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const values: number[] = [];

  for (const item of data) {
    const v = item.value;
    if (v !== null && v !== undefined) {
      values.push(v);
      if (values.length >= period) {
        const sum = values.slice(-period).reduce((a, b) => a + b, 0);
        result.set(item.date, sum / period);
      } else {
        result.set(item.date, null);
      }
    } else {
      result.set(item.date, null);
    }
  }
  return result;
}

function computeKlineMA(
  data: KlinePoint[],
  period: number
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const values: number[] = [];

  for (const item of data) {
    const v = item.close;
    if (v !== null && v !== undefined) {
      values.push(v);
      if (values.length >= period) {
        const sum = values.slice(-period).reduce((a, b) => a + b, 0);
        result.set(item.date, sum / period);
      } else {
        result.set(item.date, null);
      }
    } else {
      result.set(item.date, null);
    }
  }
  return result;
}

// ─── K-line Aggregation for Weekly / Monthly ───

function aggregateKline(data: KlinePoint[], period: 'weekly' | 'monthly'): KlinePoint[] {
  if (!data.length) return [];

  const groups = new Map<string, KlinePoint[]>();

  for (const item of data) {
    const d = new Date(item.date);
    let key: string;

    if (period === 'weekly') {
      // Get the Monday of the week
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = item.date.slice(0, 7); // YYYY-MM
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(item);
  }

  const result: KlinePoint[] = [];
  for (const [, items] of groups) {
    const validItems = items.filter(
      (i) => i.open !== null && i.close !== null && i.high !== null && i.low !== null
    );
    if (validItems.length === 0) continue;

    const first = validItems[0];
    const last = validItems[validItems.length - 1];
    const highVal = Math.max(...validItems.map((i) => i.high!));
    const lowVal = Math.min(...validItems.map((i) => i.low!));
    const volSum = validItems.reduce((s, i) => s + (i.volume ?? 0), 0);

    result.push({
      date: last.date,
      open: first.open,
      high: highVal,
      low: lowVal,
      close: last.close,
      volume: volSum,
    });
  }

  return result;
}

// ─── Data Fetching Hooks ───

function useSummary() {
  return useQuery<SummaryResponse>({
    queryKey: ['data', 'summary'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=summary');
      if (!res.ok) throw new Error('Failed to fetch summary');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useValuation() {
  return useQuery<CachedValuation[]>({
    queryKey: ['data', 'valuation'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=valuation');
      if (!res.ok) throw new Error('Failed to fetch valuation');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function usePremium() {
  return useQuery<CachedPremium[]>({
    queryKey: ['data', 'premium'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=premium');
      if (!res.ok) throw new Error('Failed to fetch premium');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useNav() {
  return useQuery<CachedNav[]>({
    queryKey: ['data', 'nav'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=nav');
      if (!res.ok) throw new Error('Failed to fetch nav');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useKline() {
  return useQuery<CachedKline[]>({
    queryKey: ['data', 'kline'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=kline');
      if (!res.ok) throw new Error('Failed to fetch kline');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useDividend() {
  return useQuery<CachedDividend[]>({
    queryKey: ['data', 'dividend'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=dividend');
      if (!res.ok) throw new Error('Failed to fetch dividend');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useMarketIndex() {
  return useQuery<MarketIndexData[]>({
    queryKey: ['data', 'market-index'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=market-index');
      if (!res.ok) throw new Error('Failed to fetch market index');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useRules() {
  return useQuery<RuleConfig[]>({
    queryKey: ['rules'],
    queryFn: async () => {
      const res = await fetch('/api/rule');
      if (!res.ok) throw new Error('Failed to fetch rules');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Anomaly filtering (§10.B4) ───
// Rejects null/undefined, non-finite, and sentinel values (|v| >= 999999)
function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 999999;
}

function filterValidPoints<T>(points: T[], getValue: (p: T) => number | null | undefined): T[] {
  return points.filter(p => isValidNumber(getValue(p)));
}

// ─── Rule impact computation (§10.B1) ───
// Computes a one-line interpretation of current indicators against the enabled rules.

function computeRuleImpact(
  etf: { code: string; category: string },
  summary: MarketDataSummary | undefined,
  rules: RuleConfig[]
): RuleImpact {
  const enabledRules = rules.filter(r => r.isEnabled);

  // 1. Blacklist check (specific_code containing this code)
  const blacklistRule = enabledRules.find(
    r =>
      r.type === 'veto' &&
      r.name.includes('黑名单') &&
      (r.applicableCodes ?? '').split(',').map(c => c.trim()).includes(etf.code)
  );
  if (blacklistRule) {
    return {
      level: 'veto',
      text: '该标的已加入黑名单，命中「资产黑名单」一票否决规则，本周不参与买入。',
      ruleName: blacklistRule.name,
    };
  }

  const pe = summary?.pePercentile;
  const premium = summary?.premiumToday;
  const avg7 = summary?.premium7dAvg;

  // 2. QDII overseas ETFs — check premium rules
  if (etf.category === 'overseas' && isValidNumber(premium)) {
    const p = premium as number;
    const a = isValidNumber(avg7) ? (avg7 as number) : p;

    const redlineRule = enabledRules.find(r => r.name.includes('溢价红线'));
    if (redlineRule && p > redlineRule.thresholdValue) {
      return {
        level: 'veto',
        text: `当前溢价率 ${p.toFixed(2)}%，7日均值 ${a.toFixed(2)}%，超过 ${redlineRule.thresholdValue}% 红线，命中「${redlineRule.name}」一票否决规则，本周不买。`,
        ruleName: redlineRule.name,
      };
    }

    const warningRule = enabledRules.find(r => r.name.includes('溢价预警'));
    const warningMax = warningRule?.thresholdValueMax ?? 3;
    if (warningRule && p >= warningRule.thresholdValue && p <= warningMax) {
      return {
        level: 'reduce',
        text: `当前溢价率 ${p.toFixed(2)}%，7日均值 ${a.toFixed(2)}%，处于 ${warningRule.thresholdValue}%-${warningMax}% 预警区间，命中减量规则「${warningRule.name}」。`,
        ruleName: warningRule.name,
      };
    }

    return {
      level: 'normal',
      text: `当前溢价率 ${p.toFixed(2)}%，7日均值 ${a.toFixed(2)}%，溢价可控，未触发溢价类规则。`,
    };
  }

  // 3. Domestic ETFs — check valuation percentile rules
  if (etf.category === 'domestic' && isValidNumber(pe)) {
    const p = pe as number;
    const dy = summary?.dividendYield;
    const highDividend =
      etf.code === '510880' && isValidNumber(dy) && (dy as number) > 4;
    const dividendExtra = highDividend
      ? ` 股息率 ${(dy as number).toFixed(2)}% 处于高位，红利策略配置价值凸显。`
      : '';

    const vetoRule = enabledRules.find(r => r.name.includes('极高分位'));
    if (vetoRule && p > vetoRule.thresholdValue) {
      return {
        level: 'veto',
        text: `当前 PE 分位 ${p.toFixed(1)}%，命中「${vetoRule.name}」一票否决规则。按当前设置，该标的本周不参与买入。${dividendExtra}`,
        ruleName: vetoRule.name,
      };
    }

    const reduceRule = enabledRules.find(r => r.name.includes('偏高'));
    const reduceMax = reduceRule?.thresholdValueMax ?? 80;
    if (reduceRule && p >= reduceRule.thresholdValue && p <= reduceMax) {
      return {
        level: 'reduce',
        text: `当前 PE 分位 ${p.toFixed(1)}%，命中「${reduceRule.name}」减量规则，本周额度减半。${dividendExtra}`,
        ruleName: reduceRule.name,
      };
    }

    const boostRule = enabledRules.find(r => r.name.includes('极度低估'));
    if (boostRule && p < boostRule.thresholdValue) {
      return {
        level: 'boost',
        text: `当前 PE 分位 ${p.toFixed(1)}%，命中「${boostRule.name}」加量规则，本周额度翻倍。${dividendExtra}`,
        ruleName: boostRule.name,
      };
    }

    return {
      level: 'normal',
      text: `当前 PE 分位 ${p.toFixed(1)}%，估值正常区间，未触发估值类规则。${dividendExtra}`,
    };
  }

  // 4. Data missing
  return {
    level: 'unknown',
    text: '当前估值数据不足，无法判断规则触发情况，建议人工确认。',
  };
}

function ruleLevelToBadge(level: RuleLevel): React.ReactNode {
  switch (level) {
    case 'veto':
      return (
        <Badge className="bg-red-100 text-red-700 border-red-200 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800">
          <ShieldAlert className="size-3 mr-1" />
          一票否决
        </Badge>
      );
    case 'reduce':
      return (
        <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
          <ShieldMinus className="size-3 mr-1" />
          减量
        </Badge>
      );
    case 'boost':
      return (
        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800">
          <ShieldPlus className="size-3 mr-1" />
          加量
        </Badge>
      );
    case 'normal':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          正常
        </Badge>
      );
    case 'unknown':
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <Info className="size-3 mr-1" />
          数据不足
        </Badge>
      );
  }
}

function ruleLevelToTextColor(level: RuleLevel): string {
  switch (level) {
    case 'veto': return 'text-red-600 dark:text-red-400';
    case 'reduce': return 'text-amber-600 dark:text-amber-400';
    case 'boost': return 'text-emerald-600 dark:text-emerald-400';
    case 'normal': return 'text-muted-foreground';
    case 'unknown': return 'text-amber-600 dark:text-amber-400';
    default: return 'text-muted-foreground';
  }
}

function ruleLevelToBg(level: RuleLevel): string {
  switch (level) {
    case 'veto': return 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800';
    case 'reduce': return 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800';
    case 'boost': return 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800';
    case 'unknown': return 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200/60 dark:border-amber-800/60';
    default: return 'bg-muted/30 border-border';
  }
}

// ─── Data source footer (§10.B4) ───

function DataSourceFooter({
  date,
  source = 'akshare',
  isNavProxy = false,
}: {
  date?: string;
  source?: string;
  isNavProxy?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-2 flex-wrap">
      <Database className="size-3" />
      <span>数据源: {source}{date ? ` · 更新: ${date}` : ''}</span>
      {isNavProxy && (
        <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-[9px] font-medium border border-amber-200 dark:border-amber-800">
          净值代理
        </span>
      )}
    </div>
  );
}

// V4.1 BUG-2026-06-A500-PB: PB 数据来源徽标（沪深300代理 / csindex 等）
function PbSourceBadge({ pbSource }: { pbSource?: string | null }) {
  if (!pbSource) return null;
  // 只在代理或异常场景显示徽标，纯 csindex 不显示（避免噪音）
  if (pbSource === 'csindex') return null;
  return <SourceBadge source={pbSource} label="PB" />;
}

// V4.1 BUG-2026-06-A500-PE: PE 数据来源徽标（沪深300代理 / multpl.com / 标普500代理 等）
function PeSourceBadge({ peSource }: { peSource?: string | null }) {
  if (!peSource) return null;
  // csindex / multpl.com 是原生数据源不显示徽标，只在代理或异常场景显示
  if (peSource === 'csindex' || peSource === 'multpl.com') return null;
  return <SourceBadge source={peSource} label="PE" />;
}

// 通用数据来源徽标
function SourceBadge({ source, label }: { source: string; label: string }) {
  const isProxy = source.includes('代理');
  const isError = source.includes('error') || source.includes('失败');
  const cls = isProxy
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800'
    : isError
    ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800'
    : 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200 dark:border-slate-700';
  return (
    <span
      className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-medium border ${cls}`}
      title={`${label} 数据来源: ${source}`}
    >
      {source}
    </span>
  );
}



// ─── Sub-Components ───

function IndicatorCard({
  label,
  value,
  percentile,
  format = 'value',
  footer,
}: {
  label: string;
  value: number | null;
  percentile: number | null;
  format?: 'value' | 'percent' | 'yield';
  footer?: React.ReactNode;
}) {
  const displayValue = (() => {
    if (value === null) return '—';
    if (format === 'percent') return `${value.toFixed(2)}%`;
    if (format === 'yield') return `${value.toFixed(2)}%`;
    return value.toFixed(2);
  })();

  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border p-3 bg-muted/30">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xl font-bold ${getPercentileColor(percentile)}`}>
        {displayValue}
      </span>
      <span className="text-xs flex items-center gap-1">
        {getPercentileDot(percentile)}
        <span className="text-muted-foreground">
          分位 {formatPercent(percentile)}
        </span>
      </span>
      {footer && (
        <div className="mt-1 -mb-1">{footer}</div>
      )}
    </div>
  );
}

function PremiumIndicatorCard({
  label,
  value,
  isDot = false,
  footer,
}: {
  label: string;
  value: number | null;
  isDot?: boolean;
  footer?: React.ReactNode;
}) {
  const displayValue = formatPercent(value);
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border p-3 bg-muted/30">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xl font-bold ${getPremiumColor(value)}`}>
        {displayValue}
      </span>
      {isDot && (
        <span className="text-xs flex items-center gap-1">
          {getPremiumDot(value)}
        </span>
      )}
      {footer && (
        <div className="mt-1 -mb-1">{footer}</div>
      )}
    </div>
  );
}

function ETFSelector({
  selectedCode,
  onSelect,
  summaryMap,
  isLoading,
}: {
  selectedCode: string;
  onSelect: (code: string) => void;
  summaryMap: Map<string, MarketDataSummary>;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {ETF_LIST.map((etf) => (
          <Skeleton key={etf.code} className="h-20 w-36 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
      {ETF_LIST.map((etf) => {
        const summary = summaryMap.get(etf.code);
        const isSelected = selectedCode === etf.code;
        const pePercentile = summary?.pePercentile ?? null;

        return (
          <button
            key={etf.code}
            onClick={() => onSelect(etf.code)}
            className={`shrink-0 flex flex-col items-center gap-1 rounded-xl border-2 p-3 transition-all cursor-pointer min-w-[120px]
              ${
                isSelected
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'
              }
            `}
          >
            <span className="text-sm font-semibold">{etf.shortName}</span>
            <span className="text-xs text-muted-foreground">{etf.code}</span>
            <span className="text-lg">{getPercentileDot(pePercentile)}</span>
          </button>
        );
      })}
    </div>
  );
}

function CoreIndicatorsPanel({
  selectedCode,
  summaryMap,
  valuationMap,
  premiumMap,
  dividendMap,
  isLoading,
}: {
  selectedCode: string;
  summaryMap: Map<string, MarketDataSummary>;
  valuationMap: Map<string, CachedValuation>;
  premiumMap: Map<string, CachedPremium>;
  dividendMap: Map<string, CachedDividend>;
  isLoading: boolean;
}) {
  const etf = ETF_LIST.find((e) => e.code === selectedCode);
  const summary = summaryMap.get(selectedCode);
  const valuation = valuationMap.get(selectedCode);
  const isOverseas = etf?.category === 'overseas';

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          暂无数据
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          {etf?.name ?? selectedCode} 核心指标
        </CardTitle>
        <CardDescription>
          {isOverseas ? '海外ETF' : '国内ETF'} · 估值数据
          {summary.valuationDate ? ` 更新于 ${summary.valuationDate}` : ''}
          <span className="ml-2 text-muted-foreground/70">· 点击"数据血缘"查看每项指标的原始值/清洗值/质量评分</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isOverseas ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <IndicatorCard
              label="PE"
              value={summary.pe}
              percentile={summary.pePercentile}
              footer={
                <div className="flex items-center justify-center flex-wrap gap-1">
                  <PeSourceBadge peSource={valuation?.peSource} />
                  <TrendLineagePopover etfCode={selectedCode} dataType="valuation" />
                </div>
              }
            />
            <IndicatorCard
              label="PB"
              value={summary.pb}
              percentile={summary.pbPercentile}
              footer={
                <div className="flex items-center justify-center flex-wrap gap-1">
                  <PbSourceBadge pbSource={valuation?.pbSource} />
                  <TrendLineagePopover etfCode={selectedCode} dataType="valuation" />
                </div>
              }
            />
            <PremiumIndicatorCard
              label="今日溢价率"
              value={summary.premiumToday}
              isDot
              footer={
                <TrendLineagePopover etfCode={selectedCode} dataType="premium" />
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <IndicatorCard
              label="PE"
              value={summary.pe}
              percentile={summary.pePercentile}
              footer={
                <div className="flex items-center justify-center flex-wrap gap-1">
                  <PeSourceBadge peSource={valuation?.peSource} />
                  <TrendLineagePopover etfCode={selectedCode} dataType="valuation" />
                </div>
              }
            />
            <IndicatorCard
              label="PB"
              value={summary.pb}
              percentile={summary.pbPercentile}
              footer={
                <div className="flex items-center justify-center flex-wrap gap-1">
                  <PbSourceBadge pbSource={valuation?.pbSource} />
                  <TrendLineagePopover etfCode={selectedCode} dataType="valuation" />
                </div>
              }
            />
            {selectedCode === '510880' && (
              <IndicatorCard
                label="股息率"
                value={summary.dividendYield}
                percentile={
                  dividendMap.get(selectedCode)?.dividendYieldPercentile ?? null
                }
                format="yield"
                footer={
                  <TrendLineagePopover etfCode={selectedCode} dataType="dividend" />
                }
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Candlestick Chart (K-line) ───

interface CandlestickChartData {
  date: string;
  fullDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  isUp: boolean;
  ma20: number | null;
  ma60: number | null;
}

// Volume bar shape component for Recharts
function VolumeBarShape(props: unknown) {
  const { x, y, width, height, payload } = props as {
    x: number; y: number; width: number; height: number; payload: CandlestickChartData;
  };
  const color = payload?.isUp ? '#ef4444' : '#22c55e';
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={color}
      fillOpacity={0.6}
    />
  );
}

// Custom SVG renderer for candlestick bars
function CandlestickRenderer(props: {
  formattedGraphicalItems: Array<{
    props: {
      points: Array<{ x: number; y: number; payload: CandlestickChartData }>;
    };
  }>;
  xAxisMap: Record<string, { scale: (v: number) => number }>;
  yAxisMap: Record<string | number, { scale: (v: number) => number }>;
  offset: { top: number };
}) {
  const { formattedGraphicalItems, yAxisMap } = props;

  // Find the points from the invisible bar
  const barItems = formattedGraphicalItems?.find((item: Record<string, unknown>) => {
    const pts = (item as Record<string, Record<string, Array<Record<string, Record<string, unknown>>>>>)?.props?.points;
    return pts?.[0]?.payload?.close !== undefined;
  });

  if (!barItems?.props?.points?.length) return null;

  // Get the y-axis scale function
  const yAxis = yAxisMap[0] || yAxisMap['0'];
  if (!yAxis?.scale) return null;
  const yScale = yAxis.scale;

  const points = barItems.props.points;
  const barWidth = Math.max(1, (points[1]?.x ?? points[0].x + 6) - points[0].x - 2);

  return (
    <g>
      {points.map((point: { x: number; y: number; payload: CandlestickChartData }, idx: number) => {
        const d = point.payload;
        if (d.open === null || d.close === null || d.high === null || d.low === null) return null;

        const isUp = d.close >= d.open;
        const color = isUp ? '#ef4444' : '#22c55e'; // Red up, Green down (Chinese convention)
        const bodyTop = yScale(Math.max(d.open, d.close));
        const bodyBottom = yScale(Math.min(d.open, d.close));
        const wickTop = yScale(d.high);
        const wickBottom = yScale(d.low);
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);
        const cx = point.x;

        return (
          <g key={idx}>
            {/* Wick (shadow) */}
            <line
              x1={cx}
              y1={wickTop}
              x2={cx}
              y2={wickBottom}
              stroke={color}
              strokeWidth={1}
            />
            {/* Body */}
            <rect
              x={cx - barWidth / 2}
              y={bodyTop}
              width={barWidth}
              height={bodyHeight}
              fill={isUp ? color : color}
              stroke={color}
              strokeWidth={0.5}
              fillOpacity={isUp ? 0.3 : 0.8}
            />
          </g>
        );
      })}
    </g>
  );
}

function KlineChart({
  klineData,
  chartType,
  timeRange,
  onChartTypeChange,
  onTimeRangeChange,
  isLoading,
}: {
  klineData: CachedKline | undefined;
  chartType: string;
  timeRange: number;
  onChartTypeChange: (type: string) => void;
  onTimeRangeChange: (months: number) => void;
  isLoading: boolean;
}) {
  const { chartData, priceDomain, volumeDomain, hasEnoughData } = useMemo(() => {
    if (!klineData?.klineHistory?.length) {
      return { chartData: [], priceDomain: [0, 1] as [number, number], volumeDomain: [0, 1] as [number, number], hasEnoughData: false };
    }

    // Step 1: Filter by time range
    let filtered = filterHistoryByMonths(klineData.klineHistory, timeRange);

    // Step 2: Aggregate if weekly or monthly
    if (chartType === 'weekly') {
      filtered = aggregateKline(filtered, 'weekly');
    } else if (chartType === 'monthly') {
      filtered = aggregateKline(filtered, 'monthly');
    }

    // Step 2b: §10.B4 — Filter out anomalous OHLCV points (sentinel 99999999 / NaN / Inf)
    filtered = filtered.filter(
      (item: KlinePoint) =>
        isValidNumber(item.close) &&
        isValidNumber(item.open) &&
        isValidNumber(item.high) &&
        isValidNumber(item.low)
    );

    // Step 3: Compute moving averages
    const ma20Map = computeKlineMA(filtered, 20);
    const ma60Map = computeKlineMA(filtered, 60);

    // Step 4: Build chart data
    const data: CandlestickChartData[] = filtered.map((item: KlinePoint) => ({
      date: item.date.slice(5), // MM-DD for display
      fullDate: item.date,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: isValidNumber(item.volume) ? item.volume : null,
      isUp: item.close !== null && item.open !== null && item.close >= item.open,
      ma20: ma20Map.get(item.date) ?? null,
      ma60: ma60Map.get(item.date) ?? null,
    }));

    // Step 5: Compute domains
    const allPrices = data
      .filter((d) => d.high !== null && d.low !== null)
      .flatMap((d) => [d.high!, d.low!]);
    const allVolumes = data
      .filter((d) => d.volume !== null)
      .map((d) => d.volume!);

    // Include MA values in price domain
    const ma20Vals = data.map((d) => d.ma20).filter((v): v is number => v !== null && isValidNumber(v));
    const ma60Vals = data.map((d) => d.ma60).filter((v): v is number => v !== null && isValidNumber(v));
    const allVals = [...allPrices, ...ma20Vals, ...ma60Vals].filter(v => isValidNumber(v));

    const priceMin = allVals.length ? Math.min(...allVals) : 0;
    const priceMax = allVals.length ? Math.max(...allVals) : 1;
    const pricePadding = (priceMax - priceMin) * 0.05 || 1;

    const volMax = allVolumes.length ? Math.max(...allVolumes) : 1;

    return {
      chartData: data,
      priceDomain: [priceMin - pricePadding, priceMax + pricePadding] as [number, number],
      volumeDomain: [0, volMax * 1.1] as [number, number],
      hasEnoughData: data.length >= 5,
    };
  }, [klineData, chartType, timeRange]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-80 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="size-4 text-emerald-600" />
            K线走势
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Chart type selector */}
            <Tabs
              value={chartType}
              onValueChange={onChartTypeChange}
            >
              <TabsList className="h-7">
                {CHART_TYPES.map((ct) => (
                  <TabsTrigger key={ct.value} value={ct.value} className="text-xs px-2 h-5">
                    {ct.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {/* Time range selector */}
            <Tabs
              value={String(timeRange)}
              onValueChange={(v) => onTimeRangeChange(Number(v))}
            >
              <TabsList className="h-7">
                {TIME_RANGES.map((tr) => (
                  <TabsTrigger key={tr.months} value={String(tr.months)} className="text-xs px-2 h-5">
                    {tr.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 || !hasEnoughData ? (
          <div className="h-80 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <Info className="size-5" />
            <span>当前历史数据不足，暂不展示此图表。</span>
          </div>
        ) : (
          <div className="space-y-0">
            {/* Candlestick + MA chart */}
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e7eb' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId={0}
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e7eb' }}
                    domain={priceDomain}
                    width={55}
                    tickFormatter={(v: number) => v.toFixed(3)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'rgba(255,255,255,0.96)',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      fontSize: '12px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                    }}
                    labelFormatter={(_label: string, payload: Array<{ payload?: CandlestickChartData }>) => {
                      if (payload?.[0]?.payload?.fullDate) return payload[0].payload.fullDate;
                      return _label;
                    }}
                    formatter={(_value: number, name: string) => {
                      if (name === 'close') return [_value.toFixed(4), '收盘'];
                      if (name === 'ma20') return [_value.toFixed(4), 'MA20'];
                      if (name === 'ma60') return [_value.toFixed(4), 'MA60'];
                      return [_value, name];
                    }}

                  />
                  {/* Invisible bar for positioning + custom candlestick rendering */}
                  <Bar
                    yAxisId={0}
                    dataKey="close"
                    barSize={6}
                    fill="transparent"
                    isAnimationActive={false}
                  />
                  {/* MA20 line */}
                  <Line
                    yAxisId={0}
                    type="monotone"
                    dataKey="ma20"
                    stroke="#f59e0b"
                    strokeWidth={1.2}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  {/* MA60 line */}
                  <Line
                    yAxisId={0}
                    type="monotone"
                    dataKey="ma60"
                    stroke="#06b6d4"
                    strokeWidth={1.2}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  {/* @ts-expect-error Recharts Customized component has incorrect TypeScript types */}
                  <Customized component={CandlestickRenderer} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Volume chart */}
            <div className="h-20">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 0, right: 10, left: 0, bottom: 5 }}
                >
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e7eb' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    tickLine={false}
                    axisLine={false}
                    domain={volumeDomain}
                    width={55}
                    tickFormatter={(v: number) => {
                      if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
                      if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
                      return String(v);
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'rgba(255,255,255,0.96)',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      fontSize: '12px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                    }}
                    labelFormatter={(_label: string, payload: Array<{ payload?: CandlestickChartData }>) => {
                      if (payload?.[0]?.payload?.fullDate) return payload[0].payload.fullDate;
                      return _label;
                    }}
                    formatter={(value: number) => {
                      if (value >= 1e8) return [`${(value / 1e8).toFixed(2)}亿`, '成交量'];
                      if (value >= 1e4) return [`${(value / 1e4).toFixed(0)}万`, '成交量'];
                      return [value, '成交量'];
                    }}
                  />
                  <Bar
                    dataKey="volume"
                    isAnimationActive={false}
                    shape={VolumeBarShape}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Legend */}
            <div className="flex items-center justify-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 bg-amber-500" />
                MA20
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 bg-cyan-500" />
                MA60
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-sm bg-red-500 opacity-60" />
                上涨
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-sm bg-green-500 opacity-60" />
                下跌
              </span>
            </div>
          </div>
        )}
        <DataSourceFooter
          date={klineData?.date}
          source={klineData?.source}
          isNavProxy={klineData?.isNavProxy}
        />
      </CardContent>
    </Card>
  );
}

// ─── Valuation History Chart (PE or PB) ───

function ValuationChart({
  title,
  icon,
  dataKey,
  history,
  currentValue,
  currentPercentile,
  timeRange,
  onTimeRangeChange,
  isLoading,
}: {
  title: string;
  icon: React.ReactNode;
  dataKey: 'pe' | 'pb';
  history: PEHistoryPoint[];
  currentValue: number | null;
  currentPercentile: number | null;
  timeRange: number;
  onTimeRangeChange: (months: number) => void;
  isLoading: boolean;
}) {
  const { chartData, valueMin, valueMax, ma20Map, ma60Map, hasEnoughData } = useMemo(() => {
    if (!history?.length) {
      return { chartData: [], valueMin: 0, valueMax: 1, ma20Map: new Map<string, number | null>(), ma60Map: new Map<string, number | null>(), hasEnoughData: false };
    }

    // §10.B4 — Filter anomalous points (null / NaN / Inf / sentinel ≥999999)
    const cleanHistory = filterValidPoints(history, (p: PEHistoryPoint) => p.value);

    // Filter by time range
    const filtered = filterHistoryByMonths(cleanHistory, timeRange);

    // Compute moving averages
    const m20 = computeMA(filtered, 20);
    const m60 = computeMA(filtered, 60);

    const data = filtered.map((p: PEHistoryPoint) => ({
      date: p.date.slice(5),
      fullDate: p.date,
      value: p.value as number,
      ma20: m20.get(p.date) ?? null,
      ma60: m60.get(p.date) ?? null,
    }));

    const values = data.map((d) => d.value);
    const ma20Vals = data.map((d) => d.ma20).filter((v): v is number => v !== null && isValidNumber(v));
    const ma60Vals = data.map((d) => d.ma60).filter((v): v is number => v !== null && isValidNumber(v));
    const allVals = [...values, ...ma20Vals, ...ma60Vals].filter(v => isValidNumber(v));

    const min = allVals.length ? Math.min(...allVals) : 0;
    const max = allVals.length ? Math.max(...allVals) : 1;
    const padding = (max - min) * 0.1 || 1;

    return {
      chartData: data,
      valueMin: min - padding,
      valueMax: max + padding,
      ma20Map: m20,
      ma60Map: m60,
      hasEnoughData: data.length >= 5,
    };
  }, [history, timeRange]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              {icon}
              {title}
            </CardTitle>
            <CardDescription className="mt-1">
              当前{dataKey.toUpperCase()} {formatValue(currentValue)} · 分位 {formatPercent(currentPercentile)}
            </CardDescription>
          </div>
          <Tabs
            value={String(timeRange)}
            onValueChange={(v) => onTimeRangeChange(Number(v))}
          >
            <TabsList className="h-7">
              {TIME_RANGES.map((tr) => (
                <TabsTrigger key={tr.months} value={String(tr.months)} className="text-xs px-2 h-5">
                  {tr.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 || !hasEnoughData ? (
          <div className="h-64 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <Info className="size-5" />
            <span>当前历史数据不足，暂不展示此图表。</span>
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                {/* Valuation zones */}
                <ReferenceArea
                  y1={valueMin}
                  y2={valueMin + (valueMax - valueMin) * 0.2}
                  fill="#10b981"
                  fillOpacity={0.08}
                />
                <ReferenceArea
                  y1={valueMin + (valueMax - valueMin) * 0.2}
                  y2={valueMin + (valueMax - valueMin) * 0.8}
                  fill="#f59e0b"
                  fillOpacity={0.06}
                />
                <ReferenceArea
                  y1={valueMin + (valueMax - valueMin) * 0.8}
                  y2={valueMax}
                  fill="#ef4444"
                  fillOpacity={0.08}
                />
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  domain={[valueMin, valueMax]}
                  width={55}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(255,255,255,0.96)',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  }}
                  labelFormatter={(_label: string, payload: Array<{ payload?: { fullDate?: string } }>) => {
                    if (payload?.[0]?.payload?.fullDate) return payload[0].payload.fullDate;
                    return _label;
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === 'value') return [value.toFixed(2), dataKey.toUpperCase()];
                    if (name === 'ma20') return [value.toFixed(2), 'MA20'];
                    if (name === 'ma60') return [value.toFixed(2), 'MA60'];
                    return [value, name];
                  }}
                />
                {/* Main value line */}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#14b8a6"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, fill: '#14b8a6', stroke: '#fff', strokeWidth: 2 }}
                />
                {/* MA20 */}
                <Line
                  type="monotone"
                  dataKey="ma20"
                  stroke="#f59e0b"
                  strokeWidth={1}
                  dot={false}
                  activeDot={false}
                  connectNulls={false}
                  strokeDasharray="4 2"
                />
                {/* MA60 */}
                <Line
                  type="monotone"
                  dataKey="ma60"
                  stroke="#06b6d4"
                  strokeWidth={1}
                  dot={false}
                  activeDot={false}
                  connectNulls={false}
                  strokeDasharray="4 2"
                />
                {/* Current value marker */}
                {currentValue !== null && currentValue !== undefined && chartData.length > 0 && (
                  <ReferenceDot
                    x={chartData[chartData.length - 1]?.date}
                    y={currentValue}
                    r={5}
                    fill="#14b8a6"
                    stroke="#fff"
                    strokeWidth={2}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {/* Zone + MA legend */}
        <div className="flex items-center justify-center gap-3 mt-3 text-xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500/20 border border-emerald-500/30" />
            低估 (&lt;20%)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-500/20 border border-amber-500/30" />
            正常 (20%-80%)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500/20 border border-red-500/30" />
            高估 (&gt;80%)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-amber-500" style={{ borderTop: '1px dashed #f59e0b' }} />
            MA20
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-cyan-500" style={{ borderTop: '1px dashed #06b6d4' }} />
            MA60
          </span>
        </div>
        <DataSourceFooter date={history?.[0]?.date} />
      </CardContent>
    </Card>
  );
}

// ─── Premium Trend Chart ───

function PremiumTrendChart({
  premiumData,
  isLoading,
}: {
  premiumData: CachedPremium | undefined;
  isLoading: boolean;
}) {
  const { chartData, hasEnoughData } = useMemo(() => {
    if (!premiumData?.premium30d?.length) return { chartData: [], hasEnoughData: false };
    // §10.B4 — filter anomalous premium points
    const valid = filterValidPoints(premiumData.premium30d, (p: PremiumHistoryPoint) => p.premium);
    return {
      chartData: valid.map((p: PremiumHistoryPoint) => ({
        date: p.date.slice(5),
        fullDate: p.date,
        premium: p.premium as number,
      })),
      hasEnoughData: valid.length >= 5,
    };
  }, [premiumData]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-600" />
          溢价率30日趋势
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 || !hasEnoughData ? (
          <div className="h-48 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <Info className="size-5" />
            <span>当前历史数据不足，暂不展示此图表。</span>
          </div>
        ) : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="premiumGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  width={55}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(255,255,255,0.96)',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  }}
                  labelFormatter={(_label: string, payload: Array<{ payload?: { fullDate?: string } }>) => {
                    if (payload?.[0]?.payload?.fullDate) return payload[0].payload.fullDate;
                    return _label;
                  }}
                  formatter={(value: number) => [`${value.toFixed(2)}%`, '溢价率']}
                />
                <ReferenceLine y={2} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
                <ReferenceLine y={3} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.6} />
                <Bar
                  dataKey="premium"
                  fill="#f59e0b"
                  fillOpacity={0.4}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <DataSourceFooter date={premiumData?.date} />
      </CardContent>
    </Card>
  );
}

// ─── Market Index Panel (broad market indices for macro context) ───

function MarketIndexCard({ data }: { data: MarketIndexData }) {
  const isUp = (data.dailyChange ?? 0) >= 0;
  const changeColor = isUp ? 'text-red-600' : 'text-emerald-600';
  const bgColor = isUp ? 'bg-red-50' : 'bg-emerald-50';

  // Mini sparkline data (last 30 points)
  const sparklineData = data.priceHistory.slice(-30).map((p) => ({
    date: p.date,
    value: p.value,
  }));

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="text-xs text-muted-foreground">{data.category}</div>
            <div className="text-sm font-medium">{data.name}</div>
          </div>
          {data.dailyChangePercent !== null && (
            <div className={`text-xs font-mono px-1.5 py-0.5 rounded ${bgColor} ${changeColor}`}>
              {isUp ? '▲' : '▼'} {Math.abs(data.dailyChangePercent).toFixed(2)}%
            </div>
          )}
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-lg font-mono font-semibold">
            {data.currentValue !== null ? data.currentValue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
          </span>
          {data.dailyChange !== null && (
            <span className={`text-xs font-mono ${changeColor}`}>
              {isUp ? '+' : ''}{data.dailyChange.toFixed(2)}
            </span>
          )}
        </div>
        {/* Mini sparkline */}
        {sparklineData.length > 1 && (
          <div className="h-[40px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparklineData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={isUp ? '#ef4444' : '#10b981'}
                  strokeWidth={1.5}
                  dot={false}
                />
                <YAxis hide domain={['dataMin', 'dataMax']} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {/* MA indicators */}
        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
          {data.ma20 !== null && (
            <span>MA20: <span className="font-mono">{data.ma20.toFixed(2)}</span></span>
          )}
          {data.ma60 !== null && (
            <span>MA60: <span className="font-mono">{data.ma60.toFixed(2)}</span></span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── V4 多周期估值面板（PRD§8.2，策略书§3） ───
// 展示 1y/3y/5y/10y/all 分位 + 样本天数 + 数据源 + 是否参与强规则
function MultiPeriodValuationPanel({
  selectedCode,
  valuationMap,
  summaryMap,
  isLoading,
  fieldConfigs,
}: {
  selectedCode: string;
  valuationMap: Map<string, CachedValuation>;
  summaryMap: Map<string, MarketDataSummary>;
  isLoading: boolean;
  fieldConfigs?: FieldSourceConfig[];
}) {
  const etf = ETF_LIST.find((e) => e.code === selectedCode);
  const valuation = valuationMap.get(selectedCode);
  const summary = summaryMap.get(selectedCode);
  const isOverseas = etf?.category === 'overseas';

  // 从 field_config 取估值字段的 主源/备源（V4.1 S4-T7）
  const valuationFieldConfig = fieldConfigs?.find((f) => f.field === 'valuation');
  const primarySources = valuationFieldConfig?.primary_sources ?? [];
  const backupSources = valuationFieldConfig?.backup_sources ?? [];
  const forcedSource = valuationFieldConfig?.forced_source ?? null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader><Skeleton className="h-6 w-48" /></CardHeader>
        <CardContent><Skeleton className="h-28 rounded-lg" /></CardContent>
      </Card>
    );
  }

  if (!valuation) {
    return null;
  }

  // PRD§8.2 展示规则：近1年只参考、近5年买入侧、近10年再平衡侧、样本不足标记
  const periods: Array<{ key: keyof CachedValuation; label: string; role: string; strong: boolean }> = [
    { key: 'pePercentile1y', label: '近1年', role: '情绪参考', strong: false },
    { key: 'pePercentile3y', label: '近3年', role: '辅助', strong: false },
    { key: 'pePercentile5y', label: '近5年', role: '买入侧主判', strong: true },
    { key: 'pePercentile10y', label: '近10年', role: '再平衡侧主判', strong: true },
    { key: 'pePercentileAll', label: '全历史', role: '再平衡备选', strong: false },
  ];

  const sampleDays = valuation.sampleDays ?? 0;
  const isSampleEnough = sampleDays >= 1000;
  const isSampleInsufficient = sampleDays > 0 && sampleDays < 500;
  const participatesStrongRule = isSampleEnough && (isOverseas ? summary?.premiumToday != null : valuation.pePercentile != null);

  // 分位颜色
  const getPercentileColor = (p: number | null | undefined) => {
    if (p === null || p === undefined) return 'text-muted-foreground/40';
    if (p > 80) return 'text-red-600';
    if (p > 60) return 'text-amber-600';
    if (p < 20) return 'text-emerald-600';
    return 'text-sky-600';
  };
  const getPercentileBg = (p: number | null | undefined) => {
    if (p === null || p === undefined) return 'bg-muted/40 border-muted';
    if (p > 80) return 'bg-red-50 border-red-300';
    if (p > 60) return 'bg-amber-50 border-amber-300';
    if (p < 20) return 'bg-emerald-50 border-emerald-300';
    return 'bg-sky-50 border-sky-300';
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="size-4 text-violet-600" />
          {etf?.name ?? selectedCode} 多周期估值分位
        </CardTitle>
        <CardDescription className="text-xs">
          策略书§3：买入侧用5年、再平衡侧用10年、近1年只做情绪参考
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* PE 多周期分位 */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span className="text-foreground/80">PE 分位</span>
            <span className="text-[10px] text-muted-foreground/60">（当前 PE: {valuation.pe?.toFixed(1) ?? '—'}）</span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {periods.map((p) => {
              const v = valuation[p.key] as number | null | undefined;
              return (
                <div
                  key={p.key}
                  className={`rounded-md border px-1.5 py-1.5 text-center ${getPercentileBg(v)} ${p.strong ? 'ring-1 ring-offset-1' : ''} ${
                    p.key === 'pePercentile5y' ? 'ring-emerald-400' : p.key === 'pePercentile10y' ? 'ring-orange-400' : ''
                  }`}
                  title={`${p.label} · ${p.role}`}
                >
                  <div className="text-[9px] text-muted-foreground/80">{p.label}</div>
                  <div className={`font-mono text-sm font-bold ${getPercentileColor(v)}`}>
                    {v !== null && v !== undefined ? `${v.toFixed(1)}%` : '—'}
                  </div>
                  <div className="text-[8px] text-muted-foreground/60 truncate">{p.role}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* PB 多周期分位 */}
        {(valuation.pbPercentile1y !== undefined || valuation.pbPercentile5y !== undefined) && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <span className="text-foreground/80">PB 分位</span>
              <span className="text-[10px] text-muted-foreground/60">（当前 PB: {valuation.pb?.toFixed(2) ?? '—'}）</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {periods.map((p) => {
                const pbKey = ('pb' + p.key.slice(2)) as keyof CachedValuation;
                const v = valuation[pbKey] as number | null | undefined;
                return (
                  <div
                    key={pbKey}
                    className={`rounded-md border px-1.5 py-1 text-center ${getPercentileBg(v)}`}
                    title={`${p.label} PB · ${p.role}`}
                  >
                    <div className="text-[9px] text-muted-foreground/80">{p.label}</div>
                    <div className={`font-mono text-xs font-bold ${getPercentileColor(v)}`}>
                      {v !== null && v !== undefined ? `${v.toFixed(1)}%` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PRD§8.2 元信息行：样本天数 + 数据源 + 是否参与强规则 */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${
            isSampleEnough ? 'text-emerald-700 border-emerald-300 bg-emerald-50' :
            isSampleInsufficient ? 'text-orange-700 border-orange-300 bg-orange-50' :
            'text-amber-700 border-amber-300 bg-amber-50'
          }`}>
            样本 {sampleDays} 天 {isSampleEnough ? '✓充足' : sampleDays > 0 ? '·不足' : '·缺失'}
          </Badge>
          {/* V4.1 S4-T7: 字段级主备源双标签（从 field_config 读） */}
          {forcedSource ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 text-amber-700 border-amber-300 bg-amber-50"
              title={`强制源: ${forcedSource}（已覆盖默认主备源）`}
            >
              强制源: {forcedSource}
            </Badge>
          ) : (
            <>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 text-emerald-700 border-emerald-300 bg-emerald-50"
                title={`主源: ${primarySources.join(', ') || '—'}`}
              >
                主源: {primarySources[0] ?? valuation.source ?? 'akshare'}
                {primarySources.length > 1 && ` +${primarySources.length - 1}`}
              </Badge>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 text-slate-700 border-slate-300 bg-slate-50 dark:text-slate-400 dark:border-slate-700 dark:bg-slate-900/30"
                title={`备源: ${backupSources.join(', ') || '—'}`}
              >
                备源: {backupSources[0] ?? '—'}
                {backupSources.length > 1 && ` +${backupSources.length - 1}`}
              </Badge>
            </>
          )}
          {/* V4 策略书§10.2: 估值口径展示 */}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sky-700 border-sky-300 bg-sky-50">
            口径: {isOverseas ? 'PE估值+溢价率' : etf?.code === '510880' ? '股息率分位' : 'PE TTM+PB'}
          </Badge>
          {valuation.date && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground font-mono">
              更新 {valuation.date}
            </Badge>
          )}
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${
            participatesStrongRule ? 'text-emerald-700 border-emerald-300' : 'text-muted-foreground'
          }`}>
            {participatesStrongRule ? '✓ 参与强规则' : '✗ 不参与强规则'}
          </Badge>
        </div>

        {/* 样本不足提示（策略书§3.2） */}
        {isSampleInsufficient && (
          <div className="text-[10px] text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-1">
            ⚠ 样本不足（{sampleDays}天 &lt; 500天），标记"样本不足，仅供参考"，不触发强买卖规则（策略书§3.2）
          </div>
        )}
        {sampleDays === 0 && (
          <div className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
            ⚠ 数据缺失，不参与规则计算，需人工确认
          </div>
        )}

        {/* V4 策略书§3.3: A500代理指数展示 */}
        {selectedCode === '159338' && !isSampleEnough && (() => {
          const proxy = valuationMap.get('510330');
          if (!proxy) return null;
          return (
            <div className="rounded-md border border-violet-200 bg-violet-50/40 p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-violet-800">
                <Info className="h-3 w-3" />
                <span>代理指数参考（策略书§3.3：A500样本不足时用沪深300辅助）</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-medium">沪深300ETF(510330)</span>
                <span className="text-muted-foreground">PE: <span className="font-mono font-bold text-foreground">{proxy.pe?.toFixed(1) ?? '—'}</span></span>
                <span className="text-muted-foreground">5年分位: <span className={`font-mono font-bold ${getPercentileColor(proxy.pePercentile5y ?? proxy.pePercentile)}`}>{(proxy.pePercentile5y ?? proxy.pePercentile)?.toFixed(1) ?? '—'}%</span></span>
                <span className="text-muted-foreground">10年分位: <span className={`font-mono font-bold ${getPercentileColor(proxy.pePercentile10y ?? proxy.pePercentile)}`}>{(proxy.pePercentile10y ?? proxy.pePercentile)?.toFixed(1) ?? '—'}%</span></span>
                <span className="text-[9px] text-violet-700/60 italic">仅作估值参考，不直接触发A500强规则</span>
              </div>
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}


// ─── V4.2 PRD§11: 极简宏观温度计面板 ───
// 4个日频指标(中债/美债/USD-CNH/VIX), 只提示不改金额

// V4.2 P4-B: 格式化宏观指标当前值的小数位
// V5.1: 债券/汇率4位, VIX/VVIX/SKEW/QVIX 2位
function formatMacroValue(val: number, metricType: string): string {
  // 恐慌/情绪类指数保留2位小数
  const fearTypes = new Set(['vix', 'vvix', 'skew', 'qvix_50etf', 'qvix_300etf']);
  if (fearTypes.has(metricType)) {
    return val.toFixed(2);
  }
  // 债券收益率和汇率保留4位小数
  return val.toFixed(4);
}

// V5.1: 恐慌级别判断函数
// 仅对 VIX/VVIX/SKEW/QVIX 有效, 其他返回默认
function getFearLevel(metricType: string, value: number | null): { label: string; color: string } {
  if (value === null) return { label: '—', color: 'text-muted-foreground' };
  switch (metricType) {
    case 'vix':
      if (value < 15) return { label: '平静', color: 'text-emerald-600 dark:text-emerald-400' };
      if (value < 20) return { label: '正常', color: 'text-muted-foreground' };
      if (value < 30) return { label: '恐慌升温', color: 'text-amber-600 dark:text-amber-400' };
      if (value < 40) return { label: '明显恐慌', color: 'text-orange-600 dark:text-orange-400' };
      return { label: '极端恐慌', color: 'text-red-600 dark:text-red-400' };
    case 'vvix':
      if (value < 80) return { label: '正常', color: 'text-muted-foreground' };
      if (value < 100) return { label: '升温', color: 'text-amber-600 dark:text-amber-400' };
      return { label: '加速', color: 'text-red-600 dark:text-red-400' };
    case 'skew':
      if (value < 130) return { label: '正常', color: 'text-muted-foreground' };
      if (value < 150) return { label: '关注', color: 'text-amber-600 dark:text-amber-400' };
      return { label: '黑天鹅风险', color: 'text-red-600 dark:text-red-400' };
    case 'qvix_50etf':
    case 'qvix_300etf':
      if (value < 15) return { label: '平静', color: 'text-emerald-600 dark:text-emerald-400' };
      if (value < 25) return { label: '正常', color: 'text-muted-foreground' };
      if (value < 30) return { label: '升温', color: 'text-amber-600 dark:text-amber-400' };
      return { label: '恐慌', color: 'text-red-600 dark:text-red-400' };
    default:
      return { label: '—', color: 'text-muted-foreground' };
  }
}

function formatMacroChange(val: number | null, metricType: string): string {
  if (val === null) return '—';
  // 债券收益率用 bp, 汇率/VIX 用 %
  if (metricType.includes('bond') || metricType.includes('treasury')) {
    return `${val > 0 ? '+' : ''}${(val * 100).toFixed(1)}bp`;
  }
  return `${val > 0 ? '+' : ''}${val.toFixed(4)}`;
}

function formatMacroChangeColor(val: number | null): string {
  if (val === null) return 'text-muted-foreground';
  // 这些指标上行=不利=红色, 下行=有利=绿色
  if (val > 0) return 'text-red-600 dark:text-red-400';
  if (val < 0) return 'text-emerald-600 dark:text-emerald-400';
  return 'text-muted-foreground';
}

function MacroQualityBadge({ status }: { status: string }) {
  // 后端可能返回: excellent / usable / suspicious / unavailable / null
  const map: Record<string, { label: string; cls: string }> = {
    excellent: { label: '正常', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
    usable: { label: '正常', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
    suspicious: { label: '提示', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
    unavailable: { label: '不可用', cls: 'bg-muted text-muted-foreground' },
  };
  const info = map[status] ?? { label: '不可用', cls: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${info.cls}`}>
      {info.label}
    </span>
  );
}

function MacroThermometerPanel() {
  const macroTempQuery = useQuery({
    queryKey: ['macro-temperature'],
    queryFn: getMacroTemperature,
    staleTime: 5 * 60 * 1000,
  });

  const macroPromptsQuery = useQuery({
    queryKey: ['macro-prompts'],
    queryFn: getMacroPrompts,
    staleTime: 5 * 60 * 1000,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await refreshMacro();
      // V4.2 P4: 刷新成功后显示提示 + 重新拉取温度计和提示数据
      const successCount = Object.values(result.results || {}).filter(v => v !== null).length;
      const totalCount = Object.keys(result.results || {}).length;
      toast.success(`宏观刷新完成: ${successCount}/${totalCount} 个指标成功`);
      macroTempQuery.refetch();
      macroPromptsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '宏观刷新失败');
    } finally {
      setIsRefreshing(false);
    }
  }, [macroTempQuery, macroPromptsQuery]);

  const items: MacroMetricItem[] = macroTempQuery.data?.items ?? [];
  const prompts: MacroPrompt[] = macroPromptsQuery.data?.prompts ?? [];
  const hasAlert = macroPromptsQuery.data?.has_alert ?? false;

  // V5.1: 按分类分组 (3类: macro_rate / us_fear / cn_sentiment)
  // 后端可能未返回 category 字段时, 按 metric_type 兜底归类
  const fearMetricTypes = new Set(['vix', 'vvix', 'skew', 'qvix_50etf', 'qvix_300etf']);
  const getItemCategory = useCallback((it: MacroMetricItem): string => {
    if (it.category) return it.category;
    if (fearMetricTypes.has(it.metric_type)) {
      return it.metric_type.startsWith('qvix') ? 'cn_sentiment' : 'us_fear';
    }
    return 'macro_rate';
  }, []);

  // 分类配置: 图标/说明文字/状态列展示方式
  const categoryConfigs: Record<string, {
    label: string;
    icon?: React.ReactNode;
    iconColor?: string;
    description?: string;
    useFearLevel: boolean;
  }> = {
    macro_rate: {
      label: '利率与汇率',
      description: '中债/美债收益率与离岸人民币汇率, 反映宏观流动性环境。',
      useFearLevel: false,
    },
    us_fear: {
      label: '美股恐慌指数',
      icon: <AlertTriangle className="size-3.5" />,
      iconColor: 'text-red-600 dark:text-red-400',
      description: 'VIX=普通恐慌, VVIX=恐慌加速度, SKEW=黑天鹅担忧。恐慌指数只辅助加仓,不覆盖规则引擎。',
      useFearLevel: true,
    },
    cn_sentiment: {
      label: 'A股情绪指标',
      icon: <Activity className="size-3.5" />,
      iconColor: 'text-orange-600 dark:text-orange-400',
      description: 'QVIX=A股期权隐含波动率(中国版VIX)。高=恐慌,低=平静。',
      useFearLevel: true,
    },
  };

  const categoryOrder: string[] = ['macro_rate', 'us_fear', 'cn_sentiment'];
  // 兜底分类列表 (后端未返回时使用)
  const categories =
    macroTempQuery.data?.categories && macroTempQuery.data.categories.length > 0
      ? macroTempQuery.data.categories
      : categoryOrder.map((key) => ({ key, label: categoryConfigs[key]?.label ?? key }));

  // 按 category 分组
  const itemsByCategory: Record<string, MacroMetricItem[]> = {};
  for (const cat of categoryOrder) itemsByCategory[cat] = [];
  for (const it of items) {
    const cat = getItemCategory(it);
    if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
    itemsByCategory[cat].push(it);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
              <Thermometer className="size-4 text-primary" />
              宏观温度计
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              V5.1 · 8指标分3类 · 利率汇率/美股恐慌/A股情绪 · 只提示不改金额
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="h-7 text-xs"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? '刷新中' : '刷新宏观'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* 宏观提示 Alert (仅异常时) */}
        {hasAlert && prompts.length > 0 && (
          <Alert className="mb-3 border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <AlertCircle className="size-4 text-amber-600" />
            <AlertTitle className="text-sm text-amber-800 dark:text-amber-300">宏观提示</AlertTitle>
            <AlertDescription>
              {prompts.map((p, i) => (
                <div key={`${p.prompt_id}-${i}`} className="text-xs mt-1 text-amber-800 dark:text-amber-300">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] mr-1 ${
                      p.severity === 'strong'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    }`}
                  >
                    {p.severity === 'strong' ? '强提示' : '提示'}
                  </span>
                  {p.prompt_text}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        )}

        {/* V5.1: 按分类分块展示 */}
        {items.length === 0 ? (
          <div className="text-center py-6 text-xs text-muted-foreground">
            暂无宏观指标数据,点击右上角"刷新宏观"获取
          </div>
        ) : (
          <div className="space-y-4">
            {categories.map((cat) => {
              const cfg = categoryConfigs[cat.key];
              const catItems = itemsByCategory[cat.key] ?? [];
              if (catItems.length === 0) return null;
              return (
                <section key={cat.key} className="space-y-1.5">
                  {/* 分类标题 */}
                  <div className="flex items-center gap-1.5">
                    {cfg?.icon && (
                      <span className={cfg.iconColor}>{cfg.icon}</span>
                    )}
                    <h4 className="text-xs font-semibold">{cat.label ?? cfg?.label ?? cat.key}</h4>
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                      {catItems.length}
                    </Badge>
                  </div>
                  {/* 分类说明 */}
                  {cfg?.description && (
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {cfg.description}
                    </p>
                  )}
                  {/* 紧凑表格 */}
                  <div className="overflow-x-auto max-h-60 overflow-y-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b">
                          <th className="text-left py-1.5 px-2 font-medium">指标</th>
                          <th className="text-right py-1.5 px-2 font-medium">当前值</th>
                          <th className="text-right py-1.5 px-2 font-medium">周变化</th>
                          <th className="text-right py-1.5 px-2 font-medium">月变化</th>
                          <th className="text-center py-1.5 px-2 font-medium">状态</th>
                          <th className="text-right py-1.5 px-2 font-medium">更新</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catItems.map((it) => {
                          const fear = cfg?.useFearLevel
                            ? getFearLevel(it.metric_type, it.current_value)
                            : null;
                          return (
                            <tr key={it.metric_type} className="border-b last:border-0">
                              <td className="py-1.5 px-2">
                                <div className="font-medium">{it.name}</div>
                                <div className="text-[10px] text-muted-foreground">{it.affects}</div>
                              </td>
                              <td className="text-right py-1.5 px-2 font-mono">
                                {it.current_value !== null
                                  ? `${formatMacroValue(it.current_value, it.metric_type)}${it.unit}`
                                  : '—'}
                              </td>
                              <td className={`text-right py-1.5 px-2 font-mono ${formatMacroChangeColor(it.weekly_change)}`}>
                                {formatMacroChange(it.weekly_change, it.metric_type)}
                              </td>
                              <td className={`text-right py-1.5 px-2 font-mono ${formatMacroChangeColor(it.monthly_change)}`}>
                                {formatMacroChange(it.monthly_change, it.metric_type)}
                              </td>
                              <td className="text-center py-1.5 px-2 whitespace-nowrap">
                                {fear ? (
                                  <span className={`text-[11px] font-medium ${fear.color}`}>
                                    {fear.label}
                                  </span>
                                ) : (
                                  <MacroQualityBadge status={it.quality_status} />
                                )}
                              </td>
                              <td className="text-right py-1.5 px-2 text-muted-foreground whitespace-nowrap">
                                {it.trade_date || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {!hasAlert && items.length > 0 && (
          <p className="text-xs text-muted-foreground mt-3">
            宏观温度计：本周无明显宏观异常。
          </p>
        )}
      </CardContent>
    </Card>
  );
}


// ─── 宏观监控面板（大盘指数 + 汇率合并） ───
function MacroMonitorPanel({ indices, isLoading }: { indices: MarketIndexData[]; isLoading: boolean }) {
  const { data: forex, isLoading: forexLoading } = useForex();

  // 指数分组
  const aShareIndices = indices.filter(i => i.category === 'A股' || i.category === 'a_share');
  const hkIndex = indices.find(i => i.category === '港股' || i.category === 'hk');
  const usIndex = indices.find(i => i.category === '美股' || i.category === 'us');

  const formatChange = (val: number | null | undefined, pct: number | null | undefined) => {
    if (val === null || val === undefined) return '—';
    const sign = val >= 0 ? '↑' : '↓';
    const color = val >= 0 ? 'text-red-600' : 'text-emerald-600';
    return (
      <span className={`font-mono font-bold ${color}`}>
        {sign}{Math.abs(val).toFixed(2)}
        {pct !== null && pct !== undefined && (
          <span className="text-[10px] ml-0.5">({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
        )}
      </span>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Globe className="size-4 text-primary" />
          宏观监控
        </CardTitle>
        <CardDescription className="text-xs">
          大盘指数 · 汇率 · 宏观环境参考（辅助定投决策）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 大盘指数行 — 紧凑卡片网格 */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-md" />)
          ) : (
            <>
              {aShareIndices.map((idx) => (
                <div key={idx.code} className="rounded-lg border bg-card/50 p-2 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground truncate">{idx.name}</span>
                    <span className="text-[9px] px-1 rounded bg-muted/50 text-muted-foreground">{idx.category}</span>
                  </div>
                  <div className="font-mono text-sm font-bold">
                    {idx.currentValue?.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) ?? '—'}
                  </div>
                  <div className="text-[11px]">
                    {formatChange(idx.dailyChange, idx.dailyChangePercent)}
                  </div>
                  {(idx.ma20 || idx.ma60) && (
                    <div className="text-[9px] text-muted-foreground/70 font-mono">
                      MA20:{idx.ma20?.toFixed(0) ?? '—'} MA60:{idx.ma60?.toFixed(0) ?? '—'}
                    </div>
                  )}
                </div>
              ))}
              {hkIndex && (
                <div className="rounded-lg border bg-card/50 p-2 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground truncate">{hkIndex.name}</span>
                    <span className="text-[9px] px-1 rounded bg-muted/50 text-muted-foreground">港股</span>
                  </div>
                  <div className="font-mono text-sm font-bold">
                    {hkIndex.currentValue?.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) ?? '—'}
                  </div>
                  <div className="text-[11px]">
                    {formatChange(hkIndex.dailyChange, hkIndex.dailyChangePercent)}
                  </div>
                </div>
              )}
              {/* 汇率卡片 — 融入指数网格 */}
              {forex && forex.rate && (
                <div className="rounded-lg border border-emerald-200/50 bg-emerald-50/30 p-2 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">USD/CNY</span>
                    <DollarSign className="size-3 text-emerald-500" />
                  </div>
                  <div className="font-mono text-sm font-bold text-foreground">
                    {forex.rate.toFixed(4)}
                  </div>
                  {(() => {
                    const prev = forex.history?.[0]?.value ?? forex.rate;
                    const changePct = prev > 0 ? ((forex.rate - prev) / prev) * 100 : 0;
                    const usdUp = changePct > 0;
                    return (
                      <div className={`text-[11px] font-mono ${usdUp ? 'text-red-600' : 'text-emerald-600'}`}>
                        {usdUp ? '↑' : '↓'} {Math.abs(changePct).toFixed(2)}%
                        <span className="text-[9px] text-muted-foreground ml-0.5">{usdUp ? '人民币贬值' : '升值'}</span>
                      </div>
                    );
                  })()}
                </div>
              )}
              {forexLoading && !forex && (
                <Skeleton className="h-20 rounded-lg" />
              )}
            </>
          )}
        </div>

        {/* 汇率影响提示 — 紧凑单行 */}
        {forex && forex.rate && (
          <div className="text-[10px] text-muted-foreground border-t pt-2">
            <span className="font-medium">汇率影响：</span>
            {(() => {
              const prev = forex.history?.[0]?.value ?? forex.rate;
              const changePct = prev > 0 ? ((forex.rate - prev) / prev) * 100 : 0;
              return changePct > 0
                ? <span className="text-red-600">美元升值增厚QDII收益，但新增买入成本上升</span>
                : <span className="text-emerald-600">美元贬值侵蚀QDII收益，但新增买入成本下降</span>;
            })()}
            <span className="text-muted-foreground/60 ml-2">数据源: {forex.source ?? 'akshare'}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// ─── 汇率监控面板（文档范围外增强） ───
function useForex() {
  return useQuery({
    queryKey: ['forex'],
    queryFn: async () => {
      const res = await fetch('/api/data?type=forex');
      if (!res.ok) throw new Error('Failed to fetch forex');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}


function MarketIndexPanel({
  indices,
  isLoading,
}: {
  indices: MarketIndexData[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            大盘指数监控
          </CardTitle>
          <CardDescription className="text-xs">
            宏观市场环境参考 · 辅助定投决策
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[120px] rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!indices || indices.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          大盘指数监控
        </CardTitle>
        <CardDescription className="text-xs">
          宏观市场环境参考 · 辅助定投决策（上证指数=A股大盘温度，创业板指=成长风格，沪深300=蓝筹基准，恒生指数=海外配置参考）
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {indices.map((idx) => (
            <MarketIndexCard key={idx.code} data={idx} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Rule Impact Panel (§10.B1) ───
// Renders a colored box that interprets the currently selected ETF's indicators
// against the enabled rules.

function RuleImpactPanel({
  etf,
  summary,
  rules,
}: {
  etf: { code: string; name: string; category: string };
  summary: MarketDataSummary | undefined;
  rules: RuleConfig[];
}) {
  const impact = useMemo(
    () => computeRuleImpact(etf, summary, rules),
    [etf, summary, rules]
  );

  return (
    <Card className={`border ${ruleLevelToBg(impact.level)}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" />
            规则影响说明
          </CardTitle>
          {ruleLevelToBadge(impact.level)}
        </div>
        <CardDescription className="text-xs">
          依据当前启用的规则引擎实时计算 · {etf.name} ({etf.code})
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className={`text-sm leading-relaxed ${ruleLevelToTextColor(impact.level)}`}>
          {impact.text}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── V5.0 Sprint3 E6: 技术分析面板 ───
// MACD(12/26/9) + 20/40周均线 → 互斥7态分类 → 执行模式系数
// 技术状态7态: strong/conflict/very_weak/improving/weak/neutral/unavailable
// 执行模式4种: immediate(立即) / staged(分批) / wait_pullback(等待回调) / base_only(仅基础仓)

const TECHNICAL_STATE_META: Record<
  string,
  { label: string; color: string; bg: string; dot: string }
> = {
  strong: {
    label: '强势',
    color: 'text-emerald-700 dark:text-emerald-400',
    bg: 'bg-emerald-100/70 dark:bg-emerald-900/40 border-emerald-300 dark:border-emerald-700',
    dot: 'bg-emerald-500',
  },
  conflict: {
    label: '冲突',
    color: 'text-amber-700 dark:text-amber-400',
    bg: 'bg-amber-100/70 dark:bg-amber-900/40 border-amber-300 dark:border-amber-700',
    dot: 'bg-amber-500',
  },
  very_weak: {
    label: '极弱',
    color: 'text-red-700 dark:text-red-400',
    bg: 'bg-red-100/70 dark:bg-red-900/40 border-red-300 dark:border-red-700',
    dot: 'bg-red-500',
  },
  improving: {
    label: '改善中',
    color: 'text-sky-700 dark:text-sky-400',
    bg: 'bg-sky-100/70 dark:bg-sky-900/40 border-sky-300 dark:border-sky-700',
    dot: 'bg-sky-500',
  },
  weak: {
    label: '弱势',
    color: 'text-orange-700 dark:text-orange-400',
    bg: 'bg-orange-100/70 dark:bg-orange-900/40 border-orange-300 dark:border-orange-700',
    dot: 'bg-orange-500',
  },
  neutral: {
    label: '中性',
    color: 'text-muted-foreground',
    bg: 'bg-muted/60 border-border',
    dot: 'bg-muted-foreground',
  },
  unavailable: {
    label: '数据不足',
    color: 'text-muted-foreground',
    bg: 'bg-muted/60 border-border',
    dot: 'bg-muted-foreground/60',
  },
};

const EXECUTION_MODE_META: Record<
  string,
  { label: string; hint: string; color: string }
> = {
  immediate: { label: '立即执行', hint: '技术面强势或中性, 一次到位', color: 'text-emerald-700 dark:text-emerald-400' },
  staged: { label: '分批执行', hint: '冲突或改善中, 分批降低择时风险', color: 'text-amber-700 dark:text-amber-400' },
  wait_pullback: { label: '等待回调', hint: '极弱, 暂缓增强仓等待反转', color: 'text-red-700 dark:text-red-400' },
  base_only: { label: '仅基础仓', hint: '弱势, 关闭增强仓只保留基础定投', color: 'text-orange-700 dark:text-orange-400' },
};

const WEEKLY_STATE_META: Record<string, string> = {
  above_ma20_above_ma40: '周线确认 (价在MA20/MA40上方)',
  above_ma20_below_ma40: '周线待确认 (在MA20上方但跌破MA40)',
  below_ma20_above_ma40: '周线走弱 (跌破MA20但守MA40)',
  below_ma20_below_ma40: '周线弱势 (跌破MA20/MA40)',
  insufficient_data: '周线数据不足',
};

const DAILY_STATE_META: Record<string, string> = {
  macd_golden_cross: 'MACD金叉 (日线反转向上)',
  macd_death_cross: 'MACD死叉 (日线反转向下)',
  macd_above_zero: 'MACD在零轴上方 (多头)',
  macd_below_zero: 'MACD在零轴下方 (空头)',
  insufficient: '日线数据不足',
};

function TechnicalAnalysisPanel({
  etf,
}: {
  etf: { code: string; name: string; category: string };
}) {
  const { data, isLoading, isError } = useQuery<TechnicalClassification>({
    queryKey: ['technical', 'classify', etf.code],
    queryFn: () => getTechnicalClass(etf.code),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const stateMeta = data
    ? TECHNICAL_STATE_META[data.state] ?? TECHNICAL_STATE_META.unavailable
    : TECHNICAL_STATE_META.unavailable;
  const modeMeta = data
    ? EXECUTION_MODE_META[data.execution_mode] ?? EXECUTION_MODE_META.immediate
    : EXECUTION_MODE_META.immediate;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          技术分析 · {etf.name}
        </CardTitle>
        <CardDescription className="text-xs">
          MACD(12/26/9) + 20/40周均线 → 互斥7态分类 → 执行模式系数
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        ) : isError || !data ? (
          <div className="h-24 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <AlertCircle className="size-5 text-muted-foreground/60" />
            <span>技术数据加载失败，已回退中性(1.0x)</span>
          </div>
        ) : (
          <>
            {/* 状态大Badge + 系数 + 执行模式 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* 技术状态 */}
              <div className={`rounded-lg border p-3 flex flex-col gap-1 ${stateMeta.bg}`}>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">技术状态</div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block size-2.5 rounded-full ${stateMeta.dot}`} />
                  <span className={`text-lg font-bold ${stateMeta.color}`}>
                    {stateMeta.label}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  state = {data.state}
                </div>
              </div>

              {/* 执行模式 */}
              <div className="rounded-lg border p-3 flex flex-col gap-1 bg-muted/30">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">执行模式</div>
                <div className={`text-lg font-bold ${modeMeta.color}`}>
                  {modeMeta.label}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {modeMeta.hint}
                </div>
              </div>

              {/* 技术系数 */}
              <div className="rounded-lg border p-3 flex flex-col gap-1 bg-muted/30">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">技术系数</div>
                <div className="text-lg font-bold font-mono tabular-nums text-foreground">
                  {data.coefficient.toFixed(1)}x
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {data.coefficient > 1
                    ? '增强仓加码'
                    : data.coefficient === 1
                    ? '正常执行'
                    : data.coefficient === 0
                    ? '增强仓清零'
                    : '增强仓减码'}
                </div>
              </div>
            </div>

            {/* 周线 / 日线 / MA 数值 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-md border bg-muted/20 p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">周线状态</div>
                <div className="text-xs font-medium">
                  {WEEKLY_STATE_META[data.weekly_state] ?? data.weekly_state}
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  MA20: <span className="text-foreground">{data.ma20 !== null ? data.ma20.toFixed(3) : '—'}</span>
                  <span className="mx-2">·</span>
                  MA40: <span className="text-foreground">{data.ma40 !== null ? data.ma40.toFixed(3) : '—'}</span>
                </div>
              </div>
              <div className="rounded-md border bg-muted/20 p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">日线状态</div>
                <div className="text-xs font-medium">
                  {DAILY_STATE_META[data.daily_state] ?? data.daily_state}
                </div>
                {data.reason && (
                  <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {data.reason}
                  </div>
                )}
              </div>
            </div>

            {/* MACD 直方图最近5天趋势 */}
            <div className="rounded-md border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  MACD直方图 最近5天
                </div>
                {data.macd_histogram_tail.length > 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    趋势: {data.macd_histogram_tail[data.macd_histogram_tail.length - 1] >
                    data.macd_histogram_tail[0]
                      ? '↑ 走强'
                      : data.macd_histogram_tail[data.macd_histogram_tail.length - 1] <
                        data.macd_histogram_tail[0]
                      ? '↓ 走弱'
                      : '→ 平稳'}
                  </div>
                )}
              </div>
              {data.macd_histogram_tail.length === 0 ? (
                <div className="text-xs text-muted-foreground">数据不足</div>
              ) : (
                <div className="flex items-stretch gap-1.5 h-20">
                  {/* 左侧: 0轴标签 */}
                  <div className="flex flex-col justify-between text-[9px] text-muted-foreground/60 font-mono pr-1">
                    <span>+</span>
                    <span className="border-t border-muted-foreground/30">0</span>
                    <span>−</span>
                  </div>
                  {/* 直方图柱子 */}
                  {data.macd_histogram_tail.map((v, i) => {
                    const maxAbs = Math.max(
                      ...data.macd_histogram_tail.map((x) => Math.abs(x)),
                      0.0001
                    );
                    const heightPct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
                    const isPositive = v >= 0;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
                        {/* 上半部分: 正值柱 (高度=heightPct%, 占容器上半) */}
                        <div className="h-1/2 w-full flex flex-col justify-end items-center">
                          {isPositive && (
                            <div
                              className="w-full rounded-t-sm bg-emerald-500/70 dark:bg-emerald-400/70"
                              style={{ height: `${heightPct * 2}%` }}
                              title={`D-${data.macd_histogram_tail.length - 1 - i}: ${v.toFixed(4)}`}
                            />
                          )}
                        </div>
                        {/* 中线 */}
                        <div className="w-full border-t border-muted-foreground/30" />
                        {/* 下半部分: 负值柱 */}
                        <div className="h-1/2 w-full flex flex-col justify-start items-center">
                          {!isPositive && (
                            <div
                              className="w-full rounded-b-sm bg-red-500/70 dark:bg-red-400/70"
                              style={{ height: `${heightPct * 2}%` }}
                              title={`D-${data.macd_histogram_tail.length - 1 - i}: ${v.toFixed(4)}`}
                            />
                          )}
                        </div>
                        <div className="text-[9px] text-muted-foreground font-mono tabular-nums">
                          {v.toFixed(3)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* MACD线 / 信号线 最新值 */}
              {data.macd_line_tail.length > 0 && data.signal_line_tail.length > 0 && (
                <div className="text-[10px] text-muted-foreground font-mono">
                  MACD线: <span className="text-foreground">{data.macd_line_tail[data.macd_line_tail.length - 1].toFixed(3)}</span>
                  <span className="mx-2">·</span>
                  信号线: <span className="text-foreground">{data.signal_line_tail[data.signal_line_tail.length - 1].toFixed(3)}</span>
                </div>
              )}
            </div>

            {/* 说明文字 */}
            <Alert className="border-border/60 bg-muted/30">
              <Info className="size-3.5 text-muted-foreground" />
              <AlertDescription className="text-[11px] text-muted-foreground leading-relaxed">
                技术指标只调整增强仓节奏,不创造预算或独立卖出。数据缺失时回退中性(1.0x)。
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── QDII Premium Emphasis Panel (§10.B2) ───
// Prominent panel for 513500 / 513300 showing current premium, 7-day avg,
// 30-day trend chart with 2%/3% reference lines, rule status, and one-line impact.

function QdiiPremiumEmphasisPanel({
  etf,
  summary,
  premiumData,
  rules,
  isLoading,
}: {
  etf: { code: string; name: string; category: string };
  summary: MarketDataSummary | undefined;
  premiumData: CachedPremium | undefined;
  rules: RuleConfig[];
  isLoading: boolean;
}) {
  const impact = useMemo(
    () => computeRuleImpact(etf, summary, rules),
    [etf, summary, rules]
  );

  const { chartData, hasEnoughData } = useMemo(() => {
    if (!premiumData?.premium30d?.length) return { chartData: [], hasEnoughData: false };
    const valid = filterValidPoints(premiumData.premium30d, (p: PremiumHistoryPoint) => p.premium);
    return {
      chartData: valid.map((p: PremiumHistoryPoint) => ({
        date: p.date.slice(5),
        fullDate: p.date,
        premium: p.premium as number,
      })),
      hasEnoughData: valid.length >= 5,
    };
  }, [premiumData]);

  const premium = summary?.premiumToday ?? null;
  const avg3 = summary?.premium3dAvg ?? premiumData?.premium3dAvg ?? null;
  const avg7 = summary?.premium7dAvg ?? null;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-2 border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" />
              QDII溢价监控 · {etf.name}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              QDII基金溢价率实时监控 · 2%预警 / 3%红线
            </CardDescription>
          </div>
          {ruleLevelToBadge(impact.level)}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Big number row — 今日 / 3日均值 / 7日均值 三列 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <div className="text-xs text-muted-foreground mb-1">当前溢价率</div>
            <div className={`text-3xl font-bold ${getPremiumColor(premium)}`}>
              {premium !== null ? `${premium.toFixed(2)}%` : '—'}
            </div>
            <div className="text-xs mt-1 flex items-center justify-center gap-1">
              {getPremiumDot(premium)}
              <span className="text-muted-foreground">
                {premium === null ? '暂无数据' : premium > 3 ? '超过红线' : premium >= 2 ? '预警区间' : '可控'}
              </span>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <div className="text-xs text-muted-foreground mb-1">3日均值</div>
            <div className={`text-3xl font-bold ${getPremiumColor(avg3)}`}>
              {avg3 !== null ? `${avg3.toFixed(2)}%` : '—'}
            </div>
            <div className="text-xs mt-1 flex items-center justify-center gap-1">
              {getPremiumDot(avg3)}
              <span className="text-muted-foreground">
                {avg3 === null ? '暂无数据' : avg3 > 3 ? '超过红线' : avg3 >= 2 ? '预警区间' : '可控'}
              </span>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <div className="text-xs text-muted-foreground mb-1">7日均值</div>
            <div className={`text-3xl font-bold ${getPremiumColor(avg7)}`}>
              {avg7 !== null ? `${avg7.toFixed(2)}%` : '—'}
            </div>
            <div className="text-xs mt-1 flex items-center justify-center gap-1">
              {getPremiumDot(avg7)}
              <span className="text-muted-foreground">
                {avg7 === null ? '暂无数据' : avg7 > 3 ? '超过红线' : avg7 >= 2 ? '预警区间' : '可控'}
              </span>
            </div>
          </div>
        </div>

        {/* Rule impact one-liner */}
        <div className={`rounded-md border p-3 text-sm ${ruleLevelToBg(impact.level)} ${ruleLevelToTextColor(impact.level)}`}>
          {impact.text}
        </div>

        {/* 30-day chart */}
        {chartData.length === 0 || !hasEnoughData ? (
          <div className="h-56 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <Info className="size-5" />
            <span>当前历史数据不足，暂不展示此图表。</span>
          </div>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="qdiiPremiumGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e5e7eb' }}
                  width={55}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(255,255,255,0.96)',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  }}
                  labelFormatter={(_label: string, payload: Array<{ payload?: { fullDate?: string } }>) => {
                    if (payload?.[0]?.payload?.fullDate) return payload[0].payload.fullDate;
                    return _label;
                  }}
                  formatter={(value: number) => [`${value.toFixed(2)}%`, '溢价率']}
                />
                <ReferenceLine y={2} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.7} label={{ value: '2% 预警', position: 'insideTopLeft', fontSize: 10, fill: '#f59e0b' }} />
                <ReferenceLine y={3} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.7} label={{ value: '3% 红线', position: 'insideTopLeft', fontSize: 10, fill: '#ef4444' }} />
                <Bar
                  dataKey="premium"
                  fill="#f59e0b"
                  fillOpacity={0.5}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <DataSourceFooter date={premiumData?.date ?? summary?.premiumDate} />
      </CardContent>
    </Card>
  );
}

// ─── 6-ETF Comparison Table (§10.B3) ───

// V4.1 S4-T8: 数据质量 5 态映射（passed / minor_abnormal / serious_abnormal / insufficient / source_inconsistent）
// 保留 estimated 作为兜底（本地估算 PE/PB，无 API 质量记录时使用）
type DataQuality5State =
  | 'passed'
  | 'minor_abnormal'
  | 'serious_abnormal'
  | 'insufficient'
  | 'source_inconsistent'
  | 'estimated';

const ETF_TO_INDEX_CODE: Record<string, string> = {
  '159338': '000510',
  '510880': '000015',
  '510330': '000300',
  '588000': '000688',
  '513500': 'SPI',
  '513300': 'IXIC',
};

// 5 态颜色与文案（与总览页 DataTrustCard 对齐）
function getDataQualityBadgeInfo(status: DataQuality5State): {
  label: string;
  className: string;
  dotClass: string;
} {
  switch (status) {
    case 'passed':
      return {
        label: '通过',
        className:
          'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30',
        dotClass: 'bg-emerald-500',
      };
    case 'minor_abnormal':
      return {
        label: '轻微异常',
        className:
          'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30',
        dotClass: 'bg-amber-500',
      };
    case 'serious_abnormal':
      return {
        label: '严重异常',
        className:
          'text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30',
        dotClass: 'bg-orange-500',
      };
    case 'insufficient':
      return {
        label: '数据不足',
        className:
          'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30',
        dotClass: 'bg-red-500',
      };
    case 'source_inconsistent':
      return {
        label: '源不一致',
        className:
          'text-red-700 dark:text-red-400 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30',
        dotClass: 'bg-red-500',
      };
    case 'estimated':
    default:
      return {
        label: '估算',
        className:
          'text-slate-700 dark:text-slate-400 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/30',
        dotClass: 'bg-slate-500',
      };
  }
}

// 把 QualityScoreItem 的 4 态（excellent/usable/suspicious/unavailable）+ reason 文本
// 映射为 5 态（passed/minor_abnormal/serious_abnormal/insufficient/source_inconsistent）
function mapQualityItemTo5State(
  item: QualityScoreItem | undefined
): DataQuality5State | null {
  if (!item) return null;
  // 优先检测源不一致（reason 文本特征）
  const reason = item.reason || '';
  if (
    reason.includes('主备源冲突') ||
    reason.includes('源不一致') ||
    reason.includes('source_inconsistent') ||
    reason.includes('source_conflict')
  ) {
    return 'source_inconsistent';
  }
  // 按 4 态映射
  switch (item.quality_status) {
    case 'excellent':
      return 'passed';
    case 'usable':
      return 'minor_abnormal';
    case 'suspicious':
      return 'serious_abnormal';
    case 'unavailable':
      return 'insufficient';
    default:
      return null;
  }
}

// V4.1 S4-T8: 批量拉取所有 ETF 的质量评分（含 valuation 索引代码映射）
// 国内 ETF 用 indexCode 查 valuation 类型，海外 ETF 用 etfCode 查 premium 类型
function useAllEtfQuality(): {
  qualityMap: Map<string, QualityScoreItem | undefined>;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ['trends', 'all-etf-quality'],
    queryFn: async () => {
      const results = await Promise.all(
        ETF_LIST.map(async (etf) => {
          const isOverseas = etf.category === 'overseas';
          // 国内用 indexCode 查 valuation，海外用 etfCode 查 premium
          const queryCode = isOverseas
            ? etf.code
            : ETF_TO_INDEX_CODE[etf.code] ?? etf.code;
          const targetMetricType = isOverseas ? 'premium' : 'valuation';
          try {
            const res = await getQualityByCode(queryCode);
            const items = res.items ?? [];
            // 按 metric_type 过滤，取最新一条（按 created_at 倒序）
            const filtered = items
              .filter((it) => it.metric_type === targetMetricType)
              .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            return [etf.code, filtered[0] ?? undefined] as const;
          } catch {
            return [etf.code, undefined] as const;
          }
        })
      );
      return new Map<string, QualityScoreItem | undefined>(results);
    },
    staleTime: 60 * 1000,
  });

  return {
    qualityMap: query.data ?? new Map<string, QualityScoreItem | undefined>(),
    isLoading: query.isLoading,
  };
}

function ComparisonTable({
  summaryMap,
  dividendMap,
  rules,
}: {
  summaryMap: Map<string, MarketDataSummary>;
  dividendMap: Map<string, CachedDividend>;
  rules: RuleConfig[];
}) {
  const { qualityMap } = useAllEtfQuality();

  const rows = useMemo(() => {
    return ETF_LIST.map((etf) => {
      const summary = summaryMap.get(etf.code);
      const dividend = dividendMap.get(etf.code);
      const impact = computeRuleImpact(etf, summary, rules);

      const pe = summary?.pePercentile ?? null;
      const pb = summary?.pbPercentile ?? null;
      const premium = summary?.premiumToday ?? null;
      const avg7 = summary?.premium7dAvg ?? null;
      const dy = dividend?.dividendYield ?? summary?.dividendYield ?? null;
      const isEstimated = summary?.isEstimated ?? false;

      // V4.1 S4-T8: 5 态质量状态（API 优先，本地兜底）
      const qualityItem = qualityMap.get(etf.code);
      const api5State = mapQualityItemTo5State(qualityItem);
      let dataQualityStatus: DataQuality5State;
      if (api5State) {
        dataQualityStatus = api5State;
      } else {
        // 兜底：保留原 3 态本地逻辑（estimated / insufficient）
        if (etf.category === 'overseas') {
          if (!isValidNumber(premium)) dataQualityStatus = 'insufficient';
          else if (isEstimated) dataQualityStatus = 'estimated';
          else dataQualityStatus = 'passed';
        } else {
          dataQualityStatus = isValidNumber(pe)
            ? 'passed'
            : 'insufficient';
        }
      }

      return {
        etf,
        pe,
        pb,
        premium,
        avg7,
        dy,
        dataQualityStatus,
        qualityItem,
        impact,
      };
    });
  }, [summaryMap, dividendMap, rules, qualityMap]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4 text-primary" />
          监控指标汇总
        </CardTitle>
        <CardDescription className="text-xs">
          6只定投ETF的核心监控指标与规则状态横向对比 · 数据源 akshare
          <span className="ml-1 text-muted-foreground/70">
            · 数据质量 5 态：通过/轻微异常/严重异常/数据不足/源不一致
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[80px]">代码</TableHead>
                <TableHead className="min-w-[110px]">名称</TableHead>
                <TableHead className="min-w-[80px] text-right">PE分位</TableHead>
                <TableHead className="min-w-[80px] text-right">PB分位</TableHead>
                <TableHead className="min-w-[80px] text-right">溢价率</TableHead>
                <TableHead className="min-w-[100px] text-right">7日溢价均值</TableHead>
                <TableHead className="min-w-[80px] text-right">股息率</TableHead>
                <TableHead className="min-w-[100px] text-center">数据质量</TableHead>
                <TableHead className="min-w-[100px] text-center">规则状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ etf, pe, pb, premium, avg7, dy, dataQualityStatus, qualityItem, impact }) => {
                const badgeInfo = getDataQualityBadgeInfo(dataQualityStatus);
                const tooltipText = qualityItem
                  ? `质量分: ${qualityItem.quality_score.toFixed(0)}/100\n状态: ${qualityItem.quality_status}\n原因: ${qualityItem.reason || '—'}`
                  : dataQualityStatus === 'estimated'
                    ? '本地估算值（PE/PB 为硬编码估算，无 API 质量记录）'
                    : '暂无 API 质量记录';
                return (
                <TableRow key={etf.code}>
                  <TableCell className="font-mono text-xs">{etf.code}</TableCell>
                  <TableCell className="font-medium text-sm">{etf.name}</TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    {isValidNumber(pe) ? (
                      <span className={getPercentileColor(pe)}>
                        {getPercentileDot(pe)} {(pe as number).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    {isValidNumber(pb) ? (
                      <span className={getPercentileColor(pb)}>
                        {getPercentileDot(pb)} {(pb as number).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    {isValidNumber(premium) ? (
                      <span className={getPremiumColor(premium)}>
                        {getPremiumDot(premium)} {(premium as number).toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    {isValidNumber(avg7) ? (
                      <span className={getPremiumColor(avg7)}>
                        {(avg7 as number).toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    {isValidNumber(dy) ? (
                      <span className={(dy as number) > 4 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                        {(dy as number).toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0.5 inline-flex items-center gap-1 whitespace-nowrap ${badgeInfo.className}`}
                      title={tooltipText}
                    >
                      <span className={`size-1.5 rounded-full ${badgeInfo.dotClass}`} />
                      {badgeInfo.label}
                      {qualityItem && (
                        <span className="font-mono text-[9px] opacity-70">
                          {qualityItem.quality_score.toFixed(0)}
                        </span>
                      )}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {ruleLevelToBadge(impact.level)}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <DataSourceFooter />
      </CardContent>
    </Card>
  );
}

// ─── Main Component ───

export default function TrendsTab() {
  const [selectedCode, setSelectedCode] = useState('159338');
  const [klineTimeRange, setKlineTimeRange] = useState(12); // default 近1年
  const [klineChartType, setKlineChartType] = useState('daily');
  const [peTimeRange, setPeTimeRange] = useState(60); // default 近5年
  const [pbTimeRange, setPbTimeRange] = useState(60); // default 近5年

  // Fetch all data in parallel
  const summaryQuery = useSummary();
  const valuationQuery = useValuation();
  const premiumQuery = usePremium();
  const navQuery = useNav();
  const klineQuery = useKline();
  const dividendQuery = useDividend();
  const marketIndexQuery = useMarketIndex();
  const rulesQuery = useRules();
  // V4.1 S4-T7: 字段级主备源配置（用于估值卡显示"主源/备源"双标签）
  const fieldConfigsQuery = useQuery<{ fields: FieldSourceConfig[] }>({
    queryKey: ['data-source', 'fields'],
    queryFn: () => getFieldConfigs(),
    staleTime: 5 * 60 * 1000,
  });
  const fieldConfigs = fieldConfigsQuery.data?.fields ?? [];

  const isLoading =
    summaryQuery.isLoading ||
    valuationQuery.isLoading ||
    premiumQuery.isLoading ||
    navQuery.isLoading;

  // Build lookup maps
  const summaryMap = useMemo(() => {
    const map = new Map<string, MarketDataSummary>();
    if (summaryQuery.data?.items) {
      for (const item of summaryQuery.data.items) {
        map.set(item.code, item);
      }
    }
    return map;
  }, [summaryQuery.data]);

  const valuationMap = useMemo(() => {
    const map = new Map<string, CachedValuation>();
    if (valuationQuery.data) {
      for (const item of valuationQuery.data) {
        map.set(item.code, item);
      }
    }
    return map;
  }, [valuationQuery.data]);

  const premiumMap = useMemo(() => {
    const map = new Map<string, CachedPremium>();
    if (premiumQuery.data) {
      for (const item of premiumQuery.data) {
        map.set(item.code, item);
      }
    }
    return map;
  }, [premiumQuery.data]);

  const klineMap = useMemo(() => {
    const map = new Map<string, CachedKline>();
    if (klineQuery.data) {
      for (const item of klineQuery.data) {
        map.set(item.code, item);
      }
    }
    return map;
  }, [klineQuery.data]);

  const dividendMap = useMemo(() => {
    const map = new Map<string, CachedDividend>();
    if (dividendQuery.data) {
      for (const item of dividendQuery.data) {
        map.set(item.code, item);
      }
    }
    return map;
  }, [dividendQuery.data]);

  // Selected ETF data
  const selectedValuation = valuationMap.get(selectedCode);
  const selectedPremium = premiumMap.get(selectedCode);
  const selectedKline = klineMap.get(selectedCode);
  const selectedEtf = ETF_LIST.find((e) => e.code === selectedCode);
  const isOverseas = selectedEtf?.category === 'overseas';
  const rules = rulesQuery.data ?? [];
  const selectedSummary = summaryMap.get(selectedCode);

  // Error state
  const hasError = summaryQuery.isError;
  const handleRetry = useCallback(() => {
    summaryQuery.refetch();
    valuationQuery.refetch();
    premiumQuery.refetch();
    navQuery.refetch();
    klineQuery.refetch();
    dividendQuery.refetch();
    marketIndexQuery.refetch();
    rulesQuery.refetch();
  }, [summaryQuery, valuationQuery, premiumQuery, navQuery, klineQuery, dividendQuery, marketIndexQuery, rulesQuery]);

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <XCircle className="size-12 text-destructive" />
        <p className="text-muted-foreground">数据加载失败，请稍后重试</p>
        <Button onClick={handleRetry} variant="outline">
          重新加载
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* 0a. V4.2 PRD§11 极简宏观温度计 (顶部, 只提示不改金额) */}
      <section>
        <MacroThermometerPanel />
      </section>

      {/* V4.2 P4-C: 移除 MacroMonitorPanel(大盘指数+汇率), 与极简宏观温度计功能重复,
          且大盘指数非 PRD/策略书要求(文档范围外增强) */}

      {/* 0b. 6-ETF 监控指标汇总（移到顶部，方便快速纵览全局） */}
      <section>
        <ComparisonTable
          summaryMap={summaryMap}
          dividendMap={dividendMap}
          rules={rules}
        />
      </section>

      {/* 1. ETF Selector */}
      <section>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">选择ETF</h2>
        <ETFSelector
          selectedCode={selectedCode}
          onSelect={setSelectedCode}
          summaryMap={summaryMap}
          isLoading={summaryQuery.isLoading}
        />
      </section>

      {/* 2. Core Indicators */}
      <section>
        <CoreIndicatorsPanel
          selectedCode={selectedCode}
          summaryMap={summaryMap}
          valuationMap={valuationMap}
          premiumMap={premiumMap}
          dividendMap={dividendMap}
          isLoading={isLoading}
        />
      </section>

      {/* 2a. V4 多周期估值面板（PRD§8.2） */}
      <section>
        <MultiPeriodValuationPanel
          selectedCode={selectedCode}
          valuationMap={valuationMap}
          summaryMap={summaryMap}
          isLoading={isLoading}
          fieldConfigs={fieldConfigs}
        />
      </section>

      {/* 2b. Rule Impact Panel (§10.B1) */}
      {selectedEtf && (
        <section>
          <RuleImpactPanel
            etf={selectedEtf}
            summary={selectedSummary}
            rules={rules}
          />
        </section>
      )}

      {/* 2c. V5.0 Sprint3 E6: 技术分析面板 (MACD + 周线MA → 7态分类 → 执行模式) */}
      {selectedEtf && (
        <section>
          <TechnicalAnalysisPanel etf={selectedEtf} />
        </section>
      )}

      {/* 3. K-line Chart (full width) */}
      <section>
        <KlineChart
          klineData={selectedKline}
          chartType={klineChartType}
          timeRange={klineTimeRange}
          onChartTypeChange={setKlineChartType}
          onTimeRangeChange={setKlineTimeRange}
          isLoading={klineQuery.isLoading}
        />
      </section>

      {/* 4. Valuation Charts - PE and PB side by side
          V4.1 BUG-2026-06-US-PE-PB: 海外 ETF 也展示（multpl.com 已能提供 PE/PB 完整历史） */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ValuationChart
          title="PE估值历史"
          icon={<TrendingDown className="size-4 text-teal-600" />}
          dataKey="pe"
          history={selectedValuation?.peHistory ?? []}
          currentValue={selectedValuation?.pe ?? null}
          currentPercentile={selectedValuation?.pePercentile ?? null}
          timeRange={peTimeRange}
          onTimeRangeChange={setPeTimeRange}
          isLoading={valuationQuery.isLoading}
        />
        <ValuationChart
          title="PB估值历史"
          icon={<TrendingDown className="size-4 text-violet-600" />}
          dataKey="pb"
          history={selectedValuation?.pbHistory ?? []}
          currentValue={selectedValuation?.pb ?? null}
          currentPercentile={selectedValuation?.pbPercentile ?? null}
          timeRange={pbTimeRange}
          onTimeRangeChange={setPbTimeRange}
          isLoading={valuationQuery.isLoading}
        />
      </section>

      {/* 5. QDII Premium Emphasis Panel (overseas only, §10.B2) */}
      {isOverseas && selectedEtf && (
        <section>
          <QdiiPremiumEmphasisPanel
            etf={selectedEtf}
            summary={selectedSummary}
            premiumData={selectedPremium}
            rules={rules}
            isLoading={premiumQuery.isLoading}
          />
        </section>
      )}

      {/* 6. 6-ETF Comparison Table — 移到底部不展示，改为顶部展示 */}
    </div>
  );
}
