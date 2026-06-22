'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Database,
  CheckCircle2,
  XCircle,
  GitBranch,
  AlertCircle,
} from 'lucide-react';
import {
  getDataLineage,
  getQualityByCode,
  type DataLineage,
  type QualityScoreItem,
} from '@/lib/api';

// ─── Valuation / Dividend code 映射（指数代码）───────────────────────────────
// ETF_CODE → INDEX_CODE 用于 valuation / dividend 类型的血缘查询
const ETF_TO_INDEX_CODE: Record<string, string> = {
  '159338': '000510', // 中证A500 → 中证A500指数
  '510880': '000015', // 红利ETF → 上证红利指数
  '510330': '000300', // 沪深300 → 沪深300指数
  '588000': '000688', // 科创50 → 科创50指数
  '513500': 'SPI',    // 标普500
  '513300': 'IXIC',   // 纳斯达克
};

const DATA_TYPE_LABEL: Record<string, string> = {
  valuation: '估值',
  premium: '溢价',
  nav: '净值',
  dividend: '股息',
  price: '行情',
};

// ─── 质量分颜色映射（0-100）───────────────────────────────────────────────────
function getQualityScoreBadgeClass(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return 'text-slate-600 bg-slate-100 border-slate-300 dark:text-slate-400 dark:bg-slate-900/40 dark:border-slate-700';
  }
  if (score >= 90) {
    return 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:text-emerald-400 dark:bg-emerald-950/40 dark:border-emerald-800';
  }
  if (score >= 75) {
    return 'text-amber-700 bg-amber-100 border-amber-300 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-800';
  }
  if (score >= 60) {
    return 'text-orange-700 bg-orange-100 border-orange-300 dark:text-orange-400 dark:bg-orange-950/40 dark:border-orange-800';
  }
  return 'text-red-700 bg-red-100 border-red-300 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800';
}

function getQualityScoreTextClass(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'text-muted-foreground';
  if (score >= 90) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 75) return 'text-amber-600 dark:text-amber-400';
  if (score >= 60) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}

// ─── 辅助：从 quality items 中取最新一条匹配 metric_type ─────────────────────
function pickLatestQualityItem(
  items: QualityScoreItem[] | undefined,
  metricType: string
): QualityScoreItem | undefined {
  if (!items || items.length === 0) return undefined;
  const filtered = items.filter((it) => it.metric_type === metricType);
  if (filtered.length === 0) return undefined;
  // 按 created_at 倒序取最新一条
  return filtered.sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || '')
  )[0];
}

// ─── 子组件：单行血缘信息 ─────────────────────────────────────────────────────
function LineageRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div
        className={`text-[11px] truncate ${mono ? 'font-mono' : ''}`}
        title={value ?? '—'}
      >
        {value ?? '—'}
      </div>
    </div>
  );
}

// ─── 主组件：数据血缘 Popover ────────────────────────────────────────────────
export interface TrendLineagePopoverProps {
  /** ETF 代码（如 159338） */
  etfCode: string;
  /** 数据类型：valuation | premium | nav | dividend | price */
  dataType: string;
  /** 触发按钮文字（默认"数据血缘"） */
  label?: string;
  /** 触发按钮尺寸 */
  size?: 'sm' | 'default';
}

export function TrendLineagePopover({
  etfCode,
  dataType,
  label = '数据血缘',
  size = 'sm',
}: TrendLineagePopoverProps) {
  const [open, setOpen] = useState(false);

  // valuation / dividend 类型 code 需要映射为指数代码
  const queryCode =
    dataType === 'valuation' || dataType === 'dividend'
      ? ETF_TO_INDEX_CODE[etfCode] ?? etfCode
      : etfCode;

  // 血缘查询（仅在 popover 打开时触发）
  const lineageQuery = useQuery<DataLineage>({
    queryKey: ['trend-lineage', queryCode, dataType],
    queryFn: () => getDataLineage(queryCode, dataType),
    enabled: open && !!queryCode && !!dataType,
    staleTime: 60 * 1000,
  });

  // 质量评分查询（取该 code 下所有 metric_type 的质量分，本地过滤）
  const qualityQuery = useQuery<{
    items: QualityScoreItem[];
  }>({
    queryKey: ['trend-quality-by-code', queryCode],
    queryFn: () => getQualityByCode(queryCode),
    enabled: open && !!queryCode,
    staleTime: 60 * 1000,
  });

  const lineage = lineageQuery.data;
  const qualityItem = pickLatestQualityItem(qualityQuery.data?.items, dataType);
  const isLoading = lineageQuery.isLoading || qualityQuery.isLoading;
  const isError = lineageQuery.isError;
  const notFound = lineageQuery.isFetched && !lineage?.found;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground"
          aria-label={`${label}: ${etfCode} ${DATA_TYPE_LABEL[dataType] ?? dataType}`}
        >
          <Database className="size-3" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[320px] p-3 max-w-[calc(100vw-2rem)]"
      >
        <div className="space-y-3">
          {/* 标题行 */}
          <div className="flex items-center justify-between gap-2 pb-2 border-b">
            <div className="flex items-center gap-1.5 min-w-0">
              <GitBranch className="size-3.5 text-emerald-600 shrink-0" />
              <span className="text-xs font-medium truncate">
                数据血缘 · {DATA_TYPE_LABEL[dataType] ?? dataType}
              </span>
            </div>
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 font-mono shrink-0"
            >
              code: {queryCode}
            </Badge>
          </div>

          {/* 加载状态 */}
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {/* 错误状态 */}
          {isError && !isLoading && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <AlertCircle className="size-5 text-red-500" />
              <div className="text-[11px] text-muted-foreground">
                血缘查询失败，请稍后重试
              </div>
            </div>
          )}

          {/* 未找到 */}
          {notFound && !isLoading && !isError && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <AlertCircle className="size-5 text-amber-500" />
              <div className="text-[11px] text-muted-foreground">
                {lineage?.message || '未找到该数据的缓存记录'}
              </div>
            </div>
          )}

          {/* 正常展示 */}
          {lineage?.found && !isLoading && !isError && (
            <>
              {/* 数值信息 */}
              <div className="space-y-1.5">
                <div className="text-[10px] font-medium text-muted-foreground/80">
                  数值信息
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <LineageRow
                    label="原始值"
                    value={lineage.raw_value ?? null}
                    mono
                  />
                  <LineageRow
                    label="清洗值"
                    value={
                      lineage.clean_value != null
                        ? String(lineage.clean_value)
                        : null
                    }
                    mono
                  />
                </div>
              </div>

              {/* 数据源 */}
              <div className="space-y-1.5">
                <div className="text-[10px] font-medium text-muted-foreground/80">
                  数据来源
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <LineageRow label="源适配器" value={lineage.source} mono />
                  <LineageRow label="源 API" value={lineage.source_api} mono />
                </div>
              </div>

              {/* 质量评分 */}
              <div className="space-y-1.5">
                <div className="text-[10px] font-medium text-muted-foreground/80">
                  数据质量
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 ${getQualityScoreBadgeClass(
                      qualityItem?.quality_score
                    )}`}
                    title={
                      qualityItem
                        ? `质量分 ${qualityItem.quality_score}（freshness=${qualityItem.freshness_score}, consistency=${qualityItem.consistency_score}, completeness=${qualityItem.completeness_score}）`
                        : '暂无质量评分记录'
                    }
                  >
                    质量分:{' '}
                    <span
                      className={`ml-1 font-mono font-bold ${getQualityScoreTextClass(
                        qualityItem?.quality_score
                      )}`}
                    >
                      {qualityItem?.quality_score != null
                        ? qualityItem.quality_score.toFixed(0)
                        : '—'}
                    </span>
                    /100
                  </Badge>

                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 ${
                      lineage.is_valid
                        ? 'text-emerald-700 bg-emerald-100 border-emerald-300 dark:text-emerald-400 dark:bg-emerald-950/40 dark:border-emerald-800'
                        : 'text-red-700 bg-red-100 border-red-300 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800'
                    }`}
                  >
                    {lineage.is_valid ? (
                      <CheckCircle2 className="size-2.5 mr-0.5" />
                    ) : (
                      <XCircle className="size-2.5 mr-0.5" />
                    )}
                    {lineage.is_valid ? '有效' : '异常'}
                  </Badge>
                </div>

                {/* 异常原因 */}
                {lineage.abnormal_reason && (
                  <div className="text-[10px] text-red-700 dark:text-red-400 italic bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 rounded px-1.5 py-1">
                    {lineage.abnormal_reason}
                  </div>
                )}

                {/* 质量评分理由（来自 quality item） */}
                {qualityItem?.reason && (
                  <div className="text-[10px] text-muted-foreground/80 italic bg-muted/40 rounded px-1.5 py-1">
                    {qualityItem.reason}
                  </div>
                )}
              </div>

              {/* 元信息 */}
              <div className="pt-2 border-t flex items-center justify-between gap-2 text-[9px] text-muted-foreground/70">
                <span className="font-mono">
                  日期: {lineage.date ?? lineage.trade_date ?? '—'}
                </span>
                {lineage.fetch_time && (
                  <span className="font-mono truncate" title={lineage.fetch_time}>
                    拉取: {lineage.fetch_time.slice(0, 16).replace('T', ' ')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default TrendLineagePopover;
