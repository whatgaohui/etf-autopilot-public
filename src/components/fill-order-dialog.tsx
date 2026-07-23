'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  ClipboardCheck,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Ban,
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
  getReconciliation,
  fillOrder,
  cancelOrder,
  type FillRequest,
  type ReconciliationItem,
} from '@/lib/api';

// V5.0 Sprint4 E8: 成交回填弹窗
//
// 从总览页"成交回填"按钮打开(仅当存在 confirmed/partially_executed 订单时显示按钮)。
//
// 每行展示一个可回填订单: ETF名称 + 计划金额 + 已成交 + 状态 Badge + [回填成交]/[撤销] 按钮
// 点击 [回填成交] 展开内联表单: 成交价格 / 成交份额 / 成交金额(自动计算) / 手续费
//
// 状态机:
//   - new_actual >= planned - 1元  → executed (toast.success "成交回填完成,订单已执行")
//   - 否则                          → partially_executed (toast.info "部分成交,剩余可继续回填")
//   - 幂等失败                       → toast.error "重复提交"
//
// [撤销] 按钮: window.confirm → cancelOrder(orderId, reason)

interface EtfInfo {
  code: string;
  name: string;
}

export interface FillOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calculationId: string;
  /** 用于把 ETF 代码映射成中文名称(可选, 缺省时回退显示 code) */
  etfInfos?: EtfInfo[];
  /** 成功回填/撤销后的回调(用于刷新对账数据等) */
  onFilled?: () => void;
}

function formatYuan(v: number): string {
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

function getEtfName(code: string, etfInfos?: EtfInfo[]): string {
  if (!etfInfos || etfInfos.length === 0) return code;
  const hit = etfInfos.find((e) => e.code === code);
  return hit?.name || code;
}

interface FillFormState {
  fillPrice: string;
  fillShares: string;
  fillAmount: string;
  fee: string;
}

const EMPTY_FORM: FillFormState = {
  fillPrice: '',
  fillShares: '',
  fillAmount: '',
  fee: '0',
};

// 状态文案 + 颜色
function getOrderStatusBadge(status: string): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'partially_executed':
      return {
        label: '部分成交',
        className:
          'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/40',
      };
    case 'confirmed':
      return {
        label: '已确认',
        className:
          'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-900/40',
      };
    default:
      return {
        label: status,
        className: 'border-border text-muted-foreground bg-muted/40',
      };
  }
}

export function FillOrderDialog({
  open,
  onOpenChange,
  calculationId,
  etfInfos,
  onFilled,
}: FillOrderDialogProps) {
  const [orders, setOrders] = useState<ReconciliationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, FillFormState>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});

  const fetchOrders = useCallback(async () => {
    if (!calculationId) {
      setOrders([]);
      return;
    }
    setLoading(true);
    try {
      // 用 reconciliation 一次性拿到 planned/actual/orderStatus, 避免二次拉取
      const resp = await getReconciliation(calculationId);
      const list = (resp.items || []).filter(
        (o) =>
          o.orderStatus === 'confirmed' ||
          o.orderStatus === 'partially_executed'
      );
      setOrders(list);
    } catch (err) {
      console.warn('[FillOrderDialog] fetchOrders failed:', err);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [calculationId]);

  useEffect(() => {
    if (open) {
      fetchOrders();
      setExpandedOrderId(null);
      setForms({});
      setSubmitting({});
      setCancelling({});
    }
  }, [open, fetchOrders]);

  const handleFormChange = (
    orderId: string,
    field: keyof FillFormState,
    value: string
  ) => {
    setForms((prev) => {
      const cur = prev[orderId] || { ...EMPTY_FORM };
      const next = { ...cur, [field]: value };
      // 自动计算成交金额 = 价格 × 份额 (仅当成交金额未被手动修改过/为空时回写)
      if (field === 'fillPrice' || field === 'fillShares') {
        const p = parseFloat(field === 'fillPrice' ? value : next.fillPrice);
        const s = parseFloat(field === 'fillShares' ? value : next.fillShares);
        if (!isNaN(p) && !isNaN(s) && p > 0 && s > 0) {
          next.fillAmount = (p * s).toFixed(2);
        }
      }
      return { ...prev, [orderId]: next };
    });
  };

  const handleSubmitFill = async (order: ReconciliationItem) => {
    const form = forms[order.orderId] || { ...EMPTY_FORM };
    const fillPrice = parseFloat(form.fillPrice);
    const fillShares = parseFloat(form.fillShares);
    const fillAmount = parseFloat(form.fillAmount);
    const fee = parseFloat(form.fee || '0') || 0;

    if (isNaN(fillPrice) || fillPrice <= 0) {
      toast.error('请输入有效的成交价格');
      return;
    }
    if (isNaN(fillShares) || fillShares <= 0) {
      toast.error('请输入有效的成交份额');
      return;
    }
    if (isNaN(fillAmount) || fillAmount <= 0) {
      toast.error('请输入有效的成交金额');
      return;
    }
    if (fee < 0) {
      toast.error('手续费不能为负');
      return;
    }

    const req: FillRequest = {
      orderId: order.orderId,
      etfCode: order.etfCode,
      fillPrice,
      fillShares,
      fillAmount,
      fee,
      idempotencyKey: `${order.orderId}-${Date.now()}`,
    };

    setSubmitting((prev) => ({ ...prev, [order.orderId]: true }));
    try {
      const resp = await fillOrder(req);
      if (resp.success) {
        const newStatus = resp.order_status || resp.orderStatus || '';
        if (newStatus === 'executed') {
          toast.success('成交回填完成,订单已执行');
        } else if (newStatus === 'partially_executed') {
          toast.info('部分成交,剩余可继续回填');
        } else {
          toast.success('成交回填已提交');
        }
        // 清空该订单的表单 + 刷新订单列表
        setForms((prev) => ({ ...prev, [order.orderId]: { ...EMPTY_FORM } }));
        setExpandedOrderId(null);
        await fetchOrders();
        onFilled?.();
      } else {
        const errMsg = resp.error || '回填失败';
        if (errMsg.includes('重复提交') || errMsg.includes('幂等')) {
          toast.error('重复提交');
        } else {
          toast.error(errMsg);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回填失败';
      if (msg.includes('重复提交') || msg.includes('幂等')) {
        toast.error('重复提交');
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting((prev) => ({ ...prev, [order.orderId]: false }));
    }
  };

  const handleCancel = async (order: ReconciliationItem) => {
    const confirmed = window.confirm(
      `确认撤销 ${getEtfName(order.etfCode, etfInfos)}(${order.etfCode}) 订单?\n` +
        `已成交部分(¥${Math.round(order.actualAmount).toLocaleString('zh-CN')})将保留, 仅未成交部分撤销。`
    );
    if (!confirmed) return;
    const reason =
      window.prompt(`撤销 ${order.etfCode} 订单的原因(可选):`) || '';
    setCancelling((prev) => ({ ...prev, [order.orderId]: true }));
    try {
      const resp = await cancelOrder(order.orderId, reason);
      if (resp.success) {
        toast.success(`订单 ${order.etfCode} 已撤销`);
        await fetchOrders();
        onFilled?.();
      } else {
        toast.error(resp.error || '撤销失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setCancelling((prev) => ({ ...prev, [order.orderId]: false }));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 text-emerald-600" />
            成交回填
          </DialogTitle>
          <DialogDescription className="text-xs">
            对已确认的执行单回填实际成交信息(支持多次部分成交)。计算批次:
            <span className="font-mono text-foreground/80 ml-1">
              {calculationId || '—'}
            </span>
            {loading && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="size-3 animate-spin" />
                同步订单…
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {orders.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2 py-10">
            <AlertCircle className="size-5 text-muted-foreground/60" />
            <span>
              {loading ? '加载中...' : '暂无可回填的已确认订单'}
            </span>
            <span className="text-[10px] text-muted-foreground/60">
              (仅 status=confirmed / partially_executed 的订单可回填)
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-auto rounded-md border max-h-[60vh]">
            <Table>
              <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur z-10">
                <TableRow>
                  <TableHead className="text-xs whitespace-nowrap">ETF / 操作</TableHead>
                  <TableHead className="text-xs whitespace-nowrap text-right">计划金额</TableHead>
                  <TableHead className="text-xs whitespace-nowrap text-right">已成交</TableHead>
                  <TableHead className="text-xs whitespace-nowrap text-center">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const expanded = expandedOrderId === o.orderId;
                  const form = forms[o.orderId] || { ...EMPTY_FORM };
                  const isSubmitting = !!submitting[o.orderId];
                  const isCancelling = !!cancelling[o.orderId];
                  const statusBadge = getOrderStatusBadge(o.orderStatus);
                  return (
                    <React.Fragment key={o.orderId}>
                      <TableRow>
                        <TableCell className="text-xs align-middle">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              className="p-0.5 rounded hover:bg-muted"
                              onClick={() =>
                                setExpandedOrderId(expanded ? null : o.orderId)
                              }
                              aria-label={expanded ? '收起' : '展开'}
                            >
                              {expanded ? (
                                <ChevronDown className="size-3.5" />
                              ) : (
                                <ChevronRight className="size-3.5" />
                              )}
                            </button>
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="font-medium truncate">
                                {getEtfName(o.etfCode, etfInfos)}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {o.etfCode}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                          {formatYuan(o.plannedAmount)}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-right align-middle whitespace-nowrap">
                          {o.actualAmount > 0 ? formatYuan(o.actualAmount) : '—'}
                        </TableCell>
                        <TableCell className="text-xs align-middle text-center">
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-mono ${statusBadge.className}`}
                          >
                            {statusBadge.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={4} className="p-3">
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                <div className="space-y-1">
                                  <label className="text-[10px] text-muted-foreground">
                                    成交价格(元)
                                  </label>
                                  <Input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    placeholder="1.2345"
                                    className="h-8 text-xs"
                                    value={form.fillPrice}
                                    onChange={(e) =>
                                      handleFormChange(
                                        o.orderId,
                                        'fillPrice',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[10px] text-muted-foreground">
                                    成交份额
                                  </label>
                                  <Input
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    placeholder="800"
                                    className="h-8 text-xs"
                                    value={form.fillShares}
                                    onChange={(e) =>
                                      handleFormChange(
                                        o.orderId,
                                        'fillShares',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[10px] text-muted-foreground">
                                    成交金额(元)
                                  </label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="自动计算"
                                    className="h-8 text-xs"
                                    value={form.fillAmount}
                                    onChange={(e) =>
                                      handleFormChange(
                                        o.orderId,
                                        'fillAmount',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[10px] text-muted-foreground">
                                    手续费(元)
                                  </label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="0"
                                    className="h-8 text-xs"
                                    value={form.fee}
                                    onChange={(e) =>
                                      handleFormChange(
                                        o.orderId,
                                        'fee',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>
                              </div>
                              {o.actualAmount > 0 && (
                                <div className="text-[10px] text-muted-foreground bg-muted/40 rounded px-2 py-1">
                                  已成交: ¥
                                  {Math.round(o.actualAmount).toLocaleString(
                                    'zh-CN'
                                  )}{' '}
                                  / 计划: ¥
                                  {Math.round(o.plannedAmount).toLocaleString(
                                    'zh-CN'
                                  )}{' '}
                                  · 偏差 {o.deviationPct > 0 ? '+' : ''}
                                  {o.deviationPct.toFixed(2)}%
                                </div>
                              )}
                              <div className="flex items-center justify-end gap-2 pt-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                                  disabled={isCancelling || isSubmitting}
                                  onClick={() => handleCancel(o)}
                                >
                                  {isCancelling ? (
                                    <Loader2 className="size-3 mr-0.5 animate-spin" />
                                  ) : (
                                    <Ban className="size-3 mr-0.5" />
                                  )}
                                  撤销
                                </Button>
                                <Button
                                  size="sm"
                                  className="h-7 text-[11px]"
                                  disabled={isSubmitting || isCancelling}
                                  onClick={() => handleSubmitFill(o)}
                                >
                                  {isSubmitting ? (
                                    <Loader2 className="size-3 mr-0.5 animate-spin" />
                                  ) : (
                                    <ClipboardCheck className="size-3 mr-0.5" />
                                  )}
                                  确认回填
                                </Button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
