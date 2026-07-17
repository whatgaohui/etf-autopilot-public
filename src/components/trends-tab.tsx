'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  Shield,
  Activity,
  Database,
  Clock,
  Info,
  Gauge,
  BarChart3,
  ChevronRight,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  TableProperties,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Tooltip as ShadcnTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

import type { EtfConfigWithSnapshot, ApiResponse, DataQualityLogDisplay } from '@/lib/types';
import { FadeInUp } from '@/lib/motion';

// ─── Constants & Types ──────────────────────────────────────────────────────────

interface EtfMeta {
  code: string;
  name: string;
  category: string;
  baseNav: number;       // approximate current NAV for random walk
  volatility: number;    // daily volatility for mock data
  isQDII: boolean;
  isDividend: boolean;
  peBase: number;        // base PE for mock percentile
  pbBase: number;        // base PB for mock percentile
}

const ETF_METADATA: Record<string, EtfMeta> = {
  '510300': { code: '510300', name: '沪深300ETF', category: 'A股宽基', baseNav: 4.05, volatility: 0.012, isQDII: false, isDividend: false, peBase: 12.5, pbBase: 1.45 },
  '510500': { code: '510500', name: '中证500ETF', category: 'A股宽基', baseNav: 6.20, volatility: 0.015, isQDII: false, isDividend: false, peBase: 22.8, pbBase: 1.78 },
  '588000': { code: '588000', name: '科创50ETF', category: 'A股宽基', baseNav: 0.95, volatility: 0.020, isQDII: false, isDividend: false, peBase: 35.2, pbBase: 3.65 },
  '513300': { code: '513300', name: '纳斯达克100ETF', category: 'QDII', baseNav: 2.35, volatility: 0.016, isQDII: true, isDividend: false, peBase: 28.5, pbBase: 5.20 },
  '513500': { code: '513500', name: '标普500ETF', category: 'QDII', baseNav: 5.80, volatility: 0.010, isQDII: true, isDividend: false, peBase: 24.0, pbBase: 4.30 },
  '512890': { code: '512890', name: '红利低波ETF', category: '红利', baseNav: 1.55, volatility: 0.009, isQDII: false, isDividend: true, peBase: 8.5, pbBase: 1.05 },
};

const CATEGORY_COLORS: Record<string, string> = {
  'A股宽基': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  'domestic': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  'QDII': 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  '红利': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'dividend': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const QUALITY_DIMENSIONS = [
  { key: 'freshness', label: '新鲜度', max: 25, icon: Clock },
  { key: 'consistency', label: '一致性', max: 30, icon: Shield },
  { key: 'completeness', label: '完整性', max: 20, icon: Database },
  { key: 'abnormal', label: '异常检测', max: 15, icon: AlertTriangle },
  { key: 'sourceHealth', label: '源健康', max: 10, icon: Activity },
] as const;

// ─── Mock Data Generators ───────────────────────────────────────────────────────

/** Seeded random for deterministic mock data per ETF */
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

interface PricePoint {
  date: string;
  nav: number;
  change: number;
}

function generateMockPriceHistory(meta: EtfMeta, days = 30): PricePoint[] {
  const rng = seededRandom(meta.code.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
  const points: PricePoint[] = [];
  let price = meta.baseNav * (0.95 + rng() * 0.10);
  const now = new Date();

  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const change = (rng() - 0.48) * meta.volatility * price;
    price = Math.max(price * 0.8, price + change);
    points.push({
      date: `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`,
      nav: Number(price.toFixed(4)),
      change: Number(((change / price) * 100).toFixed(2)),
    });
  }
  return points;
}

interface ValuationData {
  pePercentile: number;
  peValue: number;
  pbPercentile: number;
  pbValue: number;
  pePercentile1y: number;
  pePercentile3y: number;
  pePercentile5y: number;
}

function generateMockValuation(meta: EtfMeta): ValuationData {
  const rng = seededRandom(meta.code.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + 100);
  return {
    pePercentile: Number((30 + rng() * 60).toFixed(1)),
    peValue: Number((meta.peBase * (0.8 + rng() * 0.4)).toFixed(2)),
    pbPercentile: Number((25 + rng() * 65).toFixed(1)),
    pbValue: Number((meta.pbBase * (0.85 + rng() * 0.3)).toFixed(2)),
    pePercentile1y: Number((20 + rng() * 70).toFixed(1)),
    pePercentile3y: Number((25 + rng() * 60).toFixed(1)),
    pePercentile5y: Number((30 + rng() * 55).toFixed(1)),
  };
}

interface PremiumData {
  premium: number;
  nav: number;
  iopv: number;
  status: 'normal' | 'elevated' | 'high';
}

function generateMockPremium(meta: EtfMeta): PremiumData | null {
  if (!meta.isQDII) return null;
  const rng = seededRandom(meta.code.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + 200);
  const premium = Number((rng() * 8 - 1).toFixed(2));
  const nav = meta.baseNav;
  const iopv = Number((nav * (1 - premium / 100)).toFixed(4));
  const status = premium > 5 ? 'high' : premium > 3 ? 'elevated' : 'normal';
  return { premium, nav, iopv, status };
}

interface DividendData {
  yieldPct: number;
  payoutRatio: number;
  dividendPer10k: number;
  exDate: string;
}

function generateMockDividend(meta: EtfMeta): DividendData | null {
  if (!meta.isDividend) return null;
  const rng = seededRandom(meta.code.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + 300);
  const yieldPct = Number((3.5 + rng() * 3).toFixed(2));
  return {
    yieldPct,
    payoutRatio: Number((50 + rng() * 30).toFixed(1)),
    dividendPer10k: Number((meta.baseNav * yieldPct / 100).toFixed(2)),
    exDate: '2025-01-15',
  };
}

interface QualityDimensions {
  freshness: number;
  consistency: number;
  completeness: number;
  abnormal: number;
  sourceHealth: number;
  totalScore: number;
}

function generateMockQuality(meta: EtfMeta): QualityDimensions {
  const rng = seededRandom(meta.code.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + 400);
  const freshness = Number((18 + rng() * 7).toFixed(0));
  const consistency = Number((22 + rng() * 8).toFixed(0));
  const completeness = Number((15 + rng() * 5).toFixed(0));
  const abnormal = Number((10 + rng() * 5).toFixed(0));
  const sourceHealth = Number((7 + rng() * 3).toFixed(0));
  return { freshness, consistency, completeness, abnormal, sourceHealth, totalScore: freshness + consistency + completeness + abnormal + sourceHealth };
}

// ─── Helper Functions ────────────────────────────────────────────────────────────

function formatMoney(yuan: number): string {
  return '¥' + Math.abs(yuan).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percentileColor(pct: number): string {
  if (pct < 30) return 'bg-emerald-500';
  if (pct < 70) return 'bg-amber-500';
  return 'bg-red-500';
}

function percentileTextColor(pct: number): string {
  if (pct < 30) return 'text-emerald-600 dark:text-emerald-400';
  if (pct < 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function percentileLabel(pct: number): string {
  if (pct < 30) return '低估';
  if (pct < 70) return '中估';
  return '高估';
}

function qualityStatusBadge(status: string) {
  switch (status) {
    case 'valid': return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">有效</Badge>;
    case 'degraded': return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">降级</Badge>;
    case 'stale': return <Badge className="bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">陈旧</Badge>;
    case 'conflict': return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">冲突</Badge>;
    case 'missing': return <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">缺失</Badge>;
    default: return <Badge variant="secondary">{status}</Badge>;
  }
}

function premiumStatusBadge(status: string) {
  switch (status) {
    case 'normal': return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">正常</Badge>;
    case 'elevated': return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">偏高</Badge>;
    case 'high': return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">高溢价</Badge>;
    default: return <Badge variant="secondary">{status}</Badge>;
  }
}

// ─── Sub-Components ─────────────────────────────────────────────────────────────

function SectionSkeleton() {
  return <Skeleton className="h-64 w-full rounded-xl" />;
}

/** ETF selector: horizontal scrollable pill buttons */
function EtfSelector({
  etfs,
  selected,
  onSelect,
}: {
  etfs: EtfMeta[];
  selected: string;
  onSelect: (code: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar">
      {etfs.map((etf) => {
        const isActive = etf.code === selected;
        return (
          <TooltipProvider key={etf.code}>
            <ShadcnTooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(etf.code)}
                  className={[
                    'group relative flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-all duration-200 border shrink-0',
                    isActive
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-md shadow-emerald-600/20'
                      : 'bg-card border-border hover:border-emerald-300 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20',
                  ].join(' ')}
                >
                  <span className="font-mono text-xs opacity-80">{etf.code}</span>
                  <span>{etf.name.replace('ETF', '')}</span>
                  {!isActive && (
                    <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[etf.category]}`}>
                      {etf.category}
                    </span>
                  )}
                  {isActive && (
                    <span className="ml-1 size-1.5 rounded-full bg-white/80 animate-pulse" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">{etf.name} ({etf.code})</p>
                <p className="text-[10px] text-muted-foreground">{etf.category}</p>
              </TooltipContent>
            </ShadcnTooltip>
          </TooltipProvider>
        );
      })}
    </div>
  );
}

/** Time range selector pills */
function TimeRangeSelector({ range, onRangeChange }: { range: number; onRangeChange: (r: number) => void }) {
  const options = [
    { label: '7日', value: 7 },
    { label: '30日', value: 30 },
    { label: '90日', value: 90 },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onRangeChange(opt.value)}
          className={[
            'rounded-full px-3 py-1 text-xs font-medium transition-all duration-200 border',
            range === opt.value
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-card border-border hover:border-emerald-300 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20',
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Price trend chart (variable time range) */
function PriceTrendChart({ data, range }: { data: PricePoint[]; range: number }) {
  const isUp = data.length > 1 && data[data.length - 1].nav >= data[0].nav;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="size-4 text-emerald-600" />
              {range}日价格走势
            </CardTitle>
            <CardDescription className="mt-1">模拟净值曲线（随机游走）</CardDescription>
          </div>
          <Badge variant="outline" className={isUp ? 'text-emerald-600 border-emerald-300' : 'text-red-600 border-red-300'}>
            {isUp ? <TrendingUp className="size-3 mr-1" /> : <TrendingDown className="size-3 mr-1" />}
            {isUp ? '上涨趋势' : '下跌趋势'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="navGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isUp ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={isUp ? '#10b981' : '#ef4444'} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => v.toFixed(2)}
              />
              <RechartsTooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--card)',
                  fontSize: '12px',
                }}
                formatter={(value: number) => [value.toFixed(4), 'NAV']}
                labelFormatter={(label: string) => `日期: ${label}`}
              />
              <Area
                type="monotone"
                dataKey="nav"
                stroke={isUp ? '#10b981' : '#ef4444'}
                strokeWidth={2}
                fill="url(#navGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground/60 text-right">
          数据来源: 模拟数据（仅供展示）
        </p>
      </CardContent>
    </Card>
  );
}

/** Valuation percentile gauge */
function ValuationGauge({ data }: { data: ValuationData }) {
  const gaugeData = [
    { name: '1年', value: data.pePercentile1y },
    { name: '3年', value: data.pePercentile3y },
    { name: '5年', value: data.pePercentile5y },
    { name: '全周期', value: data.pePercentile },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="size-4 text-teal-600" />
          估值百分位
        </CardTitle>
        <CardDescription>PE/PB 在历史区间中的分位位置</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* PE & PB Summary */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">PE</span>
              <span className={`text-xs font-semibold ${percentileTextColor(data.pePercentile)}`}>
                {percentileLabel(data.pePercentile)}
              </span>
            </div>
            <p className="text-2xl font-bold font-mono">{data.peValue.toFixed(2)}</p>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>百分位</span>
                <span className="font-mono">{data.pePercentile.toFixed(1)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${percentileColor(data.pePercentile)}`}
                  style={{ width: `${Math.min(100, data.pePercentile)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">PB</span>
              <span className={`text-xs font-semibold ${percentileTextColor(data.pbPercentile)}`}>
                {percentileLabel(data.pbPercentile)}
              </span>
            </div>
            <p className="text-2xl font-bold font-mono">{data.pbValue.toFixed(2)}</p>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>百分位</span>
                <span className="font-mono">{data.pbPercentile.toFixed(1)}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${percentileColor(data.pbPercentile)}`}
                  style={{ width: `${Math.min(100, data.pbPercentile)}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Multi-window PE Percentile Bar Chart */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">PE 百分位 — 多时间窗口</p>
          <div className="h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={gaugeData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <RechartsTooltip
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--card)',
                    fontSize: '12px',
                  }}
                  formatter={(value: number) => [`${value.toFixed(1)}%`, 'PE 百分位']}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {gaugeData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.value < 30 ? '#10b981' : entry.value < 70 ? '#f59e0b' : '#ef4444'}
                      fillOpacity={0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Percentile legend */}
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" /> &lt;30% 低估</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-amber-500" /> 30-70% 中估</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-red-500" /> &gt;70% 高估</span>
        </div>

        <p className="text-[10px] text-muted-foreground/60 text-right">
          数据来源: 模拟估值数据（仅供展示）
        </p>
      </CardContent>
    </Card>
  );
}

/** Premium section for QDII ETFs */
function PremiumSection({ data }: { data: PremiumData | null }) {
  if (!data) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4 text-violet-600" />
              QDII 溢价率
            </CardTitle>
            <CardDescription className="mt-1">场内交易价格与IOPV的偏差</CardDescription>
          </div>
          {premiumStatusBadge(data.status)}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">溢价率</p>
            <p className={`text-xl font-bold font-mono ${data.premium > 3 ? 'text-red-600' : data.premium > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {data.premium > 0 ? '+' : ''}{data.premium}%
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">场内净值</p>
            <p className="text-lg font-mono font-semibold">{data.nav.toFixed(4)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">IOPV</p>
            <p className="text-lg font-mono font-semibold">{data.iopv.toFixed(4)}</p>
          </div>
        </div>
        {/* Premium bar */}
        <div className="rounded-lg border p-3 bg-muted/30">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-muted-foreground">溢价率范围</span>
            <span className="font-mono">-2% ~ +8%</span>
          </div>
          <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden">
            {/* Markers for thresholds */}
            <div className="absolute left-[20%] top-0 bottom-0 w-px bg-amber-400/60" />
            <div className="absolute left-[50%] top-0 bottom-0 w-px bg-red-400/60" />
            {/* Current position */}
            <div
              className="absolute top-0 bottom-0 w-1.5 rounded-full bg-violet-500 shadow-sm transition-all duration-500"
              style={{ left: `${Math.max(0, Math.min(100, (data.premium + 2) / 10 * 100))}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
            <span>-2%</span>
            <span>0%</span>
            <span>+3%</span>
            <span>+8%</span>
          </div>
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground/60 text-right">
          数据来源: 模拟溢价数据（仅供展示）
        </p>
      </CardContent>
    </Card>
  );
}

/** QDII Premium Alert Card — alert-style card for premium status */
function QdiiPremiumAlertCard({
  data,
  etfCode,
  etfName,
}: {
  data: PremiumData;
  etfCode: string;
  etfName: string;
}) {
  const alertType = data.premium > 5 ? 'danger' : data.premium > 3 ? 'warning' : 'safe';

  const alertConfig = {
    safe: {
      border: 'border-emerald-200 dark:border-emerald-800/40',
      bg: 'bg-emerald-50/50 dark:bg-emerald-950/10',
      badgeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      badgeLabel: '正常',
      icon: <Shield className="size-4 text-emerald-500" />,
      textColor: 'text-emerald-600 dark:text-emerald-400',
    },
    warning: {
      border: 'border-amber-200 dark:border-amber-800/40',
      bg: 'bg-amber-50/30 dark:bg-amber-950/10',
      badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      badgeLabel: '警告',
      icon: <AlertTriangle className="size-4 text-amber-500" />,
      textColor: 'text-amber-600 dark:text-amber-400',
    },
    danger: {
      border: 'border-red-200 dark:border-red-800/40',
      bg: 'bg-red-50/30 dark:bg-red-950/10',
      badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      badgeLabel: '危险',
      icon: <AlertTriangle className="size-4 text-red-500" />,
      textColor: 'text-red-600 dark:text-red-400',
    },
  }[alertType];

  return (
    <Alert className={`border ${alertConfig.border} ${alertConfig.bg}`}>
      <Shield className="size-4 text-muted-foreground" />
      <AlertTitle className="flex items-center gap-2 text-sm">
        {alertConfig.icon}
        QDII 溢价状态 — {etfName} ({etfCode})
        <Badge className={`${alertConfig.badgeClass} border-0 text-[10px]`}>
          {alertConfig.badgeLabel}
        </Badge>
      </AlertTitle>
      <AlertDescription className="mt-1.5 space-y-1.5">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">当前溢价率</span>
          <span className={`text-base font-bold font-mono ${alertConfig.textColor}`}>
            {data.premium > 0 ? '+' : ''}{data.premium}%
          </span>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span>场内净值: <span className="font-mono">{data.nav.toFixed(4)}</span></span>
          <span>IOPV: <span className="font-mono">{data.iopv.toFixed(4)}</span></span>
        </div>
        <p className="text-[10px] text-muted-foreground/70 mt-1">
          溢价阈值: &lt;3% 正常 | 3-5% 警告 | &gt;5% 危险（禁止买入）
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** Dividend section for dividend ETFs */
function DividendSection({ data }: { data: DividendData | null }) {
  if (!data) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="size-4 text-amber-600" />
          股息指标
        </CardTitle>
        <CardDescription>分红率与股息率</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">股息率</p>
            <p className="text-xl font-bold font-mono text-amber-600">{data.yieldPct}%</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">分红比例</p>
            <p className="text-lg font-mono font-semibold">{data.payoutRatio}%</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground mb-1">每万份分红</p>
            <p className="text-lg font-mono font-semibold">{data.dividendPer10k.toFixed(2)}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock className="size-3" />
          <span>除权日: {data.exDate}</span>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground/60 text-right">
          数据来源: 模拟分红数据（仅供展示）
        </p>
      </CardContent>
    </Card>
  );
}

/** Quality score dimension bars */
function QualityScoreDisplay({ quality }: { quality: QualityDimensions }) {
  const scoreColor = quality.totalScore >= 65 ? 'text-emerald-600' : quality.totalScore >= 45 ? 'text-amber-600' : 'text-red-600';
  const scoreBg = quality.totalScore >= 65 ? 'bg-emerald-100 dark:bg-emerald-900/30' : quality.totalScore >= 45 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-red-100 dark:bg-red-900/30';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="size-4 text-emerald-600" />
              数据质量评分
            </CardTitle>
            <CardDescription className="mt-1">五维质量评分（满分 100）</CardDescription>
          </div>
          <div className={`rounded-lg px-3 py-1.5 ${scoreBg}`}>
            <span className={`text-lg font-bold font-mono ${scoreColor}`}>{quality.totalScore}</span>
            <span className="text-[10px] text-muted-foreground ml-1">/100</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {QUALITY_DIMENSIONS.map((dim) => {
          const value = quality[dim.key as keyof QualityDimensions] as number;
          const pct = (value / dim.max) * 100;
          const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
          return (
            <div key={dim.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs">
                  <dim.icon className="size-3 text-muted-foreground" />
                  <span className="font-medium">{dim.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">满分 {dim.max}</span>
                  <span className="text-xs font-mono font-semibold">{value}</span>
                </div>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
            </div>
          );
        })}

        <Separator className="my-3" />

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Info className="size-3" />
          <span>综合质量分 ≥ 65 可用于弱规则，≥ 80 可用于强规则</span>
        </div>
        <p className="text-[10px] text-muted-foreground/60 text-right">
          数据来源: 模拟质量评分（仅供展示）
        </p>
      </CardContent>
    </Card>
  );
}

/** Data Quality from API (per-ETF real data) */
function DataQualityApiSection({ etfCode }: { etfCode: string }) {
  const { data: qualityRes, isLoading } = useQuery({
    queryKey: ['data-quality', etfCode],
    queryFn: () => fetch(`/api/data-quality?etfCode=${etfCode}`).then(r => r.json()) as Promise<ApiResponse<DataQualityLogDisplay[]>>,
  });

  const logs = qualityRes?.data ?? [];

  if (isLoading) return <SectionSkeleton />;
  if (logs.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="size-4 text-slate-500" />
            实时数据质量日志
          </CardTitle>
          <CardDescription>来自 /api/data-quality 的质量门禁记录</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Database className="size-8 mb-2 opacity-30" />
            <p className="text-sm">暂无质量日志数据</p>
            <p className="text-xs mt-1 text-muted-foreground/60">ETF {etfCode} 尚无数据质量记录</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="size-4 text-emerald-600" />
              实时数据质量日志
            </CardTitle>
            <CardDescription className="mt-1">来自数据质量门禁系统</CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">{logs.length} 条记录</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
          {logs.slice(0, 10).map((log) => (
            <div key={log.id} className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">{log.metricName}</span>
                  {qualityStatusBadge(log.qualityStatus)}
                </div>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {new Date(log.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>综合分: <span className="font-mono font-medium">{log.score}</span></span>
                {log.canUseForRule ? (
                  <span className="text-emerald-600">可用规则 ✓</span>
                ) : (
                  <span className="text-red-500">不可用 ✗</span>
                )}
                {log.reason && <span className="truncate max-w-[200px]">{log.reason}</span>}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Technical Indicator Calculations ──────────────────────────────────────────

function calculateEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateMACD(prices: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macd: macdLine, signal: signalLine, histogram };
}

function calculateRSI(prices: number[], period = 14): number[] {
  const rsi: number[] = [50];
  for (let i = 1; i < prices.length; i++) {
    if (i < period) { rsi.push(50); continue; }
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = prices[j] - prices[j - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) rsi.push(100);
    else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }
  return rsi;
}

function calculateMA(prices: number[], period: number): number[] {
  return prices.map((_, i) => {
    if (i < period - 1) return NaN;
    const slice = prices.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

interface MacdChartData {
  date: string;
  histogram: number;
  macd: number;
  signal: number;
}

function prepareChartData(priceData: PricePoint[], macdResult: ReturnType<typeof calculateMACD>): MacdChartData[] {
  const last = 20;
  const startIdx = Math.max(0, priceData.length - last);
  const chartData: MacdChartData[] = [];
  for (let i = startIdx; i < priceData.length; i++) {
    chartData.push({
      date: priceData[i].date,
      histogram: Number(macdResult.histogram[i].toFixed(6)),
      macd: Number(macdResult.macd[i].toFixed(6)),
      signal: Number(macdResult.signal[i].toFixed(6)),
    });
  }
  return chartData;
}

/** Technical Indicators Panel — MACD / RSI / MA */
function TechnicalIndicatorsPanel({ priceData, meta }: { priceData: PricePoint[]; meta: EtfMeta }) {
  const prices = priceData.map(p => p.nav);
  const macdResult = calculateMACD(prices);
  const rsiValues = calculateRSI(prices);
  const ma20 = calculateMA(prices, 20);
  const ma40 = calculateMA(prices, 40);

  const lastIdx = prices.length - 1;
  const currentMacd = macdResult.macd[lastIdx];
  const currentSignal = macdResult.signal[lastIdx];
  const currentHistogram = macdResult.histogram[lastIdx];
  const currentRSI = rsiValues[lastIdx];
  const currentMA20 = ma20[lastIdx];
  const currentMA40 = ma40[lastIdx];

  // Technical state based on MACD
  const isBullish = currentMacd > currentSignal && currentHistogram > 0;
  const isBearish = currentMacd < currentSignal && currentHistogram < 0;
  const techState = isBullish ? 'bullish' : isBearish ? 'bearish' : 'neutral';
  const techStateLabel = techState === 'bullish' ? '看多' : techState === 'bearish' ? '看空' : '中性';
  const techStateColor = techState === 'bullish'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    : techState === 'bearish'
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';

  // RSI color
  const rsiColor = currentRSI < 30
    ? 'text-emerald-600'
    : currentRSI > 70
      ? 'text-red-500'
      : 'text-amber-600';
  const rsiLabel = currentRSI < 30 ? '超卖' : currentRSI > 70 ? '超买' : '正常';

  // MA relationship
  const maBullish = !isNaN(currentMA20) && !isNaN(currentMA40) && currentMA20 > currentMA40;

  const chartData = prepareChartData(priceData, macdResult);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" />
              技术指标
            </CardTitle>
            <CardDescription>MACD / RSI / 均线系统</CardDescription>
          </div>
          <Badge variant="outline" className="text-[10px] gap-1">
            <ChevronRight className="size-3" />
            E6 进度 100%
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* MACD Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">MACD (12, 26, 9)</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${techStateColor}`}>
              {techStateLabel}
            </span>
          </div>

          {/* MACD value badges */}
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">MACD:</span>
            <span className={`font-mono font-medium ${currentMacd >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
              {currentMacd >= 0 ? '+' : ''}{currentMacd.toFixed(4)}
            </span>
            <span className="text-muted-foreground ml-2">Signal:</span>
            <span className={`font-mono font-medium ${currentSignal >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
              {currentSignal >= 0 ? '+' : ''}{currentSignal.toFixed(4)}
            </span>
            <span className="text-muted-foreground ml-2">Hist:</span>
            <span className={`font-mono font-medium ${currentHistogram >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
              {currentHistogram >= 0 ? '+' : ''}{currentHistogram.toFixed(4)}
            </span>
          </div>

          {/* MACD Histogram Chart */}
          <div className="h-[120px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                />
                <RechartsTooltip
                  contentStyle={{
                    fontSize: '10px',
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                  formatter={(value: number, name: string) => {
                    const label = name === 'histogram' ? '柱状' : name === 'macd' ? 'MACD' : 'Signal';
                    return [value.toFixed(4), label];
                  }}
                />
                <Bar dataKey="histogram" radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={`hist-${index}`} fill={entry.histogram >= 0 ? '#10b981' : '#ef4444'} />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="macd"
                  stroke="#0d9488"
                  dot={false}
                  strokeWidth={1.5}
                />
                <Line
                  type="monotone"
                  dataKey="signal"
                  stroke="#f59e0b"
                  dot={false}
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <Separator />

        {/* RSI + MA Section */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Gauge className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">RSI / 均线系统</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {/* RSI */}
            <div className="rounded-lg border p-2.5 space-y-1">
              <div className="text-[10px] text-muted-foreground">RSI (14)</div>
              <div className="flex items-baseline gap-1.5">
                <span className={`text-sm font-mono font-semibold ${rsiColor}`}>
                  {currentRSI.toFixed(1)}
                </span>
                <span className={`text-[10px] ${rsiColor}`}>
                  {rsiLabel}
                </span>
              </div>
            </div>

            {/* MA20 */}
            <div className="rounded-lg border p-2.5 space-y-1">
              <div className="text-[10px] text-muted-foreground">MA20</div>
              <span className="text-sm font-mono font-semibold">
                {isNaN(currentMA20) ? '—' : currentMA20.toFixed(4)}
              </span>
            </div>

            {/* MA40 */}
            <div className="rounded-lg border p-2.5 space-y-1">
              <div className="text-[10px] text-muted-foreground">MA40</div>
              <span className="text-sm font-mono font-semibold">
                {isNaN(currentMA40) ? '—' : currentMA40.toFixed(4)}
              </span>
            </div>

            {/* MA Relationship */}
            <div className="rounded-lg border p-2.5 space-y-1">
              <div className="text-[10px] text-muted-foreground">均线排列</div>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                maBullish
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              }`}>
                {maBullish ? '多头排列' : '空头排列'}
              </span>
            </div>
          </div>
        </div>

        <Separator />

        <p className="text-[10px] text-muted-foreground/60">数据来源: 模拟技术指标（仅供展示）</p>
      </CardContent>
    </Card>
  );
}

/** Data Lineage card */
function DataLineage({ meta }: { meta: EtfMeta }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="size-4 text-slate-500" />
          数据溯源
        </CardTitle>
        <CardDescription>数据源与更新频率</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2">
          {[
            { name: '东方财富', type: '网页采集', status: 'primary', quality: 92 },
            { name: '天天基金', type: 'API', status: 'backup', quality: 88 },
            { name: '新浪财经', type: '网页采集', status: 'degraded', quality: 65 },
          ].map((source) => (
            <div key={source.name} className="flex items-center justify-between rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${source.status === 'primary' ? 'bg-emerald-500' : source.status === 'backup' ? 'bg-slate-400' : 'bg-amber-500'}`} />
                <div>
                  <span className="text-xs font-medium">{source.name}</span>
                  <span className="text-[10px] text-muted-foreground ml-1.5">{source.type}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {source.status === 'primary' && <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300">主源</Badge>}
                <span className="text-[10px] font-mono text-muted-foreground">质量 {source.quality}</span>
              </div>
            </div>
          ))}
        </div>
        <Separator />
        <div className="text-[10px] text-muted-foreground space-y-0.5">
          <p>ETF: {meta.name} ({meta.code}) · {meta.category}</p>
          <p>采集频率: 每交易日 15:30 后自动采集</p>
          <p>上次采集: {new Date().toLocaleString('zh-CN')}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** ETF Comparison Table — all 6 ETFs side by side */
function EtfComparisonTable({ configs }: { configs: EtfConfigWithSnapshot[] }) {
  if (configs.length === 0) return null;

  const totalMarketValue = configs.reduce(
    (sum, c) => sum + (c.latestSnapshot?.marketValueYuan ?? 0), 0
  );

  // Budget utilization: compare total holdings against a target (use 105% of current as reference ceiling)
  const budgetTarget = totalMarketValue > 0 ? totalMarketValue * 1.05 : 1;
  const budgetUtilPct = (totalMarketValue / budgetTarget) * 100;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <TableProperties className="size-4 text-emerald-600" />
              ETF 对比
            </CardTitle>
            <CardDescription className="mt-1">6 只 ETF 全景对比视图</CardDescription>
          </div>
          {/* Budget utilization indicator */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">组合预算利用率</span>
            <div className="w-20">
              <Progress
                value={Math.min(100, budgetUtilPct)}
                className="h-2"
              />
            </div>
            <span className={`text-xs font-mono font-semibold ${budgetUtilPct > 95 ? 'text-red-600' : budgetUtilPct > 85 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {budgetUtilPct.toFixed(1)}%
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-[10px] text-muted-foreground">ETF</TableHead>
              <TableHead className="text-[10px] text-muted-foreground">类别</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">目标比例</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">当前市值</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">实际比例</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">偏离</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">最新净值</TableHead>
              <TableHead className="text-[10px] text-muted-foreground">估值状态</TableHead>
              <TableHead className="text-[10px] text-muted-foreground text-right">质量分</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configs.map(config => {
              const m = ETF_METADATA[config.code];
              if (!m) return null;
              const valuation = generateMockValuation(m);
              const quality = generateMockQuality(m);
              const mv = config.latestSnapshot?.marketValueYuan ?? 0;
              const actualPct = totalMarketValue > 0 ? (mv / totalMarketValue) * 100 : 0;
              const deviation = actualPct - (config.targetRatioPercent ?? 0);
              const absDeviation = Math.abs(deviation);
              const devColor = absDeviation > 5
                ? 'text-red-600 dark:text-red-400'
                : absDeviation > 3
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground';
              const valLabel = valuation.pePercentile < 30 ? '低估' : valuation.pePercentile < 70 ? '中估' : '高估';
              const valBg = valuation.pePercentile < 30
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : valuation.pePercentile < 70
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
              const qBg = quality.totalScore >= 80
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : quality.totalScore >= 65
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';

              return (
                <TableRow key={config.code}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">{config.code}</span>
                      <span className="text-xs font-medium">{config.name.replace('ETF', '')}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[m.category] ?? ''}`}>{m.category}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs font-mono font-medium">{(config.targetRatioPercent ?? 0).toFixed(2)}%</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs font-mono">{mv > 0 ? formatMoney(mv) : '—'}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs font-mono font-medium">{actualPct.toFixed(2)}%</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={`text-xs font-mono font-semibold ${devColor}`}>
                      {deviation > 0 ? '+' : ''}{deviation.toFixed(2)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs font-mono">{m.baseNav.toFixed(4)}</span>
                  </TableCell>
                  <TableCell>
                    <Badge className={`text-[10px] px-1.5 py-0 ${valBg}`}>
                      {valLabel} {valuation.pePercentile.toFixed(0)}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge className={`text-[10px] px-1.5 py-0 ${qBg}`}>
                      {quality.totalScore}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {/* Footer with totals + legend */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span>总市值: <span className="font-mono font-medium text-foreground">{formatMoney(totalMarketValue)}</span></span>
            <Separator orientation="vertical" className="h-3 hidden sm:block" />
            <span>数据更新时间: <span className="font-mono">{new Date().toLocaleString('zh-CN')}</span></span>
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" /> 偏离 &lt;±3%</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-amber-500" /> 偏离 ±3-5%</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-red-500" /> 偏离 &gt;±5%</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Trends Tab ────────────────────────────────────────────────────────────

export function TrendsTab() {
  // Fetch ETF configs for real data
  const { data: configsRes } = useQuery({
    queryKey: ['etf-configs'],
    queryFn: () => fetch('/api/etf-configs').then(r => r.json()) as Promise<ApiResponse<EtfConfigWithSnapshot[]>>,
  });

  const etfConfigs = configsRes?.data ?? [];

  // Use API data for ETF list, fallback to metadata keys
  const etfList = useMemo(() => {
    if (etfConfigs.length > 0) {
      return etfConfigs.map(c => ({
        code: c.code,
        name: c.name,
        category: c.category,
      }));
    }
    // Fallback: use metadata keys
    return Object.values(ETF_METADATA).map(m => ({ code: m.code, name: m.name, category: m.category }));
  }, [etfConfigs]);

  const [selectedEtf, setSelectedEtf] = useState<string>('510300');
  const [timeRange, setTimeRange] = useState<number>(30);

  // Generate mock data for selected ETF
  const meta = useMemo(() => ETF_METADATA[selectedEtf] ?? Object.values(ETF_METADATA)[0], [selectedEtf]);
  const priceData = useMemo(() => generateMockPriceHistory(meta, timeRange), [meta, timeRange]);
  const valuationData = useMemo(() => generateMockValuation(meta), [meta]);
  const premiumData = useMemo(() => generateMockPremium(meta), [meta]);
  const dividendData = useMemo(() => generateMockDividend(meta), [meta]);
  const qualityData = useMemo(() => generateMockQuality(meta), [meta]);

  // Find current config for the selected ETF
  const currentConfig = useMemo(() => etfConfigs.find(c => c.code === selectedEtf), [etfConfigs, selectedEtf]);

  return (
    <div className="space-y-5">
      {/* ETF Selector */}
      <FadeInUp>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-emerald-600" />
            <h3 className="text-sm font-semibold">选择 ETF</h3>
          </div>
          <EtfSelector etfs={etfList} selected={selectedEtf} onSelect={setSelectedEtf} />
        </div>
      </FadeInUp>

      {/* Current ETF info banner — enhanced */}
      {currentConfig && (() => {
        const q = generateMockQuality(meta);
        const priceChange = priceData.length >= 2
          ? ((priceData[priceData.length - 1].nav - priceData[0].nav) / priceData[0].nav * 100)
          : 0;
        return (
          <FadeInUp delay={0.05}>
            <div className="rounded-lg border bg-card p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{currentConfig.code}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[meta.category] ?? ''}`}>{meta.category}</span>
              </div>
              <Separator orientation="vertical" className="h-4 hidden sm:block" />
              <div>
                <span className="text-muted-foreground">名称</span>
<<<<<<< Updated upstream
                <span className="ml-1.5 font-medium">{currentConfig.name}</span>
=======
                <span className="font-medium">{currentConfig.name}</span>
                {/* Mini sparkline */}
                <div className="inline-block w-20 h-8 hidden sm:block">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={priceData.slice(-14)}>
                      <Line
                        type="monotone"
                        dataKey="nav"
                        stroke={priceChange >= 0 ? '#10b981' : '#ef4444'}
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
>>>>>>> Stashed changes
              </div>
              <div>
                <span className="text-muted-foreground">目标比例</span>
                <span className="ml-1.5 font-mono font-semibold text-emerald-600">{(currentConfig.targetRatioPercent ?? 0).toFixed(2)}%</span>
              </div>
              <div>
                <span className="text-muted-foreground">最新市值</span>
                <span className="ml-1.5 font-mono">
                  {currentConfig.latestSnapshot ? formatMoney(currentConfig.latestSnapshot.marketValueYuan) : '—'}
                </span>
              </div>
              {currentConfig.latestSnapshot && (
                <div>
                  <span className="text-muted-foreground">快照日</span>
                  <span className="ml-1.5 font-mono">
                    {new Date(currentConfig.latestSnapshot.snapshotDate).toLocaleDateString('zh-CN')}
                  </span>
                </div>
              )}
              <Separator orientation="vertical" className="h-4 hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">质量</span>
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono font-semibold ${
                  q.totalScore >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : q.totalScore >= 65 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                }`}>{q.totalScore}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">趋势</span>
                <span className={`inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold ${priceChange >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {priceChange >= 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                  {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
                </span>
              </div>
            </div>
          </FadeInUp>
        );
      })()}

      {/* Time Range Selector + Price Trend Chart — full width */}
      <FadeInUp delay={0.1}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">时间范围</span>
            </div>
            <TimeRangeSelector range={timeRange} onRangeChange={setTimeRange} />
          </div>
          <PriceTrendChart data={priceData} range={timeRange} />
        </div>
      </FadeInUp>

      {/* Valuation + Premium / Dividend — 2 col on desktop */}
      <div className="grid gap-5 lg:grid-cols-2">
        <FadeInUp delay={0.15}>
          <ValuationGauge data={valuationData} />
        </FadeInUp>
        <FadeInUp delay={0.2}>
          {premiumData ? <PremiumSection data={premiumData} /> : <DividendSection data={dividendData} />}
        </FadeInUp>
      </div>

      {/* If both premium and dividend exist, show dividend in another row */}
      {premiumData && dividendData && (
        <FadeInUp delay={0.22}>
          <DividendSection data={dividendData} />
        </FadeInUp>
      )}

      {/* QDII Premium Alert Card — only for QDII ETFs */}
      {premiumData && (
        <FadeInUp delay={0.23}>
          <QdiiPremiumAlertCard data={premiumData} etfCode={selectedEtf} etfName={meta.name} />
        </FadeInUp>
      )}

      {/* Quality Score + Technical State — 2 col on desktop */}
      <div className="grid gap-5 lg:grid-cols-2">
        <FadeInUp delay={0.25}>
          <QualityScoreDisplay quality={qualityData} />
        </FadeInUp>
        <FadeInUp delay={0.3}>
          <TechnicalIndicatorsPanel priceData={priceData} meta={meta} />
        </FadeInUp>
      </div>

      {/* Real Data Quality from API */}
      <FadeInUp delay={0.35}>
        <DataQualityApiSection etfCode={selectedEtf} />
      </FadeInUp>

      {/* Data Lineage */}
      <FadeInUp delay={0.4}>
        <DataLineage meta={meta} />
      </FadeInUp>

      {/* ETF Comparison Table */}
      <FadeInUp delay={0.45}>
        <EtfComparisonTable configs={etfConfigs} />
      </FadeInUp>
    </div>
  );
}