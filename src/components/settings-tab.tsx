'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  GitBranch,
  Wallet,
  ListChecks,
  Landmark,
  Database,
  Cpu,
  Plus,
  Pencil,
  Trash2,
  Play,
  Save,
  Loader2,
  RefreshCw,
  ArrowRightLeft,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  CircleDot,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type {
  StrategyVersionDisplay,
  EtfConfigWithSnapshot,
  RuleConfigDisplay,
  CashAccountDisplay,
  SystemConfigMap,
  CashAccountType,
  StrategyStatus,
  ApiResponse,
} from '@/lib/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const CASH_ACCOUNT_TYPES: CashAccountType[] = [
  'daily_cash',
  'weekly_unallocated_cash',
  'rebalance_equity_reserve',
  'qdii_pending_cash_sp500',
  'qdii_pending_cash_nasdaq',
  'manual_cash',
  'weekly_contribution_committed',
];

const ACCOUNT_LABELS: Record<CashAccountType, string> = {
  daily_cash: '日常现金',
  weekly_unallocated_cash: '未分配权益现金',
  rebalance_equity_reserve: '再平衡备用金',
  qdii_pending_cash_sp500: 'S&P 500 挂起资金',
  qdii_pending_cash_nasdaq: '纳斯达克 挂起资金',
  manual_cash: '手动指定现金',
  weekly_contribution_committed: '本周承诺注资',
};

const ACCOUNT_TYPE_COLORS: Record<CashAccountType, string> = {
  daily_cash: 'bg-slate-500',
  weekly_unallocated_cash: 'bg-emerald-500',
  rebalance_equity_reserve: 'bg-teal-500',
  qdii_pending_cash_sp500: 'bg-violet-500',
  qdii_pending_cash_nasdaq: 'bg-fuchsia-500',
  manual_cash: 'bg-amber-500',
  weekly_contribution_committed: 'bg-cyan-500',
};

const CATEGORY_COLORS: Record<string, string> = {
  'A股宽基': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  红利: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  QDII: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

const ETF_BAR_COLORS: Record<string, string> = {
  '510300': 'bg-emerald-500',
  '510500': 'bg-teal-500',
  '159915': 'bg-cyan-500',
  '513300': 'bg-violet-500',
  '513500': 'bg-fuchsia-500',
  '159905': 'bg-amber-500',
};

const RULE_GROUP_LABELS: Record<string, string> = {
  buy_rules: '买入规则',
  pause_rules: '暂停规则',
  rebalance_rules: '再平衡规则',
  data_quality_rules: '数据质量规则',
};

const STATUS_STYLES: Record<StrategyStatus, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  retired: 'bg-stone-100 text-stone-500 dark:bg-stone-900/30 dark:text-stone-500',
};

const STATUS_LABELS: Record<StrategyStatus, string> = {
  active: '活跃',
  draft: '草稿',
  retired: '已退役',
};

const MOCK_DATA_SOURCES = [
  { name: '东方财富', type: '网页采集', status: 'active', quality: 92, isPrimary: true },
  { name: '天天基金', type: 'API', status: 'active', quality: 88, isPrimary: false },
  { name: '新浪财经', type: '网页采集', status: 'degraded', quality: 65, isPrimary: false },
  { name: 'Wind 金融终端', type: 'API', status: 'inactive', quality: 0, isPrimary: false },
  { name: '聚宽', type: 'API', status: 'inactive', quality: 0, isPrimary: false },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(yuan: number | null | undefined): string {
  if (yuan == null || isNaN(yuan)) return '¥0.00';
  return '¥' + Math.abs(yuan).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

function percentToBps(pct: number): number {
  return Math.round(pct * 10000);
}

// ─── Query Keys ───────────────────────────────────────────────────────────────

const QK = {
  strategyVersions: ['strategy-versions'] as const,
  etfConfigs: ['etf-configs'] as const,
  systemConfigs: ['system-configs'] as const,
  ruleConfigs: ['rule-configs'] as const,
  cashAccounts: ['cash-accounts'] as const,
};

// ─── Section 1: Strategy Version Management ───────────────────────────────────

function StrategyVersionSection() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [activateTarget, setActivateTarget] = useState<StrategyVersionDisplay | null>(null);

  // Form state
  const [newVersion, setNewVersion] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newParams, setNewParams] = useState('');

  const { data: versionsRes, isLoading } = useQuery({
    queryKey: QK.strategyVersions,
    queryFn: () => fetch('/api/strategy-versions').then(r => r.json()) as Promise<ApiResponse<StrategyVersionDisplay[]>>,
  });

  const versions = versionsRes?.data ?? [];

  const activeVersion = useMemo(() => versions.find(v => v.status === 'active'), [versions]);

  const createMutation = useMutation({
    mutationFn: async (body: { version: string; parameters: Record<string, unknown>; createdReason?: string }) => {
      const res = await fetch('/api/strategy-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) {
        toast.success('策略版本已创建为草稿');
        setCreateOpen(false);
        setNewVersion('');
        setNewReason('');
        setNewParams('');
        queryClient.invalidateQueries({ queryKey: QK.strategyVersions });
      } else {
        toast.error(res.error ?? '创建失败');
      }
    },
    onError: () => toast.error('创建策略版本失败'),
  });

  const activateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch('/api/strategy-versions/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) {
        toast.success('策略版本已激活，旧版本已退役');
        setActivateTarget(null);
        queryClient.invalidateQueries({ queryKey: QK.strategyVersions });
      } else {
        toast.error(res.error ?? '激活失败');
      }
    },
    onError: () => toast.error('激活策略版本失败'),
  });

  const handleOpenCreate = () => {
    if (activeVersion) {
      setNewParams(JSON.stringify(activeVersion.parameters, null, 2));
    } else {
      setNewParams('{}');
    }
    setCreateOpen(true);
  };

  const handleCreate = () => {
    if (!newVersion.trim()) { toast.error('请输入版本名称'); return; }
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(newParams);
    } catch {
      toast.error('参数 JSON 格式无效');
      return;
    }
    createMutation.mutate({ version: newVersion.trim(), parameters: params, createdReason: newReason.trim() || undefined });
  };

  // Target ratios for bar chart
  const targetRatios = useMemo(() => {
    if (!activeVersion?.parameters?.target_ratios) return [];
    const ratios = activeVersion.parameters.target_ratios as Record<string, number>;
    return Object.entries(ratios).map(([code, bps]) => ({
      code,
      bps,
      percent: bps / 10000,
    })).sort((a, b) => b.bps - a.bps);
  }, [activeVersion]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>策略版本与目标配置</CardTitle>
          <CardDescription>管理策略版本，配置目标配比，激活或退役版本</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-5 text-emerald-600" />
          策略版本与目标配置
        </CardTitle>
        <CardDescription>管理策略版本，配置目标配比，激活或退役版本</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Active Version */}
        {activeVersion && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <span className="text-lg font-bold">{activeVersion.version}</span>
              <Badge className={STATUS_STYLES[activeVersion.status]}>{STATUS_LABELS[activeVersion.status]}</Badge>
              <span className="text-sm text-muted-foreground">生效于 {formatDateTime(activeVersion.effectiveAt)}</span>
            </div>

            {/* Target Ratios Bar Chart */}
            {targetRatios.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">目标配比</p>
                <div className="flex h-8 w-full overflow-hidden rounded-md">
                  {targetRatios.map((r) => (
                    <div
                      key={r.code}
                      className={`${ETF_BAR_COLORS[r.code] ?? 'bg-gray-400'} flex items-center justify-center text-[10px] font-bold text-white transition-all`}
                      style={{ width: `${r.percent}%` }}
                      title={`${r.code}: ${r.percent.toFixed(1)}%`}
                    >
                      {r.percent >= 8 ? `${r.code} ${r.percent.toFixed(1)}%` : ''}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {targetRatios.map((r) => (
                    <div key={r.code} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`inline-block size-2.5 rounded-sm ${ETF_BAR_COLORS[r.code] ?? 'bg-gray-400'}`} />
                      {r.code} {r.percent.toFixed(1)}%
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!activeVersion && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 text-center text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-400">
            <AlertTriangle className="mx-auto mb-1 size-5" />
            暂无活跃策略版本，请创建并激活一个版本
          </div>
        )}

        <Separator />

        {/* Version Table */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">版本列表</h3>
            <Button size="sm" className="gap-1.5" onClick={handleOpenCreate}>
              <Plus className="size-3.5" /> 创建新版本
            </Button>
          </div>
          <ScrollArea className="max-h-72">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">版本</TableHead>
                  <TableHead className="w-[80px]">状态</TableHead>
                  <TableHead>生效时间</TableHead>
                  <TableHead>创建原因</TableHead>
                  <TableHead className="w-[100px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">暂无策略版本</TableCell></TableRow>
                )}
                {versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">{v.version}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_STYLES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDateTime(v.effectiveAt)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{v.createdReason || '—'}</TableCell>
                    <TableCell className="text-right">
                      {v.status === 'draft' && (
                        <Button size="sm" variant="outline" className="gap-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                          onClick={() => setActivateTarget(v)}>
                          <Play className="size-3" /> 激活
                        </Button>
                      )}
                      {v.status === 'active' && (
                        <Badge variant="outline" className="text-emerald-600"><CheckCircle2 className="mr-1 size-3" />当前</Badge>
                      )}
                      {v.status === 'retired' && (
                        <span className="text-xs text-muted-foreground">已退役</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>

        {/* Create Dialog */}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>创建新策略版本</DialogTitle>
              <DialogDescription>新版本将以草稿状态创建。参数将基于当前活跃版本。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>版本名称</Label>
                <Input value={newVersion} onChange={e => setNewVersion(e.target.value)} placeholder="例如: v2.3" />
              </div>
              <div className="space-y-2">
                <Label>创建原因</Label>
                <Textarea value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="描述为什么创建此版本..." rows={2} />
              </div>
              <div className="space-y-2">
                <Label>策略参数 (JSON)</Label>
                <Textarea value={newParams} onChange={e => setNewParams(e.target.value)} rows={8} className="font-mono text-xs" />
                <p className="text-xs text-muted-foreground">target_ratios 中的值为万分比 (bps)，总和必须等于 1000000</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                创建草稿
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Activate Confirmation */}
        <AlertDialog open={!!activateTarget} onOpenChange={(open) => !open && setActivateTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认激活策略版本</AlertDialogTitle>
              <AlertDialogDescription>
                激活版本 <strong>{activateTarget?.version}</strong> 将退役当前活跃版本。
                此操作将立即生效，请确认目标配比总和为 100%。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => activateTarget && activateMutation.mutate(activateTarget.id)}
                disabled={activateMutation.isPending}
              >
                {activateMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                确认激活
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ─── Section 2: ETF Configuration ────────────────────────────────────────────

function EtfConfigSection() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EtfConfigWithSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EtfConfigWithSnapshot | null>(null);

  // Add form
  const [addForm, setAddForm] = useState({ code: '', name: '', category: 'A股宽基', targetRatioPercent: '' });
  // Edit form
  const [editForm, setEditForm] = useState({ id: '', code: '', name: '', category: '', targetRatioPercent: '' });

  const { data: configsRes, isLoading } = useQuery({
    queryKey: QK.etfConfigs,
    queryFn: () => fetch('/api/etf-configs').then(r => r.json()) as Promise<ApiResponse<EtfConfigWithSnapshot[]>>,
  });

  const configs = configsRes?.data ?? [];

  const totalRatio = useMemo(() => configs.reduce((s, c) => s + (c.targetRatioPercent ?? 0), 0), [configs]);

  const addMutation = useMutation({
    mutationFn: async (body: { code: string; name: string; category: string; targetRatioBps: number }) => {
      const res = await fetch('/api/etf-configs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) { toast.success('ETF 已添加'); setAddOpen(false); setAddForm({ code: '', name: '', category: 'A股宽基', targetRatioPercent: '' }); queryClient.invalidateQueries({ queryKey: QK.etfConfigs }); }
      else toast.error(res.error ?? '添加失败');
    },
    onError: () => toast.error('添加 ETF 失败'),
  });

  const editMutation = useMutation({
    mutationFn: async (body: { id: string; name?: string; category?: string; targetRatioBps?: number }) => {
      const res = await fetch('/api/etf-configs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) { toast.success('ETF 已更新'); setEditTarget(null); queryClient.invalidateQueries({ queryKey: QK.etfConfigs }); }
      else toast.error(res.error ?? '更新失败');
    },
    onError: () => toast.error('更新 ETF 失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/etf-configs?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) { toast.success('ETF 已删除'); setDeleteTarget(null); queryClient.invalidateQueries({ queryKey: QK.etfConfigs }); }
      else toast.error(res.error ?? '删除失败');
    },
    onError: () => toast.error('删除 ETF 失败'),
  });

  const handleAdd = () => {
    if (!addForm.code.trim() || !addForm.name.trim()) { toast.error('请填写代码和名称'); return; }
    const pct = parseFloat(addForm.targetRatioPercent);
    if (isNaN(pct) || pct < 0 || pct > 100) { toast.error('目标比例需在 0-100 之间'); return; }
    addMutation.mutate({ code: addForm.code.trim(), name: addForm.name.trim(), category: addForm.category, targetRatioBps: percentToBps(pct) });
  };

  const handleEdit = () => {
    if (!editForm.name.trim()) { toast.error('请填写名称'); return; }
    const pct = parseFloat(editForm.targetRatioPercent);
    if (isNaN(pct) || pct < 0 || pct > 100) { toast.error('目标比例需在 0-100 之间'); return; }
    editMutation.mutate({ id: editForm.id, name: editForm.name.trim(), category: editForm.category, targetRatioBps: percentToBps(pct) });
  };

  const openEdit = (c: EtfConfigWithSnapshot) => {
    setEditForm({ id: c.id, code: c.code, name: c.name, category: c.category, targetRatioPercent: String(c.targetRatioPercent ?? 0) });
    setEditTarget(c);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>ETF 核心配置</CardTitle><CardDescription>配置投资标的、目标比例和分类</CardDescription></CardHeader>
        <CardContent><Skeleton className="h-64 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Landmark className="size-5 text-teal-600" />
          ETF 核心配置
        </CardTitle>
        <CardDescription>配置投资标的、目标比例和分类</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Ratio Sum Warning */}
        <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${Math.abs(totalRatio - 100) < 0.01 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400'}`}>
          {Math.abs(totalRatio - 100) < 0.01 ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          目标比例总和: <strong>{totalRatio.toFixed(2)}%</strong>
          {Math.abs(totalRatio - 100) >= 0.01 && ' (需等于 100%)'}
        </div>

        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">ETF 列表</h3>
          <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="size-3.5" /> 添加 ETF
          </Button>
        </div>

        <ScrollArea className="max-h-80">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>代码</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-[100px]">类别</TableHead>
                <TableHead className="w-[100px] text-right">目标比例</TableHead>
                <TableHead className="text-right">当前持仓</TableHead>
                <TableHead className="w-[100px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configs.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono font-medium">{c.code}</TableCell>
                  <TableCell>{c.name}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[c.category] ?? 'bg-gray-100 text-gray-600'}`}>
                      {c.category}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono">{(c.targetRatioPercent ?? 0).toFixed(2)}%</TableCell>
                  <TableCell className="text-right font-mono">
                    {c.latestSnapshot ? formatMoney(c.latestSnapshot.marketValueYuan) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => openEdit(c)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="size-7 p-0 text-red-500 hover:text-red-600" onClick={() => setDeleteTarget(c)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {configs.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">暂无 ETF 配置</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>

        {/* Add Dialog */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>添加 ETF</DialogTitle><DialogDescription>添加新的投资标的到策略配置</DialogDescription></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2"><Label>ETF 代码</Label><Input value={addForm.code} onChange={e => setAddForm(f => ({ ...f, code: e.target.value }))} placeholder="510300" /></div>
              <div className="space-y-2"><Label>名称</Label><Input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="沪深300ETF" /></div>
              <div className="space-y-2">
                <Label>类别</Label>
                <Select value={addForm.category} onValueChange={v => setAddForm(f => ({ ...f, category: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A股宽基">A股宽基</SelectItem>
                    <SelectItem value="红利">红利</SelectItem>
                    <SelectItem value="QDII">QDII</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>目标比例 (%)</Label><Input type="number" step="0.01" value={addForm.targetRatioPercent} onChange={e => setAddForm(f => ({ ...f, targetRatioPercent: e.target.value }))} placeholder="16.67" /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>取消</Button>
              <Button onClick={handleAdd} disabled={addMutation.isPending}>
                {addMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} 添加
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit Dialog */}
        <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>编辑 ETF — {editTarget?.code}</DialogTitle><DialogDescription>修改 ETF 配置信息</DialogDescription></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2"><Label>ETF 代码</Label><Input value={editForm.code} disabled /></div>
              <div className="space-y-2"><Label>名称</Label><Input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div className="space-y-2">
                <Label>类别</Label>
                <Select value={editForm.category} onValueChange={v => setEditForm(f => ({ ...f, category: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A股宽基">A股宽基</SelectItem>
                    <SelectItem value="红利">红利</SelectItem>
                    <SelectItem value="QDII">QDII</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2"><Label>目标比例 (%)</Label><Input type="number" step="0.01" value={editForm.targetRatioPercent} onChange={e => setEditForm(f => ({ ...f, targetRatioPercent: e.target.value }))} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
              <Button onClick={handleEdit} disabled={editMutation.isPending}>
                {editMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} 保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除 ETF</AlertDialogTitle>
              <AlertDialogDescription>确定要删除 <strong>{deleteTarget?.code} ({deleteTarget?.name})</strong> 吗？此操作不可撤销。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} 删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ─── Section 3: Weekly Budget ─────────────────────────────────────────────────

function WeeklyBudgetSection() {
  const queryClient = useQueryClient();

  const { data: sysRes, isLoading: sysLoading } = useQuery({
    queryKey: QK.systemConfigs,
    queryFn: () => fetch('/api/system-configs').then(r => r.json()) as Promise<ApiResponse<SystemConfigMap>>,
  });

  const { data: cashRes, isLoading: cashLoading } = useQuery({
    queryKey: QK.cashAccounts,
    queryFn: () => fetch('/api/cash-accounts').then(r => r.json()) as Promise<ApiResponse<CashAccountDisplay[]>>,
  });

  const configs = sysRes?.data ?? {};
  const accounts = cashRes?.data ?? [];

  const [localConfigs, setLocalConfigs] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState(false);

  const budgetFields = [
    { key: 'weekly_contribution_committed', label: '本周注资', desc: '本周承诺投入的资金（元）', type: 'number' },
    { key: 'strategy_weekly_budget', label: '策略周预算', desc: '本周策略引擎使用的预算（元）', type: 'number' },
    { key: 'base_bucket_ratio', label: '基础仓比例', desc: '基础仓分配比例（万分比 bps）', type: 'number' },
    { key: 'value_bucket_ratio', label: '增强仓比例', desc: '增强仓分配比例（万分比 bps）', type: 'number' },
  ];

  // Initialize local configs when data loads
  const handleStartEdit = () => {
    const initial: Record<string, string> = {};
    budgetFields.forEach(f => { initial[f.key] = configs[f.key] ?? ''; });
    setLocalConfigs(initial);
    setIsEditing(true);
  };

  const updateMutation = useMutation({
    mutationFn: async (updates: Array<{ configKey: string; configValue: string }>) => {
      await Promise.all(updates.map(u =>
        fetch('/api/system-configs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(u),
        })
      ));
    },
    onSuccess: () => {
      toast.success('周预算配置已保存');
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: QK.systemConfigs });
    },
    onError: () => toast.error('保存失败'),
  });

  const handleSave = () => {
    const updates = budgetFields
      .filter(f => localConfigs[f.key] !== undefined)
      .map(f => ({ configKey: f.key, configValue: localConfigs[f.key] }));
    updateMutation.mutate(updates);
  };

  // EAB calculation
  const eabBreakdown = useMemo(() => {
    const investEquity = accounts.find(a => a.accountType === 'weekly_unallocated_cash')?.balanceYuan ?? 0;
    const unallocatedCash = accounts.find(a => a.accountType === 'weekly_unallocated_cash')?.balanceYuan ?? 0;
    const qdiiSp500 = accounts.find(a => a.accountType === 'qdii_pending_cash_sp500')?.balanceYuan ?? 0;
    const qdiiNasdaq = accounts.find(a => a.accountType === 'qdii_pending_cash_nasdaq')?.balanceYuan ?? 0;
    const reserve = accounts.find(a => a.accountType === 'rebalance_equity_reserve')?.balanceYuan ?? 0;
    // Also consider committed contribution
    const committed = accounts.find(a => a.accountType === 'weekly_contribution_committed')?.balanceYuan ?? 0;
    return {
      investEquity,
      unallocatedCash,
      qdiiPending: (qdiiSp500 ?? 0) + (qdiiNasdaq ?? 0),
      reserve: reserve ?? 0,
      committed: committed ?? 0,
    };
  }, [accounts]);

  const totalEAB = (eabBreakdown.investEquity ?? 0) + (eabBreakdown.unallocatedCash ?? 0) + (eabBreakdown.qdiiPending ?? 0) + (eabBreakdown.reserve ?? 0);

  if (sysLoading || cashLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>周预算与默认值</CardTitle><CardDescription>配置每周注资金额和分配比例</CardDescription></CardHeader>
        <CardContent><Skeleton className="h-48 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-5 text-amber-600" />
          周预算与默认值
        </CardTitle>
        <CardDescription>配置每周注资金额和分配比例</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Budget Fields */}
        <div className="grid gap-4 sm:grid-cols-2">
          {budgetFields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm font-medium">{f.label}</Label>
              {isEditing ? (
                <Input
                  type={f.type}
                  value={localConfigs[f.key] ?? ''}
                  onChange={e => setLocalConfigs(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              ) : (
                <p className="text-sm font-mono bg-muted rounded-md px-3 py-2">
                  {f.key.includes('ratio') ? `${configs[f.key]} bps` : formatMoney(Number(configs[f.key]) / 100)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          {!isEditing ? (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStartEdit}>
              <Pencil className="size-3.5" /> 编辑
            </Button>
          ) : (
            <>
              <Button size="sm" className="gap-1.5" onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} 保存
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>取消</Button>
            </>
          )}
        </div>

        <Separator />

        {/* EAB Preview */}
        <div>
          <h3 className="text-sm font-semibold mb-3">EAB 预览（权益配置基准）</h3>
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">未分配权益现金</span><span className="font-mono">{formatMoney(eabBreakdown.unallocatedCash)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">QDII 挂起资金</span><span className="font-mono">{formatMoney(eabBreakdown.qdiiPending)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">再平衡备用金</span><span className="font-mono">{formatMoney(eabBreakdown.reserve)}</span></div>
            </div>
            <Separator className="my-3" />
            <div className="flex items-center justify-between">
              <span className="font-medium">EAB 合计</span>
              <span className="text-lg font-bold font-mono text-emerald-600">{formatMoney(totalEAB)}</span>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">EAB = 投资资产 + 未分配现金 + QDII挂起 + 备用金（不含日常现金和手动指定现金）</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Section 4: Rule Parameters ───────────────────────────────────────────────

function RuleParametersSection() {
  const queryClient = useQueryClient();
  const [editRule, setEditRule] = useState<RuleConfigDisplay | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: rulesRes, isLoading } = useQuery({
    queryKey: QK.ruleConfigs,
    queryFn: () => fetch('/api/rule-configs').then(r => r.json()) as Promise<ApiResponse<RuleConfigDisplay[]>>,
  });

  const rules = rulesRes?.data ?? [];

  const groupedRules = useMemo(() => {
    const groups: Record<string, RuleConfigDisplay[]> = {};
    for (const rule of rules) {
      const g = rule.ruleGroup || 'other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(rule);
    }
    return groups;
  }, [rules]);

  const openGroups = useMemo(() => Object.keys(groupedRules).slice(0, 2), [groupedRules]);

  const updateMutation = useMutation({
    mutationFn: async ({ id, ruleValue }: { id: string; ruleValue: string }) => {
      const res = await fetch('/api/rule-configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ruleValue }),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) { toast.success('规则参数已更新'); setEditRule(null); queryClient.invalidateQueries({ queryKey: QK.ruleConfigs }); }
      else toast.error(res.error ?? '更新失败');
    },
    onError: () => toast.error('更新规则参数失败'),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>规则参数</CardTitle><CardDescription>配置买入、暂停、再平衡和数据质量规则</CardDescription></CardHeader>
        <CardContent><Skeleton className="h-48 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-5 text-cyan-600" />
          规则参数
        </CardTitle>
        <CardDescription>配置买入、暂停、再平衡和数据质量规则</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {Object.keys(groupedRules).length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">暂无规则配置</p>
        )}

        {Object.entries(groupedRules).map(([group, groupRules]) => (
          <Collapsible key={group} defaultOpen={openGroups.includes(group)}>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors">
              <span className="flex items-center gap-2">
                <ChevronIcon className="size-4 text-muted-foreground" />
                {RULE_GROUP_LABELS[group] ?? group}
                <Badge variant="secondary" className="text-xs">{groupRules.length}</Badge>
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-4 mt-1 space-y-2 border-l-2 border-muted pl-4">
                {groupRules.map((rule) => (
                  <div key={rule.id} className="flex items-start justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{rule.ruleName}</span>
                        {!rule.isEnabled && <Badge variant="outline" className="text-xs text-muted-foreground">已禁用</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{rule.description || rule.triggerCondition || ''}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-mono font-medium bg-muted rounded px-2 py-0.5">{rule.ruleValue}</span>
                      <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => { setEditRule(rule); setEditValue(rule.ruleValue); }}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}

        {/* Edit Rule Dialog */}
        <Dialog open={!!editRule} onOpenChange={(open) => !open && setEditRule(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>编辑规则 — {editRule?.ruleName}</DialogTitle>
              <DialogDescription>修改规则的当前值</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1">
                <Label>规则名称</Label>
                <p className="text-sm">{editRule?.ruleName}</p>
              </div>
              <div className="space-y-1">
                <Label>触发条件</Label>
                <p className="text-sm text-muted-foreground">{editRule?.triggerCondition || '—'}</p>
              </div>
              <div className="space-y-2">
                <Label>当前值</Label>
                <Input value={editValue} onChange={e => setEditValue(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditRule(null)}>取消</Button>
              <Button onClick={() => editRule && updateMutation.mutate({ id: editRule.id, ruleValue: editValue })} disabled={updateMutation.isPending}>
                {updateMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} 保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// Chevron icon for Collapsible
function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
    </svg>
  );
}

// ─── Section 5: Cash Account Management ───────────────────────────────────────

function CashAccountSection() {
  const queryClient = useQueryClient();
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferForm, setTransferForm] = useState({ from: '', to: '', amount: '', description: '' });

  const { data: accountsRes, isLoading } = useQuery({
    queryKey: QK.cashAccounts,
    queryFn: () => fetch('/api/cash-accounts').then(r => r.json()) as Promise<ApiResponse<CashAccountDisplay[]>>,
  });

  const accounts = accountsRes?.data ?? [];

  const totalBalance = useMemo(() => accounts.reduce((s, a) => s + (a.balanceYuan ?? 0), 0), [accounts]);

  const transferMutation = useMutation({
    mutationFn: async (body: { debitAccountType: string; creditAccountType: string; amountFen: number; description: string }) => {
      const res = await fetch('/api/cash-ledger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) {
        toast.success('转账已记录');
        setTransferOpen(false);
        setTransferForm({ from: '', to: '', amount: '', description: '' });
        queryClient.invalidateQueries({ queryKey: QK.cashAccounts });
      } else {
        toast.error(res.error ?? '转账失败');
      }
    },
    onError: () => toast.error('转账失败'),
  });

  const handleTransfer = () => {
    if (!transferForm.from || !transferForm.to) { toast.error('请选择转出和转入账户'); return; }
    if (transferForm.from === transferForm.to) { toast.error('转出和转入账户不能相同'); return; }
    const yuan = parseFloat(transferForm.amount);
    if (isNaN(yuan) || yuan <= 0) { toast.error('请输入有效金额'); return; }
    if (!transferForm.description.trim()) { toast.error('请输入转账说明'); return; }
    transferMutation.mutate({
      debitAccountType: transferForm.from,
      creditAccountType: transferForm.to,
      amountFen: yuanToFen(yuan),
      description: transferForm.description.trim(),
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>现金账户管理</CardTitle><CardDescription>查看和管理 7 个现金子账户</CardDescription></CardHeader>
        <CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-5 text-fuchsia-600" />
          现金账户管理
        </CardTitle>
        <CardDescription>查看和管理 7 个现金子账户</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total */}
        <div className="flex items-center justify-between rounded-md bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">总余额</span>
          <span className="text-lg font-bold font-mono">{formatMoney(totalBalance)}</span>
        </div>

        {/* Account Grid */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((acc) => {
            const bal = acc.balanceYuan ?? 0;
            const isPositive = bal > 0;
            return (
              <div key={acc.id} className="rounded-lg border p-3 space-y-2 hover:shadow-sm transition-shadow">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block size-2.5 rounded-full ${ACCOUNT_TYPE_COLORS[acc.accountType as CashAccountType] ?? 'bg-gray-400'} ${isPositive ? '' : 'opacity-40'}`} />
                    <span className="text-sm font-medium">{ACCOUNT_LABELS[acc.accountType as CashAccountType] ?? acc.accountType}</span>
                  </div>
                  {acc.countsAsEquityBase && (
                    <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300">计入EAB</Badge>
                  )}
                </div>
                <p className={`text-base font-mono font-semibold ${isPositive ? '' : 'text-muted-foreground'}`}>{formatMoney(bal)}</p>
                {acc.description && <p className="text-xs text-muted-foreground">{acc.description}</p>}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button size="sm" className="gap-1.5" onClick={() => setTransferOpen(true)}>
            <ArrowRightLeft className="size-3.5" /> 手动转账
          </Button>
        </div>

        {/* Transfer Dialog */}
        <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>手动转账</DialogTitle><DialogDescription>在两个现金子账户之间进行资金转移</DialogDescription></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>转出账户</Label>
                <Select value={transferForm.from} onValueChange={v => setTransferForm(f => ({ ...f, from: v }))}>
                  <SelectTrigger><SelectValue placeholder="选择转出账户" /></SelectTrigger>
                  <SelectContent>
                    {CASH_ACCOUNT_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{ACCOUNT_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>转入账户</Label>
                <Select value={transferForm.to} onValueChange={v => setTransferForm(f => ({ ...f, to: v }))}>
                  <SelectTrigger><SelectValue placeholder="选择转入账户" /></SelectTrigger>
                  <SelectContent>
                    {CASH_ACCOUNT_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{ACCOUNT_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>金额 (元)</Label>
                <Input type="number" step="0.01" min="0" value={transferForm.amount} onChange={e => setTransferForm(f => ({ ...f, amount: e.target.value }))} placeholder="1000.00" />
              </div>
              <div className="space-y-2">
                <Label>说明</Label>
                <Input value={transferForm.description} onChange={e => setTransferForm(f => ({ ...f, description: e.target.value }))} placeholder="转账原因说明" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTransferOpen(false)}>取消</Button>
              <Button onClick={handleTransfer} disabled={transferMutation.isPending}>
                {transferMutation.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} 确认转账
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ─── Section 6: Data Source Management (Mock) ─────────────────────────────────

function DataSourceSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-5 text-violet-600" />
          数据源管理
        </CardTitle>
        <CardDescription>查看和管理数据采集源的状态与质量</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {MOCK_DATA_SOURCES.map((src, idx) => (
            <div key={idx} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 hover:bg-muted/30 transition-colors">
              <div className="flex items-center gap-3">
                {src.isPrimary && (
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">主数据源</Badge>
                )}
                <div>
                  <p className="text-sm font-medium">{src.name}</p>
                  <p className="text-xs text-muted-foreground">{src.type}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">质量评分</p>
                  <p className={`text-sm font-mono font-semibold ${src.quality >= 80 ? 'text-emerald-600' : src.quality >= 50 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                    {src.quality > 0 ? src.quality : '—'}
                  </p>
                </div>
                <Badge variant="outline" className={
                  src.status === 'active' ? 'text-emerald-600 border-emerald-300' :
                  src.status === 'degraded' ? 'text-amber-600 border-amber-300' :
                  'text-muted-foreground'
                }>
                  <CircleDot className={`mr-1 size-3 ${src.status === 'active' ? 'fill-emerald-500 text-emerald-500' : src.status === 'degraded' ? 'fill-amber-500 text-amber-500' : 'fill-muted text-muted'}`} />
                  {src.status === 'active' ? '正常' : src.status === 'degraded' ? '降级' : '未启用'}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Section 7: System Configuration ──────────────────────────────────────────

function SystemConfigSection() {
  const queryClient = useQueryClient();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: configsRes, isLoading } = useQuery({
    queryKey: QK.systemConfigs,
    queryFn: () => fetch('/api/system-configs').then(r => r.json()) as Promise<ApiResponse<SystemConfigMap>>,
  });

  const configs = configsRes?.data ?? {};
  const entries = useMemo(() => Object.entries(configs).sort(([a], [b]) => a.localeCompare(b)), [configs]);

  const updateMutation = useMutation({
    mutationFn: async ({ configKey, configValue }: { configKey: string; configValue: string }) => {
      const res = await fetch('/api/system-configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configKey, configValue }),
      });
      return res.json() as Promise<ApiResponse>;
    },
    onSuccess: (res) => {
      if (res.success) { toast.success('系统配置已更新'); setEditKey(null); queryClient.invalidateQueries({ queryKey: QK.systemConfigs }); }
      else toast.error(res.error ?? '更新失败');
    },
    onError: () => toast.error('更新系统配置失败'),
  });

  const handleRefresh = () => {
    toast.success('数据已刷新（模拟操作）');
    queryClient.invalidateQueries({ queryKey: QK.systemConfigs });
  };

  const handleClearCache = () => {
    toast.success('缓存已清空（模拟操作）');
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>系统配置</CardTitle><CardDescription>查看和修改全局系统参数</CardDescription></CardHeader>
        <CardContent><Skeleton className="h-48 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5 text-stone-600" />
          系统配置
        </CardTitle>
        <CardDescription>查看和修改全局系统参数</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRefresh}>
            <RefreshCw className="size-3.5" /> 刷新数据
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-red-600 hover:text-red-700" onClick={handleClearCache}>
            <Trash2 className="size-3.5" /> 清空缓存
          </Button>
        </div>

        <ScrollArea className="max-h-72">
          <div className="space-y-1">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-muted/30 transition-colors">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-mono font-medium text-muted-foreground">{key}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {editKey === key ? (
                    <div className="flex items-center gap-1.5">
                      <Input className="w-48 h-8 text-sm" value={editValue} onChange={e => setEditValue(e.target.value)} />
                      <Button size="sm" className="h-8 px-2" onClick={() => updateMutation.mutate({ configKey: key, configValue: editValue })} disabled={updateMutation.isPending}>
                        {updateMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditKey(null)}>
                        <XCircle className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className="text-sm font-mono bg-muted rounded px-2 py-0.5 max-w-[200px] truncate">{value}</span>
                      <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => { setEditKey(key); setEditValue(value); }}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {entries.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无系统配置</p>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ─── Main Settings Tab ────────────────────────────────────────────────────────

export function SettingsTab() {
  return (
    <div className="space-y-2">
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight">设置</h2>
        <p className="text-sm text-muted-foreground">策略版本、ETF配置、预算、规则、现金账户与系统参数管理</p>
      </div>

      <Accordion type="multiple" defaultValue={['strategy-versions', 'etf-configs', 'weekly-budget']} className="space-y-2">
        <AccordionItem value="strategy-versions" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <GitBranch className="size-4 text-emerald-600" />
              <span className="font-semibold">策略版本与目标配置</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <StrategyVersionSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="etf-configs" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <Landmark className="size-4 text-teal-600" />
              <span className="font-semibold">ETF 核心配置</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <EtfConfigSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="weekly-budget" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <Wallet className="size-4 text-amber-600" />
              <span className="font-semibold">周预算与默认值</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <WeeklyBudgetSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="rule-params" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <ListChecks className="size-4 text-cyan-600" />
              <span className="font-semibold">规则参数</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <RuleParametersSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="cash-accounts" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <Wallet className="size-4 text-fuchsia-600" />
              <span className="font-semibold">现金账户管理</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <CashAccountSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="data-sources" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <Database className="size-4 text-violet-600" />
              <span className="font-semibold">数据源管理</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <DataSourceSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="system-configs" className="border rounded-lg px-1">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex items-center gap-2.5">
              <Cpu className="size-4 text-stone-600" />
              <span className="font-semibold">系统配置</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-1 pb-2">
            <SystemConfigSection />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}