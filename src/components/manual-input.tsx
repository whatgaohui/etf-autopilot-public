'use client';

import React, { useState, useCallback } from 'react';
import { Save, Loader2, X, Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { DEFAULT_ETF_LIST, type ManualHoldingInput } from '@/lib/types';
import type { EtfConfig } from '@/lib/types';

interface ManualInputProps {
  etfConfigs: EtfConfig[];
  onSave: (holdings: { etfCode: string; etfName: string; shares: number; costPrice: number; marketValue: number }[]) => void;
  isSaving: boolean;
  onCancel: () => void;
}

export function ManualInput({
  etfConfigs,
  onSave,
  isSaving,
  onCancel,
}: ManualInputProps) {
  const [rows, setRows] = useState<ManualHoldingInput[]>(() =>
    DEFAULT_ETF_LIST.map((etf) => ({
      etfCode: etf.code,
      etfName: etf.name,
      shares: '',
      costPrice: '',
      marketValue: 0,
    }))
  );

  // Merge target ratios from config
  const configMap = new Map(etfConfigs.map((c) => [c.code, c]));

  const handleFieldChange = useCallback(
    (index: number, field: 'shares' | 'costPrice', value: string) => {
      setRows((prev) => {
        const next = [...prev];
        const item = { ...next[index] };
        item[field] = value;

        // Auto-calculate market value
        const shares = parseFloat(item.shares);
        const costPrice = parseFloat(item.costPrice);
        if (!isNaN(shares) && !isNaN(costPrice) && shares > 0 && costPrice > 0) {
          item.marketValue = Math.round(shares * costPrice * 100) / 100;
        } else {
          item.marketValue = 0;
        }

        next[index] = item;
        return next;
      });
    },
    []
  );

  const handleSave = () => {
    const validHoldings = rows
      .filter((r) => {
        const shares = parseFloat(r.shares);
        const costPrice = parseFloat(r.costPrice);
        return !isNaN(shares) && !isNaN(costPrice) && shares > 0 && costPrice > 0;
      })
      .map((r) => ({
        etfCode: r.etfCode,
        etfName: r.etfName,
        shares: parseFloat(r.shares),
        costPrice: parseFloat(r.costPrice),
        marketValue: r.marketValue,
      }));

    if (validHoldings.length === 0) {
      return;
    }

    onSave(validHoldings);
  };

  const totalMarketValue = rows.reduce((sum, r) => sum + r.marketValue, 0);
  const validCount = rows.filter((r) => {
    const shares = parseFloat(r.shares);
    const costPrice = parseFloat(r.costPrice);
    return !isNaN(shares) && !isNaN(costPrice) && shares > 0 && costPrice > 0;
  }).length;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Pencil className="h-4 w-4 text-muted-foreground" />
            手动录入持仓
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>代码</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="text-right">持仓份额</TableHead>
              <TableHead className="text-right">成本价</TableHead>
              <TableHead className="text-right">市值(自动)</TableHead>
              <TableHead>目标占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const config = configMap.get(row.etfCode);
              const isInvestment = config?.isInvestmentTarget ?? true;

              return (
                <TableRow key={row.etfCode}>
                  <TableCell className="font-mono text-xs">
                    {row.etfCode}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.etfName}
                    {!isInvestment && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        非定投标的
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      value={row.shares}
                      onChange={(e) =>
                        handleFieldChange(index, 'shares', e.target.value)
                      }
                      className="h-8 text-sm w-32 text-right"
                      placeholder="0"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      step="0.001"
                      value={row.costPrice}
                      onChange={(e) =>
                        handleFieldChange(index, 'costPrice', e.target.value)
                      }
                      className="h-8 text-sm w-28 text-right"
                      placeholder="0.000"
                    />
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {row.marketValue > 0
                      ? `¥${row.marketValue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {config ? (
                      <Badge variant="secondary" className="text-xs">
                        {(config.targetRatio * 100).toFixed(0)}%
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between mt-4 pt-4 border-t">
          <div className="text-sm text-muted-foreground">
            已填 {validCount}/{rows.length} 只 · 总市值{' '}
            <span className="font-mono font-medium text-foreground">
              ¥{totalMarketValue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel} disabled={isSaving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={isSaving || validCount === 0}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  保存中...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-1" />
                  保存
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
