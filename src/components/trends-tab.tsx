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
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip as ShadcnTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

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
  const status = premium > 5 ? 'high' : premium > 2 ? 'elevated' : 'normal';
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

/** 30-day price trend chart */
function PriceTrendChart({ data }: { data: PricePoint[] }) {
  const isUp = data.length > 1 && data[data.length - 1].nav >= data[0].nav;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="size-4 text-emerald-600" />
              30日价格走势
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

/** Technical State placeholder */
function TechnicalStatePlaceholder() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          技术指标
        </CardTitle>
        <CardDescription>MACD / RSI / 均线系统</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center py-10 text-center space-y-3">
          <div className="size-14 rounded-xl bg-muted/50 flex items-center justify-center">
            <Activity className="size-6 text-muted-foreground/40" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">技术指标模块开发中</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Sprint 3 — MACD / RSI / 均线 / KDJ</p>
          </div>
          <Badge variant="outline" className="text-[10px] gap-1">
            <ChevronRight className="size-3" />
            E6 进度 0%
          </Badge>
        </div>
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

  // Generate mock data for selected ETF
  const meta = useMemo(() => ETF_METADATA[selectedEtf] ?? Object.values(ETF_METADATA)[0], [selectedEtf]);
  const priceData = useMemo(() => generateMockPriceHistory(meta), [meta]);
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

      {/* Current ETF info banner */}
      {currentConfig && (
        <FadeInUp delay={0.05}>
          <div className="rounded-lg border bg-card p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div>
              <span className="text-muted-foreground">代码</span>
              <span className="ml-1.5 font-mono font-semibold">{currentConfig.code}</span>
            </div>
            <div>
              <span className="text-muted-foreground">名称</span>
              <span className="ml-1.5 font-medium">{currentConfig.name}</span>
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
          </div>
        </FadeInUp>
      )}

      {/* Price Trend Chart — full width */}
      <FadeInUp delay={0.1}>
        <PriceTrendChart data={priceData} />
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

      {/* Quality Score + Technical State — 2 col on desktop */}
      <div className="grid gap-5 lg:grid-cols-2">
        <FadeInUp delay={0.25}>
          <QualityScoreDisplay quality={qualityData} />
        </FadeInUp>
        <FadeInUp delay={0.3}>
          <TechnicalStatePlaceholder />
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
    </div>
  );
}