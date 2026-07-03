'use client';

import React, { useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Clock, AlertTriangle, AlertCircle, Upload, FileEdit } from 'lucide-react';
import { toast } from 'sonner';

import { HoldingsUpload } from '@/components/holdings-upload';
import { OcrDialog } from '@/components/ocr-dialog';
import { ManualInput } from '@/components/manual-input';
import { UnifiedHoldingsTable } from '@/components/unified-holdings-table';
import { WeeklyConclusionCard } from '@/components/weekly-conclusion-card';
import { RedLineAuditCard } from '@/components/red-line-audit-card';
import { HistoryLogCard } from '@/components/history-log-card';
import { DataTrustCard } from '@/components/data-trust-card';
import { CashSubaccountFlowCard } from '@/components/cash-subaccount-flow-card';
import { PortfolioPerformanceCard } from '@/components/portfolio-performance-card';
import { ExecutionConfirmDialog } from '@/components/execution-confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { motion, FadeInUp } from '@/lib/motion';

import {
  getHoldings,
  getEtfConfigs,
  getMarketData,
  uploadOcrImage,
  saveHoldings,
  refreshMarketData,
  generateAdvice,
  getQualitySummary,
  getMacroPrompts,
} from '@/lib/api';
import type { OcrResult, AdviceResponse, CachedSummaryResponse } from '@/lib/types';

export function Overview() {
  const queryClient = useQueryClient();

  // Local state
  const [showManualInput, setShowManualInput] = useState(false);
  const [ocrDialogOpen, setOcrDialogOpen] = useState(false);
  const [ocrResults, setOcrResults] = useState<OcrResult[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSavingHoldings, setIsSavingHoldings] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [advice, setAdvice] = useState<AdviceResponse | null>(null);
  const [isGeneratingAdvice, setIsGeneratingAdvice] = useState(false);
  const [generationStep, setGenerationStep] = useState(0);
  const [executionDialogOpen, setExecutionDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Queries
  const holdingsQuery = useQuery({
    queryKey: ['holdings'],
    queryFn: getHoldings,
  });

  const etfConfigsQuery = useQuery({
    queryKey: ['etfConfigs'],
    queryFn: getEtfConfigs,
  });

  const marketDataQuery = useQuery({
    queryKey: ['marketData'],
    queryFn: () => getMarketData('summary'),
  });

  // V4.1 S4-T2/S4-T4: 数据质量摘要（30s 自动刷新，用于 DataTrustCard + 异常阻断 Alert）
  const qualitySummaryQuery = useQuery({
    queryKey: ['quality-summary'],
    queryFn: getQualitySummary,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
  const qualitySummary = qualitySummaryQuery.data ?? null;
  // V4.1 S4-T4: 质量分 < 60 或 allow_buy_suggestion=false 时阻断
  const isDataBlocked =
    !!qualitySummary &&
    (qualitySummary.avg_score < 60 || !qualitySummary.allow_buy_suggestion);

  // V4.2 PRD§11: 宏观温度计提示（仅异常时显示在可信度卡与结论卡之间）
  const macroPromptsQuery = useQuery({
    queryKey: ['macro-prompts'],
    queryFn: getMacroPrompts,
    staleTime: 5 * 60 * 1000,
  });

  const hasHoldings = !!holdingsQuery.data?.holdings?.length;
  const holdings = holdingsQuery.data?.holdings || [];
  const totalAssets = holdingsQuery.data?.totalAssets || 0;
  const investmentAssets = holdingsQuery.data?.investmentAssets;
  const snapshotDate = holdingsQuery.data?.snapshotDate || null;
  const abnormalChanges = holdingsQuery.data?.abnormalChanges || [];
  const etfConfigs = etfConfigsQuery.data || [];

  // Market data freshness
  const marketData = marketDataQuery.data as CachedSummaryResponse | null;
  const dataFreshness =
    marketData?.lastUpdated ||
    marketData?.valuationDate ||
    marketData?.premiumDate ||
    marketData?.navDate;

  // Handlers
  const handleImageUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const result = await uploadOcrImage(file);
      if (result.holdings && result.holdings.length > 0) {
        setOcrResults(result.holdings);
        setOcrDialogOpen(true);
        toast.success(`识别到 ${result.holdings.length} 条持仓记录`);
      } else {
        toast.error('未能识别到持仓信息，请尝试手动录入');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'OCR识别失败');
    } finally {
      setIsUploading(false);
    }
  }, []);

  const handleOcrConfirm = useCallback(
    async (holdingsData: { etfCode: string; etfName: string; shares: number; costPrice: number; marketValue: number }[]) => {
      setIsSavingHoldings(true);
      try {
        const snapshotDateStr = new Date().toISOString().split('T')[0];
        // V4 PRD§12.2: OCR 来源 + 人工校准标记
        const holdingsWithSource = holdingsData.map(h => ({ ...h, source: 'ocr' as const, isManualCorrected: true }));
        await saveHoldings(holdingsWithSource, snapshotDateStr);
        toast.success('持仓数据已保存');
        setOcrDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: ['holdings'] });
        setShowManualInput(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '保存失败');
      } finally {
        setIsSavingHoldings(false);
      }
    },
    [queryClient]
  );

  const handleManualSave = useCallback(
    async (holdingsData: { etfCode: string; etfName: string; shares: number; costPrice: number; marketValue: number }[]) => {
      setIsSavingHoldings(true);
      try {
        const snapshotDateStr = new Date().toISOString().split('T')[0];
        // V4 PRD§12.2: 手动录入来源
        const holdingsWithSource = holdingsData.map(h => ({ ...h, source: 'manual' as const }));
        await saveHoldings(holdingsWithSource, snapshotDateStr);
        toast.success('持仓数据已保存');
        queryClient.invalidateQueries({ queryKey: ['holdings'] });
        setShowManualInput(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '保存失败');
      } finally {
        setIsSavingHoldings(false);
      }
    },
    [queryClient]
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    toast.info('数据刷新中,可能需要1-3分钟(多源拉取),请耐心等待...');
    try {
      await refreshMarketData();
      toast.success('数据刷新成功');
      queryClient.invalidateQueries({ queryKey: ['marketData'] });
      // V4.2: 同时刷新数据质量评分
      qualitySummaryQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '刷新失败(可能超时,请稍后重试)');
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient, qualitySummaryQuery]);

  const handleGenerateAdvice = useCallback(async () => {
    setIsGeneratingAdvice(true);
    setGenerationStep(0);
    setAdvice(null);

    try {
      const stepInterval = setInterval(() => {
        setGenerationStep((prev) => Math.min(prev + 1, 2));
      }, 2000);

      const result = await generateAdvice();
      clearInterval(stepInterval);

      setGenerationStep(3);
      setAdvice(result);
      toast.success('定投建议已生成');
      // Refresh market data query to update indicators in the table
      queryClient.invalidateQueries({ queryKey: ['marketData'] });
    } catch (err) {
      setGenerationStep(0);
      toast.error(err instanceof Error ? err.message : '生成建议失败');
    } finally {
      setIsGeneratingAdvice(false);
    }
  }, [queryClient]);

  return (
    <div className="space-y-6">
      {/* V4.1 S4-T4: 数据异常阻断提示 — 质量分 < 60 或 allow_buy_suggestion=false 时显示 */}
      {isDataBlocked && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <Alert variant="destructive" className="border-red-300 dark:border-red-800/60 bg-red-50/80 dark:bg-red-950/30">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
            <AlertTitle className="text-red-800 dark:text-red-300 font-semibold">
              关键数据源异常，本次不生成自动执行建议
            </AlertTitle>
            <AlertDescription className="text-red-700/90 dark:text-red-300/80">
              请先处理数据源问题或人工确认。
              {qualitySummary && (
                <span className="ml-1 font-mono text-[11px] text-red-700/70 dark:text-red-400/70">
                  （当前质量总分 {qualitySummary.avg_score.toFixed(1)}，
                  买入建议 {qualitySummary.allow_buy_suggestion ? '允许' : '已阻断'}，
                  再平衡建议 {qualitySummary.allow_rebalance_suggestion ? '允许' : '已阻断'}）
                </span>
              )}
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {/* Action toolbar — 数据时间 + 右侧操作按钮 */}
      <FadeInUp className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {dataFreshness && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/50 px-2.5 py-1 text-[11px] text-muted-foreground">
              <Clock className="size-3 shrink-0 text-emerald-500" />
              <span className="font-medium">
                {new Date(dataFreshness).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </span>
          )}
          {hasHoldings && snapshotDate && (
            <span className="text-[11px] text-muted-foreground/60 hidden sm:inline">
              · 持仓 {new Date(snapshotDate).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasHoldings && !showManualInput && (
            <>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="h-8 text-xs">
                <Upload className="size-3.5" />
                {isUploading ? '识别中' : '更新持仓'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowManualInput(true)} className="h-8 text-xs text-muted-foreground hover:text-foreground">
                <FileEdit className="size-3.5" />
                手动录入
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageUpload(file);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
            </>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="h-8 text-xs">
            <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? '刷新中' : '刷新'}
          </Button>
        </div>
      </FadeInUp>

      {/* 持仓上传区 — 仅无持仓或手动录入模式时显示 */}
      {(!hasHoldings || showManualInput) && (
        <FadeInUp delay={0.05}>
          {!showManualInput ? (
            <HoldingsUpload
              hasHoldings={hasHoldings}
              snapshotDate={snapshotDate}
              onImageUpload={handleImageUpload}
              onManualInput={() => setShowManualInput(true)}
              isUploading={isUploading}
            />
          ) : (
            <ManualInput
              etfConfigs={etfConfigs}
              onSave={handleManualSave}
              isSaving={isSavingHoldings}
              onCancel={() => setShowManualInput(false)}
            />
          )}
        </FadeInUp>
      )}

      {/* OCR Dialog */}
      <OcrDialog
        open={ocrDialogOpen}
        onOpenChange={setOcrDialogOpen}
        ocrResults={ocrResults}
        etfConfigs={etfConfigs}
        onConfirm={handleOcrConfirm}
        isSaving={isSavingHoldings}
      />

      {/* V4.1 S4-T1/S4-T2: 数据可信度卡 — 持仓上传区下方、结论卡上方 */}
      <DataTrustCard
        data={qualitySummary}
        isLoading={qualitySummaryQuery.isLoading}
        isError={qualitySummaryQuery.isError}
        onRefresh={() => qualitySummaryQuery.refetch()}
      />

      {/* V5.0 投资收益追踪卡 — 数据可信度卡下方、结论卡上方 */}
      <PortfolioPerformanceCard hasHoldings={hasHoldings} />

      {/* V4.2 PRD§11: 宏观温度计提示区 — 仅异常时显示, 在可信度卡与结论卡之间 */}
      {macroPromptsQuery.data?.has_alert && macroPromptsQuery.data.prompts.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <Alert className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <AlertCircle className="size-4 text-amber-600" />
            <AlertTitle className="text-sm text-amber-800 dark:text-amber-300">宏观提示</AlertTitle>
            <AlertDescription>
              {macroPromptsQuery.data.prompts.map((p, i) => (
                <div key={`${p.prompt_id}-${i}`} className="text-xs mt-1 text-amber-800 dark:text-amber-300">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] mr-1 ${
                      p.severity === 'strong'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    }`}
                  >
                    {p.severity === 'strong' ? '强提示' : '提示'}
                  </span>
                  {p.prompt_text}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {/* V4 策略书§10.3: 持仓异常变化提示 */}
      {abnormalChanges.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-xl border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-700/40 p-4 shadow-soft"
        >
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2">
            <AlertTriangle className="size-3.5" />
            <span>持仓异常变化提示</span>
          </div>
          <div className="space-y-1.5">
            {abnormalChanges.map((c) => (
              <div key={c.etfCode} className="flex items-center gap-2 text-[11px] text-amber-800 dark:text-amber-300">
                <span className="font-medium">{c.etfName}({c.etfCode})</span>
                <span className="font-mono text-muted-foreground">
                  ¥{c.previousValue.toLocaleString('zh-CN')} → ¥{c.currentValue.toLocaleString('zh-CN')}
                </span>
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-amber-700 border-amber-300 bg-amber-100/70 dark:text-amber-300 dark:border-amber-700 dark:bg-amber-900/30">
                  变化{c.changePct}%
                </Badge>
                <span className="text-[10px] text-amber-700/70 dark:text-amber-400/70">请确认是否识别错误</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* 本周定投建议结论卡 — 全宽展示 */}
      {hasHoldings && (
        <FadeInUp delay={0.1}>
          <WeeklyConclusionCard
            advice={advice}
            isGenerating={isGeneratingAdvice}
            onGenerateAdvice={handleGenerateAdvice}
            onConfirmExecution={() => setExecutionDialogOpen(true)}
          />
        </FadeInUp>
      )}

      {/* Section 2: Red Line Audit Card (auto-hides when no vetoed investment-target items) */}
      {hasHoldings && advice && (
        <FadeInUp delay={0.15}>
          <RedLineAuditCard advice={advice} />
        </FadeInUp>
      )}

      {/* V4.2 §9 现金子账户流向卡 — 结论卡下方、持仓明细表上方,仅 advice 存在时渲染 */}
      {hasHoldings && advice && <CashSubaccountFlowCard advice={advice} />}

      {/* Section 3: Unified Holdings + Monitoring + Advice Table */}
      {hasHoldings && (
        <FadeInUp delay={0.2}>
          <UnifiedHoldingsTable
            holdings={holdings}
            totalAssets={totalAssets}
            investmentAssets={investmentAssets}
            etfConfigs={etfConfigs}
            marketData={marketData}
            advice={advice}
            isGeneratingAdvice={isGeneratingAdvice}
            generationStep={generationStep}
            onGenerateAdvice={handleGenerateAdvice}
          />
        </FadeInUp>
      )}

      {/* Section 4: History Log (V4 策略书§11 审计 + §10.3 回溯) */}
      <FadeInUp delay={0.25}>
        <HistoryLogCard />
      </FadeInUp>

      {/* V5.0 执行确认弹窗 — 仅当执行单(advice)已生成时可用 */}
      <ExecutionConfirmDialog
        open={executionDialogOpen}
        onOpenChange={setExecutionDialogOpen}
        calculationId={advice?.calculationId || ''}
        suggestions={advice?.suggestions || []}
        onConfirmed={() => {
          // 确认后刷新收益追踪 + 持仓（实际执行可能影响持仓）
          queryClient.invalidateQueries({ queryKey: ['portfolio-performance'] });
        }}
      />
    </div>
  );
}
