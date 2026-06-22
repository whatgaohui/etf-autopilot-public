'use client';

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Ban, Repeat, PauseCircle, ArrowRight } from 'lucide-react';
import type { AdviceResponse, AdviceSuggestion, RuleHit, RebalanceSuggestion } from '@/lib/types';
import { FadeInUp, staggerContainer, StaggerItem, motion } from '@/lib/motion';

// Codes excluded from investment decisions (cash reserve + gold)
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

interface RedLineAuditCardProps {
  advice: AdviceResponse;
  /** Optional callback when a chip is clicked (e.g., to scroll to the row in the detail table). */
  onSelectCode?: (code: string) => void;
}

// Backward-compat helper: accept both string[] (v1) and RuleHit[] (v2)
function normalizeRuleHits(hits: Array<RuleHit | string> | undefined | null): RuleHit[] {
  if (!hits || !Array.isArray(hits)) return [];
  return hits.map((r) => {
    if (typeof r === 'string') {
      return {
        ruleType: 'info',
        ruleName: r,
        conditionText: '',
        actualValue: '',
        threshold: '',
        effect: '',
      };
    }
    return r as RuleHit;
  });
}

// Find the first veto rule from the suggestion's rulesHit, falling back to any info rule
function findVetoRule(s: AdviceSuggestion): RuleHit | null {
  const hits = normalizeRuleHits(s.rulesHit as Array<RuleHit | string> | undefined);
  const veto = hits.find((r) => r.ruleType === 'veto');
  if (veto) return veto;
  // Fallback: if vetoed but no explicit veto rule, take any non-empty rule
  return hits.find((r) => r.ruleName) || null;
}

// Build a short chip text like "PE分位92.9%>80%" or "溢价6.28%>3%"
function buildChipLabel(s: AdviceSuggestion, rule: RuleHit | null): string {
  if (rule) {
    const actual = rule.actualValue?.trim();
    const threshold = rule.threshold?.trim();
    if (actual && threshold) {
      return `${actual}>${threshold}`;
    }
    if (rule.ruleName) {
      return rule.ruleName;
    }
  }
  // Fallback: derive from reasonSummary first clause
  if (s.reasonSummary) {
    const first = s.reasonSummary.split(/[，。；,.;]/)[0];
    if (first && first.length <= 18) return first;
    if (first) return first.slice(0, 16) + '…';
  }
  return '一票否决';
}

export function RedLineAuditCard({ advice, onSelectCode }: RedLineAuditCardProps) {
  // PRD§7.4 三类信息：A.一票否决 B.暂停买入(超配不补仓) C.再平衡建议
  const allInvestment = (advice.suggestions || []).filter(
    (s) => !NON_INVESTMENT_CODES.has(s.code)
  );
  const vetoedInvestment = allInvestment.filter((s) => s.vetoed);
  // 暂停买入：非否决但金额为0（超配不补仓 或 数据质量减量至0）
  const pausedInvestment = allInvestment.filter((s) => !s.vetoed && (s.amount ?? 0) === 0);
  const rebalanceList: RebalanceSuggestion[] = advice.rebalanceSuggestions ?? [];

  if (vetoedInvestment.length === 0 && pausedInvestment.length === 0 && rebalanceList.length === 0) {
    return null;
  }

  const totalUnallocated = advice.totalUnallocated ?? 0;

  return (
    <FadeInUp delay={0.05}>
      <Card className="shadow-card overflow-hidden">
        <CardContent className="space-y-4 pt-6">
          {/* A. 一票否决 */}
          {vetoedInvestment.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400">
                <span className="inline-flex items-center justify-center rounded-md bg-red-100/70 dark:bg-red-900/40 p-0.5">
                  <Ban className="h-3 w-3" />
                </span>
                <span>一票否决风险 ({vetoedInvestment.length})</span>
              </div>
              <motion.div
                variants={staggerContainer(0.04)}
                initial="hidden"
                animate="show"
                className="flex flex-wrap gap-2"
              >
                {vetoedInvestment.map((s) => {
                  const rule = findVetoRule(s);
                  const label = buildChipLabel(s, rule);
                  return (
                    <StaggerItem key={s.code} className="inline-block">
                      <button
                        type="button"
                        onClick={() => onSelectCode?.(s.code)}
                        title={rule?.conditionText || s.reasonSummary}
                        className="inline-flex items-center gap-1.5 rounded-full border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-950/30 px-2.5 py-1 text-[11px] text-red-700 dark:text-red-400 hover:-translate-y-0.5 hover:shadow-soft hover:border-red-300 dark:hover:border-red-700 hover:bg-red-100/80 dark:hover:bg-red-900/40 transition-all duration-200 ease-out-expo cursor-pointer"
                      >
                        <Ban className="h-3 w-3 shrink-0" />
                        <span className="font-medium">{s.name}</span>
                        <span className="text-red-600/80 dark:text-red-400/80 font-mono">{label}</span>
                      </button>
                    </StaggerItem>
                  );
                })}
              </motion.div>
            </div>
          )}

          {/* B. 暂停买入（超配不补仓，含释放预算去向） */}
          {pausedInvestment.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <span className="inline-flex items-center justify-center rounded-md bg-amber-100/70 dark:bg-amber-900/40 p-0.5">
                  <PauseCircle className="h-3 w-3" />
                </span>
                <span>暂停买入 · 超配不补仓 ({pausedInvestment.length})</span>
              </div>
              <div className="rounded-md border border-amber-200/70 dark:border-amber-800/40 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-amber-50/50 dark:bg-amber-950/30">
                    <tr>
                      <th className="text-left font-medium px-2 py-1 text-amber-800 dark:text-amber-400">标的</th>
                      <th className="text-left font-medium px-2 py-1 text-amber-800 dark:text-amber-400">原因</th>
                      <th className="text-right font-medium px-2 py-1 text-amber-800 dark:text-amber-400">释放预算去向</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pausedInvestment.map((s) => (
                      <tr key={s.code} className="border-t border-amber-100 dark:border-amber-900/40">
                        <td className="px-2 py-1 font-medium">{s.name}</td>
                        <td className="px-2 py-1 text-muted-foreground truncate max-w-[160px]" title={s.reasonSummary}>
                          {s.reasonSummary}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400">
                            <ArrowRight className="h-3 w-3" />
                            华宝添益
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* C. 再平衡建议 */}
          {rebalanceList.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-orange-700 dark:text-orange-400">
                <span className="inline-flex items-center justify-center rounded-md bg-orange-100/70 dark:bg-orange-900/40 p-0.5">
                  <Repeat className="h-3 w-3" />
                </span>
                <span>再平衡建议 ({rebalanceList.length})</span>
              </div>
              <div className="rounded-md border border-orange-200/70 dark:border-orange-800/40 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-orange-50/50 dark:bg-orange-950/30">
                    <tr>
                      <th className="text-left font-medium px-2 py-1 text-orange-800 dark:text-orange-400">标的</th>
                      <th className="text-center font-medium px-2 py-1 text-orange-800 dark:text-orange-400">等级</th>
                      <th className="text-right font-medium px-2 py-1 text-orange-800 dark:text-orange-400">卖出金额</th>
                      <th className="text-right font-medium px-2 py-1 text-orange-800 dark:text-orange-400">资金去向</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebalanceList.map((r) => (
                      <tr key={r.code} className="border-t border-orange-100 dark:border-orange-900/40">
                        <td className="px-2 py-1 font-medium">{r.name}</td>
                        <td className="px-2 py-1 text-center">
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1 py-0 rounded-full ${
                              r.triggerLevel === 'level2'
                                ? 'border-orange-400 dark:border-orange-600 text-orange-700 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-900/40'
                                : 'border-orange-300/70 dark:border-orange-700/50 text-orange-600 dark:text-orange-400 bg-orange-50/40 dark:bg-orange-950/30'
                            }`}
                          >
                            {r.triggerLevel === 'level2' ? '二级' : '一级'}
                          </Badge>
                        </td>
                        <td className="px-2 py-1 text-right font-mono font-semibold text-orange-700 dark:text-orange-400">
                          -¥{r.sellAmount.toLocaleString('zh-CN')}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <span className="inline-flex items-center gap-0.5 text-orange-700 dark:text-orange-400">
                            <ArrowRight className="h-3 w-3" />
                            华宝添益
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </FadeInUp>
  );
}
