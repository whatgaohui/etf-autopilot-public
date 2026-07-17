'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { FadeInUp } from '@/lib/motion';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

import type { ExecutionOrderDisplay, ApiResponse } from '@/lib/types';

// ─── Props ──────────────────────────────────────────────────

interface FillExecutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: ExecutionOrderDisplay | null;
  etfName: string;
}

// ─── Helpers ────────────────────────────────────────────────

function formatMoneyYuan(value: number): string {
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getDefaultExecutedAt(): string {
  const now = new Date();
  // Format for datetime-local: YYYY-MM-DDTHH:MM
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

function toIsoString(datetimeLocal: string): string {
  // Convert datetime-local value to ISO string
  return new Date(datetimeLocal).toISOString();
}

// ─── Component ──────────────────────────────────────────────

export function FillExecutionDialog({
  open,
  onOpenChange,
  order,
  etfName,
}: FillExecutionDialogProps) {
  const queryClient = useQueryClient();

  // ─── Form State ─────────────────────────────────────────
  const [price, setPrice] = useState('');
  const [shares, setShares] = useState('');
  const [fee, setFee] = useState('5.00');
  const [executedAt, setExecutedAt] = useState(getDefaultExecutedAt());
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [idempotencyEdited, setIdempotencyEdited] = useState(false);
  const generatedKeyRef = useRef('');

  // Stable idempotency key: generated once when dialog opens with a new order
  const currentIdempotencyKey = idempotencyEdited
    ? idempotencyKey
    : (() => {
        if (order && open) {
          if (!generatedKeyRef.current || !generatedKeyRef.current.startsWith(`fill-${order.id}-`)) {
            generatedKeyRef.current = `fill-${order.id}-${Date.now()}`;
          }
          return generatedKeyRef.current;
        }
        return '';
      })();

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Reset on close
        setPrice('');
        setShares('');
        setFee('5.00');
        setExecutedAt(getDefaultExecutedAt());
        setIdempotencyKey('');
        setIdempotencyEdited(false);
        generatedKeyRef.current = '';
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  // ─── Auto-calculated amount ─────────────────────────────
  const calculatedAmount = useMemo(() => {
    const p = parseFloat(price);
    const s = parseFloat(shares);
    if (isNaN(p) || isNaN(s) || p <= 0 || s <= 0) return null;
    return p * s;
  }, [price, shares]);

  // ─── Validation ─────────────────────────────────────────
  const isValid = useMemo(() => {
    const p = parseFloat(price);
    const s = parseFloat(shares);
    const f = parseFloat(fee);
    return !isNaN(p) && p > 0 && !isNaN(s) && s > 0 && !isNaN(f) && f >= 0 && executedAt.length > 0;
  }, [price, shares, fee, executedAt]);

  // ─── Submit Mutation ────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!order || !calculatedAmount) throw new Error('Invalid form state');

      const p = parseFloat(price);
      const s = parseFloat(shares);
      const f = parseFloat(fee);

      const body = {
        orderId: order.id,
        priceFen: Math.round(p * 100 * 10000),        // 元 × 100 × 10000
        sharesX10000: Math.round(s * 10000),            // 份 × 10000
        amountFen: Math.round(calculatedAmount * 100),   // 元 × 100
        feeFen: Math.round(f * 100),                     // 元 × 100
        executedAt: toIsoString(executedAt),
        idempotencyKey: currentIdempotencyKey,
      };

      const res = await fetch('/api/execution-fills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data: ApiResponse = await res.json();
      if (!data.success) throw new Error(data.error ?? '回填失败');
      return data;
    },
    onSuccess: (data) => {
      toast.success('成交回填成功', {
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ['execution-orders'] });
      queryClient.invalidateQueries({ queryKey: ['execution-fills'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      handleOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '成交回填失败');
    },
  });

  const handleSubmit = useCallback(() => {
    if (!isValid) return;
    submitMutation.mutate();
  }, [isValid, submitMutation]);

  if (!order) return null;

  const isBuy = order.side === 'buy';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            成交回填 — {etfName} ({order.etfCode})
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            填写实际成交信息，系统将自动计算成交金额
          </DialogDescription>
        </DialogHeader>

        <FadeInUp className="space-y-4 py-2" delay={0.05}>
          {/* Direction badge */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">交易方向</span>
            <Badge
              className={`border-0 text-xs px-2 py-0.5 ${
                isBuy
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
              }`}
            >
              {isBuy ? '买入' : '卖出'}
            </Badge>
          </div>

          {/* Plan info (read-only) */}
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-1.5">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">计划信息</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] text-muted-foreground">计划金额</div>
                <div className="text-sm font-mono font-medium tabular-nums">
                  {formatMoneyYuan(order.plannedAmountYuan)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground">计划份额</div>
                <div className="text-sm font-mono font-medium tabular-nums">
                  {order.plannedSharesActual != null
                    ? `${order.plannedSharesActual.toLocaleString('zh-CN')} 份`
                    : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Price & Shares */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fill-price" className="text-xs">
                成交价格 <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="fill-price"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="3.852"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="pr-12 font-mono tabular-nums"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                  元/份
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fill-shares" className="text-xs">
                成交份额 <span className="text-red-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="fill-shares"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="3200"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  className="pr-8 font-mono tabular-nums"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                  份
                </span>
              </div>
            </div>
          </div>

          {/* Auto-calculated amount */}
          <div className="space-y-1.5">
            <Label className="text-xs">成交金额（自动计算）</Label>
            <div
              className={`rounded-md border border-border/50 px-3 py-2 text-sm font-mono font-medium tabular-nums transition-colors ${
                calculatedAmount != null
                  ? 'bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300'
                  : 'bg-muted/20 text-muted-foreground'
              }`}
            >
              {calculatedAmount != null
                ? formatMoneyYuan(calculatedAmount)
                : '—'}
            </div>
          </div>

          {/* Fee & Time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fill-fee" className="text-xs">
                手续费
              </Label>
              <div className="relative">
                <Input
                  id="fill-fee"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue="5.00"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  className="pr-8 font-mono tabular-nums"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
                  元
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fill-time" className="text-xs">
                成交时间
              </Label>
              <Input
                id="fill-time"
                type="datetime-local"
                value={executedAt}
                onChange={(e) => setExecutedAt(e.target.value)}
                className="text-xs"
              />
            </div>
          </div>

          {/* Idempotency key */}
          <div className="space-y-1.5">
            <Label htmlFor="fill-idem" className="text-xs">
              幂等键
            </Label>
            <Input
              id="fill-idem"
              type="text"
              value={currentIdempotencyKey}
              onChange={(e) => {
                setIdempotencyKey(e.target.value);
                setIdempotencyEdited(true);
              }}
              className="font-mono text-xs text-muted-foreground"
            />
            <p className="text-[10px] text-muted-foreground">
              用于防止重复提交，自动生成，一般无需修改
            </p>
          </div>
        </FadeInUp>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitMutation.isPending}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700 text-white min-w-[96px]"
            disabled={!isValid || !currentIdempotencyKey.trim() || submitMutation.isPending}
            onClick={handleSubmit}
          >
            {submitMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
            ) : null}
            提交回填
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}