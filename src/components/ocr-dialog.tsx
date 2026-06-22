'use client';

import React, { useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { OcrResult, EtfConfig } from '@/lib/types';
import { DEFAULT_ETF_LIST } from '@/lib/types';

interface OcrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ocrResults: OcrResult[];
  etfConfigs: EtfConfig[];
  onConfirm: (holdings: { etfCode: string; etfName: string; shares: number; costPrice: number; marketValue: number }[]) => void;
  isSaving: boolean;
}

export function OcrDialog({
  open,
  onOpenChange,
  ocrResults,
  etfConfigs,
  onConfirm,
  isSaving,
}: OcrDialogProps) {
  const [editedResults, setEditedResults] = useState<OcrResult[]>([]);

  // Initialize edited results when ocrResults change
  React.useEffect(() => {
    setEditedResults(
      ocrResults.map((r) => ({ ...r }))
    );
  }, [ocrResults]);

  const knownCodes = new Set([
    ...etfConfigs.map((c) => c.code),
    ...DEFAULT_ETF_LIST.map((e) => e.code),
  ]);

  const isFieldUncertain = (value: number | null): boolean => value === null;

  const handleFieldChange = (
    index: number,
    field: keyof OcrResult,
    value: string
  ) => {
    setEditedResults((prev) => {
      const next = [...prev];
      const item = { ...next[index] };

      if (field === 'name' || field === 'code') {
        (item as Record<string, unknown>)[field] = value;
      } else {
        // numeric fields
        const num = value === '' ? null : parseFloat(value);
        (item as Record<string, unknown>)[field] = isNaN(num as number) ? null : num;
      }

      next[index] = item;
      return next;
    });
  };

  const handleConfirm = () => {
    const holdings = editedResults
      .filter((r) => r.code && r.marketValue !== null && r.marketValue > 0)
      .map((r) => ({
        etfCode: r.code,
        etfName: r.name,
        shares: r.shares || 0,
        costPrice: r.costPrice || 0,
        marketValue: r.marketValue || 0,
      }));

    onConfirm(holdings);
  };

  const validCount = editedResults.filter(
    (r) => r.code && r.marketValue !== null && r.marketValue > 0
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>OCR 识别结果校准</DialogTitle>
          <DialogDescription>
            请检查并修正AI识别的持仓信息，红色标记的字段可能识别有误
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>ETF名称</TableHead>
                <TableHead>代码</TableHead>
                <TableHead className="text-right">持仓份额</TableHead>
                <TableHead className="text-right">成本价</TableHead>
                <TableHead className="text-right">市值</TableHead>
                <TableHead className="text-right">盈亏</TableHead>
                <TableHead className="text-right">可用份额</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {editedResults.map((item, index) => {
                const isKnown = knownCodes.has(item.code);
                const hasUncertain = isFieldUncertain(item.shares) || isFieldUncertain(item.costPrice) || isFieldUncertain(item.marketValue);

                return (
                  <TableRow key={index} className={hasUncertain ? 'bg-red-50/50' : ''}>
                    <TableCell className="text-muted-foreground text-xs">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.name}
                        onChange={(e) => handleFieldChange(index, 'name', e.target.value)}
                        className="h-8 text-sm min-w-[100px]"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.code}
                        onChange={(e) => handleFieldChange(index, 'code', e.target.value)}
                        className={`h-8 text-sm w-24 font-mono ${isFieldUncertain(item.code as unknown as number | null) ? 'border-red-300' : ''}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        value={item.shares ?? ''}
                        onChange={(e) => handleFieldChange(index, 'shares', e.target.value)}
                        className={`h-8 text-sm w-28 text-right ${isFieldUncertain(item.shares) ? 'border-red-300' : ''}`}
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.001"
                        value={item.costPrice ?? ''}
                        onChange={(e) => handleFieldChange(index, 'costPrice', e.target.value)}
                        className={`h-8 text-sm w-24 text-right ${isFieldUncertain(item.costPrice) ? 'border-red-300' : ''}`}
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.01"
                        value={item.marketValue ?? ''}
                        onChange={(e) => handleFieldChange(index, 'marketValue', e.target.value)}
                        className={`h-8 text-sm w-28 text-right ${isFieldUncertain(item.marketValue) ? 'border-red-300' : ''}`}
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        value={(item as any).profitLoss ?? ''}
                        onChange={(e) => handleFieldChange(index, 'profitLoss', e.target.value)}
                        className="h-8 text-sm w-24 text-right"
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        value={(item as any).availableShares ?? ''}
                        onChange={(e) => handleFieldChange(index, 'availableShares', e.target.value)}
                        className="h-8 text-sm w-24 text-right"
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell>
                      {isKnown ? (
                        <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          <Check className="h-3 w-3 mr-1" />
                          定投标的
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          未纳入定投
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <p className="text-xs text-muted-foreground">
            有效记录: {validCount}/{editedResults.length}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              取消
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isSaving || validCount === 0}
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  保存中...
                </>
              ) : (
                '确认保存'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
