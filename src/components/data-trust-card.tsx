'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Clock,
  Activity,
  Database,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import {
  getQualitySummary,
  getCrossCheckHistory,
  type QualityScoreItem,
} from '@/lib/api';
import { FadeInUp } from '@/lib/motion';

/* ---------- 颜色规范：emerald / amber / orange / red / slate ---------- */

type StatusColor = {
  label: string;
  text: string;
  bg: string;
  border: string;
  dot: string;
  progress: string;
};

function getScoreStatus(score: number): StatusColor {
  if (score >= 90) {
    return {
      label: '优秀',
      text: 'text-emerald-700 dark:text-emerald-400',
      bg: 'bg-emerald-50/60 dark:bg-emerald-950/30',
      border: 'border-emerald-200 dark:border-emerald-800/50',
      dot: 'bg-emerald-500',
      progress: '[&>[data-slot=progress-indicator]]:bg-emerald-500',
    };
  }
  if (score >= 75) {
    return {
      label: '可用',
      text: 'text-amber-700 dark:text-amber-400',
      bg: 'bg-amber-50/60 dark:bg-amber-950/30',
      border: 'border-amber-200 dark:border-amber-800/50',
      dot: 'bg-amber-500',
      progress: '[&>[data-slot=progress-indicator]]:bg-amber-500',
    };
  }
  if (score >= 60) {
    return {
      label: '可疑',
      text: 'text-orange-700 dark:text-orange-400',
      bg: 'bg-orange-50/60 dark:bg-orange-950/30',
      border: 'border-orange-200 dark:border-orange-800/50',
      dot: 'bg-orange-500',
      progress: '[&>[data-slot=progress-indicator]]:bg-orange-500',
    };
  }
  return {
    label: '不可用',
    text: 'text-red-700 dark:text-red-400',
    bg: 'bg-red-50/60 dark:bg-red-950/30',
    border: 'border-red-200 dark:border-red-800/50',
    dot: 'bg-red-500',
    progress: '[&>[data-slot=progress-indicator]]:bg-red-500',
  };
}

function getMetricStatusColor(
  status: QualityScoreItem['quality_status']
): { label: string; text: string; bg: string; border: string; dot: string } {
  switch (status) {
    case 'excellent':
      return {
        label: '优秀',
        text: 'text-emerald-700 dark:text-emerald-400',
        bg: 'bg-emerald-50/40 dark:bg-emerald-950/20',
        border: 'border-emerald-200/70 dark:border-emerald-800/40',
        dot: 'bg-emerald-500',
      };
    case 'usable':
      return {
        label: '可用',
        text: 'text-amber-700 dark:text-amber-400',
        bg: 'bg-amber-50/40 dark:bg-amber-950/20',
        border: 'border-amber-200/70 dark:border-amber-800/40',
        dot: 'bg-amber-500',
      };
    case 'suspicious':
      return {
        label: '可疑',
        text: 'text-orange-700 dark:text-orange-400',
        bg: 'bg-orange-50/40 dark:bg-orange-950/20',
        border: 'border-orange-200/70 dark:border-orange-800/40',
        dot: 'bg-orange-500',
      };
    case 'unavailable':
      return {
        label: '不可用',
        text: 'text-red-700 dark:text-red-400',
        bg: 'bg-red-50/40 dark:bg-red-950/20',
        border: 'border-red-200/70 dark:border-red-800/40',
        dot: 'bg-red-500',
      };
    default:
      return {
        label: '未知',
        text: 'text-slate-700 dark:text-slate-400',
        bg: 'bg-slate-50/40 dark:bg-slate-950/20',
        border: 'border-slate-200/70 dark:border-slate-800/40',
        dot: 'bg-slate-500',
      };
  }
}

/* ---------- 5 类指标分组（PRD §10.8 metric_type → 5 类展示） ---------- */

const METRIC_BUCKETS: { key: string; label: string; match: string[] }[] = [
  { key: 'price', label: '行情', match: ['price', 'market_index', 'market'] },
  { key: 'nav', label: '净值', match: ['nav'] },
  { key: 'premium', label: '溢价', match: ['premium'] },
  { key: 'valuation', label: '估值', match: ['valuation'] },
  { key: 'dividend', label: '股息', match: ['dividend'] },
];

function aggregateMetricBucket(
  items: QualityScoreItem[],
  match: string[]
): {
  total: number;
  best: QualityScoreItem['quality_status'];
  worst: QualityScoreItem['quality_status'];
  avgScore: number;
} {
  const bucket = items.filter((it) => match.includes(it.metric_type));
  if (bucket.length === 0) {
    return { total: 0, best: 'unavailable', worst: 'unavailable', avgScore: 0 };
  }
  // 用最差状态代表整组（保守）
  const order: Record<string, number> = {
    excellent: 4,
    usable: 3,
    suspicious: 2,
    unavailable: 1,
  };
  let worst: QualityScoreItem['quality_status'] = 'excellent';
  let best: QualityScoreItem['quality_status'] = 'unavailable';
  let sum = 0;
  for (const it of bucket) {
    if (order[it.quality_status] < order[worst]) worst = it.quality_status;
    if (order[it.quality_status] > order[best]) best = it.quality_status;
    sum += it.quality_score;
  }
  return {
    total: bucket.length,
    best,
    worst,
    avgScore: Math.round((sum / bucket.length) * 10) / 10,
  };
}

/* ---------- 工具：格式化时间 ---------- */

function formatTime(iso: string | null | undefined): string {
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

/* ---------- 子组件：5 类指标卡 ---------- */

function MetricTypeTile({
  label,
  total,
  worst,
  avgScore,
}: {
  label: string;
  total: number;
  worst: QualityScoreItem['quality_status'];
  avgScore: number;
}) {
  const c = getMetricStatusColor(worst);
  return (
    <div
      className={`rounded-md border ${c.border} ${c.bg} px-3 py-2 flex flex-col gap-1 min-w-0`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <span className={`inline-flex items-center gap-1 text-[10px] ${c.text}`}>
          <span className={`size-1.5 rounded-full ${c.dot}`} />
          {total === 0 ? '无数据' : c.label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`font-mono text-base font-bold ${c.text}`}>
          {total === 0 ? '—' : avgScore.toFixed(1)}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          / {total} 条
        </span>
      </div>
    </div>
  );
}

/* ---------- 主组件 ---------- */

export interface DataTrustCardProps {
  /** 外部传入的 quality 数据（可选）。若不传，组件内部用 useQuery 拉取 */
  data?: Awaited<ReturnType<typeof getQualitySummary>> | null;
  /** 是否加载中（仅当外部传入 data 时生效） */
  isLoading?: boolean;
  /** 是否出错（仅当外部传入 data 时生效） */
  isError?: boolean;
  /** 手动刷新回调（可选） */
  onRefresh?: () => void;
}

export function DataTrustCard({
  data,
  isLoading,
  isError,
  onRefresh,
}: DataTrustCardProps) {
  // 内部默认拉取，外部可覆盖
  const internalQuery = useQuery({
    queryKey: ['quality-summary'],
    queryFn: getQualitySummary,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const crossCheckQuery = useQuery({
    queryKey: ['cross-check-stats-for-trust'],
    queryFn: () => getCrossCheckHistory({ stats: true, limit: 1 }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const summary = data ?? internalQuery.data ?? null;
  const loading = data ? !!isLoading : internalQuery.isLoading;
  const error = data ? !!isError : internalQuery.isError;

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh();
    } else {
      internalQuery.refetch();
      crossCheckQuery.refetch();
    }
  };

  if (loading) {
    return <DataTrustCardSkeleton />;
  }

  if (error || !summary) {
    return (
      <Card className="shadow-card">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 text-red-500" />
            <span>数据质量信息加载失败</span>
            <button
              type="button"
              onClick={handleRefresh}
              className="ml-auto text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
            >
              重试
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const score = summary.avg_score;
  const status = getScoreStatus(score);
  const items: QualityScoreItem[] = summary.items || [];
  const totalMetrics = summary.total_metrics || items.length;

  // 主备源一致性：cross-check stats
  // V4.1 BUG-2026-06-QUALITY: 区分"单源降级"和"双源失败"
  // - passed: 主备源都有值且一致 → 通过
  // - inconsistent: 主备源都有值但不一致 → 不一致
  // - backup_failed + primary_failed: 一源成功一源失败 → 单源降级（数据仍可用，不等于失败）
  // - both_failed: 主备源均失败 → 失败（数据不可用）
  const ccStats = crossCheckQuery.data?.stats;
  const ccLoading = crossCheckQuery.isLoading;
  const ccPassed = ccStats?.passed ?? 0;
  const ccInconsistent = ccStats?.inconsistent ?? 0;
  // 单源降级 = primary_failed + backup_failed（一源成功，数据仍可用）
  const ccSingleSource =
    (ccStats?.primary_failed ?? 0) + (ccStats?.backup_failed ?? 0);
  // 失败 = both_failed（主备源均失败，数据不可用）
  const ccFailed = ccStats?.both_failed ?? 0;
  const ccTotal = ccStats?.total ?? 0;

  // 缓存更新时间：取 items 里最新 created_at
  let latestUpdated = '';
  for (const it of items) {
    const t = it.created_at || it.trade_date || '';
    if (t && t > latestUpdated) latestUpdated = t;
  }

  // 异常指标数：quality_status != 'excellent' && != 'usable'
  const abnormalCount = items.filter(
    (it) => it.quality_status !== 'excellent' && it.quality_status !== 'usable'
  ).length;

  return (
    <FadeInUp delay={0.05}>
      <Card className="shadow-card overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center justify-center rounded-lg bg-emerald-50/60 dark:bg-emerald-950/40 p-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              <CardTitle className="text-sm font-semibold">
                数据可信度总览
              </CardTitle>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 rounded-full text-muted-foreground"
              >
                {totalMetrics} 条指标
              </Badge>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              aria-label="刷新数据质量"
            >
              <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">刷新</span>
            </button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* 第 1 行：质量总分 + 是否允许出建议（grid 2 列 mobile / 3 列 sm+） */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* 区 1：质量总分大数字 + 状态色 */}
            <div
              className={`sm:col-span-2 rounded-lg border ${status.border} ${status.bg} px-4 py-3 flex items-center gap-4 min-w-0`}
            >
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Activity className="size-3" />
                  质量总分
                </span>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className={`font-mono text-4xl font-bold leading-none ${status.text}`}>
                    {score.toFixed(1)}
                  </span>
                  <span className="text-sm text-muted-foreground">/ 100</span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 rounded-full ${status.text} ${status.border} ${status.bg}`}
                  >
                    {status.label}
                  </Badge>
                </div>
                <div className="mt-2">
                  <Progress
                    value={score}
                    className={`h-1.5 ${status.progress}`}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    优秀 {summary.excellent ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <span className="size-1.5 rounded-full bg-amber-500" />
                    可用 {summary.usable ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <span className="size-1.5 rounded-full bg-orange-500" />
                    可疑 {summary.suspicious ?? 0}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <span className="size-1.5 rounded-full bg-red-500" />
                    不可用 {summary.unavailable ?? 0}
                  </span>
                </div>
              </div>
            </div>

            {/* 区 2：是否允许出建议（两个开关） */}
            <div className="rounded-lg border border-border/60 bg-muted/20 dark:bg-muted/10 px-4 py-3 flex flex-col justify-between gap-2 min-w-0">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <ShieldCheck className="size-3" />
                是否允许出建议
              </span>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground/80">买入建议</span>
                  <div className="flex items-center gap-1.5">
                    {summary.allow_buy_suggestion ? (
                      <CheckCircle2 className="size-3 text-emerald-500" />
                    ) : (
                      <XCircle className="size-3 text-red-500" />
                    )}
                    <Switch
                      checked={!!summary.allow_buy_suggestion}
                      disabled
                      aria-label="允许出买入建议"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground/80">再平衡建议</span>
                  <div className="flex items-center gap-1.5">
                    {summary.allow_rebalance_suggestion ? (
                      <CheckCircle2 className="size-3 text-emerald-500" />
                    ) : (
                      <XCircle className="size-3 text-red-500" />
                    )}
                    <Switch
                      checked={!!summary.allow_rebalance_suggestion}
                      disabled
                      aria-label="允许出再平衡建议"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 区 3：5 类指标状态（行情/净值/溢价/估值/股息） */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Database className="size-3" />
              <span>5 类指标状态</span>
              <span className="text-[10px] text-muted-foreground/60">
                （取每组最差状态，保守判定）
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {METRIC_BUCKETS.map((b) => {
                const agg = aggregateMetricBucket(items, b.match);
                return (
                  <MetricTypeTile
                    key={b.key}
                    label={b.label}
                    total={agg.total}
                    worst={agg.worst}
                    avgScore={agg.avgScore}
                  />
                );
              })}
            </div>
          </div>

          {/* 区 4 + 5 + 6：主备源一致性 / 缓存更新时间 / 异常指标数 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* 区 4：主备源一致性 */}
            <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3 min-w-0">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1 mb-1.5">
                <CheckCircle2 className="size-3" />
                主备源一致性
              </div>
              {ccLoading ? (
                <Skeleton className="h-7 w-full" />
              ) : (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    <span className="font-mono text-base font-bold text-emerald-700 dark:text-emerald-400">
                      {ccPassed}
                    </span>
                    <span className="text-[10px] text-muted-foreground">通过</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-amber-500" />
                    <span className="font-mono text-base font-bold text-amber-700 dark:text-amber-400">
                      {ccInconsistent}
                    </span>
                    <span className="text-[10px] text-muted-foreground">不一致</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-sky-500" />
                    <span className="font-mono text-base font-bold text-sky-700 dark:text-sky-400">
                      {ccSingleSource}
                    </span>
                    <span className="text-[10px] text-muted-foreground">单源</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-red-500" />
                    <span className="font-mono text-base font-bold text-red-700 dark:text-red-400">
                      {ccFailed}
                    </span>
                    <span className="text-[10px] text-muted-foreground">失败</span>
                  </span>
                </div>
              )}
              <div className="text-[10px] text-muted-foreground/70 mt-1">
                共 {ccTotal} 次校验 · 单源=主源可用备源未配置
              </div>
            </div>

            {/* 区 5：缓存更新时间 */}
            <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3 min-w-0">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1 mb-1.5">
                <Clock className="size-3" />
                缓存更新时间
              </div>
              <div className="font-mono text-sm font-medium text-foreground">
                {formatTime(latestUpdated)}
              </div>
              <div className="text-[10px] text-muted-foreground/70 mt-1">
                最近一次质量评分写入
              </div>
            </div>

            {/* 区 6：异常指标数 */}
            <div
              className={`rounded-lg border px-4 py-3 min-w-0 ${
                abnormalCount > 0
                  ? 'border-orange-200 dark:border-orange-800/50 bg-orange-50/40 dark:bg-orange-950/20'
                  : 'border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/40 dark:bg-emerald-950/20'
              }`}
            >
              <div
                className={`text-[11px] flex items-center gap-1 mb-1.5 ${
                  abnormalCount > 0
                    ? 'text-orange-700 dark:text-orange-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                <AlertTriangle className="size-3" />
                异常指标数
              </div>
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`font-mono text-2xl font-bold ${
                    abnormalCount > 0
                      ? 'text-orange-700 dark:text-orange-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {abnormalCount}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  / {totalMetrics} 条
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground/70 mt-1">
                {abnormalCount > 0
                  ? '可疑 + 不可用合计，需关注'
                  : '全部优秀或可用，正常'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </FadeInUp>
  );
}

/* ---------- Skeleton ---------- */

function DataTrustCardSkeleton() {
  return (
    <Card className="shadow-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Skeleton className="sm:col-span-2 h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-32" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-md" />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}
