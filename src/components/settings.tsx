'use client'

import { useState, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Settings2,
  Save,
  Loader2,
  Pencil,
  Ban,
  Plus,
  Trash2,
  CheckCircle2,
  CheckCircle,
  XCircle,
  AlertCircle,
  ShieldAlert,
  ShieldMinus,
  ShieldPlus,
  ShieldCheck,
  Info,
  RotateCcw,
  Database,
  Wifi,
  RefreshCw,
  Activity,
  Wallet,
  Key,
  Bell,
  GitBranch,
  Zap,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Layers,
  ListChecks,
  ExternalLink,
  Download,
  Server,
  Eye,
  HardDrive,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from '@/components/ui/alert'
import {
  getFieldConfigs,
  updateFieldConfig,
  forceSwitchSource,
  getCrossCheckHistory,
  runCrossCheck,
  getDataLineage,
  getDataSourceRegistry,
  enableDataSource,
  disableDataSource,
  setDataSourceToken,
  getFetchLogs,
  updateThreshold,
  getQualitySummary,
  // V4.2 P5-C: 数据采集服务控制面板所需 API
  getDataSourceStatus as getDataSourceStatusApi,
  getMacroTemperature,
  refreshMarketData as refreshMarketDataApi,
  refreshMacro,
  recomputeQuality,
  // V4.2 P6: 后台管理
  getDbStats,
  getTableData,
  clearTable,
  resetCache,
  exportBusinessData,
  getServiceStatus,
  type DbStats,
  type DbTableInfo,
  type TableData,
  type FieldSourceConfig,
  type CrossCheckRecord,
  type CrossCheckStats,
  type DataLineage,
  type DataSourceRegistryItem,
  type FetchLogItem,
  type QualityScoreItem,
  type DataSourceStatus,
  type MacroMetricItem,
} from '@/lib/api'

// ─── Types ───────────────────────────────────────────────────────────────────

interface EtfConfig {
  id: string
  code: string
  name: string
  category: string
  targetRatio: number
  isBlacklisted: boolean
  isInvestmentTarget: boolean
  sortOrder: number
}

interface RuleConfig {
  id: string
  name: string
  type: string
  triggerCondition: string
  thresholdValue: number
  thresholdValueMax: number | null
  applicableScope: string
  applicableCodes: string | null
  reason: string
  isEnabled: boolean
  sortOrder: number
}

interface SystemConfig {
  id: string
  key: string
  value: string
  description: string | null
}

// ─── Default rules (mirrors prisma/seed.ts) ──────────────────────────────────
// Used by the "恢复默认规则" flow (§9.A4).

const DEFAULT_RULES: Array<Omit<RuleConfig, 'id'>> = [
  // Veto
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
    triggerCondition: 'PE分位>80%停止买入',
    thresholdValue: 80.0,
    thresholdValueMax: null,
    applicableScope: 'all',
    applicableCodes: null,
    reason: '高分位买入3年收益率显著偏低',
    isEnabled: true,
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
  // Reduce
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
  // Boost
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  domestic: '国内',
  overseas: '海外',
  commodity: '商品',
  cash: '现金',
}

const RULE_TYPE_LABELS: Record<string, string> = {
  veto: '一票否决规则（策略书§6.3）',
  reduce: '减量买入规则（策略书§6.4）',
  boost: '加量买入规则（策略书§6.5）',
}

const RULE_TYPE_ICONS: Record<string, React.ReactNode> = {
  veto: <ShieldAlert className="size-4" />,
  reduce: <ShieldMinus className="size-4" />,
  boost: <ShieldPlus className="size-4" />,
}

function getCategoryBadge(category: string) {
  switch (category) {
    case 'domestic':
      return (
        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800">
          国内
        </Badge>
      )
    case 'overseas':
      return (
        <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
          海外
        </Badge>
      )
    case 'commodity':
      return (
        <Badge className="bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-100 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800">
          商品
        </Badge>
      )
    default:
      return <Badge variant="outline">{category}</Badge>
  }
}

function getRuleTypeColor(type: string) {
  switch (type) {
    case 'veto':
      return 'text-red-600 dark:text-red-400'
    case 'reduce':
      return 'text-yellow-600 dark:text-yellow-400'
    case 'boost':
      return 'text-green-600 dark:text-green-400'
    default:
      return ''
  }
}

function getRuleTypeBg(type: string) {
  switch (type) {
    case 'veto':
      return 'bg-red-50 dark:bg-red-950/30'
    case 'reduce':
      return 'bg-yellow-50 dark:bg-yellow-950/30'
    case 'boost':
      return 'bg-green-50 dark:bg-green-950/30'
    default:
      return ''
  }
}

function getRuleTypeBorder(type: string) {
  switch (type) {
    case 'veto':
      return 'border-red-200 dark:border-red-800'
    case 'reduce':
      return 'border-yellow-200 dark:border-yellow-800'
    case 'boost':
      return 'border-green-200 dark:border-green-800'
    default:
      return ''
  }
}

function getApplicableScopeLabel(scope: string, codes: string | null, etfMap: Record<string, string>) {
  if (scope === 'all') return '全部标的'
  if (scope === 'qdii') return 'QDII标的'
  if ((scope === 'specific' || scope === 'specific_code') && codes) {
    const names = codes.split(',').map(c => etfMap[c.trim()] || c.trim())
    return names.join(', ')
  }
  return scope
}

// ─── Rule condition formatting (§9.A1) ───────────────────────────────────────
// Maps the raw technical values to a human-readable trigger condition.

function formatRuleCondition(rule: RuleConfig): string {
  const n = rule.name || ''
  if (n.includes('溢价红线')) return `溢价率 > ${rule.thresholdValue}%`
  if (n.includes('溢价预警')) {
    return `${rule.thresholdValue}% ≤ 溢价率 ≤ ${rule.thresholdValueMax ?? 3}%`
  }
  if (n.includes('极高分位')) return `PE分位 > ${rule.thresholdValue}%`
  if (n.includes('偏高')) {
    return `${rule.thresholdValue}% ≤ PE分位 ≤ ${rule.thresholdValueMax ?? 80}%`
  }
  if (n.includes('极度低估')) return `PE分位 < ${rule.thresholdValue}%`
  if (n.includes('过度集中')) return `当前占比 > 目标占比 × ${rule.thresholdValue}`
  if (n.includes('负偏离')) return `当前占比 < 目标占比 × ${rule.thresholdValue}`
  if (n.includes('黑名单')) return `已加入黑名单`
  return rule.triggerCondition
}

// Human-readable applicable scope (§9.A1).
function getApplicableScopeDisplay(
  scope: string,
  codes: string | null,
  etfMap: Record<string, string>
): string {
  if (scope === 'all') return '全部6只ETF'
  if (scope === 'qdii') return 'QDII(标普500/纳斯达克)'
  if (scope === 'specific_code' || scope === 'specific') {
    if (!codes) return '指定代码'
    const list = codes
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => (etfMap[c] ? `${c} ${etfMap[c]}` : c))
    return list.length > 0 ? list.join('、') : '指定代码'
  }
  return scope
}

// ─── API fetchers ────────────────────────────────────────────────────────────

async function fetchEtfConfigs(): Promise<EtfConfig[]> {
  const res = await fetch('/api/etf')
  if (!res.ok) throw new Error('Failed to fetch ETF configs')
  return res.json()
}

async function fetchRules(): Promise<RuleConfig[]> {
  const res = await fetch('/api/rule')
  if (!res.ok) throw new Error('Failed to fetch rules')
  return res.json()
}

async function fetchSystemConfigs(): Promise<SystemConfig[]> {
  const res = await fetch('/api/system')
  if (!res.ok) throw new Error('Failed to fetch system configs')
  return res.json()
}

// V4 数据源 fetchers
async function fetchDataSourceStatus() {
  const res = await fetch('/api/data-source?type=status')
  if (!res.ok) throw new Error('Failed to fetch data source status')
  return res.json()
}

async function fetchThresholds() {
  const res = await fetch('/api/data-source?type=thresholds')
  if (!res.ok) throw new Error('Failed to fetch thresholds')
  return res.json()
}

async function testDataSources(): Promise<Array<{ source: string; connected: boolean; latencyMs: number; message: string }>> {
  const res = await fetch('/api/data-source', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to test data sources')
  return res.json()
}

async function refreshMarketData(): Promise<{ success: boolean; message: string }> {
  const res = await fetch('/api/data', { method: 'POST' })
  if (!res.ok) throw new Error('Failed to refresh data')
  return res.json()
}

// ─── Section 1: Target Allocation ────────────────────────────────────────────

function TargetAllocationSection({ configs }: { configs: EtfConfig[] }) {
  const queryClient = useQueryClient()

  const investmentTargets = configs.filter(c => c.isInvestmentTarget && !c.isBlacklisted)
  const domesticEtfs = investmentTargets.filter(c => c.category === 'domestic')
  const overseasEtfs = investmentTargets.filter(c => c.category === 'overseas')

  const [userEdits, setUserEdits] = useState<Record<string, number>>({})
  const [isSaving, setIsSaving] = useState(false)

  // Derive ratios from configs, with user edits overlaid
  const ratios: Record<string, number> = {}
  investmentTargets.forEach(c => {
    ratios[c.code] = userEdits[c.code] ?? Math.round(c.targetRatio * 100)
  })

  const domesticTotal = domesticEtfs.reduce((sum, c) => sum + (ratios[c.code] ?? 0), 0)
  const overseasTotal = overseasEtfs.reduce((sum, c) => sum + (ratios[c.code] ?? 0), 0)
  const grandTotal = domesticTotal + overseasTotal
  const isValid = grandTotal === 100

  const updateMutation = useMutation({
    mutationFn: async (items: { code: string; targetRatio: number }[]) => {
      const res = await fetch('/api/etf', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items.map(i => ({ code: i.code, targetRatio: i.targetRatio }))),
      })
      if (!res.ok) throw new Error('Failed to save ETF configs')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['etf-configs'] })
      toast.success('投资标的比例已保存')
    },
    onError: () => {
      toast.error('保存失败，请重试')
    },
  })

  const handleSave = () => {
    if (!isValid) {
      toast.error('总比例必须等于100%')
      return
    }
    const items = investmentTargets.map(c => ({
      code: c.code,
      targetRatio: (userEdits[c.code] ?? Math.round(c.targetRatio * 100)) / 100,
    }))
    setIsSaving(true)
    updateMutation.mutate(items, { onSettled: () => setIsSaving(false) })
  }

  const handleRatioChange = (code: string, value: number) => {
    setUserEdits(prev => ({ ...prev, [code]: value }))
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings2 className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">投资标的与目标配置</CardTitle>
        </div>
        <CardDescription className="text-xs">设置各投资标的的目标配比，总计必须等于100%</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Domestic ETFs */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800">
              国内权益
            </Badge>
            <span className="text-sm text-muted-foreground">合计 {domesticTotal}%</span>
          </div>
          <div className="space-y-4">
            {domesticEtfs.map(etf => (
              <EtfRatioRow
                key={etf.code}
                etf={etf}
                ratio={ratios[etf.code] ?? 0}
                onChange={(v) => handleRatioChange(etf.code, v)}
              />
            ))}
          </div>
        </div>

        <Separator />

        {/* Overseas ETFs */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
              海外权益
            </Badge>
            <span className="text-sm text-muted-foreground">合计 {overseasTotal}%</span>
          </div>
          <div className="space-y-4">
            {overseasEtfs.map(etf => (
              <EtfRatioRow
                key={etf.code}
                etf={etf}
                ratio={ratios[etf.code] ?? 0}
                onChange={(v) => handleRatioChange(etf.code, v)}
              />
            ))}
          </div>
        </div>

        <Separator />

        {/* Summary bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 bg-muted/30">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>国内权益: <strong>{domesticTotal}%</strong></span>
            <span className="text-muted-foreground">|</span>
            <span>海外权益: <strong>{overseasTotal}%</strong></span>
            <span className="text-muted-foreground">|</span>
            <span>总计: <strong>{grandTotal}%</strong></span>
          </div>
          <div className="flex items-center gap-2">
            {isValid ? (
              <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-4" />
                <span className="text-sm font-medium">有效</span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-red-600 dark:text-red-400">
                <XCircle className="size-4" />
                <span className="text-sm font-medium">总比例需等于100%</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving || !isValid}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EtfRatioRow({ etf, ratio, onChange }: { etf: EtfConfig; ratio: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      {getCategoryBadge(etf.category)}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate">{etf.name}</span>
        <span className="text-sm text-muted-foreground ml-1">({etf.code})</span>
      </div>
      <div className="flex items-center gap-2 w-[140px] shrink-0">
        <Input
          type="number"
          min={0}
          max={100}
          value={ratio}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            if (!isNaN(v) && v >= 0 && v <= 100) onChange(v)
          }}
          className="w-16 h-8 text-center text-sm"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
      <div className="w-[120px] shrink-0 hidden sm:block">
        <Slider
          value={[ratio]}
          min={0}
          max={100}
          step={1}
          onValueChange={(v) => onChange(v[0])}
        />
      </div>
    </div>
  )
}

// ─── Section 2: Weekly Budget ────────────────────────────────────────────────

function WeeklyBudgetSection({ configs }: { configs: SystemConfig[] }) {
  const queryClient = useQueryClient()
  const budgetConfig = configs.find(c => c.key === 'weekly_budget')
  const [userBudget, setUserBudget] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Derive budget: use user edit if available, otherwise fall back to server value
  const budget = userBudget ?? (budgetConfig?.value ?? '40000')

  const updateMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const res = await fetch('/api/system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) throw new Error('Failed to save system config')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-configs'] })
      toast.success('定投额度已保存')
    },
    onError: () => {
      toast.error('保存失败，请重试')
    },
  })

  const handleSave = () => {
    const numVal = parseFloat(budget)
    if (isNaN(numVal) || numVal <= 0) {
      toast.error('请输入有效的金额')
      return
    }
    setIsSaving(true)
    updateMutation.mutate(
      { key: 'weekly_budget', value: budget },
      { onSettled: () => setIsSaving(false) }
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings2 className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">定投额度</CardTitle>
        </div>
        <CardDescription className="text-xs">设置每周定投的总金额</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
          <div className="space-y-2 flex-1 w-full sm:w-auto">
            <Label htmlFor="weekly-budget">每周定投金额 (元)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="weekly-budget"
                type="number"
                min={0}
                step={1000}
                value={budget}
                onChange={(e) => setUserBudget(e.target.value)}
                className="max-w-[200px]"
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">元/周</span>
            </div>
          </div>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Section 3: Rule Management ──────────────────────────────────────────────

interface AddRuleFormState {
  name: string
  metric: 'pe_percentile' | 'premium' | 'deviation' | 'blacklist'
  threshold: string
  thresholdMax: string
  applicableScope: 'all' | 'qdii' | 'specific_code'
  applicableCodes: string
  reason: string
}

function buildTriggerCondition(
  type: string,
  metric: AddRuleFormState['metric'],
  threshold: number,
  thresholdMax: number | null
): string {
  const isPremium = metric === 'premium'
  const isPE = metric === 'pe_percentile'
  const isDev = metric === 'deviation'
  const suffix = isPremium ? '%' : isPE ? '%' : ''
  if (type === 'veto') {
    if (metric === 'blacklist') return '黑名单标的停止买入'
    return `${isPremium ? '溢价率' : isPE ? 'PE分位' : '当前占比'}>${threshold}${suffix}停止买入`
  }
  if (type === 'reduce') {
    if (isDev) return `当前占比>目标占比×${threshold}减半`
    return `${isPremium ? '溢价率' : 'PE分位'}${threshold}-${thresholdMax ?? ''}${suffix}减半买入`
  }
  // boost
  if (isDev) return `当前占比<目标占比×${threshold}翻倍`
  return `${isPremium ? '溢价率' : isPE ? 'PE分位' : '当前占比'}<${threshold}${suffix}翻倍买入`
}

function AddRuleDialog({
  open,
  onOpenChange,
  type,
  etfMap,
  nextSortOrder,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: string
  etfMap: Record<string, string>
  nextSortOrder: number
  onCreated: (payload: Omit<RuleConfig, 'id'>) => Promise<void>
}) {
  const typeLabel = type === 'veto' ? '一票否决' : type === 'reduce' ? '减量' : '加量'
  const [form, setForm] = useState<AddRuleFormState>({
    name: '',
    metric: 'pe_percentile',
    threshold: '',
    thresholdMax: '',
    applicableScope: 'all',
    applicableCodes: '',
    reason: '',
  })
  const [isSaving, setIsSaving] = useState(false)

  const reset = () => {
    setForm({
      name: '',
      metric: 'pe_percentile',
      threshold: '',
      thresholdMax: '',
      applicableScope: 'all',
      applicableCodes: '',
      reason: '',
    })
  }

  const isBlacklist = form.metric === 'blacklist'
  const isReduce = type === 'reduce'
  const isDev = form.metric === 'deviation'

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('请输入规则名称')
      return
    }
    if (!isBlacklist) {
      if (form.threshold === '' || isNaN(parseFloat(form.threshold))) {
        toast.error('请输入有效的阈值')
        return
      }
      if (isReduce && !isDev && (form.thresholdMax === '' || isNaN(parseFloat(form.thresholdMax)))) {
        toast.error('减量区间规则需要提供区间上限')
        return
      }
    }
    if (form.applicableScope === 'specific_code' && !form.applicableCodes.trim()) {
      toast.error('请输入指定ETF代码')
      return
    }

    const threshold = isBlacklist ? 1.0 : parseFloat(form.threshold)
    const thresholdMax = isReduce && !isDev && form.thresholdMax !== ''
      ? parseFloat(form.thresholdMax)
      : (type === 'veto' && form.metric === 'premium' ? 100 : null)

    const triggerCondition = buildTriggerCondition(
      type,
      form.metric,
      threshold,
      thresholdMax
    )

    const payload: Omit<RuleConfig, 'id'> = {
      name: form.name.trim(),
      type,
      triggerCondition,
      thresholdValue: threshold,
      thresholdValueMax: thresholdMax,
      applicableScope: form.applicableScope,
      applicableCodes: form.applicableScope === 'specific_code' ? form.applicableCodes.trim() : null,
      reason: form.reason.trim(),
      isEnabled: true,
      sortOrder: nextSortOrder,
    }

    setIsSaving(true)
    try {
      await onCreated(payload)
      reset()
      onOpenChange(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新增{typeLabel}规则</DialogTitle>
          <DialogDescription>
            创建一条{typeLabel}买入规则，提交后将立即生效并参与下一次定投决策。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor="new-rule-name">规则名称</Label>
            <Input
              id="new-rule-name"
              placeholder="如：QDII溢价红线"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>触发指标</Label>
            <Select
              value={form.metric}
              onValueChange={(v) => setForm({ ...form, metric: v as AddRuleFormState['metric'] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择触发指标" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pe_percentile">PE分位</SelectItem>
                <SelectItem value="premium">溢价率（QDII适用）</SelectItem>
                <SelectItem value="deviation">当前占比偏离</SelectItem>
                {type === 'veto' && <SelectItem value="blacklist">黑名单</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>比较方式</Label>
            <Input
              disabled
              className="bg-muted"
              value={
                isBlacklist
                  ? '黑名单标的停止买入'
                  : type === 'veto'
                  ? '大于阈值'
                  : type === 'reduce'
                  ? (isDev ? '大于阈值（占比偏离）' : '区间 [下限, 上限]')
                  : '小于阈值'
              }
            />
          </div>

          {!isBlacklist && (
            <div className={isReduce && !isDev ? 'grid grid-cols-2 gap-3' : 'space-y-2'}>
              <div className="space-y-2">
                <Label htmlFor="new-threshold">
                  {isReduce && !isDev ? '区间下限' : '阈值'}
                </Label>
                <Input
                  id="new-threshold"
                  type="number"
                  step="0.1"
                  value={form.threshold}
                  onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                  placeholder={isPEorPremium(form.metric) ? '如 80' : '如 1.5'}
                />
              </div>
              {isReduce && !isDev && (
                <div className="space-y-2">
                  <Label htmlFor="new-threshold-max">区间上限</Label>
                  <Input
                    id="new-threshold-max"
                    type="number"
                    step="0.1"
                    value={form.thresholdMax}
                    onChange={(e) => setForm({ ...form, thresholdMax: e.target.value })}
                    placeholder="如 100"
                  />
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>适用范围</Label>
            <Select
              value={form.applicableScope}
              onValueChange={(v) => setForm({ ...form, applicableScope: v as AddRuleFormState['applicableScope'] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择适用范围" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部ETF</SelectItem>
                <SelectItem value="qdii">QDII（标普500/纳斯达克）</SelectItem>
                <SelectItem value="specific_code">指定代码</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.applicableScope === 'specific_code' && (
            <div className="space-y-2">
              <Label htmlFor="new-codes">指定ETF代码（多个用逗号分隔）</Label>
              <Input
                id="new-codes"
                placeholder="如 518880,511990"
                value={form.applicableCodes}
                onChange={(e) => setForm({ ...form, applicableCodes: e.target.value })}
              />
              {form.applicableCodes.trim() && (
                <p className="text-xs text-muted-foreground">
                  {form.applicableCodes
                    .split(',')
                    .map(c => c.trim())
                    .filter(Boolean)
                    .map(c => etfMap[c] ? `${c} ${etfMap[c]}` : `${c} (未知)`)
                    .join('、')}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="new-reason">规则理由</Label>
            <Textarea
              id="new-reason"
              placeholder="简要说明为何设置此规则"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            新增规则
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isPEorPremium(metric: AddRuleFormState['metric']): boolean {
  return metric === 'pe_percentile' || metric === 'premium'
}

function RuleManagementSection({ rules, etfMap }: { rules: RuleConfig[]; etfMap: Record<string, string> }) {
  const queryClient = useQueryClient()

  const vetoRules = rules.filter(r => r.type === 'veto')
  const reduceRules = rules.filter(r => r.type === 'reduce')
  const boostRules = rules.filter(r => r.type === 'boost')

  const [editRule, setEditRule] = useState<RuleConfig | null>(null)
  const [editThreshold, setEditThreshold] = useState<string>('')
  const [editThresholdMax, setEditThresholdMax] = useState<string>('')
  const [editEnabled, setEditEnabled] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // Add-rule dialog state
  const [addRuleType, setAddRuleType] = useState<string | null>(null)

  // Restore-defaults confirm state
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)

  const updateRuleMutation = useMutation({
    mutationFn: async (data: { id: string; thresholdValue?: number; thresholdValueMax?: number | null; isEnabled?: boolean }) => {
      const res = await fetch('/api/rule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update rule')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      toast.success('规则已更新')
    },
    onError: () => {
      toast.error('更新失败，请重试')
    },
  })

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/rule?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete rule')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      toast.success('规则已删除')
    },
    onError: () => {
      toast.error('删除失败，请重试')
    },
  })

  const toggleRuleMutation = useMutation({
    mutationFn: async ({ id, isEnabled }: { id: string; isEnabled: boolean }) => {
      const res = await fetch('/api/rule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, isEnabled }),
      })
      if (!res.ok) throw new Error('Failed to toggle rule')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
    },
    onError: () => {
      toast.error('切换失败，请重试')
    },
  })

  const createRuleMutation = useMutation({
    mutationFn: async (payload: Omit<RuleConfig, 'id'>) => {
      const res = await fetch('/api/rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error || 'Failed to create rule')
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      toast.success('新规则已创建')
    },
    onError: (err: Error) => {
      toast.error(err.message || '创建失败，请重试')
    },
  })

  const handleOpenEdit = (rule: RuleConfig) => {
    setEditRule(rule)
    setEditThreshold(String(rule.thresholdValue))
    setEditThresholdMax(rule.thresholdValueMax !== null ? String(rule.thresholdValueMax) : '')
    setEditEnabled(rule.isEnabled)
  }

  const handleSaveEdit = () => {
    if (!editRule) return
    const threshold = parseFloat(editThreshold)
    const thresholdMax = editThresholdMax !== '' ? parseFloat(editThresholdMax) : null

    if (isNaN(threshold)) {
      toast.error('请输入有效的主阈值')
      return
    }

    setIsSaving(true)
    updateRuleMutation.mutate(
      {
        id: editRule.id,
        thresholdValue: threshold,
        thresholdValueMax: thresholdMax,
        isEnabled: editEnabled,
      },
      {
        onSettled: () => {
          setIsSaving(false)
          setEditRule(null)
        },
      }
    )
  }

  const handleToggle = (rule: RuleConfig, checked: boolean) => {
    toggleRuleMutation.mutate({ id: rule.id, isEnabled: checked })
  }

  const handleDelete = (rule: RuleConfig) => {
    deleteRuleMutation.mutate(rule.id)
  }

  const handleAddRule = async (payload: Omit<RuleConfig, 'id'>) => {
    await createRuleMutation.mutateAsync(payload)
  }

  // §9.A4: Restore default rules — DELETE all then POST the 8 seed rules.
  const handleRestoreDefaults = async () => {
    setIsRestoring(true)
    try {
      // 1. Delete all existing rules
      await Promise.all(
        rules.map(r =>
          fetch(`/api/rule?id=${r.id}`, { method: 'DELETE' }).then(res => {
            if (!res.ok) throw new Error('Failed to delete rule')
            return res.json()
          })
        )
      )
      // 2. POST the 8 default rules
      for (const rule of DEFAULT_RULES) {
        const { id: _id, ...rest } = rule
        void _id
        await fetch('/api/rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rest),
        }).then(res => {
          if (!res.ok) throw new Error('Failed to create rule')
          return res.json()
        })
      }
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      toast.success('已恢复 8 条默认规则')
      setRestoreOpen(false)
    } catch {
      toast.error('恢复默认规则失败，请重试')
    } finally {
      setIsRestoring(false)
    }
  }

  const nextSortOrderFor = (type: string) => {
    const list = rules.filter(r => r.type === type)
    if (list.length === 0) return type === 'veto' ? 1 : type === 'reduce' ? 4 : 7
    return Math.max(...list.map(r => r.sortOrder)) + 1
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Settings2 className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">规则管理</CardTitle>
            </div>
            <CardDescription className="text-xs">管理定投决策规则（策略书§6 买入侧 + §7 再平衡侧）。一票否决 {'>'} 减量 {'>'} 加量 {'>'} 目标缺口分配，减量优先于加量</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRestoreOpen(true)}
            disabled={isRestoring}
            className="shrink-0"
          >
            {isRestoring ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            恢复默认规则
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* PRD§9.2 规则分组1: 暂停规则（一票否决） */}
        <RuleGroup
          title="暂停规则 · 一票否决（策略书§6.3）"
          type="veto"
          rules={vetoRules}
          etfMap={etfMap}
          onToggle={handleToggle}
          onEdit={handleOpenEdit}
          onDelete={handleDelete}
          onAdd={() => setAddRuleType('veto')}
        />
        {/* PRD§9.2 规则分组2: 买入规则（减量+加量） */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span>买入规则（策略书§6.4 减量 + §6.5 加量）</span>
            <span className="text-xs text-muted-foreground/60">减量优先于加量</span>
          </div>
          <RuleGroup
            title="减量买入规则（策略书§6.4）"
            type="reduce"
            rules={reduceRules}
            etfMap={etfMap}
            onToggle={handleToggle}
            onEdit={handleOpenEdit}
            onDelete={handleDelete}
            onAdd={() => setAddRuleType('reduce')}
          />
          <RuleGroup
            title="加量买入规则（策略书§6.5）"
            type="boost"
            rules={boostRules}
            etfMap={etfMap}
            onToggle={handleToggle}
            onEdit={handleOpenEdit}
            onDelete={handleDelete}
            onAdd={() => setAddRuleType('boost')}
          />
        </div>
        {/* PRD§9.2 规则分组3-5: 再平衡/数据质量/现金水池（在其他卡片配置） */}
        <div className="rounded-md border border-muted bg-muted/20 p-3 space-y-1.5 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">其他规则分组</div>
          <div className="flex items-center gap-1.5">
            <ShieldMinus className="h-3 w-3 text-orange-500" />
            <span>再平衡规则（策略书§7）：A股/红利/美股三类差异化卖出，规则引擎内置，无需手动配置</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="h-3 w-3 text-amber-500" />
            <span>数据质量规则（策略书§5）：在「数据质量规则配置」卡片展示阈值</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Wallet className="h-3 w-3 text-sky-500" />
            <span>现金水池规则（策略书§8）：在「现金水池配置」卡片配置标的和阈值</span>
          </div>
        </div>
      </CardContent>

      {/* Edit Dialog */}
      <Dialog open={!!editRule} onOpenChange={(open) => { if (!open) setEditRule(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑规则 - {editRule?.name}</DialogTitle>
            <DialogDescription>
              修改规则的阈值参数和启用状态
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {editRule && (
              <>
                <div className="space-y-2">
                  <Label>规则名称</Label>
                  <Input value={editRule.name} disabled className="bg-muted" />
                </div>
                <div className="space-y-2">
                  <Label>触发条件（自然语言）</Label>
                  <Input value={formatRuleCondition(editRule)} disabled className="bg-muted" />
                </div>
                <div className="space-y-2">
                  <Label>原始触发条件</Label>
                  <Input value={editRule.triggerCondition} disabled className="bg-muted" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-threshold">主阈值</Label>
                  <Input
                    id="edit-threshold"
                    type="number"
                    step="0.1"
                    value={editThreshold}
                    onChange={(e) => setEditThreshold(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-threshold-max">上限（区间规则使用，留空表示无上限）</Label>
                  <Input
                    id="edit-threshold-max"
                    type="number"
                    step="0.1"
                    value={editThresholdMax}
                    onChange={(e) => setEditThresholdMax(e.target.value)}
                    placeholder="留空表示无上限"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="edit-enabled"
                    checked={editEnabled}
                    onCheckedChange={setEditEnabled}
                  />
                  <Label htmlFor="edit-enabled">启用此规则</Label>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRule(null)}>取消</Button>
            <Button onClick={handleSaveEdit} disabled={isSaving}>
              {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Rule Dialog */}
      {addRuleType && (
        <AddRuleDialog
          open={!!addRuleType}
          onOpenChange={(open) => { if (!open) setAddRuleType(null) }}
          type={addRuleType}
          etfMap={etfMap}
          nextSortOrder={nextSortOrderFor(addRuleType)}
          onCreated={handleAddRule}
        />
      )}

      {/* Restore Defaults AlertDialog */}
      <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认恢复默认规则？</AlertDialogTitle>
            <AlertDialogDescription>
              当前所有自定义规则将被覆盖，并重新插入 8 条默认规则（QDII溢价红线、估值极高分位、资产黑名单、QDII溢价预警、估值偏高分位、持仓过度集中、估值极度低估、负偏离过大）。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleRestoreDefaults()
              }}
              disabled={isRestoring}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRestoring ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              确认恢复
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function RuleGroup({
  title,
  type,
  rules,
  etfMap,
  onToggle,
  onEdit,
  onDelete,
  onAdd,
}: {
  title: string
  type: string
  rules: RuleConfig[]
  etfMap: Record<string, string>
  onToggle: (rule: RuleConfig, checked: boolean) => void
  onEdit: (rule: RuleConfig) => void
  onDelete: (rule: RuleConfig) => void
  onAdd: () => void
}) {
  const typeLabel = type === 'veto' ? '一票否决' : type === 'reduce' ? '减量' : '加量'
  return (
    <div className={`rounded-lg border ${getRuleTypeBorder(type)} ${getRuleTypeBg(type)} p-4`}>
      <div className={`flex items-center justify-between gap-2 mb-3 ${getRuleTypeColor(type)}`}>
        <div className="flex items-center gap-2">
          {RULE_TYPE_ICONS[type]}
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="h-7 text-xs"
        >
          <Plus className="size-3.5" />
          新增{typeLabel}规则
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">暂无规则</p>
      ) : (
        <div className="overflow-x-auto -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[110px]">规则名称</TableHead>
                <TableHead className="min-w-[140px]">触发条件</TableHead>
                <TableHead className="min-w-[120px]">适用范围</TableHead>
                <TableHead className="min-w-[140px]">理由</TableHead>
                <TableHead className="min-w-[120px]">状态</TableHead>
                <TableHead className="w-[100px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map(rule => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium text-sm">{rule.name}</TableCell>
                  <TableCell className="text-sm">
                    <span className="font-mono text-foreground">{formatRuleCondition(rule)}</span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {getApplicableScopeDisplay(rule.applicableScope, rule.applicableCodes, etfMap)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate" title={rule.reason || ''}>
                    {rule.reason || '-'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={rule.isEnabled}
                        onCheckedChange={(checked) => onToggle(rule, checked)}
                        aria-label={`切换规则 ${rule.name}`}
                      />
                      {rule.isEnabled ? (
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                          ✅ 已启用
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                          ⛔ 已停用
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={() => onEdit(rule)}
                        aria-label={`编辑规则 ${rule.name}`}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive hover:text-destructive"
                        onClick={() => onDelete(rule)}
                        aria-label={`删除规则 ${rule.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// ─── Section 4: Blacklist Management ─────────────────────────────────────────

// ─── Section 5: Data Source Config (V4 PRD§9.3) ──────────────────────────────

function formatDateTime(iso: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ─── 数据源管理模块常量（V4 §4）───────────────────────────────────────────────

const ETF_OPTIONS = [
  { code: '159338', name: '中证A500ETF', indexCode: '000510' },
  { code: '510880', name: '红利ETF', indexCode: '000015' },
  { code: '510330', name: '沪深300ETF', indexCode: '000300' },
  { code: '588000', name: '科创50ETF', indexCode: '000688' },
  { code: '513500', name: '标普500ETF', indexCode: 'SPI' },
  { code: '513300', name: '纳斯达克ETF', indexCode: 'IXIC' },
]

const DATA_TYPES = [
  { value: 'valuation', label: '指数估值 PE/PB' },
  { value: 'premium', label: 'ETF 溢价率' },
  { value: 'nav', label: '基金净值' },
  { value: 'dividend', label: '股息率' },
  { value: 'price', label: 'ETF 行情价' },
]

const FIELD_LABEL_MAP: Record<string, string> = {
  valuation: '估值',
  premium: '溢价',
  nav: '净值',
  dividend: '股息',
  price: '行情',
}

const ADAPTER_ROLE_MAP: Record<string, { label: string; color: string }> = {
  primary: { label: '主源', color: 'text-emerald-700 bg-emerald-100 border-emerald-300' },
  backup: { label: '备源', color: 'text-sky-700 bg-sky-100 border-sky-300' },
  reference: { label: '参考', color: 'text-muted-foreground bg-muted border-border' },
  validator: { label: '校验', color: 'text-amber-700 bg-amber-100 border-amber-300' },
}

const ADAPTER_STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  active: { label: '已激活', color: 'text-emerald-700', dot: 'bg-emerald-500' },
  unconfigured: { label: '待配置', color: 'text-amber-700', dot: 'bg-amber-500' },
  planned: { label: '规划中', color: 'text-slate-600', dot: 'bg-slate-400' },
  error: { label: '异常', color: 'text-red-700', dot: 'bg-red-500' },
}

const CROSS_CHECK_STATUS_MAP: Record<string, { label: string; color: string }> = {
  passed: { label: '通过', color: 'text-emerald-700 bg-emerald-100 border-emerald-300' },
  source_inconsistent: { label: '源不一致', color: 'text-red-700 bg-red-100 border-red-300' },
  primary_failed: { label: '主源失败', color: 'text-amber-700 bg-amber-100 border-amber-300' },
  backup_failed: { label: '备源失败', color: 'text-amber-700 bg-amber-100 border-amber-300' },
  both_failed: { label: '双源失败', color: 'text-red-700 bg-red-100 border-red-300' },
  no_backup: { label: '无备源', color: 'text-slate-600 bg-slate-100 border-slate-300' },
}

// 适配器 available → badge 颜色（用于 Tab2 主源/备源 Badge）
function adapterAvailableColor(available: boolean, status?: string): string {
  if (status === 'planned') return 'text-slate-600 bg-slate-100 border-slate-300'
  return available
    ? 'text-emerald-700 bg-emerald-100 border-emerald-300'
    : 'text-amber-700 bg-amber-100 border-amber-300'
}

// ─── V4.2 P5-C: 数据采集服务控制面板 ─────────────────────────────────────────
// 集成在 DataSourceSection 卡片顶部，提供：
// 1. 服务状态展示（data-service 状态 / 最近刷新 / 缓存量 / 宏观指标 / 质量评分）
// 2. 4 个操作按钮：刷新行情 / 刷新宏观 / 重算质量 / 测试连通性

function DataServiceControlCard() {
  const queryClient = useQueryClient()
  const [refreshingMarket, setRefreshingMarket] = useState(false)
  const [refreshingMacro, setRefreshingMacro] = useState(false)
  const [recomputingQuality, setRecomputingQuality] = useState(false)
  const [testingSources, setTestingSources] = useState(false)
  const [testResults, setTestResults] = useState<Array<{ source: string; connected: boolean; latencyMs: number; message: string }>>([])

  // 服务状态（30s 自动刷新；与 SourcesListTab 共享 cache）
  const { data: dsStatus } = useQuery<DataSourceStatus>({
    queryKey: ['data-source-status'],
    queryFn: getDataSourceStatusApi,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const { data: qualitySummary } = useQuery({
    queryKey: ['data-quality-summary'],
    queryFn: getQualitySummary,
    refetchInterval: 30_000,
  })

  const { data: macroData } = useQuery<{ items: MacroMetricItem[] }>({
    queryKey: ['macro-temperature-status'],
    queryFn: getMacroTemperature,
    refetchInterval: 60_000,
  })

  const macroItems = macroData?.items ?? []
  const macroNormal = macroItems.filter(
    (it) => it.quality_status === 'excellent' || it.quality_status === 'usable'
  ).length
  const macroTotal = macroItems.length || 4

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleRefreshMarket = async () => {
    setRefreshingMarket(true)
    toast.info('行情刷新中，约 1-3 分钟，请稍候')
    try {
      const res = await refreshMarketDataApi()
      const updated = res.updated_codes?.length ?? 0
      toast.success(res.message || `行情刷新完成，已更新 ${updated} 只 ETF`)
      queryClient.invalidateQueries({ queryKey: ['data-source-status'] })
      queryClient.invalidateQueries({ queryKey: ['data-quality-summary'] })
      queryClient.invalidateQueries({ queryKey: ['data-source-registry'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '行情刷新失败')
    } finally {
      setRefreshingMarket(false)
    }
  }

  const handleRefreshMacro = async () => {
    setRefreshingMacro(true)
    try {
      const res = await refreshMacro()
      const results = res.results ?? {}
      const total = Object.keys(results).length || 4
      const successCount = Object.values(results).filter(
        (v) => v !== null && v !== undefined
      ).length
      toast.success(`宏观刷新完成: ${successCount}/${total} 成功`)
      queryClient.invalidateQueries({ queryKey: ['macro-temperature-status'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '宏观刷新失败')
    } finally {
      setRefreshingMacro(false)
    }
  }

  const handleRecomputeQuality = async () => {
    setRecomputingQuality(true)
    try {
      const res = await recomputeQuality()
      if (res.success) {
        toast.success(
          `质量评分已重算: ${res.total_metrics} 个指标，平均分 ${res.avg_score}`
        )
        queryClient.invalidateQueries({ queryKey: ['data-quality-summary'] })
        queryClient.invalidateQueries({ queryKey: ['data-quality-summary-matrix'] })
      } else {
        toast.error('质量重算未成功')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '质量重算失败')
    } finally {
      setRecomputingQuality(false)
    }
  }

  const handleTestSources = async () => {
    setTestingSources(true)
    try {
      const res = await testDataSources()
      setTestResults(res)
      const ok = res.filter((d) => d.connected).length
      toast.success(`连通性测试完成: ${ok}/${res.length} 个数据源正常`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '连通性测试失败')
    } finally {
      setTestingSources(false)
    }
  }

  // 服务在线判定：有 dsStatus 或 qualitySummary 任一能拉到，说明 data-service 在跑
  const serviceOnline = !!dsStatus || !!qualitySummary

  return (
    <div className="rounded-lg border border-emerald-200/60 bg-emerald-50/30 dark:border-emerald-900/40 dark:bg-emerald-950/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-semibold">数据采集服务控制</span>
        <Badge
          variant="outline"
          className={`ml-auto text-xs ${
            serviceOnline
              ? 'text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-700 dark:bg-emerald-950/40'
              : 'text-muted-foreground border-muted-foreground/30 bg-muted/40'
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${
              serviceOnline ? 'bg-emerald-500' : 'bg-muted-foreground/50'
            }`}
          />
          {serviceOnline ? '运行中' : '已停止'}
        </Badge>
      </div>

      {/* 状态展示 grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="rounded-md border bg-background/60 p-2 flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">最近行情刷新</span>
          <span className="font-mono text-xs font-bold leading-tight pt-0.5">
            {dsStatus?.lastDataUpdate ? formatDateTime(dsStatus.lastDataUpdate) : '—'}
          </span>
        </div>
        <div className="rounded-md border bg-background/60 p-2 flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">缓存数据量</span>
          <span className="font-mono text-sm font-bold leading-tight pt-0.5">
            {dsStatus?.cacheRows ?? '—'}
            <span className="text-xs text-muted-foreground font-normal"> 行</span>
          </span>
        </div>
        <div className="rounded-md border bg-background/60 p-2 flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">宏观指标</span>
          <span className="font-medium leading-tight pt-0.5">
            <span
              className={
                macroNormal === macroTotal
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-amber-700 dark:text-amber-300'
              }
            >
              {macroNormal}/{macroTotal}
            </span>
            <span className="text-muted-foreground"> 正常</span>
          </span>
        </div>
        <div className="rounded-md border bg-background/60 p-2 flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">数据质量评分</span>
          <span className="font-mono text-sm font-bold leading-tight pt-0.5">
            {qualitySummary ? qualitySummary.avg_score.toFixed(1) : '—'}
            <span className="text-xs text-muted-foreground font-normal"> / 100</span>
          </span>
        </div>
      </div>

      {/* 4 个操作按钮 */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={handleRefreshMarket}
          disabled={refreshingMarket}
        >
          {refreshingMarket ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
          )}
          {refreshingMarket ? '刷新中...' : '刷新行情数据'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefreshMacro}
          disabled={refreshingMacro}
        >
          {refreshingMacro ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Activity className="h-3.5 w-3.5 mr-1" />
          )}
          {refreshingMacro ? '刷新中...' : '刷新宏观数据'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRecomputeQuality}
          disabled={recomputingQuality}
        >
          {recomputingQuality ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Database className="h-3.5 w-3.5 mr-1" />
          )}
          {recomputingQuality ? '重算中...' : '重新计算质量评分'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleTestSources}
          disabled={testingSources}
        >
          {testingSources ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Wifi className="h-3.5 w-3.5 mr-1" />
          )}
          {testingSources ? '测试中...' : '测试数据源连通性'}
        </Button>
      </div>

      {/* 连通性测试结果 */}
      {testResults.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-xs font-medium text-muted-foreground">
            连通性测试结果
          </div>
          <div className="max-h-48 overflow-y-auto pr-1 space-y-1.5">
            {testResults.map((r) => (
              <div
                key={r.source}
                className="flex items-center gap-2 text-xs p-2 rounded-md border bg-background/60"
              >
                {r.connected ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                )}
                <span className="font-medium truncate">{r.source}</span>
                {r.connected && r.latencyMs > 0 && (
                  <Badge
                    variant="outline"
                    className="text-xs px-1 py-0 text-emerald-700 border-emerald-300"
                  >
                    {r.latencyMs}ms
                  </Badge>
                )}
                <span className="text-muted-foreground truncate ml-auto">
                  {r.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DataSourceSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-sky-600" />
          数据源管理
        </CardTitle>
        <CardDescription className="text-xs">
          主源 + 备源 + 交叉校验 + 数据血缘 + 拉取日志 + 质量结果（策略书§4 / V4.1 §10.10）。Tab 切换查看：数据源列表 / 字段级配置 / 交叉校验 / 数据血缘 / 拉取日志 / 质量结果。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataServiceControlCard />
        <Tabs defaultValue="sources" className="w-full">
          <TabsList className="grid grid-cols-3 sm:grid-cols-6 h-auto w-full">
            <TabsTrigger value="sources" className="text-xs gap-1">
              <Database className="h-3.5 w-3.5" />
              <span>数据源列表</span>
            </TabsTrigger>
            <TabsTrigger value="fields" className="text-xs gap-1">
              <Layers className="h-3.5 w-3.5" />
              <span>字段级配置</span>
            </TabsTrigger>
            <TabsTrigger value="cross-check" className="text-xs gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>交叉校验</span>
            </TabsTrigger>
            <TabsTrigger value="lineage" className="text-xs gap-1">
              <GitBranch className="h-3.5 w-3.5" />
              <span>数据血缘</span>
            </TabsTrigger>
            <TabsTrigger value="fetch-logs" className="text-xs gap-1">
              <ListChecks className="h-3.5 w-3.5" />
              <span>拉取日志</span>
            </TabsTrigger>
            <TabsTrigger value="quality-matrix" className="text-xs gap-1">
              <Activity className="h-3.5 w-3.5" />
              <span>质量结果</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sources" className="mt-4">
            <SourcesListTab />
          </TabsContent>
          <TabsContent value="fields" className="mt-4">
            <FieldConfigsTab />
          </TabsContent>
          <TabsContent value="cross-check" className="mt-4">
            <CrossCheckTab />
          </TabsContent>
          <TabsContent value="lineage" className="mt-4">
            <DataLineageTab />
          </TabsContent>
          <TabsContent value="fetch-logs" className="mt-4">
            <FetchLogsTab />
          </TabsContent>
          <TabsContent value="quality-matrix" className="mt-4">
            <DataQualityMatrixTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

// ─── Tab 1: 数据源列表 ─────────────────────────────────────────────────────────

function SourcesListTab() {
  const queryClient = useQueryClient()
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<Array<{ source: string; connected: boolean; latencyMs: number; message: string }>>([])
  const [tokenDialogSource, setTokenDialogSource] = useState<DataSourceRegistryItem | null>(null)
  const [errorGuideOpen, setErrorGuideOpen] = useState(false)

  const { data: status, isLoading } = useQuery({
    queryKey: ['data-source-status'],
    queryFn: fetchDataSourceStatus,
  })

  // S5-T5: 用合并接口 /registry 取代 /sources（含 is_enabled / capabilities / last_status / has_token）
  const { data: registryData, isLoading: registryLoading } = useQuery({
    queryKey: ['data-source-registry'],
    queryFn: getDataSourceRegistry,
  })

  const { data: thresholdsData } = useQuery({
    queryKey: ['data-source-thresholds'],
    queryFn: fetchThresholds,
  })

  // S5-T3: 启用/停用数据源
  const toggleEnabledMutation = useMutation({
    mutationFn: async ({ id, enable }: { id: string; enable: boolean }) => {
      return enable ? enableDataSource(id) : disableDataSource(id)
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.enable ? '已启用该数据源' : '已停用该数据源')
      queryClient.invalidateQueries({ queryKey: ['data-source-registry'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : '操作失败'
      toast.error(msg)
    },
  })

  const refreshMutation = useMutation({
    mutationFn: refreshMarketData,
    onSuccess: () => {
      toast.success('数据刷新已启动（后台进行，约1-2分钟完成）')
      queryClient.invalidateQueries({ queryKey: ['data-source-status'] })
      queryClient.invalidateQueries({ queryKey: ['data-source-registry'] })
    },
    onError: () => toast.error('刷新失败'),
  })

  const testMutation = useMutation({
    mutationFn: testDataSources,
    onMutate: () => setTesting(true),
    onSuccess: (data) => {
      setTestResults(data)
      setTesting(false)
      const okCount = data.filter(d => d.connected).length
      toast.success(`${okCount}/${data.length} 个数据源连接正常`)
    },
    onError: () => {
      setTesting(false)
      toast.error('连通性测试失败')
    },
  })

  const registrySources: DataSourceRegistryItem[] = registryData?.sources ?? []

  return (
    <div className="space-y-4">
      {/* 数据源列表（含启用/停用 Switch + 最近拉取状态 + Token 配置入口） */}
      <div className="space-y-2">
        {registryLoading ? (
          <Skeleton className="h-32 w-full rounded-md" />
        ) : registrySources.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded-md border bg-muted/30">
            暂无数据源信息
          </div>
        ) : (
          registrySources.map((s) => (
            <DataSourceRow
              key={s.id}
              source={s}
              onToggle={(enable) => toggleEnabledMutation.mutate({ id: s.id, enable })}
              onConfigureToken={() => setTokenDialogSource(s)}
              pendingToggle={
                toggleEnabledMutation.isPending &&
                toggleEnabledMutation.variables?.id === s.id
              }
            />
          ))
        )}
      </div>

      {/* 缓存概览 */}
      {status && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground">监控标的</div>
            <div className="font-mono text-lg font-bold">{status.trackedCount}</div>
          </div>
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground">缓存记录</div>
            <div className="font-mono text-lg font-bold">{status.cacheRows}</div>
          </div>
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground">最近更新</div>
            <div className="font-mono text-xs font-bold leading-tight pt-1">{formatDateTime(status.lastDataUpdate)}</div>
          </div>
        </div>
      )}
      {isLoading && !status && <Skeleton className="h-16 w-full rounded-md" />}

      {/* 双源校验容忍阈值（S5-T6 可编辑） */}
      {thresholdsData && (
        <ThresholdsEditor thresholds={thresholdsData.thresholds} note={thresholdsData.note} />
      )}

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
          手动刷新数据
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => testMutation.mutate()}
          disabled={testing}
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Activity className="h-3.5 w-3.5 mr-1" />}
          测试连通性
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-xs h-8"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['data-source-registry'] })}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          刷新列表
        </Button>
      </div>

      {/* 连通性测试结果 */}
      {testResults.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-xs font-medium text-muted-foreground">连通性测试结果</div>
          {testResults.map((r) => (
            <div key={r.source} className="flex items-center gap-2 text-xs p-2 rounded-md border bg-card/50">
              {r.connected ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
              )}
              <span className="font-medium">{r.source}</span>
              {r.connected && r.latencyMs > 0 && (
                <Badge variant="outline" className="text-xs px-1 py-0 text-emerald-700 border-emerald-300">
                  {r.latencyMs}ms
                </Badge>
              )}
              <span className="text-muted-foreground truncate">{r.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* S5-T8: 异常处理指引折叠卡 */}
      <Collapsible open={errorGuideOpen} onOpenChange={setErrorGuideOpen} className="rounded-md border border-amber-200/60 bg-amber-50/30">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-1.5 p-3 text-left">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-700" />
            <span className="text-xs font-medium text-amber-800">数据源异常处理指引</span>
            <ChevronDown className={`h-3 w-3 ml-auto text-amber-700 transition-transform ${errorGuideOpen ? 'rotate-180' : ''}`} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3 space-y-2">
          <Alert className="border-amber-200 bg-amber-50/60 text-amber-900">
            <AlertCircle className="h-4 w-4 text-amber-700" />
            <AlertTitle className="text-xs">场景 1：主源失败如何切备源</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed">
              系统会自动降级到备源（efinance / tushare），无需手动干预；如需强制指定使用某源，
              可前往"字段级配置"Tab 使用"强制切源"按钮覆盖默认优先级（用于排查数据异常）。
            </AlertDescription>
          </Alert>
          <Alert className="border-amber-200 bg-amber-50/60 text-amber-900">
            <Key className="h-4 w-4 text-amber-700" />
            <AlertTitle className="text-xs">场景 2：Token 失效如何处理</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed">
              点击数据源行的"配置 Token"按钮重新输入 Token，保存后立即生效（Fernet 加密存储）。
              旧 Token 失效不会影响其他数据源，仅该源会退化为"待配置"状态。
            </AlertDescription>
          </Alert>
          <Alert className="border-amber-200 bg-amber-50/60 text-amber-900">
            <Zap className="h-4 w-4 text-amber-700" />
            <AlertTitle className="text-xs">场景 3：限流如何降级</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed">
              系统自动降级到备源，无需手动干预。每个数据源已配置 rate_limit_per_min 限流参数，
              触发限流时记录"error"日志到"拉取日志"Tab，并立即尝试备源拉取，刷新不阻断。
            </AlertDescription>
          </Alert>
        </CollapsibleContent>
      </Collapsible>

      {/* Token 配置 Dialog（S5-T11） */}
      {tokenDialogSource && (
        <TokenConfigDialog
          source={tokenDialogSource}
          open={!!tokenDialogSource}
          onOpenChange={(o) => !o && setTokenDialogSource(null)}
        />
      )}
    </div>
  )
}

// 单行数据源卡片：Switch + 名称 + 角色 + 最近拉取状态 + Token 配置入口
function DataSourceRow({
  source,
  onToggle,
  onConfigureToken,
  pendingToggle,
}: {
  source: DataSourceRegistryItem
  onToggle: (enable: boolean) => void
  onConfigureToken: () => void
  pendingToggle: boolean
}) {
  const rm = ADAPTER_ROLE_MAP[source.role] ?? ADAPTER_ROLE_MAP.reference
  const isAkshare = source.id === 'akshare'
  // last_status 状态判断
  const lastStatus = source.last_status ?? {}
  const hasSuccess = !!lastStatus.last_success_time
  const hasError = !!lastStatus.error_message && lastStatus.status !== 'success' && lastStatus.status !== 'ok'
  const latencyMs = lastStatus.latency_ms ?? 0

  return (
    <div className={`flex items-start gap-3 p-3 rounded-md border bg-card/50 transition-opacity ${source.is_enabled ? '' : 'opacity-60 bg-muted/30'}`}>
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <span className={`h-2 w-2 rounded-full ${source.is_enabled ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
        <Wifi className={`h-3.5 w-3.5 ${source.is_enabled ? 'text-emerald-500' : 'text-muted-foreground/50'}`} />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">{source.name}</span>
          <Badge variant="outline" className={`text-xs px-1.5 py-0 ${rm.color}`}>{rm.label}</Badge>
          {source.is_enabled ? (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-emerald-700 bg-emerald-50 border-emerald-300">
              已启用
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-slate-700 bg-slate-100 border-slate-300">
              已停用
            </Badge>
          )}
          {source.needs_token && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-sky-700 bg-sky-50 border-sky-300">
              <Key className="h-2.5 w-2.5 mr-0.5" />需 Token
            </Badge>
          )}
          {source.needs_token && source.has_token && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-emerald-700 bg-emerald-50 border-emerald-300">
              ✓ Token 已配置
            </Badge>
          )}
          {source.needs_token && !source.has_token && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 text-amber-700 bg-amber-50 border-amber-300">
              ⚠ Token 待配置
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{source.description}</p>
        {source.sub_sources && (
          <p className="text-xs text-muted-foreground/70 font-mono">
            子源: {source.sub_sources}
          </p>
        )}
        {/* Capabilities: 按指标展示 primary/backup/validator 角色徽标 */}
        {source.capabilities && source.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {source.capabilities.map((c) => {
              const label = FIELD_LABEL_MAP[c.metric_type] || c.metric_type
              let roleText = ''
              let color = ''
              if (c.is_primary) { roleText = '主'; color = 'text-emerald-700 bg-emerald-50 border-emerald-300' }
              else if (c.is_backup) { roleText = '备'; color = 'text-slate-700 bg-slate-50 border-slate-300' }
              else if (c.is_validator) { roleText = '校验'; color = 'text-amber-700 bg-amber-50 border-amber-300' }
              if (!roleText) return null
              return (
                <Badge key={c.metric_type} variant="outline" className={`text-xs px-1 py-0 ${color}`}>
                  {label}·{roleText}
                </Badge>
              )
            })}
          </div>
        )}
        {/* 最近拉取状态（S5-T5） */}
        <div className="flex items-center gap-3 flex-wrap pt-0.5 text-xs">
          {hasSuccess ? (
            <span className="flex items-center gap-1 text-emerald-700" title={`最近成功: ${formatDateTime(lastStatus.last_success_time || '')}`}>
              <CheckCircle className="h-3 w-3" />
              最近成功 {formatDateTime(lastStatus.last_success_time || '')}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-muted-foreground/60">
              <Activity className="h-3 w-3" />
              暂无成功记录
            </span>
          )}
          {hasError && (
            <span
              className="flex items-center gap-1 text-red-700 max-w-[260px] truncate"
              title={lastStatus.error_message || ''}
            >
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{lastStatus.error_message}</span>
            </span>
          )}
          {latencyMs > 0 && (
            <span className="flex items-center gap-1 text-slate-600">
              <Zap className="h-3 w-3" />
              {latencyMs}ms
            </span>
          )}
          {source.homepage && (
            <a
              href={source.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sky-700 hover:underline ml-auto"
            >
              <ExternalLink className="h-3 w-3" />
              官网
            </a>
          )}
        </div>
      </div>
      {/* 右侧操作区：Token 配置 + Switch */}
      <div className="flex flex-col items-end gap-2 shrink-0">
        {source.needs_token && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={onConfigureToken}
          >
            <Key className="h-3 w-3 mr-1" />
            {source.has_token ? '更新 Token' : '配置 Token'}
          </Button>
        )}
        <div className="flex items-center gap-1.5">
          <Switch
            checked={source.is_enabled}
            disabled={isAkshare || pendingToggle}
            onCheckedChange={(checked) => onToggle(checked)}
          />
          {pendingToggle && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {isAkshare && (
          <span className="text-xs text-muted-foreground/70 italic">主源必启</span>
        )}
      </div>
    </div>
  )
}

// S5-T11: Token 配置 Dialog
function TokenConfigDialog({
  source,
  open,
  onOpenChange,
}: {
  source: DataSourceRegistryItem
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')

  const saveMutation = useMutation({
    mutationFn: (tk: string) => setDataSourceToken(source.id, tk),
    onSuccess: () => {
      toast.success(`${source.name} Token 已保存（Fernet 加密存储）`)
      queryClient.invalidateQueries({ queryKey: ['data-source-registry'] })
      setToken('')
      onOpenChange(false)
    },
    onError: () => toast.error('保存失败，请重试'),
  })

  const handleSave = () => {
    if (!token.trim()) {
      toast.error('请输入 Token')
      return
    }
    saveMutation.mutate(token.trim())
  }

  const handleClear = () => {
    saveMutation.mutate('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5">
            <Key className="h-4 w-4 text-amber-600" />
            配置 Token — {source.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Token 将通过 Fernet 对称加密后存储到 data_source 注册表，不会以明文形式落盘。
            后端服务读取时按需解密。{source.homepage && (
              <a href={source.homepage} target="_blank" rel="noopener noreferrer" className="ml-1 text-sky-600 underline">
                前往官网获取 →
              </a>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Token 明文</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={source.has_token ? '••••••••（已保存，输入新值覆盖）' : '请粘贴 Token 字符串'}
              className="font-mono text-xs h-8"
            />
            {source.has_token && (
              <div className="flex items-center gap-1 text-xs text-emerald-700">
                <CheckCircle2 className="h-3 w-3" />
                当前已配置 Token（如需清除请点"清除 Token"）
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          {source.has_token && (
            <Button
              size="sm"
              variant="outline"
              className="text-red-700 hover:text-red-800"
              onClick={handleClear}
              disabled={saveMutation.isPending}
            >
              清除 Token
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending || !token.trim()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" />
            )}
            加密保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// S5-T6: 双源校验阈值可编辑
// 注意：后端返回 snake_case 字段（max_diff / threshold_type），这里直接用 snake_case 读取
function ThresholdsEditor({
  thresholds,
  note,
}: {
  thresholds: Array<{
    key: string
    label: string
    threshold_type: string
    max_diff: number
    max_diff_pct: number | null
    max_diff_pp: number | null
    unit: string
  }>
  note: string
}) {
  const queryClient = useQueryClient()
  // 本地编辑态：key → 正在编辑的临时值（未保存）
  const [editing, setEditing] = useState<Record<string, string>>({})
  // 正在保存的 key（防止并发提交）
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: ({ key, maxDiff }: { key: string; maxDiff: number }) => updateThreshold(key, maxDiff),
    onSuccess: (_data, vars) => {
      toast.success(`阈值 ${vars.key} 已保存`)
      queryClient.invalidateQueries({ queryKey: ['data-source-thresholds'] })
      setEditing((prev) => {
        const next = { ...prev }
        delete next[vars.key]
        return next
      })
      setSavingKey(null)
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : '保存失败'
      toast.error(msg)
      setSavingKey(null)
    },
  })

  const handleStartEdit = (key: string, current: number) => {
    setEditing((prev) => ({ ...prev, [key]: String(current) }))
  }

  const handleCancelEdit = (key: string) => {
    setEditing((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const handleSave = (key: string) => {
    const raw = editing[key]
    if (raw === undefined) return
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) {
      toast.error('请输入大于 0 的数字')
      return
    }
    setSavingKey(key)
    saveMutation.mutate({ key, maxDiff: num })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
        <span>双源校验容忍阈值</span>
        <Badge variant="outline" className="text-xs px-1 py-0 text-amber-700 bg-amber-50 border-amber-300">可编辑</Badge>
      </div>
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-7 text-xs">字段</TableHead>
              <TableHead className="h-7 text-xs text-right">容忍差异</TableHead>
              <TableHead className="h-7 text-xs text-right w-[120px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {thresholds.map((t) => {
              const isEditing = editing[t.key] !== undefined
              const isSavingThis = savingKey === t.key
              return (
                <TableRow key={t.key}>
                  <TableCell className="py-1.5 text-xs">
                    <div>{t.label}</div>
                    <div className="text-xs text-muted-foreground/70 font-mono">{t.key} · {t.threshold_type}</div>
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-right">
                    {isEditing ? (
                      <div className="flex items-center justify-end gap-1">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editing[t.key]}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [t.key]: e.target.value }))}
                          className="font-mono text-xs h-7 w-20 text-right"
                          autoFocus
                        />
                        <span className="text-xs text-muted-foreground">{t.unit}</span>
                      </div>
                    ) : (
                      <span className="font-mono">
                        ≤{t.max_diff}{t.unit}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5 text-xs text-right">
                    {isEditing ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-xs"
                          onClick={() => handleCancelEdit(t.key)}
                          disabled={isSavingThis}
                        >
                          取消
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                          onClick={() => handleSave(t.key)}
                          disabled={isSavingThis}
                        >
                          {isSavingThis ? (
                            <Loader2 className="h-3 w-3 mr-0.5 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3 mr-0.5" />
                          )}
                          保存
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => handleStartEdit(t.key, t.max_diff)}
                      >
                        <Pencil className="h-3 w-3 mr-0.5" />
                        编辑
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground/70 italic">{note}</p>
    </div>
  )
}

// ─── Tab 2: 字段级主备源配置 ───────────────────────────────────────────────────

function FieldConfigsTab() {
  const queryClient = useQueryClient()
  const [editingField, setEditingField] = useState<FieldSourceConfig | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['field-configs'],
    queryFn: getFieldConfigs,
  })

  const forceSwitchMutation = useMutation({
    mutationFn: ({ field, source }: { field: string; source: string | null }) =>
      forceSwitchSource(field, source),
    onSuccess: (_data, vars) => {
      toast.success(vars.source === null ? '已清除强制源' : `已切换强制源为 ${vars.source}`)
      queryClient.invalidateQueries({ queryKey: ['field-configs'] })
    },
    onError: () => toast.error('强制切源失败'),
  })

  const fields = data?.fields ?? []

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200/60 bg-sky-50/30 p-2.5 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium text-sky-800">V4 策略书§4.3：</span>
        按字段配置主备源优先级。主源失败时自动切备源；强制源会覆盖默认优先级（用于排查数据异常）。
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-md" />
      ) : fields.length === 0 ? (
        <div className="text-xs text-muted-foreground italic p-3 rounded-md border bg-muted/30">
          暂无字段配置
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-xs whitespace-nowrap">字段</TableHead>
                <TableHead className="h-8 text-xs whitespace-nowrap">主源</TableHead>
                <TableHead className="h-8 text-xs whitespace-nowrap">备源</TableHead>
                <TableHead className="h-8 text-xs whitespace-nowrap">强制源</TableHead>
                <TableHead className="h-8 text-xs whitespace-nowrap text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((f) => {
                return (
                  <TableRow key={f.field}>
                    <TableCell className="py-2 text-xs font-medium whitespace-nowrap">
                      {f.field_label}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {f.primary_sources.length === 0 ? (
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          f.primary_sources.map((src) => {
                            const ad = f.adapter_status?.[src]
                            const status = ad?.status
                            const color = adapterAvailableColor(ad?.available ?? false, status)
                            return (
                              <Badge key={src} variant="outline" className={`text-xs px-1.5 py-0 ${color}`}>
                                {ad?.display_name || ad?.name || src}
                              </Badge>
                            )
                          })
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {f.backup_sources.length === 0 ? (
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          f.backup_sources.map((src) => {
                            const ad = f.adapter_status?.[src]
                            const status = ad?.status
                            const color = adapterAvailableColor(ad?.available ?? false, status)
                            return (
                              <Badge key={src} variant="outline" className={`text-xs px-1.5 py-0 ${color}`}>
                                {ad?.display_name || ad?.name || src}
                              </Badge>
                            )
                          })
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {f.forced_source ? (
                        <div className="flex items-center gap-1">
                          <Badge variant="outline" className="text-xs px-1.5 py-0 text-amber-700 bg-amber-100 border-amber-300">
                            <Zap className="h-2.5 w-2.5 mr-0.5" />
                            {f.adapter_status?.[f.forced_source]?.display_name
                              || f.adapter_status?.[f.forced_source]?.name
                              || f.forced_source}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1 text-xs text-muted-foreground hover:text-red-700"
                            onClick={() =>
                              forceSwitchMutation.mutate({ field: f.field, source: null })
                            }
                            disabled={forceSwitchMutation.isPending}
                            title="清除强制源"
                          >
                            <Ban className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs"
                              disabled={forceSwitchMutation.isPending}
                            >
                              <Zap className="h-3 w-3 mr-0.5" />
                              {f.forced_source ? '切换强制源' : '强制切源'}
                              <ChevronDown className="h-3 w-3 ml-0.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuLabel className="text-xs">
                              选择强制源（{f.field_label}）
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {f.available_adapters.map((src) => {
                              const ad = f.adapter_status?.[src]
                              return (
                                <DropdownMenuItem
                                  key={src}
                                  className="text-xs cursor-pointer"
                                  onSelect={() =>
                                    forceSwitchMutation.mutate({ field: f.field, source: src })
                                  }
                                >
                                  <div className="flex items-center gap-1.5 w-full">
                                    <span
                                      className={`h-1.5 w-1.5 rounded-full ${
                                        ad?.available ? 'bg-emerald-500' : 'bg-amber-500'
                                      }`}
                                    />
                                    <span className="flex-1">
                                      {ad?.display_name || ad?.name || src}
                                    </span>
                                    {!ad?.available && (
                                      <span className="text-xs text-amber-700">不可用</span>
                                    )}
                                  </div>
                                </DropdownMenuItem>
                              )
                            })}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => setEditingField(f)}
                        >
                          <Pencil className="h-3 w-3 mr-0.5" />
                          编辑
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editingField && (
        <EditFieldConfigDialog
          key={editingField.field}
          field={editingField}
          open={!!editingField}
          onOpenChange={(o) => !o && setEditingField(null)}
        />
      )}
    </div>
  )
}

// 编辑字段主备源配置的对话框
function EditFieldConfigDialog({
  field,
  open,
  onOpenChange,
}: {
  field: FieldSourceConfig
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [primary, setPrimary] = useState<Set<string>>(new Set(field.primary_sources))
  const [backup, setBackup] = useState<Set<string>>(new Set(field.backup_sources))

  const updateMutation = useMutation({
    mutationFn: () => updateFieldConfig(field.field, Array.from(primary), Array.from(backup)),
    onSuccess: () => {
      toast.success(`字段 ${field.field_label} 配置已更新`)
      queryClient.invalidateQueries({ queryKey: ['field-configs'] })
      onOpenChange(false)
    },
    onError: () => toast.error('更新失败'),
  })

  const toggle = (set: Set<string>, src: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(src)
    else next.delete(src)
    return next
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5">
            <Pencil className="h-4 w-4" />
            编辑字段配置 — {field.field_label}
          </DialogTitle>
          <DialogDescription className="text-xs">
            勾选主源（按优先级）和备源。主源失败时按备源顺序回退。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {field.available_adapters.map((src) => {
            const ad = field.adapter_status?.[src]
            const isPrimary = primary.has(src)
            const isBackup = backup.has(src)
            return (
              <div
                key={src}
                className="flex items-center justify-between gap-2 p-2 rounded-md border bg-card/40"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      ad?.available ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium">
                      {ad?.display_name || ad?.name || src}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {src}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isPrimary}
                      onChange={(e) => {
                        setPrimary((p) => toggle(p, src, e.target.checked))
                        if (e.target.checked) {
                          setBackup((b) => {
                            const n = new Set(b)
                            n.delete(src)
                            return n
                          })
                        }
                      }}
                      className="accent-emerald-600 h-3.5 w-3.5"
                    />
                    <span className="text-emerald-700">主源</span>
                  </label>
                  <label className="flex items-center gap-1 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isBackup}
                      onChange={(e) => {
                        setBackup((b) => toggle(b, src, e.target.checked))
                        if (e.target.checked) {
                          setPrimary((p) => {
                            const n = new Set(p)
                            n.delete(src)
                            return n
                          })
                        }
                      }}
                      className="accent-sky-600 h-3.5 w-3.5"
                    />
                    <span className="text-sky-700">备源</span>
                  </label>
                </div>
              </div>
            )
          })}
          {field.available_adapters.length === 0 && (
            <div className="text-xs text-muted-foreground italic">无可用适配器</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending || (primary.size === 0 && backup.size === 0)}
          >
            {updateMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" />
            )}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Tab 3: 交叉校验 ──────────────────────────────────────────────────────────

function CrossCheckTab() {
  const queryClient = useQueryClient()
  const [selectedEtf, setSelectedEtf] = useState<string>('159338')
  const [runResults, setRunResults] = useState<CrossCheckRecord[] | null>(null)

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['cross-check-stats'],
    queryFn: () => getCrossCheckHistory({ stats: true, limit: 50 }),
  })

  const stats: CrossCheckStats | undefined = statsData?.stats
  const history: CrossCheckRecord[] = statsData?.records ?? []

  const runMutation = useMutation({
    mutationFn: (etfCode: string) => runCrossCheck(etfCode),
    onMutate: () => setRunResults(null),
    onSuccess: (data) => {
      setRunResults(data.results)
      toast.success(`交叉校验完成（${data.results.length} 条记录）`)
      queryClient.invalidateQueries({ queryKey: ['cross-check-stats'] })
    },
    onError: () => toast.error('交叉校验请求失败（可能超时，请稍后重试）'),
  })

  const statsCards = [
    {
      label: '总校验次数',
      value: stats?.total ?? 0,
      color: 'text-slate-700',
      bg: 'bg-slate-50',
      icon: Activity,
    },
    {
      label: '通过率',
      value: stats ? `${stats.pass_rate.toFixed(1)}%` : '—',
      color: 'text-emerald-700',
      bg: 'bg-emerald-50',
      icon: CheckCircle2,
    },
    {
      label: '源不一致',
      value: stats?.inconsistent ?? 0,
      color: 'text-red-700',
      bg: 'bg-red-50',
      icon: AlertTriangle,
    },
    {
      label: '主源失败',
      value: stats?.primary_failed ?? 0,
      color: 'text-amber-700',
      bg: 'bg-amber-50',
      icon: XCircle,
    },
  ]

  return (
    <div className="space-y-3">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {statsCards.map((c) => {
          const Icon = c.icon
          return (
            <div key={c.label} className={`rounded-md border ${c.bg} p-2.5`}>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Icon className={`h-3 w-3 ${c.color}`} />
                <span>{c.label}</span>
              </div>
              <div className={`font-mono text-lg font-bold ${c.color} mt-0.5`}>
                {statsLoading ? <Skeleton className="h-5 w-10" /> : c.value}
              </div>
            </div>
          )
        })}
      </div>

      {stats?.last_check_time && (
        <div className="text-xs text-muted-foreground/70 italic">
          最近校验时间: {formatDateTime(stats.last_check_time)}
        </div>
      )}

      {/* 立即执行交叉校验 */}
      <div className="rounded-md border border-sky-200/60 bg-sky-50/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-sky-800">
          <Zap className="h-3.5 w-3.5" />
          <span>立即执行交叉校验</span>
        </div>
        <p className="text-xs text-muted-foreground">
          选择 ETF 后调用主源+备源同时拉取并比对。慢请求（akshare 网络拉取可能 30s+），请耐心等待。
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={selectedEtf} onValueChange={setSelectedEtf}>
            <SelectTrigger size="sm" className="h-8 w-[200px] text-xs">
              <SelectValue placeholder="选择 ETF" />
            </SelectTrigger>
            <SelectContent>
              {ETF_OPTIONS.map((e) => (
                <SelectItem key={e.code} value={e.code} className="text-xs">
                  <span className="font-mono">{e.code}</span>
                  <span className="ml-2 text-muted-foreground">{e.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => runMutation.mutate(selectedEtf)}
            disabled={runMutation.isPending}
            className="h-8"
          >
            {runMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5 mr-1" />
            )}
            {runMutation.isPending ? '执行中…' : '立即执行'}
          </Button>
        </div>

        {runResults && (
          <div className="pt-2 space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              本次校验结果（{runResults.length} 条）
            </div>
            <CrossCheckRecordsTable records={runResults} />
          </div>
        )}
      </div>

      {/* 历史校验记录 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            <span>最近校验历史（最多 50 条）</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['cross-check-stats'] })}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            刷新
          </Button>
        </div>
        {statsLoading ? (
          <Skeleton className="h-32 w-full rounded-md" />
        ) : history.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded-md border bg-muted/30">
            暂无校验历史
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <CrossCheckRecordsTable records={history} />
          </div>
        )}
      </div>
    </div>
  )
}

function CrossCheckRecordsTable({ records }: { records: CrossCheckRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-7 text-xs whitespace-nowrap">时间</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap">字段</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap">代码</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap text-right">主源值</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap text-right">备源值</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap text-right">差异</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap">状态</TableHead>
            <TableHead className="h-7 text-xs whitespace-nowrap">说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r, idx) => {
            const sm = CROSS_CHECK_STATUS_MAP[r.quality_status] ?? {
              label: r.quality_status,
              color: 'text-muted-foreground bg-muted border-border',
            }
            const diffDisplay =
              r.diff_pct !== null && r.diff_pct !== undefined
                ? `${r.diff_pct.toFixed(2)}%`
                : r.diff_pp !== null && r.diff_pp !== undefined
                ? `${r.diff_pp.toFixed(2)}pp`
                : '—'
            return (
              <TableRow key={`${r.fetch_time}-${r.field}-${r.code}-${idx}`}>
                <TableCell className="py-1.5 text-xs font-mono whitespace-nowrap text-muted-foreground">
                  {formatDateTime(r.fetch_time)}
                </TableCell>
                <TableCell className="py-1.5 text-xs whitespace-nowrap">
                  {FIELD_LABEL_MAP[r.field] || r.field}
                </TableCell>
                <TableCell className="py-1.5 text-xs font-mono whitespace-nowrap">
                  {r.code}
                </TableCell>
                <TableCell className="py-1.5 text-xs font-mono text-right whitespace-nowrap">
                  {r.primary_value ?? '—'}
                </TableCell>
                <TableCell className="py-1.5 text-xs font-mono text-right whitespace-nowrap">
                  {r.backup_value ?? '—'}
                </TableCell>
                <TableCell className="py-1.5 text-xs font-mono text-right whitespace-nowrap">
                  {diffDisplay}
                </TableCell>
                <TableCell className="py-1.5 text-xs whitespace-nowrap">
                  <Badge variant="outline" className={`text-xs px-1 py-0 ${sm.color}`}>
                    {sm.label}
                  </Badge>
                </TableCell>
                <TableCell className="py-1.5 text-xs text-muted-foreground max-w-[200px] truncate" title={r.notes}>
                  {r.notes || '—'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ─── Tab 4: 数据血缘 ──────────────────────────────────────────────────────────

function DataLineageTab() {
  const [selectedEtf, setSelectedEtf] = useState<string>('159338')
  const [selectedType, setSelectedType] = useState<string>('valuation')

  // valuation 类型 code 需要映射成指数代码
  const queryCode = useMemo(() => {
    if (selectedType === 'valuation') {
      const opt = ETF_OPTIONS.find((e) => e.code === selectedEtf)
      return opt?.indexCode || selectedEtf
    }
    return selectedEtf
  }, [selectedEtf, selectedType])

  const { data: lineage, isLoading } = useQuery({
    queryKey: ['data-lineage', queryCode, selectedType],
    queryFn: () => getDataLineage(queryCode, selectedType),
    enabled: !!queryCode && !!selectedType,
  })

  const [jsonExpanded, setJsonExpanded] = useState(false)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200/60 bg-sky-50/30 p-2.5 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium text-sky-800">V4 策略书§4.5：</span>
        数据血缘追踪 — 选 ETF 与数据类型，查看该数据的来源、原始值、清洗值、分位窗口及完整 JSON 快照。
        <span className="text-amber-700"> 注：估值类型 code 自动映射为指数代码。</span>
      </div>

      {/* 选择器 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-muted-foreground">ETF 代码</label>
          <Select value={selectedEtf} onValueChange={setSelectedEtf}>
            <SelectTrigger size="sm" className="h-8 w-[200px] text-xs">
              <SelectValue placeholder="选择 ETF" />
            </SelectTrigger>
            <SelectContent>
              {ETF_OPTIONS.map((e) => (
                <SelectItem key={e.code} value={e.code} className="text-xs">
                  <span className="font-mono">{e.code}</span>
                  <span className="ml-2 text-muted-foreground">{e.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-muted-foreground">数据类型</label>
          <Select value={selectedType} onValueChange={setSelectedType}>
            <SelectTrigger size="sm" className="h-8 w-[180px] text-xs">
              <SelectValue placeholder="选择数据类型" />
            </SelectTrigger>
            <SelectContent>
              {DATA_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-0.5 self-end">
          <Badge variant="outline" className="text-xs px-1.5 py-0 font-mono">
            查询 code: {queryCode}
          </Badge>
        </div>
      </div>

      {/* 血缘信息卡片 */}
      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-md" />
      ) : !lineage || !lineage.found ? (
        <div className="flex flex-col items-center justify-center gap-2 p-8 rounded-md border border-dashed bg-muted/20 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground/50" />
          <div className="text-sm font-medium text-muted-foreground">未找到该数据类型的缓存记录</div>
          <div className="text-xs text-muted-foreground/70">
            请确认该 ETF/数据类型已通过数据刷新获取，或查看其他组合
          </div>
          {lineage?.message && (
            <div className="text-xs text-muted-foreground/60 font-mono mt-1">
              {lineage.message}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* 基础信息 */}
          <div className="rounded-md border bg-card/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Info className="h-3.5 w-3.5 text-sky-600" />
              <span>基础信息</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <LineageItem label="代码" value={lineage.code} mono />
              <LineageItem label="数据类型" value={FIELD_LABEL_MAP[lineage.data_type || ''] || lineage.data_type} />
              <LineageItem label="日期" value={lineage.date} mono />
              <LineageItem label="交易日" value={lineage.trade_date} mono />
              <LineageItem label="拉取时间" value={formatDateTime(lineage.fetch_time || '')} mono />
              <LineageItem label="样本天数" value={lineage.sample_days != null ? `${lineage.sample_days} 日` : '—'} mono />
            </div>
          </div>

          {/* 数值信息 */}
          <div className="rounded-md border bg-card/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Activity className="h-3.5 w-3.5 text-emerald-600" />
              <span>数值信息</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <LineageItem label="原始值" value={lineage.raw_value ?? '—'} mono />
              <LineageItem label="清洗值" value={lineage.clean_value != null ? String(lineage.clean_value) : '—'} mono />
              <LineageItem label="分位值" value={lineage.percentile != null ? `${lineage.percentile.toFixed(2)}` : '—'} mono />
              <LineageItem label="分位窗口" value={lineage.percentile_window} />
            </div>
          </div>

          {/* 数据源 */}
          <div className="rounded-md border bg-card/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Database className="h-3.5 w-3.5 text-sky-600" />
              <span>数据来源</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <LineageItem label="源适配器" value={lineage.source} mono />
              <LineageItem label="源 API" value={lineage.source_api} mono />
            </div>
          </div>

          {/* 质量 */}
          <div className="rounded-md border bg-card/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              <span>数据质量</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={`text-xs px-1.5 py-0 ${
                  lineage.is_valid
                    ? 'text-emerald-700 bg-emerald-100 border-emerald-300'
                    : 'text-red-700 bg-red-100 border-red-300'
                }`}
              >
                {lineage.is_valid ? (
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                ) : (
                  <XCircle className="h-2.5 w-2.5 mr-0.5" />
                )}
                {lineage.is_valid ? '有效' : '异常'}
              </Badge>
              {lineage.abnormal_reason && (
                <span className="text-xs text-red-700 italic">
                  {lineage.abnormal_reason}
                </span>
              )}
            </div>
          </div>

          {/* 完整 JSON 快照 */}
          {lineage.data_json && (
            <div className="rounded-md border bg-card/40 p-3 space-y-2">
              <button
                className="flex items-center gap-1.5 text-xs font-medium w-full text-left"
                onClick={() => setJsonExpanded((v) => !v)}
              >
                <Code2 className="h-3.5 w-3.5 text-slate-600" />
                <span>完整 JSON 快照</span>
                <ChevronDown
                  className={`h-3 w-3 ml-auto transition-transform ${jsonExpanded ? 'rotate-180' : ''}`}
                />
              </button>
              {jsonExpanded && (
                <pre className="text-xs font-mono text-muted-foreground bg-muted/40 rounded-md p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(lineage.data_json), null, 2)
                    } catch {
                      return lineage.data_json
                    }
                  })()}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LineageItem({
  label,
  value,
  mono,
}: {
  label: string
  value?: string | null
  mono?: boolean
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xs ${mono ? 'font-mono' : ''} break-all`}>
        {value ?? '—'}
      </div>
    </div>
  )
}

// ─── Tab 5: 拉取日志（S5-T4） ─────────────────────────────────────────────────

const FETCH_LOG_STATUS_MAP: Record<string, { label: string; color: string }> = {
  success: { label: '成功', color: 'text-emerald-700 bg-emerald-100 border-emerald-300' },
  error: { label: '失败', color: 'text-red-700 bg-red-100 border-red-300' },
  skipped: { label: '跳过', color: 'text-slate-700 bg-slate-100 border-slate-300' },
  no_data: { label: '无数据', color: 'text-amber-700 bg-amber-100 border-amber-300' },
}

function FetchLogsTab() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [limit, setLimit] = useState<number>(100)

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['data-source-fetch-logs', statusFilter, limit],
    queryFn: () =>
      getFetchLogs({
        limit,
        status: statusFilter === 'all' ? undefined : (statusFilter as 'success' | 'error' | 'skipped' | 'no_data'),
      }),
    refetchOnMount: true,
  })

  const logs: FetchLogItem[] = data?.logs ?? []
  const total: number = data?.total ?? 0

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200/60 bg-sky-50/30 p-2.5 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium text-sky-800">V4.1 §13.9 data_fetch_log 表：</span>
        每次拉取（success/error/skipped/no_data）都会写入拉取日志，包含 request_id 追踪、延迟、错误信息。
        支持按状态过滤、按 limit 控制（最大 500 条）。
      </div>

      {/* 工具栏：状态过滤 + 条数 + 刷新 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">状态</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger size="sm" className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="全部" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部</SelectItem>
              <SelectItem value="success" className="text-xs">成功</SelectItem>
              <SelectItem value="error" className="text-xs">失败</SelectItem>
              <SelectItem value="skipped" className="text-xs">跳过</SelectItem>
              <SelectItem value="no_data" className="text-xs">无数据</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">条数</Label>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger size="sm" className="h-8 w-[90px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50" className="text-xs">50</SelectItem>
              <SelectItem value="100" className="text-xs">100</SelectItem>
              <SelectItem value="200" className="text-xs">200</SelectItem>
              <SelectItem value="500" className="text-xs">500</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['data-source-fetch-logs'] })}
          disabled={isFetching}
        >
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
          )}
          刷新
        </Button>
        <div className="text-xs text-muted-foreground/70 italic ml-auto">
          共 {total} 条记录（显示前 {logs.length} 条）
        </div>
      </div>

      {/* 日志表格 */}
      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-md" />
      ) : logs.length === 0 ? (
        <div className="text-xs text-muted-foreground italic p-4 rounded-md border bg-muted/30 text-center">
          暂无拉取日志（可尝试切换状态过滤或刷新页面）
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <div className="max-h-[28rem] overflow-y-auto overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead className="h-8 text-xs whitespace-nowrap">时间</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap">数据源</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap">指标</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap">代码</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap">状态</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap text-right">行数</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap text-right">延迟</TableHead>
                  <TableHead className="h-8 text-xs whitespace-nowrap">错误信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log, idx) => {
                  const sm = FETCH_LOG_STATUS_MAP[log.status] ?? {
                    label: log.status,
                    color: 'text-muted-foreground bg-muted border-border',
                  }
                  return (
                    <TableRow key={`${log.request_id}-${idx}`}>
                      <TableCell className="py-1.5 text-xs font-mono whitespace-nowrap text-muted-foreground">
                        {formatDateTime(log.fetch_time)}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono whitespace-nowrap">
                        {log.source_id}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs whitespace-nowrap">
                        <Badge variant="outline" className="text-xs px-1 py-0 text-slate-700 bg-slate-50 border-slate-300">
                          {FIELD_LABEL_MAP[log.metric_type] || log.metric_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono whitespace-nowrap">
                        {log.code || '—'}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs whitespace-nowrap">
                        <Badge variant="outline" className={`text-xs px-1 py-0 ${sm.color}`}>
                          {sm.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono text-right whitespace-nowrap">
                        {log.row_count || '—'}
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono text-right whitespace-nowrap text-slate-600">
                        {log.latency_ms ? `${log.latency_ms}ms` : '—'}
                      </TableCell>
                      <TableCell
                        className="py-1.5 text-xs text-muted-foreground max-w-[260px] truncate"
                        title={log.error_message || ''}
                      >
                        {log.error_message || '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab 6: 数据质量结果矩阵（S5-T7） ────────────────────────────────────────

const METRIC_LABELS: Record<string, string> = {
  valuation: '估值',
  premium: '溢价',
  nav: '净值',
  dividend: '股息',
  price: '行情',
}

function getQualityBadgeClass(score: number): string {
  if (score >= 90) return 'text-emerald-700 bg-emerald-100 border-emerald-300'
  if (score >= 75) return 'text-amber-700 bg-amber-100 border-amber-300'
  if (score >= 60) return 'text-orange-700 bg-orange-100 border-orange-300'
  return 'text-red-700 bg-red-100 border-red-300'
}

function getQualityStatusText(status: string): string {
  return {
    excellent: '优秀',
    usable: '可用',
    suspicious: '可疑',
    unavailable: '不可用',
  }[status] || status
}

function DataQualityMatrixTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['data-quality-summary-matrix'],
    queryFn: getQualitySummary,
    staleTime: 60_000,
  })

  const [expandedCode, setExpandedCode] = useState<string | null>(null)

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-md" />
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        <AlertCircle className="h-4 w-4 inline-block mr-1" />
        加载质量摘要失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (!data || !data.items || data.items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic p-4 rounded-md border bg-muted/30 text-center">
        暂无质量评分记录（请先在总览页"手动刷新数据"以生成质量评分）
      </div>
    )
  }

  // 按 code 分组：每个 ETF 的 5 指标 → 最新一条 quality item
  const grouped: Record<string, Record<string, QualityScoreItem>> = {}
  for (const item of data.items) {
    const code = item.code
    if (!grouped[code]) grouped[code] = {}
    const existing = grouped[code][item.metric_type]
    if (!existing || (item.created_at || '') > (existing.created_at || '')) {
      grouped[code][item.metric_type] = item
    }
  }
  const codes = Object.keys(grouped).sort()
  const metricTypes = ['valuation', 'premium', 'nav', 'dividend', 'price']

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-200/60 bg-sky-50/30 p-2.5 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium text-sky-800">V4.1 §10.8 数据质量评分矩阵：</span>
        按 ETF × 5 指标（估值/溢价/净值/股息/行情）展示质量分 + 状态色 Badge。
        点击单元格展开看 5 子分（freshness/consistency/completeness/abnormal/sourceHealth）+ reason。
      </div>

      {/* 顶部摘要 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="rounded-md border bg-emerald-50 p-2 text-center">
          <div className="text-xs text-emerald-700">优秀 (≥90)</div>
          <div className="font-mono text-base font-bold text-emerald-700">{data.excellent}</div>
        </div>
        <div className="rounded-md border bg-amber-50 p-2 text-center">
          <div className="text-xs text-amber-700">可用 (75-89)</div>
          <div className="font-mono text-base font-bold text-amber-700">{data.usable}</div>
        </div>
        <div className="rounded-md border bg-orange-50 p-2 text-center">
          <div className="text-xs text-orange-700">可疑 (60-74)</div>
          <div className="font-mono text-base font-bold text-orange-700">{data.suspicious}</div>
        </div>
        <div className="rounded-md border bg-red-50 p-2 text-center">
          <div className="text-xs text-red-700">不可用 (&lt;60)</div>
          <div className="font-mono text-base font-bold text-red-700">{data.unavailable}</div>
        </div>
        <div className="rounded-md border bg-slate-50 p-2 text-center">
          <div className="text-xs text-slate-700">平均分</div>
          <div className="font-mono text-base font-bold text-slate-700">{data.avg_score.toFixed(1)}</div>
        </div>
      </div>

      {/* 矩阵表格 */}
      <div className="rounded-md border overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-xs whitespace-nowrap">ETF 代码</TableHead>
                {metricTypes.map((mt) => (
                  <TableHead key={mt} className="h-8 text-xs text-center whitespace-nowrap">
                    {METRIC_LABELS[mt] || mt}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((code) => {
                const isExpanded = expandedCode === code
                return (
                  <Fragment key={code}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setExpandedCode(isExpanded ? null : code)}
                    >
                      <TableCell className="py-2 text-xs font-mono whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          {isExpanded ? (
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          )}
                          {code}
                        </div>
                      </TableCell>
                      {metricTypes.map((mt) => {
                        const item = grouped[code][mt]
                        if (!item) {
                          return (
                            <TableCell key={mt} className="py-2 text-xs text-center text-muted-foreground/40">
                              —
                            </TableCell>
                          )
                        }
                        const badgeClass = getQualityBadgeClass(item.quality_score)
                        return (
                          <TableCell key={mt} className="py-2 text-xs text-center">
                            <Badge variant="outline" className={`text-xs px-1.5 py-0.5 ${badgeClass}`}>
                              {item.quality_score.toFixed(0)}
                            </Badge>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {getQualityStatusText(item.quality_status)}
                            </div>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={metricTypes.length + 1} className="py-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {metricTypes.map((mt) => {
                              const item = grouped[code][mt]
                              if (!item) return null
                              return (
                                <div key={mt} className="rounded-md border bg-card p-2 space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium">{METRIC_LABELS[mt] || mt}</span>
                                    <Badge variant="outline" className={`text-xs px-1 py-0 ${getQualityBadgeClass(item.quality_score)}`}>
                                      {item.quality_score.toFixed(0)} · {getQualityStatusText(item.quality_status)}
                                    </Badge>
                                  </div>
                                  <div className="grid grid-cols-5 gap-1 text-xs text-center">
                                    <div>
                                      <div className="text-muted-foreground/70">新鲜度</div>
                                      <div className="font-mono">{item.freshness_score.toFixed(0)}</div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground/70">一致性</div>
                                      <div className="font-mono">{item.consistency_score.toFixed(0)}</div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground/70">完整度</div>
                                      <div className="font-mono">{item.completeness_score.toFixed(0)}</div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground/70">异常</div>
                                      <div className="font-mono">{item.abnormal_score.toFixed(0)}</div>
                                    </div>
                                    <div>
                                      <div className="text-muted-foreground/70">源健康</div>
                                      <div className="font-mono">{item.source_health_score.toFixed(0)}</div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 pt-0.5">
                                    <Badge variant="outline" className={`text-xs px-1 py-0 ${item.can_use_for_rule ? 'text-emerald-700 bg-emerald-50 border-emerald-300' : 'text-red-700 bg-red-50 border-red-300'}`}>
                                      {item.can_use_for_rule ? '可用于规则' : '不可用于规则'}
                                    </Badge>
                                    <Badge variant="outline" className={`text-xs px-1 py-0 ${item.can_use_for_strong_rule ? 'text-emerald-700 bg-emerald-50 border-emerald-300' : 'text-amber-700 bg-amber-50 border-amber-300'}`}>
                                      {item.can_use_for_strong_rule ? '可用于强规则' : '不可用于强规则'}
                                    </Badge>
                                  </div>
                                  {item.reason && (
                                    <div className="text-xs text-muted-foreground italic pt-0.5 border-t">
                                      {item.reason}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground/70 italic">
        <Info className="h-3 w-3" />
        <span>点击 ETF 行展开查看 5 子分（freshness/consistency/completeness/abnormal/sourceHealth）+ reason + can_use_for_rule</span>
      </div>
    </div>
  )
}


// ─── Section 5b: Data Quality Config (V4 PRD§9.4) ─────────────────────────────

function DataQualityConfigSection() {
  // V4 策略书§3.2 样本天数阈值 + §5.4 缓存过期 + §4.4 主备源差异 + §5.2 异常值过滤
  const sampleDayThresholds = [
    { label: '可参与5年分位规则', value: '≥ 1000 交易日', color: 'text-emerald-700 bg-emerald-50' },
    { label: '展示但标记"样本不足"', value: '500 ~ 999 交易日', color: 'text-amber-700 bg-amber-50' },
    { label: '不参与强规则', value: '< 500 交易日', color: 'text-orange-700 bg-orange-50' },
  ]

  const staleThresholds = [
    { label: 'A股收盘价', red: '非最新交易日', yellow: '超2交易日', rule: '§5.4' },
    { label: 'QDII净值', red: '—', yellow: '超2交易日', rule: '§5.4' },
    { label: '溢价率', red: '当日缺失', yellow: '—', rule: '§5.4' },
    { label: '股息率', red: '—', yellow: '超7交易日', rule: '§5.4' },
  ]

  const outlierThresholds = [
    { label: 'PE', range: '≤ 0 或 ≥ 500', rule: '§5.2' },
    { label: 'PB', range: '≤ 0 或 ≥ 100', rule: '§5.2' },
    { label: '溢价率', range: '|值| > 30%', rule: '§5.2' },
    { label: '股息率', range: '< 0 或 > 20%', rule: '§5.2' },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldMinus className="h-4 w-4 text-amber-600" />
          数据质量规则配置
        </CardTitle>
        <CardDescription className="text-xs">
          样本天数阈值、缓存过期阈值、异常值过滤等（策略书§3.2/§4.4/§5.2/§5.4）
          <span className="block mt-1 text-amber-600/80">⚠ 当前为系统预设阈值（策略书定义），只读展示。规则引擎严格按这些阈值执行数据质量判断。</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 关键数据缺失处理方式（MVP默认保守） */}
        <div className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
            <ShieldAlert className="h-3.5 w-3.5" />
            关键数据缺失处理方式
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-400 bg-emerald-100">
              ✓ 保守策略（默认）
            </Badge>
            <span className="text-xs text-muted-foreground">
              不自动买入、不自动再平衡，提示人工确认
            </span>
          </div>
          <div className="text-xs text-muted-foreground/60 italic">
            未来可选"中性"策略（忽略规则仅提示风险），MVP 阶段只实现保守策略
          </div>
        </div>

        {/* 样本天数阈值（策略书§3.2） */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span>样本天数阈值</span>
            <Badge variant="outline" className="text-xs px-1 py-0 text-muted-foreground">策略书§3.2</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
            {sampleDayThresholds.map((t) => (
              <div key={t.label} className={`rounded-md border px-2 py-1.5 ${t.color}`}>
                <div className="text-xs font-medium">{t.label}</div>
                <div className="font-mono text-xs font-bold">{t.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 缓存过期阈值（策略书§5.4） */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span>缓存过期阈值</span>
            <Badge variant="outline" className="text-xs px-1 py-0 text-muted-foreground">策略书§5.4</Badge>
          </div>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-7 text-xs">数据类型</TableHead>
                  <TableHead className="h-7 text-xs text-center w-[100px]">🔴 标红</TableHead>
                  <TableHead className="h-7 text-xs text-center w-[100px]">🟡 标黄</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staleThresholds.map((t) => (
                  <TableRow key={t.label}>
                    <TableCell className="py-1 text-xs">{t.label}</TableCell>
                    <TableCell className="py-1 text-xs text-center font-mono text-red-600">{t.red}</TableCell>
                    <TableCell className="py-1 text-xs text-center font-mono text-amber-600">{t.yellow}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* 异常值过滤阈值（策略书§5.2） */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span>异常值过滤阈值</span>
            <Badge variant="outline" className="text-xs px-1 py-0 text-muted-foreground">策略书§5.2</Badge>
          </div>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-7 text-xs">指标</TableHead>
                  <TableHead className="h-7 text-xs text-right">异常范围</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outlierThresholds.map((t) => (
                  <TableRow key={t.label}>
                    <TableCell className="py-1 text-xs">{t.label}</TableCell>
                    <TableCell className="py-1 text-xs text-right font-mono text-red-600">{t.range}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground/70 italic">
            异常值处理：raw_value 保留原始值，clean_value 置 null，is_valid=false，记录 abnormal_reason
          </p>
        </div>

        {/* 主备源差异阈值已在数据源配置模块展示，这里加链接说明 */}
        <div className="text-xs text-muted-foreground/60 italic border-t pt-2">
          主备源差异容忍阈值见上方「数据源配置」模块（策略书§4.4）
        </div>
      </CardContent>
    </Card>
  )
}


// ─── Section 5c: Cash Pool Config (V4 PRD§9.5) ───────────────────────────────

function CashPoolConfigSection({ configs }: { configs: SystemConfig[] }) {
  const queryClient = useQueryClient()
  const [isSaving, setIsSaving] = useState(false)

  // 读取配置（带默认值）
  const poolCode = configs.find(c => c.key === 'cash_pool_code')?.value || '511990'
  const autoUnallocated = configs.find(c => c.key === 'cash_pool_auto_unallocated')?.value !== 'false'
  const autoRebalance = configs.find(c => c.key === 'cash_pool_auto_rebalance')?.value !== 'false'
  const warningThreshold = parseInt(configs.find(c => c.key === 'cash_pool_warning_threshold')?.value || '20', 10)
  const strongThreshold = parseInt(configs.find(c => c.key === 'cash_pool_strong_threshold')?.value || '30', 10)

  const [localPoolCode, setLocalPoolCode] = useState(poolCode)
  const [localAutoUnallocated, setLocalAutoUnallocated] = useState(autoUnallocated)
  const [localAutoRebalance, setLocalAutoRebalance] = useState(autoRebalance)
  const [localWarning, setLocalWarning] = useState(warningThreshold)
  const [localStrong, setLocalStrong] = useState(strongThreshold)

  const updateMutation = useMutation({
    mutationFn: async (items: Array<{ key: string; value: string }>) => {
      const results = await Promise.all(
        items.map(item =>
          fetch('/api/system', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
          })
        )
      )
      if (results.some(r => !r.ok)) throw new Error('Failed to save')
      return true
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-configs'] })
      toast.success('现金水池配置已保存')
    },
    onError: () => toast.error('保存失败，请重试'),
  })

  const handleSave = () => {
    if (localWarning >= localStrong) {
      toast.error('强提醒阈值必须大于提醒阈值')
      return
    }
    setIsSaving(true)
    updateMutation.mutate(
      [
        { key: 'cash_pool_code', value: localPoolCode },
        { key: 'cash_pool_auto_unallocated', value: String(localAutoUnallocated) },
        { key: 'cash_pool_auto_rebalance', value: String(localAutoRebalance) },
        { key: 'cash_pool_warning_threshold', value: String(localWarning) },
        { key: 'cash_pool_strong_threshold', value: String(localStrong) },
      ],
      { onSettled: () => setIsSaving(false) }
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-sky-600" />
          现金水池配置
        </CardTitle>
        <CardDescription className="text-xs">
          华宝添益承接未投资资金和再平衡释放资金（策略书§8）。现金占比过高会产生现金拖累提醒。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 现金水池标的 */}
        <div className="space-y-1.5">
          <Label className="text-xs">现金水池标的</Label>
          <div className="flex items-center gap-2">
            <Input
              value={localPoolCode}
              onChange={(e) => setLocalPoolCode(e.target.value)}
              className="font-mono text-sm w-32"
              placeholder="511990"
            />
            <Badge variant="outline" className="text-xs text-sky-700 border-sky-300 bg-sky-50">
              默认: 511990 华宝添益ETF
            </Badge>
          </div>
        </div>

        {/* 自动转入开关 */}
        <div className="space-y-2">
          <Label className="text-xs">资金自动转入</Label>
          <div className="flex flex-col gap-2 rounded-md border p-2.5 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Switch
                  checked={localAutoUnallocated}
                  onCheckedChange={setLocalAutoUnallocated}
                />
                <span className="text-xs">未投资资金自动转入现金水池</span>
              </div>
              <span className={`text-xs font-mono ${localAutoUnallocated ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {localAutoUnallocated ? '✓ 启用' : '✗ 停用'}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Switch
                  checked={localAutoRebalance}
                  onCheckedChange={setLocalAutoRebalance}
                />
                <span className="text-xs">再平衡释放资金自动转入现金水池</span>
              </div>
              <span className={`text-xs font-mono ${localAutoRebalance ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                {localAutoRebalance ? '✓ 启用' : '✗ 停用'}
              </span>
            </div>
          </div>
        </div>

        {/* 现金占比提醒阈值 */}
        <div className="space-y-1.5">
          <Label className="text-xs">现金占比提醒阈值</Label>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-amber-200 bg-amber-50/40 p-2.5">
              <div className="text-xs text-amber-700 mb-1">提醒阈值</div>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={localWarning}
                  onChange={(e) => setLocalWarning(parseInt(e.target.value) || 0)}
                  className="font-mono text-sm h-8 w-20"
                />
                <span className="text-xs text-amber-700">%</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">华宝添益占总资产 &gt; {localWarning}% 提醒</div>
            </div>
            <div className="rounded-md border border-red-200 bg-red-50/40 p-2.5">
              <div className="text-xs text-red-700 mb-1">强提醒阈值</div>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={localStrong}
                  onChange={(e) => setLocalStrong(parseInt(e.target.value) || 0)}
                  className="font-mono text-sm h-8 w-20"
                />
                <span className="text-xs text-red-700">%</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">&gt; {localStrong}% 强提醒可能现金拖累</div>
            </div>
          </div>
        </div>

        {/* 保存按钮 */}
        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            保存配置
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}


// ─── Section 5d: Notify Config (V4 PRD§16 P2: 推送通知) ──────────────────────

function NotifyConfigSection({ configs }: { configs: SystemConfig[] }) {
  const queryClient = useQueryClient()
  const [webhookUrl, setWebhookUrl] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const savedUrl = configs.find(c => c.key === 'notify_webhook_url')?.value || ''
  const savedEnabled = configs.find(c => c.key === 'notify_enabled')?.value === 'true'

  const saveMutation = useMutation({
    mutationFn: async (items: Array<{ key: string; value: string }>) => {
      await Promise.all(items.map(item =>
        fetch('/api/system', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) })
      ))
    },
    onSuccess: () => {
      toast.success('通知配置已保存')
      queryClient.invalidateQueries({ queryKey: ['system-configs'] })
    },
    onError: () => toast.error('保存失败'),
  })

  const handleSave = () => {
    setSaving(true)
    saveMutation.mutate(
      [
        { key: 'notify_webhook_url', value: webhookUrl || savedUrl },
        { key: 'notify_enabled', value: String(enabled) },
      ],
      { onSettled: () => setSaving(false) }
    )
  }

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test', message: '🔔 这是一条测试通知，ETF定投助手通知功能已启用。' }),
      })
      return res.json()
    },
    onMutate: () => setTesting(true),
    onSuccess: (data) => {
      if (data.success) toast.success('测试通知发送成功')
      else toast.error(data.message || '发送失败')
    },
    onError: () => toast.error('测试请求失败'),
    onSettled: () => setTesting(false),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4 text-violet-600" />
          推送通知配置
        </CardTitle>
        <CardDescription className="text-xs">
          生成建议后自动推送到企业微信/钉钉/飞书（PRD§16 P2）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-2.5 bg-muted/20">
          <div className="flex items-center gap-2">
            <Switch checked={enabled || savedEnabled} onCheckedChange={setEnabled} />
            <span className="text-xs">启用推送通知</span>
          </div>
          <span className={`text-xs font-mono ${(enabled || savedEnabled) ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            {(enabled || savedEnabled) ? '✓ 启用' : '✗ 停用'}
          </span>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Webhook URL</Label>
          <Input
            value={webhookUrl || savedUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
            className="font-mono text-xs h-8"
          />
          <p className="text-xs text-muted-foreground">
            支持企业微信、钉钉、飞书的群机器人 Webhook 地址
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleSave} disabled={saving} className="h-8">
            {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
            保存配置
          </Button>
          {(enabled || savedEnabled) && (webhookUrl || savedUrl) && (
            <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testing} className="h-8">
              {testing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Activity className="h-3 w-3 mr-1" />}
              发送测试通知
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}


function BlacklistSection({ configs }: { configs: EtfConfig[] }) {
  const queryClient = useQueryClient()
  const blacklisted = configs.filter(c => c.isBlacklisted)

  const [addCode, setAddCode] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const updateMutation = useMutation({
    mutationFn: async (items: { code: string; isBlacklisted: boolean }[]) => {
      const res = await fetch('/api/etf', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
      })
      if (!res.ok) throw new Error('Failed to update blacklist')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['etf-configs'] })
      toast.success('黑名单已更新')
    },
    onError: () => {
      toast.error('更新失败，请重试')
    },
  })

  const handleRemoveFromBlacklist = (code: string) => {
    setIsSaving(true)
    updateMutation.mutate(
      [{ code, isBlacklisted: false }],
      { onSettled: () => setIsSaving(false) }
    )
  }

  // §9.A5: Auto-lookup name from etfConfigs list while the user types.
  const trimmedCode = addCode.trim()
  const lookupConfig = trimmedCode
    ? configs.find(c => c.code === trimmedCode)
    : undefined
  const isAlreadyBlacklisted = !!lookupConfig?.isBlacklisted
  const isInvestmentTarget = !!lookupConfig?.isInvestmentTarget

  const handleAddToBlacklist = () => {
    if (!trimmedCode) {
      toast.error('请输入ETF代码')
      return
    }
    if (!lookupConfig) {
      toast.error('未找到该ETF代码')
      return
    }
    if (isAlreadyBlacklisted) {
      toast.error('该ETF已在黑名单中')
      return
    }
    setIsSaving(true)
    updateMutation.mutate(
      [{ code: trimmedCode, isBlacklisted: true }],
      {
        onSettled: () => setIsSaving(false),
        onSuccess: () => setAddCode(''),
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Ban className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">黑名单管理</CardTitle>
        </div>
        <CardDescription className="text-xs">管理被排除在定投范围外的ETF标的</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {blacklisted.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">暂无黑名单标的</p>
        ) : (
          <div className="space-y-3">
            {blacklisted.map(etf => (
              <div
                key={etf.id}
                className="flex items-center justify-between rounded-lg border p-3 gap-2 flex-wrap"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Badge variant="destructive">黑名单</Badge>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1">
                      <span className="text-sm font-medium truncate">{etf.name}</span>
                      <span className="text-sm text-muted-foreground">({etf.code})</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Info className="size-3 shrink-0" />
                      <span>已加入黑名单，不参与定投建议</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemoveFromBlacklist(etf.code)}
                    disabled={isSaving}
                  >
                    移除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Separator />

        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-2">
          <div className="space-y-2 flex-1 w-full sm:w-auto">
            <Label htmlFor="add-blacklist">添加ETF到黑名单</Label>
            <div className="flex items-center gap-2">
              <Input
                id="add-blacklist"
                placeholder="输入ETF代码，如 518880"
                value={addCode}
                onChange={(e) => setAddCode(e.target.value)}
                className="max-w-[200px]"
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddToBlacklist() }}
              />
              <Button onClick={handleAddToBlacklist} disabled={isSaving} size="sm">
                <Plus className="size-4" />
                添加
              </Button>
            </div>
            {/* §9.A5: live lookup hint */}
            {trimmedCode && (
              <div className="text-xs">
                {lookupConfig ? (
                  <span className="text-muted-foreground">
                    → {lookupConfig.name}
                    {isAlreadyBlacklisted && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">（已在黑名单）</span>
                    )}
                    {isInvestmentTarget && !isAlreadyBlacklisted && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">（当前为定投标的）</span>
                    )}
                  </span>
                ) : (
                  <span className="text-red-600 dark:text-red-400">
                    未知代码：未在ETF配置中找到 {trimmedCode}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SettingsTab() {
  const {
    data: etfConfigs = [],
    isLoading: etfLoading,
    error: etfError,
  } = useQuery({
    queryKey: ['etf-configs'],
    queryFn: fetchEtfConfigs,
  })

  const {
    data: rules = [],
    isLoading: rulesLoading,
    error: rulesError,
  } = useQuery({
    queryKey: ['rules'],
    queryFn: fetchRules,
  })

  const {
    data: systemConfigs = [],
    isLoading: systemLoading,
    error: systemError,
  } = useQuery({
    queryKey: ['system-configs'],
    queryFn: fetchSystemConfigs,
  })

  // Build ETF code→name map for rule scope display
  const etfMap: Record<string, string> = {}
  etfConfigs.forEach(c => {
    etfMap[c.code] = c.name
  })

  const isLoading = etfLoading || rulesLoading || systemLoading

  if (etfError || rulesError || systemError) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8">
            <div className="flex items-center gap-2 text-destructive justify-center">
              <XCircle className="size-5" />
              <span>加载设置数据失败，请刷新页面重试</span>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-[300px] w-full rounded-xl" />
        <Skeleton className="h-[120px] w-full rounded-xl" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
        <Skeleton className="h-[200px] w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <SettingsSectionNav />
      <div id="section-target" className="scroll-mt-32">
        <TargetAllocationSection configs={etfConfigs} />
      </div>
      <div id="section-budget" className="scroll-mt-32">
        <WeeklyBudgetSection configs={systemConfigs} />
      </div>
      <div id="section-rules" className="scroll-mt-32">
        <RuleManagementSection rules={rules} etfMap={etfMap} />
      </div>
      <div id="section-blacklist" className="scroll-mt-32">
        <BlacklistSection configs={etfConfigs} />
      </div>
      <div id="section-datasource" className="scroll-mt-32">
        <DataSourceSection />
      </div>
      <div id="section-quality" className="scroll-mt-32">
        <DataQualityConfigSection />
      </div>
      <div id="section-cashpool" className="scroll-mt-32">
        <CashPoolConfigSection configs={systemConfigs} />
      </div>
      <div id="section-notify" className="scroll-mt-32">
        <NotifyConfigSection configs={systemConfigs} />
      </div>
      <div id="section-admin" className="scroll-mt-32">
        <AdminSection />
      </div>
    </div>
  )
}

// ─── V4.2 P5-B: Settings page section navigation (sticky anchor bar) ────────

const SETTINGS_SECTION_DEFS: Array<{ id: string; label: string }> = [
  { id: 'section-target', label: '目标配置' },
  { id: 'section-budget', label: '定投额度' },
  { id: 'section-rules', label: '规则管理' },
  { id: 'section-blacklist', label: '黑名单' },
  { id: 'section-datasource', label: '数据源管理' },
  { id: 'section-quality', label: '数据质量' },
  { id: 'section-cashpool', label: '现金水池' },
  { id: 'section-notify', label: '通知' },
  { id: 'section-admin', label: '后台管理' },
]

function SettingsSectionNav() {
  const handleJump = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }
  return (
    <div className="sticky top-14 z-40 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-background/95 backdrop-blur border-b shadow-sm">
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
        {SETTINGS_SECTION_DEFS.map((s) => (
          <Button
            key={s.id}
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 h-8 px-3 text-xs text-muted-foreground hover:text-foreground pointer-events-auto"
            onClick={() => handleJump(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

// ─── V4.2 P6-C: Admin Section — 后台管理面板 ────────────────────────────────
// 双库表行数可视化 + 表数据查看 + 危险操作(清空缓存)二次确认 + 业务数据导出 + 服务状态

const ADMIN_SAFE_CLEAR_TABLES = new Set([
  'market_data_cache',
  'market_data_raw',
  'market_data_clean',
  'data_quality_result',
  'source_compare_result',
  'cross_check_log',
  'data_fetch_log',
  'macro_metric_cache',
  'macro_prompt_log',
])

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

function formatLastUpdate(s: string): string {
  if (!s) return '—'
  // 截断到秒, 太长截短
  const trimmed = s.length > 19 ? s.slice(0, 19) : s
  return trimmed.replace('T', ' ')
}

function AdminSection() {
  const queryClient = useQueryClient()
  const [tableDialog, setTableDialog] = useState<{ db: string; table: string } | null>(null)
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<Record<string, unknown> | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 拉取双库表统计
  const { data: dbStats, isLoading, refetch } = useQuery<DbStats>({
    queryKey: ['admin-db-stats'],
    queryFn: getDbStats,
  })

  // 查看表数据
  const { data: tableData, isLoading: tableLoading } = useQuery<TableData>({
    queryKey: ['admin-table-data', tableDialog?.db, tableDialog?.table],
    queryFn: () => getTableData(tableDialog!.db, tableDialog!.table, 100),
    enabled: !!tableDialog,
  })

  // 清空单表
  const clearTableMutation = useMutation({
    mutationFn: ({ db, table }: { db: string; table: string }) => clearTable(db, table),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`已清空 ${data.table || ''}，删除 ${data.deleted_rows ?? 0} 行`)
        queryClient.invalidateQueries({ queryKey: ['admin-db-stats'] })
      } else {
        toast.error(data.error || '清空失败')
      }
    },
    onError: (err: Error) => toast.error(err.message || '清空请求失败，数据服务可能未启动'),
  })

  // 一键清空所有市场缓存
  const resetCacheMutation = useMutation({
    mutationFn: () => resetCache(),
    onSuccess: (data) => {
      if (data.success) {
        const totalDeleted = (data.cleared || []).reduce(
          (sum, t) => sum + (t.deleted ?? 0),
          0
        )
        toast.success(`已清空 ${data.cleared?.length ?? 0} 张表，共删除 ${totalDeleted} 行`)
        queryClient.invalidateQueries({ queryKey: ['admin-db-stats'] })
      } else {
        toast.error('清空缓存失败')
      }
    },
    onError: (err: Error) => toast.error(err.message || '清空缓存请求失败，数据服务可能未启动'),
  })

  // 重新计算质量评分(复用 P5-C API)
  const recomputeMutation = useMutation({
    mutationFn: () => recomputeQuality(),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`质量评分已重算：${data.total_metrics} 指标，平均分 ${data.avg_score.toFixed(1)}`)
      } else {
        toast.error('质量评分重算失败')
      }
    },
    onError: (err: Error) => toast.error(err.message || '质量评分重算请求失败，数据服务可能未启动'),
  })

  // 导出业务数据为 JSON 文件
  const handleExport = async () => {
    setExporting(true)
    try {
      const result = await exportBusinessData()
      const blob = new Blob([JSON.stringify(result, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      a.download = `etf-business-backup-${ts}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('业务数据已导出为 JSON 文件')
    } catch {
      toast.error('导出失败，请重试')
    } finally {
      setExporting(false)
    }
  }

  // 查看服务状态
  const handleViewStatus = async () => {
    setStatusLoading(true)
    setStatusDialogOpen(true)
    try {
      const data = await getServiceStatus()
      setServiceStatus(data)
    } catch {
      setServiceStatus({ error: '获取服务状态失败' })
    } finally {
      setStatusLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4 text-rose-600" />
              后台管理
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              查看/维护两个数据库（业务库 + 市场库）。危险操作需二次确认，业务核心表禁止清空。
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            刷新统计
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 4 个操作按钮 */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => recomputeMutation.mutate()}
            disabled={recomputeMutation.isPending}
          >
            {recomputeMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5 mr-1" />
            )}
            重新计算质量评分
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1" />
            )}
            导出业务数据
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={handleViewStatus}
          >
            <Server className="h-3.5 w-3.5 mr-1" />
            查看服务状态
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-8"
            onClick={() => setResetDialogOpen(true)}
            disabled={resetCacheMutation.isPending}
          >
            {resetCacheMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
            )}
            清空市场缓存
          </Button>
        </div>

        {/* 双库表统计 */}
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-32 w-full rounded-md" />
            <Skeleton className="h-48 w-full rounded-md" />
          </div>
        ) : dbStats ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DbTableCard
              title="业务数据库"
              subtitle="Prisma custom.db · 配置/持仓/规则/系统配置"
              fileBytes={dbStats.business.file_size}
              tables={dbStats.business.tables}
              dbKey="business"
              onView={(table) => setTableDialog({ db: 'business', table })}
            />
            <DbTableCard
              title="市场数据库"
              subtitle="market_data.db · 行情缓存/原始/清洗/质量/宏观"
              fileBytes={dbStats.market.file_size}
              tables={dbStats.market.tables}
              dbKey="market"
              onView={(table) => setTableDialog({ db: 'market', table })}
              onClear={(table) => clearTableMutation.mutate({ db: 'market', table })}
              clearPending={clearTableMutation.isPending}
            />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-6 text-center">
            暂无数据，点击「刷新统计」重试
          </div>
        )}
      </CardContent>

      {/* 表数据查看 Dialog */}
      <Dialog
        open={!!tableDialog}
        onOpenChange={(open) => !open && setTableDialog(null)}
      >
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" />
              {tableDialog?.db === 'business' ? '业务库' : '市场库'} · {tableDialog?.table}
            </DialogTitle>
            <DialogDescription className="text-xs">
              展示前 100 行数据（只读）。完整数据请直接查询 SQLite 文件。
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto max-h-[60vh] rounded-md border">
            {tableLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : tableData?.error ? (
              <div className="p-4 text-sm text-red-600 dark:text-red-400">
                加载失败：{tableData.error}
              </div>
            ) : tableData && tableData.rows.length > 0 ? (
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur z-10">
                  <TableRow>
                    {tableData.columns.map((col) => (
                      <TableHead key={col} className="text-xs whitespace-nowrap">
                        {col}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableData.rows.map((row, idx) => (
                    <TableRow key={idx}>
                      {tableData.columns.map((col) => {
                        const v = (row as Record<string, unknown>)[col]
                        const display =
                          v === null || v === undefined
                            ? '—'
                            : typeof v === 'object'
                              ? JSON.stringify(v).slice(0, 80) +
                                (JSON.stringify(v).length > 80 ? '…' : '')
                              : String(v)
                        return (
                          <TableCell
                            key={col}
                            className="text-xs whitespace-nowrap font-mono max-w-[260px] truncate"
                            title={display}
                          >
                            {display}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-4 text-sm text-muted-foreground text-center">
                表为空或无数据
              </div>
            )}
          </div>
          <DialogFooter className="text-xs text-muted-foreground">
            共 {tableData?.count ?? 0} 行 · {tableData?.columns.length ?? 0} 列
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 服务状态 Dialog */}
      <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />
              服务状态
            </DialogTitle>
            <DialogDescription className="text-xs">
              data-service 进程信息 + 数据库大小 + 系统指标
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto max-h-[55vh] rounded-md border bg-muted/30 p-3">
            {statusLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : serviceStatus ? (
              <pre className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                {JSON.stringify(serviceStatus, null, 2)}
              </pre>
            ) : (
              <div className="text-sm text-muted-foreground">无数据</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 清空所有市场缓存 AlertDialog (危险操作二次确认) */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              确认清空所有市场数据缓存？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs space-y-2">
              <span className="block">
                此操作将清空以下 9 张市场表的所有数据，<b className="text-red-600">不可恢复</b>：
              </span>
              <span className="block font-mono text-xs leading-relaxed">
                market_data_cache / market_data_raw / market_data_clean /
                data_quality_result / source_compare_result / cross_check_log /
                data_fetch_log / macro_metric_cache / macro_prompt_log
              </span>
              <span className="block">
                业务库（etf_config / holding_snapshot / rule_config / system_config）<b>不受影响</b>。
                清空后需要重新触发行情/宏观数据采集。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetCacheMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={resetCacheMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                resetCacheMutation.mutate(undefined, {
                  onSettled: () => setResetDialogOpen(false),
                })
              }}
            >
              {resetCacheMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

// 双库表卡片
function DbTableCard({
  title,
  subtitle,
  fileBytes,
  tables,
  dbKey,
  onView,
  onClear,
  clearPending,
}: {
  title: string
  subtitle: string
  fileBytes: number
  tables: DbTableInfo[]
  dbKey: 'business' | 'market'
  onView: (table: string) => void
  onClear?: (table: string) => void
  clearPending?: boolean
}) {
  const totalRows = tables.reduce((sum, t) => sum + (t.rows > 0 ? t.rows : 0), 0)
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-3 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{title}</span>
          <Badge variant="outline" className="text-xs ml-auto">
            {formatBytes(fileBytes)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        <div className="text-xs text-muted-foreground mt-1">
          共 {tables.length} 张表 · {totalRows.toLocaleString()} 行
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto p-1.5">
        {tables.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-6">无表</div>
        ) : (
          <ul className="space-y-1">
            {tables.map((t) => {
              const isClearable = dbKey === 'market' && ADMIN_SAFE_CLEAR_TABLES.has(t.name)
              return (
                <li
                  key={t.name}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 group"
                >
                  <Database className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono truncate flex-1 min-w-0" title={t.name}>
                    {t.name}
                  </span>
                  <Badge
                    variant="secondary"
                    className="text-xs font-mono shrink-0 tabular-nums"
                  >
                    {t.rows.toLocaleString()} 行
                  </Badge>
                  <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline w-[140px] text-right tabular-nums">
                    {formatLastUpdate(t.last_update)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs shrink-0"
                    onClick={() => onView(t.name)}
                  >
                    <Eye className="h-3 w-3 mr-0.5" />
                    查看
                  </Button>
                  {isClearable && onClear && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
                      onClick={() => onClear(t.name)}
                      disabled={clearPending}
                    >
                      <Trash2 className="h-3 w-3 mr-0.5" />
                      清空
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

