'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  PiggyBank,
  Award,
  BarChart3,
  RefreshCw,
  Info,
} from 'lucide-react';
import { getPortfolioPerformance, type PortfolioPerformance } from '@/lib/api';
import { FadeInUp } from '@/lib/motion';

function formatYuan(v: number): string {
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

function formatPct(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  } catch {
    return iso;
  }
}

interface MetricTileProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'emerald' | 'red' | 'amber' | 'sky' | 'slate';
  strong?: boolean;
}

const TONE_CLASSES: Record<
  MetricTileProps['tone'],
  { border: string; bg: string; text: string; iconWrap: string }
> = {
  emerald: {
    border: 'border-emerald-200 dark:border-emerald-800/50',
    bg: 'bg-emerald-50/60 dark:bg-emerald-950/30',
    text: 'text-emerald-700 dark:text-emerald-400',
    iconWrap: 'bg-emerald-100/70 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
  },
  red: {
    border: 'border-red-200 dark:border-red-800/50',
    bg: 'bg-red-50/60 dark:bg-red-950/30',
    text: 'text-red-700 dark:text-red-400',
    iconWrap: 'bg-red-100/70 dark:bg-red-900/50 text-red-600 dark:text-red-400',
  },
  amber: {
    border: 'border-amber-200 dark:border-amber-800/50',
    bg: 'bg-amber-50/60 dark:bg-amber-950/30',
    text: 'text-amber-700 dark:text-amber-400',
    iconWrap: 'bg-amber-100/70 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400',
  },
  sky: {
    border: 'border-sky-200 dark:border-sky-800/50',
    bg: 'bg-sky-50/60 dark:bg-sky-950/30',
    text: 'text-sky-700 dark:text-sky-400',
    iconWrap: 'bg-sky-100/70 dark:bg-sky-900/50 text-sky-600 dark:text-sky-400',
  },
  slate: {
    border: 'border-border/60',
    bg: 'bg-muted/20 dark:bg-muted/10',
    text: 'text-foreground',
    iconWrap: 'bg-muted/60 text-muted-foreground',
  },
};

function MetricTile({ label, value, sub, icon: Icon, tone, strong }: MetricTileProps) {
  const c = TONE_CLASSES[tone];
  return (
    <div className={`rounded-lg border ${c.border} ${c.bg} px-4 py-3 min-w-0`}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
        <span className={`inline-flex items-center justify-center rounded-md p-0.5 ${c.iconWrap}`}>
          <Icon className="size-3" />
        </span>
        <span>{label}</span>
      </div>
      <div
        className={`font-mono leading-tight ${strong ? 'text-2xl font-bold' : 'text-lg font-bold'} ${c.text}`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground/80 mt-1">{sub}</div>
      )}
    </div>
  );
}

function PortfolioChart({ data }: { data: PortfolioPerformance['history'] }) {
  const chartData = data.map((p) => ({
    date: formatShortDate(p.date),
    invested: Math.round(p.invested),
    value: Math.round(p.value),
  }));

  return (
    <div className="h-64 w-full" style={{ minWidth: 300 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            width={56}
            tickFormatter={(v: number) => `${(v / 10000).toFixed(1)}万`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(255,255,255,0.96)',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '12px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}
            formatter={(value: number, name: string) => {
              if (name === 'invested') return [formatYuan(value), '累计投入'];
              if (name === 'value') return [formatYuan(value), '当前市值'];
              return [value, name];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value: string) =>
              value === 'invested' ? '累计投入' : value === 'value' ? '当前市值' : value
            }
          />
          <Line
            type="monotone"
            dataKey="invested"
            stroke="#94a3b8"
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: '#94a3b8', stroke: '#fff', strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#14b8a6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#14b8a6', stroke: '#fff', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PortfolioPerformanceCardSkeleton() {
  return (
    <Card className="shadow-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </CardContent>
    </Card>
  );
}

export interface PortfolioPerformanceCardProps {
  /** 是否有持仓。无持仓时显示空状态 */
  hasHoldings: boolean;
}

export function PortfolioPerformanceCard({ hasHoldings }: PortfolioPerformanceCardProps) {
  const query = useQuery({
    queryKey: ['portfolio-performance'],
    queryFn: getPortfolioPerformance,
    enabled: hasHoldings,
    staleTime: 60_000,
  });

  // 无持仓：显示空状态
  if (!hasHoldings) {
    return (
      <FadeInUp delay={0.05}>
        <Card className="shadow-card overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-lg bg-sky-50/60 dark:bg-sky-950/40 p-1.5">
                <BarChart3 className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              </span>
              <CardTitle className="text-sm font-semibold">投资收益追踪</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-32 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
              <Info className="size-5 text-muted-foreground/60" />
              <span>上传持仓后可查看收益追踪</span>
            </div>
          </CardContent>
        </Card>
      </FadeInUp>
    );
  }

  if (query.isLoading) {
    return <PortfolioPerformanceCardSkeleton />;
  }

  // 接口出错或返回空数据：显示提示
  // 空数据判定：无 history 且累计投入/市值均为 0（可能是后端尚未实现或无执行记录）
  const isEmptyData =
    !query.data ||
    ((query.data.history?.length ?? 0) === 0 &&
      (query.data.totalInvested ?? 0) === 0 &&
      (query.data.totalValue ?? 0) === 0);

  if (query.isError || isEmptyData) {
    return (
      <FadeInUp delay={0.05}>
        <Card className="shadow-card overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex items-center justify-center rounded-lg bg-sky-50/60 dark:bg-sky-950/40 p-1.5">
                  <BarChart3 className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                </span>
                <CardTitle className="text-sm font-semibold">投资收益追踪</CardTitle>
              </div>
              <button
                type="button"
                onClick={() => query.refetch()}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                aria-label="刷新收益追踪"
              >
                <RefreshCw className="size-3" />
                <span className="hidden sm:inline">刷新</span>
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-32 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
              <Info className="size-5 text-muted-foreground/60" />
              <span>暂无收益数据，请确认数据服务已启动并已记录执行历史</span>
            </div>
          </CardContent>
        </Card>
      </FadeInUp>
    );
  }

  const perf = query.data;
  const hasHistory = (perf.history?.length ?? 0) > 0;
  const isProfit = perf.totalReturn >= 0;
  const vsBenchmarkPositive = perf.vsBenchmark >= 0;

  return (
    <FadeInUp delay={0.05}>
      <Card className="shadow-card overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center justify-center rounded-lg bg-sky-50/60 dark:bg-sky-950/40 p-1.5">
                <BarChart3 className="h-4 w-4 text-sky-600 dark:text-sky-400" />
              </span>
              <CardTitle className="text-sm font-semibold">投资收益追踪</CardTitle>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 rounded-full text-muted-foreground"
              >
                {hasHistory ? `${perf.history.length} 个时点` : '无历史'}
              </Badge>
            </div>
            <button
              type="button"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              aria-label="刷新收益追踪"
            >
              <RefreshCw className={`size-3 ${query.isFetching ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">刷新</span>
            </button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* 5 项指标 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <MetricTile
              label="累计投入"
              value={formatYuan(perf.totalInvested)}
              icon={PiggyBank}
              tone="slate"
              strong
            />
            <MetricTile
              label="当前市值"
              value={formatYuan(perf.totalValue)}
              icon={Wallet}
              tone="sky"
              strong
            />
            <MetricTile
              label="累计收益"
              value={`${isProfit ? '+' : ''}${formatYuan(perf.totalReturn)}`}
              sub={formatPct(perf.totalReturnPct)}
              icon={isProfit ? TrendingUp : TrendingDown}
              tone={isProfit ? 'emerald' : 'red'}
              strong
            />
            <MetricTile
              label="年化收益"
              value={formatPct(perf.annualReturn)}
              icon={TrendingUp}
              tone={perf.annualReturn >= 0 ? 'emerald' : 'red'}
            />
            <MetricTile
              label="跑赢沪深300"
              value={`${vsBenchmarkPositive ? '+' : ''}${perf.vsBenchmark.toFixed(2)}%`}
              icon={Award}
              tone={vsBenchmarkPositive ? 'emerald' : 'amber'}
            />
          </div>

          {/* 收益曲线 */}
          {hasHistory ? (
            <PortfolioChart data={perf.history} />
          ) : (
            <div className="h-32 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
              <Info className="size-5 text-muted-foreground/60" />
              <span>暂无收益历史曲线</span>
            </div>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}
