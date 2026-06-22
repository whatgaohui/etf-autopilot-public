import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Clean existing data
  await prisma.systemConfig.deleteMany()
  await prisma.ruleConfig.deleteMany()
  await prisma.holdingSnapshot.deleteMany()
  await prisma.etfConfig.deleteMany()

  // ===== ETF Config =====
  const etfConfigs = [
    {
      code: '159338',
      name: '中证A500ETF',
      category: 'domestic',
      targetRatio: 0.18,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 1,
    },
    {
      code: '510880',
      name: '红利ETF',
      category: 'domestic',
      targetRatio: 0.18,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 2,
    },
    {
      code: '510330',
      name: '沪深300ETF',
      category: 'domestic',
      targetRatio: 0.12,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 3,
    },
    {
      code: '588000',
      name: '科创50ETF',
      category: 'domestic',
      targetRatio: 0.12,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 4,
    },
    {
      code: '513500',
      name: '标普500ETF',
      category: 'overseas',
      targetRatio: 0.24,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 5,
    },
    {
      code: '513300',
      name: '纳斯达克ETF',
      category: 'overseas',
      targetRatio: 0.16,
      isBlacklisted: false,
      isInvestmentTarget: true,
      sortOrder: 6,
    },
    {
      code: '518880',
      name: '黄金ETF华安',
      category: 'commodity',
      targetRatio: 0,
      isBlacklisted: true,
      isInvestmentTarget: false,
      sortOrder: 7,
    },
    {
      code: '511990',
      name: '华宝添益ETF',
      category: 'cash',
      targetRatio: 0,
      isBlacklisted: false,
      isInvestmentTarget: false,
      sortOrder: 8,
    },
  ]

  for (const etf of etfConfigs) {
    await prisma.etfConfig.create({ data: etf })
  }
  console.log(`  ✅ Inserted ${etfConfigs.length} ETF configs`)

  // ===== Rule Config =====
  const ruleConfigs = [
    // Veto rules
    {
      name: 'QDII溢价红线',
      type: 'veto',
      triggerCondition: '溢价率>3%停止买入',
      thresholdValue: 3.0,
      thresholdValueMax: 100,
      applicableScope: 'qdii',
      applicableCodes: '513300,513500',
      reason: '买入溢价ETF多付3%+，长期复利损失大',
      isEnabled: true,
      sortOrder: 1,
    },
    {
      name: '估值极高分位',
      type: 'veto',
      triggerCondition: 'PE分位>80%停止买入(V4.1,已禁用)',
      thresholdValue: 80.0,
      thresholdValueMax: null,
      applicableScope: 'all',
      applicableCodes: null,
      reason: 'V4.2改为软风控4档,此规则已禁用',
      isEnabled: false,
      sortOrder: 2,
    },
    {
      name: '资产黑名单',
      type: 'veto',
      triggerCondition: '黑名单标的停止买入',
      thresholdValue: 1.0,
      thresholdValueMax: null,
      applicableScope: 'specific_code',
      applicableCodes: '518880',
      reason: '家庭分工，避免重复配置',
      isEnabled: true,
      sortOrder: 3,
    },
    // Reduce rules
    {
      name: 'QDII溢价预警',
      type: 'reduce',
      triggerCondition: '溢价率2%-3%减半买入',
      thresholdValue: 2.0,
      thresholdValueMax: 3.0,
      applicableScope: 'qdii',
      applicableCodes: '513300,513500',
      reason: '溢价风险可控但需折中',
      isEnabled: true,
      sortOrder: 4,
    },
    {
      name: '估值偏高分位',
      type: 'reduce',
      triggerCondition: 'PE分位60%-80%减半买入',
      thresholdValue: 60.0,
      thresholdValueMax: 80.0,
      applicableScope: 'all',
      applicableCodes: null,
      reason: '合理偏高区需克制',
      isEnabled: true,
      sortOrder: 5,
    },
    // V4.2 策略书§5.2: 软风控4档(影响增强仓, 不影响基础仓)
    {
      name: '估值高估(80-90%禁增强仓)',
      type: 'soft_veto_enhancement',
      triggerCondition: 'PE分位80-90%仅基础仓',
      thresholdValue: 80.0,
      thresholdValueMax: 90.0,
      applicableScope: 'all',
      applicableCodes: null,
      reason: 'V4.2软风控第2档:禁增强仓',
      isEnabled: true,
      sortOrder: 6,
    },
    {
      name: '估值极高(90-95%仅严重欠配极小额)',
      type: 'soft_veto_enhancement',
      triggerCondition: 'PE分位90-95%仅欠配极小额',
      thresholdValue: 90.0,
      thresholdValueMax: 95.0,
      applicableScope: 'all',
      applicableCodes: null,
      reason: 'V4.2软风控第3档',
      isEnabled: true,
      sortOrder: 7,
    },
    {
      name: '估值极端(>95%暂停新增)',
      type: 'soft_veto_all',
      triggerCondition: 'PE分位>95%暂停新增',
      thresholdValue: 95.0,
      thresholdValueMax: null,
      applicableScope: 'all',
      applicableCodes: null,
      reason: 'V4.2软风控第4档:暂停全部',
      isEnabled: true,
      sortOrder: 8,
    },
    {
      name: '持仓过度集中',
      type: 'reduce',
      triggerCondition: '当前占比>目标占比×1.5减半',
      thresholdValue: 1.5,
      thresholdValueMax: null,
      applicableScope: 'all',
      applicableCodes: null,
      reason: '防止单一标的过度集中',
      isEnabled: true,
      sortOrder: 6,
    },
    // Boost rules
    {
      name: '估值极度低估',
      type: 'boost',
      triggerCondition: 'PE分位<20%翻倍买入',
      thresholdValue: 20.0,
      thresholdValueMax: null,
      applicableScope: 'all',
      applicableCodes: null,
      reason: '历史上此区间买入胜率极高',
      isEnabled: true,
      sortOrder: 7,
    },
    {
      name: '负偏离过大',
      type: 'boost',
      triggerCondition: '当前占比<目标占比×0.5翻倍',
      thresholdValue: 0.5,
      thresholdValueMax: null,
      applicableScope: 'all',
      applicableCodes: null,
      reason: '严重欠配时加速补仓',
      isEnabled: true,
      sortOrder: 8,
    },
  ]

  for (const rule of ruleConfigs) {
    await prisma.ruleConfig.create({ data: rule })
  }
  console.log(`  ✅ Inserted ${ruleConfigs.length} rule configs`)

  // ===== System Config =====
  const systemConfigs = [
    {
      key: 'weekly_budget',
      value: '40000',
      description: '每周定投总额度(元)',
    },
    {
      key: 'tushare_token',
      value: '',
      description: 'Tushare API Token',
    },
    {
      key: 'data_last_updated',
      value: '',
      description: '数据最后更新时间',
    },
  ]

  for (const config of systemConfigs) {
    await prisma.systemConfig.create({ data: config })
  }
  console.log(`  ✅ Inserted ${systemConfigs.length} system configs`)

  console.log('🎉 Seeding completed!')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
