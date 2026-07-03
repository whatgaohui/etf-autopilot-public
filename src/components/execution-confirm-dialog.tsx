'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  confirmExecution,
  type ExecutionStatus,
} from '@/lib/api';
import type { AdviceSuggestion } from '@/lib/types';

// Cash reserve + gold codes excluded from investment decisions
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

function formatYuan(v: number): string {
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

interface ExecutionRowState {
  etfCode: string;
  etfName: string;
  plannedAmount: number;
  actualAmount: string;
  status: ExecutionStatus;
}

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  executed: '已执行',
  skipped: '已跳过',
  partial: '部分执行',
};

const STATUS_STYLE: Record<ExecutionStatus, string> = {
  executed:
    'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40',
  skipped:
    'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40',
  partial:
    'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40',
};

export interface ExecutionConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calculationId: string;
  suggestions: AdviceSuggestion[];
  /** 确认成功后的回调（用于刷新数据等） */
  onConfirmed?: () => void;
}

export function ExecutionConfirmDialog({
  open,
  onOpenChange,
  calculationId,
  suggestions,
  onConfirmed,
}: ExecutionConfirmDialogProps) {
  // 仅展示"建议买入"的投资标的（剔除 511990 华宝添益 / 518880 黄金ETF）
  const buySuggestions = useMemo(
    () =>
      (suggestions || [])
        .filter((s) => !NON_INVESTMENT_CODES.has(s.code))
        .filter((s) => (s.amount ?? 0) > 0),
    [suggestions]
  );

  const [rows, setRows] = useState<ExecutionRowState[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开弹窗或建议列表变化时，重置表单
  useEffect(() => {
    if (open) {
      setRows(
        buySuggestions.map((s) => ({
          etfCode: s.code,
          etfName: s.name,
          plannedAmount: s.amount,
          actualAmount: String(s.amount),
          status: 'executed' as ExecutionStatus,
        }))
      );
    }
  }, [open, buySuggestions]);

  const updateRow = (idx: number, patch: Partial<ExecutionRowState>) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    );
  };

  const totalPlanned = rows.reduce((sum, r) => sum + r.plannedAmount, 0);
  const totalActual = rows.reduce((sum, r) => {
    const v = parseFloat(r.actualAmount);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
  const deviation = totalActual - totalPlanned;

  const handleConfirm = async () => {
    if (!calculationId) {
      toast.error('缺少计算批次ID，无法确认执行');
      return;
    }
    if (rows.length === 0) {
      toast.error('没有可确认的执行项');
      return;
    }

    setSubmitting(true);
    try {
      const items = rows.map((r) => {
        const actual = parseFloat(r.actualAmount);
        return {
          etfCode: r.etfCode,
          plannedAmount: r.plannedAmount,
          actualAmount: isNaN(actual) ? 0 : actual,
          status: r.status,
        };
      });
      await confirmExecution(calculationId, items);
      toast.success('执行已确认');
      onOpenChange(false);
      onConfirmed?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '执行确认失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            确认执行本周定投建议
          </DialogTitle>
          <DialogDescription className="text-xs">
            核对每条建议的实际执行金额与状态。计算批次：
            <span className="font-mono text-foreground/80 ml-1">{calculationId || '—'}</span>
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2 py-10">
            <AlertCircle className="size-5 text-muted-foreground/60" />
            <span>本周无建议买入标的，无需确认</span>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto rounded-md border max-h-[55vh]">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur z-10">
                  <TableRow>
                    <TableHead className="text-xs whitespace-nowrap">ETF</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">计划金额</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">实际金额</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, idx) => (
                    <TableRow key={r.etfCode}>
                      <TableCell className="text-xs align-middle">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="font-medium truncate">{r.etfName}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {r.etfCode}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                        {formatYuan(r.plannedAmount)}
                      </TableCell>
                      <TableCell className="text-xs align-middle">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={r.actualAmount}
                          onChange={(e) => updateRow(idx, { actualAmount: e.target.value })}
                          className="h-8 text-xs font-mono w-28 ml-auto text-right"
                          disabled={submitting}
                        />
                      </TableCell>
                      <TableCell className="text-xs align-middle">
                        <Select
                          value={r.status}
                          onValueChange={(v) =>
                            updateRow(idx, { status: v as ExecutionStatus })
                          }
                          disabled={submitting}
                        >
                          <SelectTrigger className="h-8 text-xs w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="executed">已执行</SelectItem>
                            <SelectItem value="skipped">已跳过</SelectItem>
                            <SelectItem value="partial">部分执行</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* 汇总 */}
            <div className="flex flex-wrap items-center gap-2 text-xs px-1 pt-2">
              <Badge variant="outline" className="text-[11px] font-mono">
                计划合计 {formatYuan(totalPlanned)}
              </Badge>
              <Badge variant="outline" className="text-[11px] font-mono">
                实际合计 {formatYuan(totalActual)}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[11px] font-mono ${
                  deviation >= 0
                    ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/40 dark:bg-emerald-900/30'
                    : 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/40 dark:bg-amber-900/30'
                }`}
              >
                偏差 {deviation >= 0 ? '+' : ''}
                {formatYuan(deviation)}
              </Badge>
              <span className="text-[10px] text-muted-foreground/70 ml-auto">
                状态说明：已执行 / 已跳过 / 部分执行
              </span>
            </div>
          </>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={submitting || rows.length === 0}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            )}
            确认执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
