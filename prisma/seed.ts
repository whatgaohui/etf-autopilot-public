/**
 * ETF Autopilot V5 — Seed Script
 *
 * Populates the database with realistic demo data for a ~500,000 RMB portfolio.
 * All monetary amounts are in 分 (cents). 1 RMB = 100 分.
 *
 * Run: bunx prisma db seed
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// ─── Helper: RMB to 分 ────────────────────────────────────
const fen = (yuan: number) => Math.round(yuan * 100)

// ─── Helper: 份额 to 整数（×10000 保留4位精度）─────────────
const shares10k = (shares: number) => Math.round(shares * 10000)

// ─── Helper: 价格 to 分/万份 ─────────────────────────────
const priceFen = (price: number) => Math.round(price * 100 * 10000)

async function main() {
  console.log('🌱 Seeding ETF Autopilot V5 database...\n')

  // ═══════════════════════════════════════════════════════════
  // 1. EtfConfig — 6 ETFs, target ratios sum to 100% (10000 BPS)
  // ═══════════════════════════════════════════════════════════
  console.log('  📦 EtfConfig...')

  const etfConfigs = await Promise.all([
    db.etfConfig.upsert({
      where: { code: '510300' },
      update: {},
      create: {
        code: '510300',
        name: '沪深300ETF',
        category: 'domestic',
        targetRatioBps: 2000, // 20%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 1,
        assetClass: 'domestic',
        role: 'core',
      },
    }),
    db.etfConfig.upsert({
      where: { code: '510500' },
      update: {},
      create: {
        code: '510500',
        name: '中证500ETF',
        category: 'domestic',
        targetRatioBps: 1800, // 18%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 2,
        assetClass: 'domestic',
        role: 'core',
      },
    }),
    db.etfConfig.upsert({
      where: { code: '588000' },
      update: {},
      create: {
        code: '588000',
        name: '科创50ETF',
        category: 'domestic',
        targetRatioBps: 1200, // 12%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 3,
        assetClass: 'domestic',
        role: 'satellite',
      },
    }),
    db.etfConfig.upsert({
      where: { code: '512890' },
      update: {},
      create: {
        code: '512890',
        name: '红利低波ETF',
        category: 'domestic',
        targetRatioBps: 1000, // 10%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 4,
        assetClass: 'domestic',
        role: 'satellite',
      },
    }),
    db.etfConfig.upsert({
      where: { code: '513500' },
      update: {},
      create: {
        code: '513500',
        name: '标普500ETF',
        category: 'overseas',
        targetRatioBps: 2500, // 25%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 5,
        assetClass: 'overseas',
        role: 'core',
      },
    }),
    db.etfConfig.upsert({
      where: { code: '513300' },
      update: {},
      create: {
        code: '513300',
        name: '纳斯达克100ETF',
        category: 'overseas',
        targetRatioBps: 1500, // 15%
        isBlacklisted: false,
        isInvestmentTarget: true,
        sortOrder: 6,
        assetClass: 'overseas',
        role: 'satellite',
      },
    }),
  ])
  console.log(`    ✅ ${etfConfigs.length} ETFs created\n`)

  // ═══════════════════════════════════════════════════════════
  // 2. StrategyVersion — V5.0 active strategy
  // ═══════════════════════════════════════════════════════════
  console.log('  📋 StrategyVersion...')

  const v5Params = JSON.stringify({
    target_ratios: {
      '510300': 0.20,
      '510500': 0.18,
      '588000': 0.12,
      '512890': 0.10,
      '513500': 0.25,
      '513300': 0.15,
    },
    weekly_budget: 7000,
    base_bucket_ratio: 0.40,
    value_bucket_ratio: 0.60,
    max_single_etf_buy_ratio: 0.70,
    qdii_release_plan_weeks: 8,
    qdii_release_cap_multiplier: 2.0,
    buy_percentile_windows: { domestic: '5y', overseas: '5y' },
    sell_percentile_windows: { domestic: '10y', overseas: '10y' },
    rebalance_thresholds: { L1: 0.30, L2: 0.50 },
    soft_wind_control_levels: [
      'none',
      'reduce',
      'forbid_enhancement',
      'minimal_base',
      'pause_all',
    ],
  })

  const strategyVersion = await db.strategyVersion.upsert({
    where: { version: 'v5.0' },
    update: {},
    create: {
      version: 'v5.0',
      status: 'active',
      parameters: v5Params,
      docRef: 'ETF定投助手投资策略说明书V5.0',
      effectiveAt: new Date('2026-07-01T00:00:00.000Z'),
      createdReason: 'V5.0初始版本 — 统一策略参数、规则引擎、现金账本',
      confirmedBy: 'system',
    },
  })
  console.log(`    ✅ Strategy ${strategyVersion.version} (${strategyVersion.status})\n`)

  // ═══════════════════════════════════════════════════════════
  // 3. HoldingSnapshot — 6 ETFs, total portfolio ~500,000 RMB
  // ═══════════════════════════════════════════════════════════
  console.log('  📊 HoldingSnapshot...')

  const snapshotDate = new Date('2026-07-11T00:00:00.000Z') // Last Friday
  const totalPortfolioFen = fen(500000)

  // Holdings: ETF code → { shares, costPerUnit, marketValue, currentRatio }
  const holdings: Array<{
    etfCode: string
    shares: number
    costPerUnit: number
    marketValue: number
    currentRatio: number
  }> = [
    // 沪深300: ~100,000 RMB
    {
      etfCode: '510300',
      shares: 22000,
      costPerUnit: 4.35,
      marketValue: 101200,
      currentRatio: 0.2024,
    },
    // 中证500: ~85,000 RMB
    {
      etfCode: '510500',
      shares: 95000,
      costPerUnit: 0.82,
      marketValue: 85500,
      currentRatio: 0.171,
    },
    // 科创50: ~55,000 RMB
    {
      etfCode: '588000',
      shares: 13000,
      costPerUnit: 3.90,
      marketValue: 57200,
      currentRatio: 0.1144,
    },
    // 红利低波: ~48,000 RMB
    {
      etfCode: '512890',
      shares: 32000,
      costPerUnit: 1.42,
      marketValue: 48600,
      currentRatio: 0.0972,
    },
    // 标普500: ~120,000 RMB
    {
      etfCode: '513500',
      shares: 31000,
      costPerUnit: 3.65,
      marketValue: 124000,
      currentRatio: 0.248,
    },
    // 纳斯达克100: ~82,000 RMB
    {
      etfCode: '513300',
      shares: 8500,
      costPerUnit: 9.10,
      marketValue: 83300,
      currentRatio: 0.1666,
    },
  ]

  const snapshots = await Promise.all(
    holdings.map((h) =>
      db.holdingSnapshot.create({
        data: {
          snapshotDate,
          etfCode: h.etfCode,
          shares: shares10k(h.shares),
          costPer10k: priceFen(h.costPerUnit),
          marketValueFen: fen(h.marketValue),
          currentRatioBps: Math.round(h.currentRatio * 10000),
          source: 'manual',
          isManualCorrected: true,
        },
      }),
    ),
  )
  console.log(
    `    ✅ ${snapshots.length} holding snapshots (total: ¥${totalPortfolioFen / 100})\n`,
  )

  // ═══════════════════════════════════════════════════════════
  // 4. CashSubaccount — 7 accounts with realistic balances
  // ═══════════════════════════════════════════════════════════
  console.log('  💰 CashSubaccount...')

  const cashAccounts: Array<{
    type: any
    balance: number
    equity: boolean
    desc: string
  }> = [
    {
      type: 'daily_cash',
      balance: 3200,
      equity: false,
      desc: '日常现金（不计入权益基准）',
    },
    {
      type: 'weekly_unallocated_cash',
      balance: 8500,
      equity: true,
      desc: '本周未分配权益现金',
    },
    {
      type: 'rebalance_equity_reserve',
      balance: 12000,
      equity: true,
      desc: '再平衡权益备用金',
    },
    {
      type: 'qdii_pending_cash_sp500',
      balance: 5600,
      equity: true,
      desc: '标普500 QDII 挂起资金',
    },
    {
      type: 'qdii_pending_cash_nasdaq',
      balance: 4200,
      equity: true,
      desc: '纳斯达克 QDII 挂起资金',
    },
    {
      type: 'manual_cash',
      balance: 15000,
      equity: false,
      desc: '用户手动指定现金（不计入权益基准）',
    },
    {
      type: 'weekly_contribution_committed',
      balance: 7000,
      equity: true,
      desc: '本周承诺注资（待分配）',
    },
  ]

  const subaccounts = await Promise.all(
    cashAccounts.map((a) =>
      db.cashSubaccount.upsert({
        where: { accountType: a.type },
        update: { balanceFen: fen(a.balance), description: a.desc, countsAsEquityBase: a.equity },
        create: {
          accountType: a.type,
          balanceFen: fen(a.balance),
          countsAsEquityBase: a.equity,
          description: a.desc,
        },
      }),
    ),
  )
  console.log(`    ✅ ${subaccounts.length} cash subaccounts\n`)

  // ═══════════════════════════════════════════════════════════
  // 5. RuleConfig — Buy / Pause / Rebalance rules
  // ═══════════════════════════════════════════════════════════
  console.log('  📜 RuleConfig...')

  const rules = [
    // ── Buy Rules ──
    {
      group: 'buy',
      name: 'pe_low_buy_boost',
      value: 'pe_percentile < 30 → boost 1.5x',
      desc: 'PE分位低于30%时增强买入',
      type: 'boost',
      condition: 'pe_percentile < 30',
      metric: 'pe_percentile',
      window: '5y',
      op: 'lt',
      threshold: 3000, // 30.00% in BPS
      scope: 'all',
    },
    {
      group: 'buy',
      name: 'pe_high_buy_reduce',
      value: 'pe_percentile > 80 → reduce 0.5x',
      desc: 'PE分位高于80%时减少买入',
      type: 'reduce',
      condition: 'pe_percentile > 80',
      metric: 'pe_percentile',
      window: '5y',
      op: 'gt',
      threshold: 8000,
      scope: 'all',
    },
    {
      group: 'buy',
      name: 'dividend_yield_high_boost',
      value: '股息率分位 < 20 → boost 1.3x',
      desc: '高股息分位低时增强买入红利ETF',
      type: 'boost',
      condition: 'dividend_yield_percentile < 20',
      metric: 'dividend_yield_percentile',
      window: '10y',
      op: 'lt',
      threshold: 2000,
      scope: 'specific',
      codes: '512890',
    },
    {
      group: 'buy',
      name: 'max_single_etf_cap',
      value: '单ETF不超过目标比例×1.7',
      desc: '单只ETF实际比例不超过目标比例的170%',
      type: 'veto',
      condition: 'current_ratio > target_ratio * 1.7',
      metric: 'deviation',
      threshold: 17000,
      scope: 'all',
    },

    // ── Pause Rules ──
    {
      group: 'pause',
      name: 'qdii_premium_veto',
      value: 'QDII溢价 > 5% → 禁买',
      desc: 'QDII ETF溢价超过5%时禁止买入',
      type: 'veto',
      condition: 'premium_today > 5%',
      metric: 'premium_today',
      window: null,
      op: 'gt',
      threshold: 500, // 5.00% in BPS
      scope: 'qdii',
    },
    {
      group: 'pause',
      name: 'data_quality_gate',
      value: '质量分 < 60 → 禁买',
      desc: '数据质量分低于60分时禁止规则使用',
      type: 'veto',
      condition: 'quality_score < 60',
      metric: 'quality_score',
      threshold: 6000, // 60.00 in 100-based score
      scope: 'all',
    },
    {
      group: 'pause',
      name: 'soft_wind_forbid_enhancement',
      value: 'PE > 95分位 → 禁增强仓',
      desc: 'PE分位超过95%时仅允许基础仓',
      type: 'reduce',
      condition: 'pe_percentile > 95',
      metric: 'pe_percentile',
      window: '10y',
      op: 'gt',
      threshold: 9500,
      scope: 'all',
    },

    // ── Rebalance Rules ──
    {
      group: 'rebalance',
      name: 'rebalance_L1_sell',
      value: '超配 ≥ 30% → L1减仓',
      desc: '实际比例超过目标30%时触发L1减仓',
      type: 'reduce',
      condition: 'deviation >= 30%',
      metric: 'deviation',
      threshold: 3000,
      scope: 'all',
    },
    {
      group: 'rebalance',
      name: 'rebalance_L2_sell',
      value: '超配 ≥ 50% → L2深度减仓',
      desc: '实际比例超过目标50%时触发L2深度减仓',
      type: 'reduce',
      condition: 'deviation >= 50%',
      metric: 'deviation',
      threshold: 5000,
      scope: 'all',
    },

    // ── Data Quality Rules ──
    {
      group: 'data_quality',
      name: 'freshness_degraded',
      value: '数据>3天 → degraded',
      desc: '数据超过3天未更新标记为degraded',
      type: 'reduce',
      condition: 'age_days > 3',
      threshold: 300,
      scope: 'all',
    },
    {
      group: 'data_quality',
      name: 'consistency_conflict',
      value: '源间差异>2% → conflict',
      desc: '多数据源间差异超过2%标记为conflict',
      type: 'veto',
      condition: 'source_diff > 2%',
      threshold: 200,
      scope: 'all',
    },
  ]

  const ruleConfigs = await Promise.all(
    rules.map((r, i) =>
      db.ruleConfig.create({
        data: {
          ruleGroup: r.group,
          ruleName: r.name,
          ruleValue: r.value,
          description: r.desc,
          ruleType: r.type,
          triggerCondition: r.condition,
          thresholdValue: r.threshold,
          applicableScope: r.scope,
          applicableCodes: (r as any).codes || null,
          conditionMetric: r.metric,
          percentileWindow: (r as any).window || null,
          operator: (r as any).op || null,
          priority: i + 1,
          isEnabled: true,
          sortOrder: i + 1,
          displayText: r.desc,
        },
      }),
    ),
  )
  console.log(`    ✅ ${ruleConfigs.length} rules created\n`)

  // ═══════════════════════════════════════════════════════════
  // 6. SystemConfig — Key system parameters
  // ═══════════════════════════════════════════════════════════
  console.log('  ⚙️ SystemConfig...')

  const sysConfigs = [
    { key: 'weekly_budget', value: '700000', desc: '每周定投预算（分）= ¥7,000' },
    { key: 'base_bucket_ratio', value: '4000', desc: '基础仓比例（BPS）= 40%' },
    { key: 'value_bucket_ratio', value: '6000', desc: '增强仓比例（BPS）= 60%' },
    { key: 'qdii_release_weeks', value: '8', desc: 'QDII释放计划周数' },
    { key: 'qdii_release_cap_multiplier', value: '200', desc: 'QDII释放上限倍率（BPS）= 2.0x' },
    { key: 'min_trade_amount_fen', value: '100000', desc: '最小交易金额（分）= ¥1,000' },
    { key: 'trading_unit', value: '100', desc: 'ETF最小交易单位（份）' },
    { key: 'data_quality_gate_score', value: '60', desc: '数据质量门禁分数阈值' },
    { key: 'soft_wind_control_level', value: 'none', desc: '当前软风控级别' },
    { key: 'rebalance_L1_threshold', value: '3000', desc: 'L1再平衡阈值（BPS）= 30%' },
    { key: 'rebalance_L2_threshold', value: '5000', desc: 'L2再平衡阈值（BPS）= 50%' },
    { key: 'engine_version', value: 'v5.0', desc: '当前规则引擎版本' },
  ]

  const sysConfigRecords = await Promise.all(
    sysConfigs.map((c) =>
      db.systemConfig.upsert({
        where: { configKey: c.key },
        update: { configValue: c.value, description: c.desc },
        create: {
          configKey: c.key,
          configValue: c.value,
          description: c.desc,
        },
      }),
    ),
  )
  console.log(`    ✅ ${sysConfigRecords.length} system configs\n`)

  // ═══════════════════════════════════════════════════════════
  // 7. CalculationLog — 3 audit entries
  // ═══════════════════════════════════════════════════════════
  console.log('  📝 CalculationLog...')

  const calcLogs = [
    {
      id: 'calc-2026-07-04',
      strategy: 'v5.0',
      engine: 'v5.0',
      hash: 'a1b2c3d4e5f60708',
      eab: 528000,
      budget: 7000,
      allocated: 6200,
      rebalanced: 0,
      unallocated: 800,
      dest: 'weekly_unallocated_cash',
      rulesHit: JSON.stringify([
        { rule: 'pe_low_buy_boost', etf: '510500', effect: 'boost 1.5x' },
        { rule: 'pe_high_buy_reduce', etf: '513500', effect: 'reduce 0.5x' },
        { rule: 'qdii_premium_veto', etf: '513300', effect: 'veto' },
      ]),
      quality: JSON.stringify({
        '510300': { score: 98, status: 'valid' },
        '510500': { score: 95, status: 'valid' },
        '588000': { score: 88, status: 'valid' },
        '512890': { score: 92, status: 'valid' },
        '513500': { score: 72, status: 'degraded' },
        '513300': { score: 45, status: 'conflict' },
      }),
      results: JSON.stringify({
        orders: [
          { etf: '510300', amount: 1400, side: 'buy', mode: 'immediate' },
          { etf: '510500', amount: 2100, side: 'buy', mode: 'immediate' },
          { etf: '588000', amount: 840, side: 'buy', mode: 'immediate' },
          { etf: '512890', amount: 700, side: 'buy', mode: 'immediate' },
          { etf: '513500', amount: 1160, side: 'buy', mode: 'staged' },
        ],
        total_budget: 7000,
        total_planned: 6200,
        unallocated: 800,
        unallocated_destination: 'weekly_unallocated_cash',
        soft_wind_control: 'none',
      }),
      createdAt: new Date('2026-07-04T09:30:00.000Z'),
    },
    {
      id: 'calc-2026-07-11',
      strategy: 'v5.0',
      engine: 'v5.0',
      hash: 'f6e5d4c3b2a10987',
      eab: 541300,
      budget: 7000,
      allocated: 5800,
      rebalanced: 0,
      unallocated: 1200,
      dest: 'weekly_unallocated_cash',
      rulesHit: JSON.stringify([
        { rule: 'pe_low_buy_boost', etf: '512890', effect: 'boost 1.3x' },
        { rule: 'qdii_premium_veto', etf: '513500', effect: 'veto' },
        { rule: 'data_quality_gate', etf: '513300', effect: 'veto' },
        { rule: 'soft_wind_forbid_enhancement', etf: '588000', effect: 'reduce' },
      ]),
      quality: JSON.stringify({
        '510300': { score: 97, status: 'valid' },
        '510500': { score: 94, status: 'valid' },
        '588000': { score: 91, status: 'valid' },
        '512890': { score: 96, status: 'valid' },
        '513500': { score: 55, status: 'degraded' },
        '513300': { score: 30, status: 'missing' },
      }),
      results: JSON.stringify({
        orders: [
          { etf: '510300', amount: 1400, side: 'buy', mode: 'immediate' },
          { etf: '510500', amount: 1260, side: 'buy', mode: 'immediate' },
          { etf: '512890', amount: 910, side: 'buy', mode: 'immediate' },
          { etf: '588000', amount: 560, side: 'buy', mode: 'base_only' },
          { etf: '513500', amount: 0, side: 'buy', mode: 'wait_pullback', blocked: 'qdii_premium' },
          { etf: '513300', amount: 0, side: 'buy', mode: 'immediate', blocked: 'data_quality_missing' },
        ],
        total_budget: 7000,
        total_planned: 5800,
        unallocated: 1200,
        unallocated_destination: 'weekly_unallocated_cash',
        soft_wind_control: 'none',
        blocked_etfs: ['513500', '513300'],
      }),
      createdAt: new Date('2026-07-11T09:15:00.000Z'),
    },
    {
      id: 'calc-2026-06-27',
      strategy: 'v5.0',
      engine: 'v5.0',
      hash: '1122334455667788',
      eab: 515000,
      budget: 7000,
      allocated: 7000,
      rebalanced: 0,
      unallocated: 0,
      dest: null,
      rulesHit: JSON.stringify([
        { rule: 'pe_low_buy_boost', etf: '510500', effect: 'boost 1.5x' },
        { rule: 'pe_low_buy_boost', etf: '512890', effect: 'boost 1.3x' },
      ]),
      quality: JSON.stringify({
        '510300': { score: 99, status: 'valid' },
        '510500': { score: 97, status: 'valid' },
        '588000': { score: 93, status: 'valid' },
        '512890': { score: 95, status: 'valid' },
        '513500': { score: 88, status: 'valid' },
        '513300': { score: 82, status: 'valid' },
      }),
      results: JSON.stringify({
        orders: [
          { etf: '510300', amount: 1400, side: 'buy', mode: 'immediate' },
          { etf: '510500', amount: 1890, side: 'buy', mode: 'immediate' },
          { etf: '588000', amount: 840, side: 'buy', mode: 'immediate' },
          { etf: '512890', amount: 910, side: 'buy', mode: 'immediate' },
          { etf: '513500', amount: 1400, side: 'buy', mode: 'immediate' },
          { etf: '513300', amount: 560, side: 'buy', mode: 'staged' },
        ],
        total_budget: 7000,
        total_planned: 7000,
        unallocated: 0,
        soft_wind_control: 'none',
      }),
      createdAt: new Date('2026-06-27T09:45:00.000Z'),
    },
  ]

  const logRecords = await Promise.all(
    calcLogs.map((l) =>
      db.calculationLog.create({
        data: {
          calculationId: l.id,
          strategyVersion: l.strategy,
          engineVersion: l.engine,
          inputsHash: l.hash,
          eabFen: fen(l.eab),
          budgetFen: fen(l.budget),
          totalAllocatedFen: fen(l.allocated),
          totalRebalancedFen: fen(l.rebalanced),
          totalUnallocatedFen: fen(l.unallocated),
          cashDestination: l.dest,
          rulesHitSummary: l.rulesHit,
          dataQualitySummary: l.quality,
          resultsJson: l.results,
          createdAt: l.createdAt,
        },
      }),
    ),
  )
  console.log(`    ✅ ${logRecords.length} calculation logs\n`)

  // ═══════════════════════════════════════════════════════════
  // 8. DataSource — Data source registry
  // ═══════════════════════════════════════════════════════════
  console.log('  🌐 DataSource...')

  const dataSources = [
    {
      name: 'akshare',
      type: 'api' as const,
      primary: true,
      priority: 10,
      rateLimit: 30,
      metrics: JSON.stringify([
        'valuation',
        'premium',
        'nav',
        'dividend',
        'price',
      ]),
      quality: 92,
      status: 'healthy',
      desc: 'AkShare — 开源金融数据接口（主数据源）',
      homepage: 'https://github.com/akfamily/akshare',
    },
    {
      name: 'eastmoney',
      type: 'api' as const,
      primary: false,
      priority: 20,
      rateLimit: 60,
      metrics: JSON.stringify(['valuation', 'price', 'nav']),
      quality: 88,
      status: 'healthy',
      desc: '东方财富 — 备用数据源',
      homepage: 'https://www.eastmoney.com',
    },
    {
      name: 'csindex_direct',
      type: 'index_direct' as const,
      primary: false,
      priority: 5,
      rateLimit: 10,
      metrics: JSON.stringify(['valuation']),
      quality: 95,
      status: 'healthy',
      desc: '中证指数官网 — 估值权威校验源',
      homepage: 'https://www.csindex.com.cn',
    },
    {
      name: 'tushare',
      type: 'api' as const,
      primary: false,
      priority: 30,
      rateLimit: 20,
      metrics: JSON.stringify(['valuation', 'price', 'dividend']),
      quality: 85,
      status: 'degraded',
      desc: 'Tushare — 备用数据源（积分制）',
      homepage: 'https://tushare.pro',
    },
  ]

  const dsRecords = await Promise.all(
    dataSources.map((d) =>
      db.dataSource.upsert({
        where: { sourceName: d.name },
        update: {
          qualityScore: d.quality,
          healthStatus: d.status,
        },
        create: {
          sourceName: d.name,
          sourceType: d.type,
          isPrimary: d.primary,
          priority: d.priority,
          rateLimitPerMin: d.rateLimit,
          supportedMetrics: d.metrics,
          qualityScore: d.quality,
          healthStatus: d.status,
          description: d.desc,
          homepage: d.homepage,
        },
      }),
    ),
  )
  console.log(`    ✅ ${dsRecords.length} data sources\n`)

  // ═══════════════════════════════════════════════════════════
  // 9. CashLedger — Sample double-entry transfers
  // ═══════════════════════════════════════════════════════════
  console.log('  📒 CashLedger...')

  const now = new Date()
  const transfers = [
    // Transfer 1: Weekly contribution → committed
    {
      transferId: 'trf-weekly-2026-07-07',
      debit: 'daily_cash' as const,
      credit: 'weekly_contribution_committed' as const,
      amount: fen(7000),
      referenceId: 'calc-2026-07-11',
      occurredAt: new Date('2026-07-07T08:00:00.000Z'),
    },
    // Transfer 2: QDII premium → pending (S&P500)
    {
      transferId: 'trf-qdii-premium-sp500',
      debit: 'weekly_unallocated_cash' as const,
      credit: 'qdii_pending_cash_sp500' as const,
      amount: fen(5600),
      referenceId: 'calc-2026-07-04',
      occurredAt: new Date('2026-07-04T10:00:00.000Z'),
    },
    // Transfer 3: QDII premium → pending (Nasdaq)
    {
      transferId: 'trf-qdii-premium-nasdaq',
      debit: 'weekly_unallocated_cash' as const,
      credit: 'qdii_pending_cash_nasdaq' as const,
      amount: fen(4200),
      referenceId: 'calc-2026-07-04',
      occurredAt: new Date('2026-07-04T10:00:00.000Z'),
    },
    // Transfer 4: Rebalance sell → reserve
    {
      transferId: 'trf-rebalance-sell-510300',
      debit: 'weekly_unallocated_cash' as const,
      credit: 'rebalance_equity_reserve' as const,
      amount: fen(8000),
      referenceId: 'rebalance-2026-06-20',
      occurredAt: new Date('2026-06-20T14:30:00.000Z'),
    },
    // Transfer 5: Manual deposit
    {
      transferId: 'trf-manual-deposit-001',
      debit: 'manual_cash' as const,
      credit: 'weekly_unallocated_cash' as const,
      amount: fen(5000),
      referenceId: 'manual-001',
      occurredAt: new Date('2026-07-10T11:00:00.000Z'),
    },
  ]

  const ledgerEntries = await Promise.all(
    transfers.flatMap((t) => [
      // Debit entry
      db.cashLedger.create({
        data: {
          debitAccount: t.debit,
          creditAccount: t.credit,
          amountFen: t.amount,
          transferId: t.transferId,
          entryType: 'debit',
          referenceId: t.referenceId,
          occurredAt: t.occurredAt,
          status: 'active',
        },
      }),
      // Credit entry
      db.cashLedger.create({
        data: {
          debitAccount: t.debit,
          creditAccount: t.credit,
          amountFen: t.amount,
          transferId: t.transferId,
          entryType: 'credit',
          referenceId: t.referenceId,
          occurredAt: t.occurredAt,
          status: 'active',
        },
      }),
    ]),
  )
  console.log(`    ✅ ${ledgerEntries.length} ledger entries (${transfers.length} transfers)\n`)

  // ═══════════════════════════════════════════════════════════
  // 10. DataQualityLog — Recent quality checks
  // ═══════════════════════════════════════════════════════════
  console.log('  ✅ DataQualityLog...')

  // 6 ETFs × 5 metrics = 30 records
  // Score = freshness(0-25) + consistency(0-30) + completeness(0-20) + abnormal(0-15) + source(0-10)
  const qualityLogs = [
    // ─── 510300 沪深300: All 5 valid, scores 90-98 ─────────────
    { etf: '510300', metric: 'pe_percentile', status: 'valid' as const,
      score: 95, fresh: 24, consist: 28, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510300', metric: 'pb_percentile', status: 'valid' as const,
      score: 94, fresh: 24, consist: 27, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510300', metric: 'premium_today', status: 'valid' as const,
      score: 96, fresh: 25, consist: 28, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510300', metric: 'nav', status: 'valid' as const,
      score: 92, fresh: 23, consist: 27, complete: 19, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510300', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 90, fresh: 22, consist: 26, complete: 19, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },

    // ─── 510500 中证500: All 5 valid, scores 88-95 ─────────────
    { etf: '510500', metric: 'pe_percentile', status: 'valid' as const,
      score: 94, fresh: 23, consist: 28, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510500', metric: 'pb_percentile', status: 'valid' as const,
      score: 92, fresh: 23, consist: 27, complete: 19, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510500', metric: 'premium_today', status: 'valid' as const,
      score: 90, fresh: 22, consist: 27, complete: 18, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510500', metric: 'nav', status: 'valid' as const,
      score: 91, fresh: 22, consist: 27, complete: 19, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '510500', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 88, fresh: 21, consist: 26, complete: 19, abnormal: 12, source: 10,
      canRule: true, canStrong: true, reason: null },

    // ─── 588000 科创50: All 5 valid, scores 85-93 ──────────────
    { etf: '588000', metric: 'pe_percentile', status: 'valid' as const,
      score: 91, fresh: 22, consist: 27, complete: 18, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '588000', metric: 'pb_percentile', status: 'valid' as const,
      score: 89, fresh: 22, consist: 26, complete: 18, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '588000', metric: 'premium_today', status: 'valid' as const,
      score: 87, fresh: 21, consist: 26, complete: 18, abnormal: 12, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '588000', metric: 'nav', status: 'valid' as const,
      score: 85, fresh: 20, consist: 26, complete: 18, abnormal: 12, source: 9,
      canRule: true, canStrong: true, reason: null },
    { etf: '588000', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 93, fresh: 23, consist: 27, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },

    // ─── 512890 红利低波: All 5 valid, dividend primary 98 ─────
    { etf: '512890', metric: 'pe_percentile', status: 'valid' as const,
      score: 94, fresh: 23, consist: 27, complete: 19, abnormal: 15, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '512890', metric: 'pb_percentile', status: 'valid' as const,
      score: 92, fresh: 23, consist: 27, complete: 19, abnormal: 13, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '512890', metric: 'premium_today', status: 'valid' as const,
      score: 95, fresh: 24, consist: 28, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '512890', metric: 'nav', status: 'valid' as const,
      score: 93, fresh: 23, consist: 27, complete: 19, abnormal: 14, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '512890', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 98, fresh: 25, consist: 28, complete: 20, abnormal: 15, source: 10,
      canRule: true, canStrong: true, reason: '红利ETF核心指标，数据质量最优' },

    // ─── 513500 标普500 QDII: premium degraded, pe lower ──────
    { etf: '513500', metric: 'pe_percentile', status: 'valid' as const,
      score: 72, fresh: 18, consist: 20, complete: 19, abnormal: 10, source: 5,
      canRule: true, canStrong: false, reason: 'Tushare源数据缺失，仅AkShare可用' },
    { etf: '513500', metric: 'pb_percentile', status: 'valid' as const,
      score: 89, fresh: 22, consist: 27, complete: 18, abnormal: 12, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '513500', metric: 'premium_today', status: 'degraded' as const,
      score: 55, fresh: 12, consist: 16, complete: 19, abnormal: 5, source: 3,
      canRule: true, canStrong: false, reason: '溢价数据2天未更新，AkShare接口返回延迟' },
    { etf: '513500', metric: 'nav', status: 'valid' as const,
      score: 88, fresh: 22, consist: 26, complete: 19, abnormal: 11, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '513500', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 86, fresh: 21, consist: 26, complete: 18, abnormal: 11, source: 10,
      canRule: true, canStrong: true, reason: null },

    // ─── 513300 纳斯达克100 QDII: pe missing, premium conflict, nav stale ─
    { etf: '513300', metric: 'pe_percentile', status: 'missing' as const,
      score: 30, fresh: 0, consist: 10, complete: 10, abnormal: 5, source: 5,
      canRule: false, canStrong: false, reason: '纳斯达克100 PE数据所有源均不可用' },
    { etf: '513300', metric: 'pb_percentile', status: 'valid' as const,
      score: 82, fresh: 20, consist: 24, complete: 18, abnormal: 10, source: 10,
      canRule: true, canStrong: true, reason: null },
    { etf: '513300', metric: 'premium_today', status: 'conflict' as const,
      score: 45, fresh: 18, consist: 0, complete: 19, abnormal: 5, source: 3,
      canRule: false, canStrong: false, reason: 'AkShare溢价4.2%, EastMoney溢价7.8%, 差异超阈值' },
    { etf: '513300', metric: 'nav', status: 'stale' as const,
      score: 65, fresh: 10, consist: 20, complete: 19, abnormal: 6, source: 10,
      canRule: true, canStrong: false, reason: '净值数据T-2延迟，纳斯达克周末休市' },
    { etf: '513300', metric: 'dividend_yield_percentile', status: 'valid' as const,
      score: 78, fresh: 19, consist: 23, complete: 18, abnormal: 8, source: 10,
      canRule: true, canStrong: false, reason: null },
  ]

  const dqRecords = await Promise.all(
    qualityLogs.map((q) =>
      db.dataQualityLog.create({
        data: {
          etfCode: q.etf,
          metricName: q.metric,
          qualityStatus: q.status,
          score: q.score,
          freshnessScore: q.fresh,
          consistencyScore: q.consist,
          completenessScore: q.complete,
          abnormalScore: q.abnormal,
          sourceHealthScore: q.source,
          canUseForRule: q.canRule,
          canUseForStrongRule: q.canStrong,
          reason: q.reason,
        },
      }),
    ),
  )
  console.log(`    ✅ ${dqRecords.length} data quality logs\n`)

  // ═══════════════════════════════════════════════════════════
  // 11. CalculationSnapshot — Frozen snapshots for recent calcs
  // ═══════════════════════════════════════════════════════════
  console.log('  📸 CalculationSnapshot...')

  const snapshots2 = await Promise.all([
    db.calculationSnapshot.create({
      data: {
        calculationId: 'calc-2026-07-11',
        strategyVersionId: strategyVersion.id,
        holdingsHash: 'f6e5d4c3b2a10987',
        cashHash: 'c3b2a1f6e5d40987',
        marketHash: 'a10987f6e5d4c3b2',
        frozenAt: new Date('2026-07-11T09:14:55.000Z'),
      },
    }),
    db.calculationSnapshot.create({
      data: {
        calculationId: 'calc-2026-07-04',
        strategyVersionId: strategyVersion.id,
        holdingsHash: 'a1b2c3d4e5f60708',
        cashHash: 'e5f60708a1b2c3d4',
        marketHash: 'c3d4e5f60708a1b2',
        frozenAt: new Date('2026-07-04T09:29:50.000Z'),
      },
    }),
  ])
  console.log(`    ✅ ${snapshots2.length} calculation snapshots\n`)

  // ═══════════════════════════════════════════════════════════
  // 12. ExecutionOrder — Sample orders from latest calculation
  // ═══════════════════════════════════════════════════════════
  console.log('  📋 ExecutionOrder...')

  const calcSnap = snapshots2[0] // calc-2026-07-11
  const orders = await Promise.all([
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '510300',
        side: 'buy',
        plannedAmountFen: fen(1400),
        plannedShares: shares10k(3200),
        executionMode: 'immediate',
        status: 'confirmed',
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '510500',
        side: 'buy',
        plannedAmountFen: fen(1260),
        plannedShares: shares10k(14500),
        executionMode: 'immediate',
        status: 'executed',
        actualAmountFen: fen(1258),
        actualShares: shares10k(14498),
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '512890',
        side: 'buy',
        plannedAmountFen: fen(910),
        plannedShares: shares10k(6200),
        executionMode: 'immediate',
        status: 'executed',
        actualAmountFen: fen(912),
        actualShares: shares10k(6210),
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '588000',
        side: 'buy',
        plannedAmountFen: fen(560),
        plannedShares: shares10k(950),
        executionMode: 'base_only',
        status: 'ready_for_review',
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '513500',
        side: 'buy',
        plannedAmountFen: 0,
        plannedShares: 0,
        executionMode: 'wait_pullback',
        status: 'blocked',
        rejectReason: 'QDII溢价 > 5%, 禁止买入',
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
    db.executionOrder.create({
      data: {
        calculationId: 'calc-2026-07-11',
        snapshotId: calcSnap.id,
        etfCode: '513300',
        side: 'buy',
        plannedAmountFen: 0,
        plannedShares: 0,
        executionMode: 'immediate',
        status: 'blocked',
        rejectReason: '数据质量缺失 (PE分位所有源不可用)',
        createdAt: new Date('2026-07-11T09:16:00.000Z'),
      },
    }),
  ])
  console.log(`    ✅ ${orders.length} execution orders\n`)

  // ═══════════════════════════════════════════════════════════
  // 13. ExecutionFill — Sample fills for executed orders
  // ═══════════════════════════════════════════════════════════
  console.log('  📄 ExecutionFill...')

  // Fill for 510500 order (order index 1)
  const fill510500 = await db.executionFill.create({
    data: {
      orderId: orders[1].id,
      priceFen: priceFen(0.0868), // 0.0868 RMB per share
      shares: shares10k(14498),
      amountFen: fen(1258.43),
      feeFen: fen(0.63),
      executedAt: new Date('2026-07-11T10:32:00.000Z'),
      idempotencyKey: 'fill-510500-20260711-103200',
    },
  })

  // Fill for 512890 order (order index 2)
  const fill512890 = await db.executionFill.create({
    data: {
      orderId: orders[2].id,
      priceFen: priceFen(0.1468),
      shares: shares10k(6210),
      amountFen: fen(911.63),
      feeFen: fen(0.46),
      executedAt: new Date('2026-07-11T10:35:00.000Z'),
      idempotencyKey: 'fill-512890-20260711-103500',
    },
  })
  console.log(`    ✅ 2 execution fills\n`)

  // ═══════════════════════════════════════════════════════════
  // 14. ReleasePlan — Active QDII release plans
  // ═══════════════════════════════════════════════════════════
  console.log('  🔄 ReleasePlan...')

  const releasePlans = await Promise.all([
    db.releasePlan.create({
      data: {
        planType: 'qdii_premium',
        accountId: 'qdii_pending_cash_sp500',
        state: 'releasing',
        weeksTotal: 8,
        weeksRemaining: 5,
        balanceFen: fen(5600),
        weeklyAmountFen: fen(1120), // 5600 / 5
        targetEtf: '513500',
        createdAt: new Date('2026-07-04T10:00:00.000Z'),
        updatedAt: new Date('2026-07-11T10:00:00.000Z'),
      },
    }),
    db.releasePlan.create({
      data: {
        planType: 'qdii_premium',
        accountId: 'qdii_pending_cash_nasdaq',
        state: 'paused',
        weeksTotal: 8,
        weeksRemaining: 7,
        balanceFen: fen(4200),
        weeklyAmountFen: fen(600),
        targetEtf: '513300',
        pausedReason: '纳斯达克100数据质量缺失，暂停释放',
        createdAt: new Date('2026-07-04T10:00:00.000Z'),
        updatedAt: new Date('2026-07-08T10:00:00.000Z'),
      },
    }),
  ])
  console.log(`    ✅ ${releasePlans.length} release plans\n`)

  // ═══════════════════════════════════════════════════════════
  // 15. ManualOverride — A couple of overrides
  // ═══════════════════════════════════════════════════════════
  console.log('  ✏️ ManualOverride...')

  const overrides = await Promise.all([
    db.manualOverride.create({
      data: {
        rule: 'weekly_budget',
        beforeValue: '4000',
        afterValue: '7000',
        reason: '月薪调整后提高周定投额',
        effectiveAt: new Date('2026-07-01T00:00:00.000Z'),
        expiresAt: null,
        confirmedBy: 'user',
      },
    }),
    db.manualOverride.create({
      data: {
        rule: 'qdii_premium_threshold',
        beforeValue: '3%',
        afterValue: '5%',
        reason: '适度放宽QDII溢价容忍度',
        effectiveAt: new Date('2026-06-15T00:00:00.000Z'),
        expiresAt: new Date('2026-09-15T00:00:00.000Z'),
        confirmedBy: 'user',
      },
    }),
  ])
  console.log(`    ✅ ${overrides.length} manual overrides\n`)

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  console.log('═════════════════════════════════════════════════')
  console.log('  ✅ Seed completed successfully!')
  console.log('═════════════════════════════════════════════════')
  console.log(`
  Tables seeded:
    EtfConfig           ${etfConfigs.length}  rows
    StrategyVersion     1  row (v5.0 active)
    HoldingSnapshot     ${snapshots.length}  rows
    CashSubaccount      ${subaccounts.length}  rows
    CashLedger          ${ledgerEntries.length}  entries (${transfers.length} transfers)
    RuleConfig          ${ruleConfigs.length}  rules
    SystemConfig        ${sysConfigRecords.length}  configs
    CalculationLog      ${logRecords.length}  logs
    CalculationSnapshot ${snapshots2.length}  snapshots
    ExecutionOrder      ${orders.length}  orders
    ExecutionFill       2  fills
    ReleasePlan         ${releasePlans.length}  plans
    ManualOverride      ${overrides.length}  overrides
    DataSource          ${dsRecords.length}  sources
    DataQualityLog      ${dqRecords.length}  quality checks
  `)
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })