import ZAI from 'z-ai-web-dev-sdk';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDataServiceRunning } from '@/lib/data-service';
import type { AdviceSuggestion, RuleHit } from '@/lib/types';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// Codes excluded from investment ratio calculation
// 华宝添益 (511990) = cash reserve, 黄金ETF (518880) = family allocation
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

// ─── AI consistency check helpers (optimization doc §11.2) ───────────────────

/**
 * Extract all ¥-prefixed numbers from a piece of Chinese text.
 * Returns an array of numbers (parsed from "¥5,714" / "¥5714" / "5714元").
 */
function extractYuanAmounts(text: string): number[] {
  if (!text) return [];
  // Match ¥ followed by optional thousands separators and digits, optionally suffixed by 元
  const regex = /¥\s*([\d,]+(?:\.\d+)?)\s*元?/g;
  const amounts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (!Number.isNaN(num)) amounts.push(num);
  }
  return amounts;
}

/**
 * Build a deterministic template explanation when the LLM output fails the consistency check.
 * Format: `${name}本周建议金额为${amount}元。原因：${reasonSummary} 触发规则：${rulesHit...}。`
 */
function buildTemplateLogic(s: AdviceSuggestion): string {
  const ruleNames = (s.rulesHit || [])
    .map((r) => (typeof r === 'string' ? r : r.ruleName))
    .filter(Boolean);
  const rulesText = ruleNames.length > 0 ? ruleNames.join('、') : '无';
  const reason = s.reasonSummary || '按规则引擎结果执行';
  return `${s.name}本周建议金额为${s.amount}元。原因：${reason} 触发规则：${rulesText}。`;
}

/**
 * Check whether the LLM logic text is consistent with the rule engine's `amount`.
 * Returns `{ ok: true }` if consistent, otherwise `{ ok: false, reason }`.
 *
 * Per optimization-doc §11.2, we reject when:
 *  - A vetoed (amount=0) item is described with a positive per-ETF buy amount (hallucination)
 *  - A non-vetoed item's ¥ amount doesn't match the rule engine's amount
 *  - The LLM claims to have adjusted the amount due to macro environment (usurping the rule engine)
 * We do NOT reject the mere word "买入" — "本周不买入" and "买入0元" are legitimate phrasings.
 */
function checkLogicConsistency(s: AdviceSuggestion, logic: string): { ok: boolean; reason?: string } {
  if (!logic || typeof logic !== 'string') {
    return { ok: false, reason: 'empty logic' };
  }

  // Reject if the LLM claims to have adjusted the amount based on macro environment
  // (the rule engine is the sole authority on amounts; macro is background only).
  if (/因(宏观|市场环境|新闻|消息|情绪).{0,6}(调整|修改|改变|增加|减少).{0,4}(金额|额度|买入)/.test(logic)) {
    return { ok: false, reason: 'LLM claims to adjust amount based on macro environment (rule engine is sole authority)' };
  }

  // Extract all ¥-prefixed numbers and verify each is consistent with the rule engine.
  // Allow known context values (weekly budget) so the LLM can reference them as background.
  const amounts = extractYuanAmounts(logic);
  const contextAmounts = new Set<number>([40000, 0]); // weekly budget + zero
  if (amounts.length > 0) {
    if (s.amount === 0) {
      // Vetoed: reject any positive ¥ amount that isn't a known context value
      // (e.g. "少量买入¥5000" for a vetoed ETF is a hallucination)
      for (const a of amounts) {
        if (a > 0 && !contextAmounts.has(a)) {
          return { ok: false, reason: `vetoed item mentions per-ETF buy amount ¥${a} (should be 0)` };
        }
      }
    } else {
      // Non-vetoed: at least one ¥ amount must match `s.amount` exactly.
      const matched = amounts.some((a) => Math.abs(a - s.amount) < 0.5);
      if (!matched) {
        return { ok: false, reason: `no ¥ amount matches rule engine amount ${s.amount} (found: ${amounts.join(', ')})` };
      }
    }
  }

  return { ok: true };
}

// POST /api/advice - Generate weekly investment advice
export async function POST() {
  try {
    // Step 1: Get latest holdings
    const latestSnapshot = await db.holdingSnapshot.findFirst({
      orderBy: { snapshotDate: 'desc' },
    });

    if (!latestSnapshot) {
      return NextResponse.json(
        { error: 'No holding snapshot found. Please upload holdings first.' },
        { status: 400 }
      );
    }

    const holdings = await db.holdingSnapshot.findMany({
      where: { snapshotDate: latestSnapshot.snapshotDate },
      orderBy: { marketValue: 'desc' },
    });

    // Step 2: Get ETF configs and rules
    const etfConfigs = await db.etfConfig.findMany();
    const rules = await db.ruleConfig.findMany({
      where: { isEnabled: true },
    });
    const weeklyBudgetConfig = await db.systemConfig.findUnique({
      where: { key: 'weekly_budget' },
    });
    const weeklyBudget = parseFloat(weeklyBudgetConfig?.value || '40000');

    // Step 3: Ensure Python data-service is running, then get market data
    await ensureDataServiceRunning();
    let marketData: Record<string, unknown> = {};
    try {
      const marketDataResponse = await fetch(
        `${PYTHON_SERVICE}/api/cached/summary`,
        { next: { revalidate: 0 }, signal: AbortSignal.timeout(10000) }
      );
      if (marketDataResponse.ok) {
        marketData = await marketDataResponse.json();
      }
    } catch (e) {
      console.error('Failed to fetch market data:', e);
    }

    // Step 3.5: Merge holdings by code (in case duplicates exist)
    const mergedHoldings = new Map<string, { code: string; name: string; marketValue: number; currentRatio: number }>();
    for (const h of holdings) {
      const existing = mergedHoldings.get(h.etfCode);
      if (existing) {
        existing.marketValue += h.marketValue;
        if (h.etfName) existing.name = h.etfName;
      } else {
        mergedHoldings.set(h.etfCode, {
          code: h.etfCode,
          name: h.etfName,
          marketValue: h.marketValue,
          currentRatio: h.currentRatio,
        });
      }
    }

    // Recalculate currentRatio after merging
    // IMPORTANT: Use investment-only total (excluding 华宝添益 and 黄金) as denominator
    // so that the 6 investment ETFs' ratios sum to 100% and match target ratios
    const investmentAssets = Array.from(mergedHoldings.values())
      .filter((h) => !NON_INVESTMENT_CODES.has(h.code))
      .reduce((s, h) => s + h.marketValue, 0);

    for (const h of mergedHoldings.values()) {
      if (NON_INVESTMENT_CODES.has(h.code)) {
        // Non-investment items: ratio based on total assets (for display only)
        const totalAssets = Array.from(mergedHoldings.values()).reduce((s, x) => s + x.marketValue, 0);
        h.currentRatio = totalAssets > 0 ? (h.marketValue / totalAssets) * 100 : 0;
      } else {
        // Investment items: ratio based on investment-only total
        h.currentRatio = investmentAssets > 0 ? (h.marketValue / investmentAssets) * 100 : 0;
      }
    }
    const uniqueHoldings = Array.from(mergedHoldings.values());

    // Step 4: Call Python rule engine (target-gap-v2)
    // CRITICAL: The rule engine expects currentRatio as a FRACTION (0.148),
    // not a percentage (14.8). Convert before sending.
    const holdingsForEngine = uniqueHoldings.map((h) => ({
      code: h.code,
      name: h.name,
      marketValue: h.marketValue,
      currentRatio: h.currentRatio / 100, // Convert percentage to fraction
    }));

    let calculationResult: Record<string, unknown> = {};
    try {
      const calculateResponse = await fetch(
        `${PYTHON_SERVICE}/api/calculate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            holdings: holdingsForEngine,
            targetRatios: etfConfigs
              .filter((e) => e.isInvestmentTarget)
              .map((e) => ({
                code: e.code,
                targetRatio: e.targetRatio,
              })),
            rules: rules.map((r) => ({
              id: r.id,
              name: r.name,
              type: r.type,
              thresholdValue: r.thresholdValue,
              thresholdValueMax: r.thresholdValueMax,
              applicableScope: r.applicableScope,
              applicableCodes: r.applicableCodes ? r.applicableCodes.split(',').filter(Boolean) : [],
              isEnabled: r.isEnabled,
            })),
            weeklyBudget,
            marketData,
          }),
          signal: AbortSignal.timeout(60000),
        }
      );

      if (calculateResponse.ok) {
        calculationResult = await calculateResponse.json();
      } else {
        const errorText = await calculateResponse.text();
        console.error('Rule engine error:', errorText);
        return NextResponse.json(
          { error: 'Rule engine calculation failed' },
          { status: 500 }
        );
      }
    } catch (e) {
      console.error('Failed to call rule engine:', e);
      return NextResponse.json(
        { error: 'Failed to call rule engine' },
        { status: 500 }
      );
    }

    // Step 5: Get macro summary via Web Search
    let macroSummary = '';
    try {
      const zai = await ZAI.create();
      const searchResults = await zai.functions.invoke('web_search', {
        query: '本周A股美股宏观经济重要事件 美联储 央行政策',
        num: 5,
      });
      macroSummary = Array.isArray(searchResults)
        ? searchResults.map((r: { snippet?: string }) => r.snippet || '').join('\n')
        : '';
    } catch (e) {
      console.error('Web search failed:', e);
      macroSummary = '宏观数据获取失败，本次建议仅基于量化指标。';
    }

    // Step 6: Call LLM for logic explanation with STRONG constraints (optimization doc §11.1)
    const zai = await ZAI.create();
    const rawSuggestions = (calculationResult.suggestions || []) as Array<Record<string, unknown>>;

    // Build a focused, structured context for each ETF so the LLM can explain the gap-driven logic.
    const suggestionsForLLM = rawSuggestions.map((s) => {
      const code = s.code as string;
      const amount = s.amount as number;
      const targetRatio = s.targetRatio as number;
      const currentRatio = s.currentRatio as number;
      const deviation = s.deviation as number;
      const pePercentile = (s.pePercentile ?? null) as number | null;
      const pbPercentile = (s.pbPercentile ?? null) as number | null;
      const premiumToday = (s.premiumToday ?? null) as number | null;
      const premium7dAvg = (s.premium7dAvg ?? null) as number | null;
      const dividendYield = (s.dividendYield ?? null) as number | null;
      const vetoed = s.vetoed as boolean;
      const multiplier = s.multiplier as number;
      const reasonSummary = (s.reasonSummary as string) || '';
      const currentValue = (s.currentValue as number) ?? 0;
      const targetValueAfterBudget = (s.targetValueAfterBudget as number) ?? 0;
      const gapAmount = (s.gapAmount as number) ?? 0;
      const baseGapAmount = (s.baseGapAmount as number) ?? 0;
      const preCapAmount = (s.preCapAmount as number) ?? 0;

      // Normalize rulesHit to an array of structured objects (handle both RuleHit[] and string[])
      const rawHits = (s.rulesHit ?? []) as Array<RuleHit | string>;
      const rulesHit = rawHits.map((r) =>
        typeof r === 'string'
          ? { ruleType: 'info', ruleName: r, conditionText: '', actualValue: '', threshold: '', effect: '' }
          : r
      );

      return {
        code,
        name: s.name,
        amount,
        targetRatio,
        currentRatio,
        deviation,
        currentValue,
        targetValueAfterBudget,
        gapAmount,
        baseGapAmount,
        preCapAmount,
        pePercentile,
        pbPercentile,
        premiumToday,
        premium7dAvg,
        dividendYield,
        vetoed,
        multiplier,
        reasonSummary,
        rulesHit,
      };
    });

    const llmResponse = await zai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `你是一位专业的ETF定投逻辑分析助手。你的唯一任务是基于规则引擎（target-gap-rebalance-v4算法）的精确计算结果，为每只ETF生成详细、有依据的买入逻辑说明，并为再平衡建议生成卖出逻辑说明。

【硬性约束 - 严格遵守】
1. 所有金额必须与规则引擎的 final_amount / sell_amount 完全一致；不得修改/增加/减少金额。
2. 不得引入规则引擎未命中的规则。
3. 若 final_amount=0（含被否决或已超配），必须解释为"不买"，不能改写为"少量买入"。
4. 宏观环境仅作背景参考，不参与金额计算。
5. 你不能重新计算金额，也不能质疑规则引擎的结果；你的职责仅是解释。
6. 再平衡说明中的卖出金额必须等于规则引擎的 sell_amount；不得对未触发再平衡的标的编造卖出建议。

【target-gap-rebalance-v4算法说明】
买入侧（target-gap）：
- 投资资产总值 = sum(仅定投标的市值)
- 目标市值(预算后) = (投资资产 + 周预算) × 目标占比
- 资金缺口 = 目标市值 - 当前市值
- base_gap_amount = max(0, 资金缺口)   ← 关键：超配标的缺口≤0，不参与分配
- 预算分配 = 周预算 × base_gap / sum(所有标的基础缺口)
- 应用减量倍率(0.5) / 加量倍率(2.0) / 倍率压制规则：减量 > 加量
- 缺口上限：单标的金额 ≤ base_gap_amount
- 总预算约束：分配总和 ≤ 周预算

再平衡侧（§7 估值极端+超配双条件）：
- 超额市值 = 当前持仓市值 - 当前定投资产总额 × 目标占比
- 卖出金额 = 超额市值 × 卖出比例
- A股宽基：PE/PB分位>90%且超配≥5pp→卖超额30%；>95%且超配≥8pp→卖超额50%
- 红利ETF：股息率分位<15%且超配≥5pp→卖30%；<10%且超配≥8pp→卖50%
- 美股宽基：PE分位>95%且超配≥10pp→卖超额20%；QDII溢价>5%且超配≥5pp→卖超额30%~50%
- 卖的是超配部分，不卖核心底仓；资金去向华宝添益(511990)

【分析维度】
1. 估值分析：PE分位处于什么区间？是低估、合理还是高估？
2. 溢价分析（仅QDII）：当前溢价率多少？7日均值趋势如何？是否触及预警或红线？
3. 配置偏离分析：当前占比与目标占比偏离多少？是欠配还是超配？
4. 缺口与分配：base_gap_amount、按缺口比例分配、倍率调整、缺口上限、总预算压缩
5. 规则触发分析：命中了哪些规则？倍率是多少？为什么？
6. 横向对比：与其他ETF相比，为什么这只分配更多/更少？
7. 再平衡分析（仅对触发再平衡的标的）：为何同时满足极高估+超配双条件？卖出比例依据？资金去向？`,
        },
        {
          role: 'user',
          content: `【规则引擎计算结果（target-gap-rebalance-v4，含完整审计字段）】
买入建议：
${JSON.stringify(suggestionsForLLM, null, 2)}

再平衡建议：
${JSON.stringify((calculationResult.rebalanceSuggestions || []).map((r: Record<string, unknown>) => ({
  code: r.code, name: r.name, triggerType: r.triggerType, triggerLevel: r.triggerLevel,
  valuationMetric: r.valuationMetric, valuationValue: r.valuationValue,
  currentRatio: r.currentRatio, targetRatio: r.targetRatio, deviationPp: r.deviationPp,
  excessValue: r.excessValue, sellRatio: r.sellRatio, sellAmount: r.sellAmount,
  cashDestination: r.cashDestination, reasonSummary: r.reasonSummary,
})), null, 2)}

现金水池流向：
${JSON.stringify(calculationResult.cashPoolSuggestions || [], null, 2)}

【宏观环境背景】
${macroSummary}

【任务】
为每只ETF生成一段150-250字的买入逻辑分析（buy_logic），并为每个触发再平衡的标的生成一段120-200字的卖出逻辑说明（rebalance_logic）。

买入逻辑必须包含：
1. 该ETF当前的关键指标状态（PE分位、溢价率、偏离度）
2. 资金缺口 base_gap_amount 的含义（>0=欠配，=0=超配不补仓）
3. 触发了什么规则，倍率是多少，为什么
4. 金额是如何从缺口→按比例分配→倍率调整→缺口上限→总预算约束→最终金额
5. 若 amount=0：明确说明本周不买，并解释是"已超配不补仓"、"被否决"还是"非定投标的"
6. 宏观环境对本只ETF的参考意义（仅背景，不影响金额）

再平衡逻辑必须包含：
1. 为何该标的同时满足"极高估"与"明显超配"双条件（引用具体分位值和超配百分点）
2. 卖出比例（30%/50%/20%）的依据，对应策略书哪个等级
3. 卖出金额 = 超额市值 × 卖出比例 的计算过程
4. 资金去向华宝添益
5. 强调"卖的是超配部分，不卖核心底仓"

【输出格式】
必须用JSON对象输出，包含 buy_explanations 和 rebalance_explanations 两个数组：
{
  "buy_explanations": [{
    "code": "ETF代码",
    "name": "ETF名称",
    "logic": "详细的买入逻辑分析（150-250字）"
  }],
  "rebalance_explanations": [{
    "code": "ETF代码",
    "name": "ETF名称",
    "logic": "再平衡卖出逻辑说明（120-200字）"
  }]
}

【严禁】
- 严禁在 logic 文本中出现与规则引擎不一致的金额（¥前缀数字必须等于 amount/sell_amount）
- 严禁在 amount=0 的ETF的 logic 中出现"买入""加仓""补仓""建议买"等措辞
- 严禁对未触发再平衡的标的生成 rebalance_explanations
- 严禁编造规则引擎未触发的规则`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const logicContent =
      (llmResponse.choices?.[0]?.message?.content as string) || '{}';
    let logicExplanations: Array<{ code: string; name: string; logic: string }> = [];
    let rebalanceExplanations: Array<{ code: string; name: string; logic: string }> = [];
    try {
      // Try parsing as object {buy_explanations, rebalance_explanations} first (V4 format)
      const jsonObjMatch = logicContent.match(/\{[\s\S]*\}/);
      const parsed = jsonObjMatch ? JSON.parse(jsonObjMatch[0]) : JSON.parse(logicContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        logicExplanations = parsed.buy_explanations || parsed.buyExplanations || [];
        rebalanceExplanations = parsed.rebalance_explanations || parsed.rebalanceExplanations || [];
      } else if (Array.isArray(parsed)) {
        // Backward compat: old format was a flat array
        logicExplanations = parsed;
      }
    } catch {
      logicExplanations = rawSuggestions.map((s) => ({
        code: (s.code as string) || '',
        name: (s.name as string) || '',
        logic: '',
      }));
    }

    // Step 7: Merge calculation results with logic explanations + AI consistency check
    // Filter to only show the 6 investment target ETFs
    const investmentTargetCodes = new Set(
      etfConfigs.filter((e) => e.isInvestmentTarget).map((e) => e.code)
    );

    const filteredSuggestions = rawSuggestions.filter(
      (s) => investmentTargetCodes.has(s.code as string)
    );

    const mergedSuggestions: AdviceSuggestion[] = filteredSuggestions.map((s) => {
      // Build the typed AdviceSuggestion object, ensuring all new audit fields are present
      const code = s.code as string;
      const name = (s.name as string) || '';
      const amount = (s.amount as number) ?? 0;
      const targetRatio = (s.targetRatio as number) ?? 0;
      const currentRatio = (s.currentRatio as number) ?? 0;
      const deviation = (s.deviation as number) ?? 0;
      const currentValue = (s.currentValue as number) ?? 0;
      const targetValueAfterBudget = (s.targetValueAfterBudget as number) ?? 0;
      const gapAmount = (s.gapAmount as number) ?? 0;
      const baseGapAmount = (s.baseGapAmount as number) ?? 0;
      const pePercentile = (s.pePercentile ?? null) as number | null;
      const pbPercentile = (s.pbPercentile ?? null) as number | null;
      const premiumToday = (s.premiumToday ?? null) as number | null;
      const premium7dAvg = (s.premium7dAvg ?? null) as number | null;
      const dividendYield = (s.dividendYield ?? null) as number | null;
      // V4 多周期估值分位透传
      const pePercentile1y = (s.pePercentile1y ?? null) as number | null;
      const pePercentile3y = (s.pePercentile3y ?? null) as number | null;
      const pePercentile5y = (s.pePercentile5y ?? null) as number | null;
      const pePercentile10y = (s.pePercentile10y ?? null) as number | null;
      const pePercentileAll = (s.pePercentileAll ?? null) as number | null;
      const pbPercentile1y = (s.pbPercentile1y ?? null) as number | null;
      const pbPercentile3y = (s.pbPercentile3y ?? null) as number | null;
      const pbPercentile5y = (s.pbPercentile5y ?? null) as number | null;
      const pbPercentile10y = (s.pbPercentile10y ?? null) as number | null;
      const pbPercentileAll = (s.pbPercentileAll ?? null) as number | null;
      const dataQuality = (s.dataQuality ?? null) as AdviceSuggestion['dataQuality'];
      const vetoed = (s.vetoed as boolean) ?? false;
      const multiplier = (s.multiplier as number) ?? 1;
      const preCapAmount = (s.preCapAmount as number) ?? 0;
      const reasonSummary = (s.reasonSummary as string) || '';
      const rawHits = (s.rulesHit ?? []) as Array<RuleHit | string>;
      const rulesHit: RuleHit[] = rawHits.map((r) =>
        typeof r === 'string'
          ? { ruleType: 'info', ruleName: r, conditionText: '', actualValue: '', threshold: '', effect: '' }
          : r
      );

      const suggestion: AdviceSuggestion = {
        code,
        name,
        amount,
        targetRatio,
        currentRatio,
        deviation,
        currentValue,
        targetValueAfterBudget,
        gapAmount,
        baseGapAmount,
        pePercentile,
        pbPercentile,
        premiumToday,
        premium7dAvg,
        dividendYield,
        // V4 多周期估值分位
        pePercentile1y,
        pePercentile3y,
        pePercentile5y,
        pePercentile10y,
        pePercentileAll,
        pbPercentile1y,
        pbPercentile3y,
        pbPercentile5y,
        pbPercentile10y,
        pbPercentileAll,
        dataQuality,
        vetoed,
        multiplier,
        rulesHit,
        preCapAmount,
        reasonSummary,
        // V4.2 策略书§4/§5: 桶类型 + 软风控级别(透传规则引擎结果)
        bucketType: (s.bucketType as string) ?? 'none',
        softWindControl: (s.softWindControl as string) ?? 'none',
      };

      // Find LLM-generated logic for this code
      const llmEntry = logicExplanations.find((l) => l.code === code);
      let logic = llmEntry?.logic || '';

      // ─── AI Consistency Check (optimization doc §11.2) ───
      // Verify LLM logic agrees with the rule engine. If not, fall back to a deterministic template.
      if (logic) {
        const check = checkLogicConsistency(suggestion, logic);
        if (!check.ok) {
          console.warn(
            `[ADVICE][CONSISTENCY] Replacing LLM logic for ${code} (${name}): ${check.reason}`
          );
          logic = buildTemplateLogic(suggestion);
        }
      } else {
        // No LLM logic returned — use the template directly
        logic = buildTemplateLogic(suggestion);
      }

      suggestion.logic = logic;
      return suggestion;
    });

    // Build the final advice response — spread the full calculationResult so all audit fields
    // (calculationId, engineVersion, calculatedAt, allocationStrategy, dataSnapshot) pass through.
    // V4: merge rebalance logic explanations into rebalanceSuggestions with consistency check.
    const rawRebalanceSuggestions = (calculationResult.rebalanceSuggestions || []) as Array<Record<string, unknown>>;
    const mergedRebalanceSuggestions = rawRebalanceSuggestions.map((r) => {
      const code = (r.code as string) || '';
      const sellAmount = (r.sellAmount as number) ?? 0;
      const llmEntry = rebalanceExplanations.find((l) => l.code === code);
      let rebalanceLogic = llmEntry?.logic || '';

      // Rebalance AI consistency check: sell_amount in logic must match rule engine
      if (rebalanceLogic) {
        const amounts = extractYuanAmounts(rebalanceLogic);
        if (amounts.length > 0) {
          const matched = amounts.some((a) => Math.abs(a - sellAmount) < 0.5);
          if (!matched) {
            console.warn(
              `[ADVICE][REBALANCE-CONSISTENCY] Replacing rebalance logic for ${code}: sell_amount ${sellAmount} not found in ${amounts.join(', ')}`
            );
            rebalanceLogic = `${(r.name as string) || ''}触发再平衡：${(r.reasonSummary as string) || ''} 建议卖出¥${sellAmount}，资金转入华宝添益。`;
          }
        }
      } else {
        rebalanceLogic = `${(r.name as string) || ''}触发再平衡：${(r.reasonSummary as string) || ''} 建议卖出¥${sellAmount}，资金转入华宝添益。`;
      }

      return { ...r, rebalanceLogic };
    });

    // V4 迭代7：统计 AI 一致性校验结果，回填到 calculation_log（策略书§11 ai_explanation_check_result）
    let aiPassed = 0;
    let aiReplaced = 0;
    // 检查 buy suggestions：若 logic 来自模板（含"规则引擎结果执行"且无 LLM 个性化），视为 replaced
    for (const s of mergedSuggestions) {
      const llmEntry = logicExplanations.find((l) => l.code === s.code);
      if (!llmEntry?.logic) {
        aiReplaced++; // 无 LLM 输出，用模板
      } else {
        // 重新校验判断是否通过
        const check = checkLogicConsistency(s, llmEntry.logic);
        if (check.ok) aiPassed++;
        else aiReplaced++;
      }
    }
    // 检查 rebalance suggestions
    for (const r of mergedRebalanceSuggestions) {
      const code = (r.code as string) || '';
      const llmEntry = rebalanceExplanations.find((l) => l.code === code);
      if (llmEntry?.logic) {
        const sellAmount = (r.sellAmount as number) ?? 0;
        const amounts = extractYuanAmounts(llmEntry.logic);
        const matched = amounts.length > 0 && amounts.some((a) => Math.abs(a - sellAmount) < 0.5);
        if (matched) aiPassed++;
        else aiReplaced++;
      } else {
        aiReplaced++;
      }
    }
    const aiCheckResult = aiReplaced === 0
      ? 'passed'
      : aiPassed === 0
      ? 'all_replaced'
      : `partial(${aiPassed}/${aiPassed + aiReplaced})`;

    // 回填到 calculation_log（best-effort）
    try {
      const calcId = (calculationResult.calculationId as string) || '';
      if (calcId) {
        await fetch(`http://127.0.0.1:3031/api/calculation-log/${calcId}/ai-check`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            aiCheckResult,
            aiExplanationJson: JSON.stringify({
              buyExplanations: logicExplanations,
              rebalanceExplanations,
              summary: { passed: aiPassed, replaced: aiReplaced, total: aiPassed + aiReplaced },
            }),
          }),
          signal: AbortSignal.timeout(5000),
        });
      }
    } catch (e) {
      console.warn('[ADVICE] Failed to update ai_check_result in calculation_log:', e);
    }

    const advice = {
      ...calculationResult,
      suggestions: mergedSuggestions,
      rebalanceSuggestions: mergedRebalanceSuggestions,
      macroSummary,
      generatedAt: new Date().toISOString(),
      aiCheckResult,
      aiCheckSummary: { passed: aiPassed, replaced: aiReplaced, total: aiPassed + aiReplaced },
    };

    return NextResponse.json(advice);
  } catch (error) {
    console.error('Advice generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate advice' },
      { status: 500 }
    );
  }
}
