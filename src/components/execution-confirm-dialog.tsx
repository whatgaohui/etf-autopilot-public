'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  ShieldCheck,
} from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createExecutionOrders,
  confirmExecutionOrders,
  getExecutionOrders,
  type ExecutionOrder,
} from '@/lib/api';
import type { AdviceSuggestion } from '@/lib/types';

// Cash reserve + gold codes excluded from investment decisions
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

function formatYuan(v: number): string {
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

// V5.0 Sprint3 E6: 技术状态颜色映射 (与 unified-holdings-table.tsx 对齐)
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

// V5.0 Sprint3 E6: 执行模式映射
function getExecutionModeLabel(m: string | undefined | null): string {
  switch (m) {
    case 'immediate': return '立即执行';
    case 'staged': return '分批执行';
    case 'wait_pullback': return '等待回调';
    case 'base_only': return '仅基础仓';
    default: return '立即执行';
  }
}

function getExecutionModeHint(m: string | undefined | null): string {
  switch (m) {
    case 'immediate': return '技术面强势或中性, 一次到位';
    case 'staged': return '冲突或改善中, 分批降低择时风险';
    case 'wait_pullback': return '极弱, 暂缓增强仓等待反转';
    case 'base_only': return '弱势, 关闭增强仓只保留基础定投';
    default: return '';
  }
}

// 行状态: pending (待确认) / confirmed (已确认) / rejected (已拒绝)
type RowStatus = 'pending' | 'confirmed' | 'rejected';

interface ExecutionRowState {
  etfCode: string;
  etfName: string;
  plannedAmount: number;
  executionMode: string;       // immediate | staged | wait_pullback | base_only
  technicalState?: string;     // 7态
  technicalCoefficient?: number;
  status: RowStatus;
  rejectReason: string;
  processing: boolean;         // 单行处理中 (确认/拒绝 API 调用中)
}

const STATUS_LABEL: Record<RowStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  rejected: '已拒绝',
};

const STATUS_STYLE: Record<RowStatus, string> = {
  pending:
    'border-border text-muted-foreground bg-muted/40 dark:bg-muted/20',
  confirmed:
    'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40',
  rejected:
    'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/60 dark:bg-red-900/40',
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
  const [initializing, setInitializing] = useState(false);
  const [batchConfirming, setBatchConfirming] = useState(false);

  // 打开弹窗时:
  //   1. 从 suggestions 初始化行
  //   2. 调用 createExecutionOrders 创建 pending 订单 (幂等)
  //   3. 拉取已有订单, 同步 confirmed/rejected 状态
  const initializeOrders = useCallback(async () => {
    if (!calculationId || buySuggestions.length === 0) {
      setRows(
        buySuggestions.map((s) => ({
          etfCode: s.code,
          etfName: s.name,
          plannedAmount: s.amount,
          executionMode: s.technicalMode || 'immediate',
          technicalState: s.technicalState,
          technicalCoefficient: s.technicalCoefficient,
          status: 'pending' as RowStatus,
          rejectReason: '',
          processing: false,
        }))
      );
      return;
    }

    setInitializing(true);
    // 先从 suggestions 初始化行 (避免初始化期间界面空白)
    setRows(
      buySuggestions.map((s) => ({
        etfCode: s.code,
        etfName: s.name,
        plannedAmount: s.amount,
        executionMode: s.technicalMode || 'immediate',
        technicalState: s.technicalState,
        technicalCoefficient: s.technicalCoefficient,
        status: 'pending' as RowStatus,
        rejectReason: '',
        processing: false,
      }))
    );

    try {
      // 1. 创建 pending 订单 (幂等, 已存在则更新 planned_amount/mode 但不覆盖 confirmed/rejected)
      await createExecutionOrders(
        calculationId,
        buySuggestions.map((s) => ({
          etfCode: s.code,
          side: 'buy',
          plannedAmount: s.amount,
          executionMode: s.technicalMode || 'immediate',
        }))
      );

      // 2. 拉取订单列表, 同步状态
      const resp = await getExecutionOrders(calculationId);
      const orderMap = new Map<string, ExecutionOrder>();
      for (const o of resp.items || []) {
        orderMap.set(o.etfCode, o);
      }

      setRows((prev) =>
        prev.map((r) => {
          const o = orderMap.get(r.etfCode);
          if (!o) return r;
          let newStatus: RowStatus = 'pending';
          if (o.status === 'confirmed') newStatus = 'confirmed';
          else if (o.status === 'rejected') newStatus = 'rejected';
          return {
            ...r,
            status: newStatus,
            rejectReason: o.rejectedReason ?? '',
            // 用订单上的 executionMode (后端权威)
            executionMode: o.executionMode || r.executionMode,
          };
        })
      );
    } catch (err) {
      // 初始化失败不阻断 — 用户仍可逐项确认 (后端会再次尝试)
      console.warn('[ExecutionConfirmDialog] init orders failed:', err);
    } finally {
      setInitializing(false);
    }
  }, [calculationId, buySuggestions]);

  useEffect(() => {
    if (open) {
      initializeOrders();
    }
  }, [open, initializeOrders]);

  const updateRow = (etfCode: string, patch: Partial<ExecutionRowState>) => {
    setRows((prev) =>
      prev.map((r) => (r.etfCode === etfCode ? { ...r, ...patch } : r))
    );
  };

  // 单行确认/拒绝
  const handleRowAction = async (
    etfCode: string,
    action: 'confirm' | 'reject',
    reason: string = ''
  ) => {
    if (!calculationId) {
      toast.error('缺少计算批次ID，无法确认执行');
      return;
    }
    updateRow(etfCode, { processing: true });
    try {
      await confirmExecutionOrders(calculationId, [{ etfCode, action, reason }]);
      if (action === 'confirm') {
        updateRow(etfCode, { status: 'confirmed', processing: false });
        toast.success(`${etfCode} 已确认`);
      } else {
        updateRow(etfCode, {
          status: 'rejected',
          rejectReason: reason,
          processing: false,
        });
        toast.info(`${etfCode} 已拒绝`);
      }
    } catch (err) {
      updateRow(etfCode, { processing: false });
      toast.error(err instanceof Error ? err.message : `${etfCode} 操作失败`);
    }
  };

  // 全部确认 (仅 pending 行)
  const handleConfirmAll = async () => {
    if (!calculationId) {
      toast.error('缺少计算批次ID，无法确认执行');
      return;
    }
    const pendingRows = rows.filter((r) => r.status === 'pending');
    if (pendingRows.length === 0) {
      toast.info('没有待确认的项');
      return;
    }

    setBatchConfirming(true);
    // 标记所有 pending 行为 processing
    setRows((prev) =>
      prev.map((r) =>
        r.status === 'pending' ? { ...r, processing: true } : r
      )
    );

    try {
      const items = pendingRows.map((r) => ({
        etfCode: r.etfCode,
        action: 'confirm' as const,
      }));
      await confirmExecutionOrders(calculationId, items);
      setRows((prev) =>
        prev.map((r) =>
          r.status === 'pending'
            ? { ...r, status: 'confirmed', processing: false }
            : r
        )
      );
      toast.success(`已批量确认 ${pendingRows.length} 项`);
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          r.status === 'pending' ? { ...r, processing: false } : r
        )
      );
      toast.error(err instanceof Error ? err.message : '批量确认失败');
    } finally {
      setBatchConfirming(false);
    }
  };

  // 完成: 关闭弹窗 + 反馈
  const handleFinish = () => {
    const confirmedCount = rows.filter((r) => r.status === 'confirmed').length;
    const rejectedRows = rows.filter((r) => r.status === 'rejected');
    const pendingCount = rows.filter((r) => r.status === 'pending').length;

    if (rows.length === 0) {
      onOpenChange(false);
      return;
    }

    if (pendingCount > 0) {
      // 还有未处理的, 提示但不强制阻止关闭
      toast.warning(`还有 ${pendingCount} 项未确认, 已自动保留为 pending 状态`);
    } else if (rejectedRows.length === 0) {
      // 全部 confirmed
      toast.success(`执行订单已确认 (共 ${confirmedCount} 项)`);
    } else {
      // 部分 rejected
      const rejectedNames = rejectedRows
        .map((r) => `${r.etfName}(${r.etfCode})`)
        .join('、');
      toast.warning(
        `已确认 ${confirmedCount} 项, 已拒绝 ${rejectedRows.length} 项: ${rejectedNames}`
      );
    }
    onOpenChange(false);
    onConfirmed?.();
  };

  // 统计
  const totalPlanned = rows.reduce((sum, r) => sum + r.plannedAmount, 0);
  const confirmedAmount = rows
    .filter((r) => r.status === 'confirmed')
    .reduce((sum, r) => sum + r.plannedAmount, 0);
  const rejectedAmount = rows
    .filter((r) => r.status === 'rejected')
    .reduce((sum, r) => sum + r.plannedAmount, 0);
  const pendingCount = rows.filter((r) => r.status === 'pending').length;
  const confirmedCount = rows.filter((r) => r.status === 'confirmed').length;
  const rejectedCount = rows.filter((r) => r.status === 'rejected').length;

  const anyProcessing =
    initializing || batchConfirming || rows.some((r) => r.processing);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            确认执行本周定投建议
          </DialogTitle>
          <DialogDescription className="text-xs">
            逐项确认或拒绝本周建议。计算批次：
            <span className="font-mono text-foreground/80 ml-1">
              {calculationId || '—'}
            </span>
            {initializing && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="size-3 animate-spin" />
                同步订单状态…
              </span>
            )}
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
                    <TableHead className="text-xs whitespace-nowrap text-center">执行模式</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-center">状态/操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.etfCode}>
                      <TableCell className="text-xs align-middle">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="font-medium truncate">{r.etfName}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {r.etfCode}
                          </span>
                          {r.technicalState && (
                            <Badge
                              variant="outline"
                              className={`text-[9px] px-1.5 py-0 h-3.5 rounded-full font-mono w-fit ${getTechnicalStateBadgeClass(r.technicalState)}`}
                              title={`V5.0 技术状态: ${getTechnicalStateLabel(r.technicalState)}${
                                r.technicalCoefficient
                                  ? ` (${r.technicalCoefficient.toFixed(1)}x)`
                                  : ''
                              }`}
                            >
                              {getTechnicalStateLabel(r.technicalState)}
                              {r.technicalCoefficient
                                ? ` ${r.technicalCoefficient.toFixed(1)}x`
                                : ''}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                        {formatYuan(r.plannedAmount)}
                      </TableCell>
                      <TableCell className="text-xs align-middle text-center whitespace-nowrap">
                        <div className="flex flex-col items-center gap-0.5">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 rounded-full font-mono border-border bg-muted/30"
                            title={getExecutionModeHint(r.executionMode)}
                          >
                            {getExecutionModeLabel(r.executionMode)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs align-middle">
                        {r.status === 'pending' ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7 px-2 text-[11px]"
                                disabled={r.processing || anyProcessing}
                                onClick={() => handleRowAction(r.etfCode, 'confirm')}
                              >
                                {r.processing ? (
                                  <Loader2 className="size-3 mr-0.5 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="size-3 mr-0.5" />
                                )}
                                确认
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                                disabled={r.processing || anyProcessing}
                                onClick={() => {
                                  const reason = window.prompt(`拒绝 ${r.etfName}(${r.etfCode}) 的原因 (可选):`) || '';
                                  handleRowAction(r.etfCode, 'reject', reason);
                                }}
                              >
                                {r.processing ? (
                                  <Loader2 className="size-3 mr-0.5 animate-spin" />
                                ) : (
                                  <XCircle className="size-3 mr-0.5" />
                                )}
                                拒绝
                              </Button>
                            </div>
                            <span className="text-[9px] text-muted-foreground text-center">
                              {STATUS_LABEL.pending}
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5 items-start">
                            <Badge
                              variant="outline"
                              className={`text-[10px] px-1.5 py-0 h-4 rounded-full font-mono ${STATUS_STYLE[r.status]}`}
                            >
                              {r.status === 'confirmed' ? (
                                <CheckCircle2 className="size-2.5 mr-0.5 inline" />
                              ) : (
                                <XCircle className="size-2.5 mr-0.5 inline" />
                              )}
                              {STATUS_LABEL[r.status]}
                            </Badge>
                            {r.status === 'rejected' && r.rejectReason && (
                              <span
                                className="text-[9px] text-red-600 dark:text-red-400 max-w-[180px] truncate"
                                title={r.rejectReason}
                              >
                                原因: {r.rejectReason}
                              </span>
                            )}
                            {r.status === 'rejected' && !r.rejectReason && (
                              <span className="text-[9px] text-muted-foreground">未填写原因</span>
                            )}
                          </div>
                        )}
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
              <Badge
                variant="outline"
                className={`text-[11px] font-mono ${
                  confirmedCount > 0
                    ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/40 dark:bg-emerald-900/30'
                    : ''
                }`}
              >
                已确认 {confirmedCount} 项 / {formatYuan(confirmedAmount)}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[11px] font-mono ${
                  rejectedCount > 0
                    ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 bg-red-100/40 dark:bg-red-900/30'
                    : ''
                }`}
              >
                已拒绝 {rejectedCount} 项 / {formatYuan(rejectedAmount)}
              </Badge>
              {pendingCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-[11px] font-mono border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/40 dark:bg-amber-900/30"
                >
                  待确认 {pendingCount} 项
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground/70 ml-auto inline-flex items-center gap-1">
                <ShieldCheck className="size-3" />
                状态机: pending → confirmed/rejected (不可逆)
              </span>
            </div>
          </>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={anyProcessing}
          >
            取消
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleConfirmAll}
            disabled={anyProcessing || pendingCount === 0}
            title={pendingCount === 0 ? '没有待确认的项' : `批量确认 ${pendingCount} 项 pending`}
          >
            {batchConfirming ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            )}
            全部确认 ({pendingCount})
          </Button>
          <Button
            size="sm"
            onClick={handleFinish}
            disabled={anyProcessing || rows.length === 0}
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
