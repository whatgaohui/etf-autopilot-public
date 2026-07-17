'use client';

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { BarChart3, TrendingUp, Settings } from 'lucide-react';
import { OverviewTab } from '@/components/overview-tab';
import { TrendsTab } from '@/components/trends-tab';
import { SettingsTab } from '@/components/settings-tab';
import { ThemeToggle } from '@/components/theme-toggle';
import { FadeInUp } from '@/lib/motion';

// Create a react-query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

/* ---------- 导航元数据：单源真理，Sidebar / 移动端 / Hero 共用 ---------- */
type NavValue = 'overview' | 'trends' | 'settings';
interface NavItem {
  value: NavValue;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}
const NAV_ITEMS: NavItem[] = [
  { value: 'overview', label: '总览', description: '持仓与资金调拨执行单', icon: BarChart3 },
  { value: 'trends', label: '趋势', description: '多周期估值与历史回溯', icon: TrendingUp },
  { value: 'settings', label: '设置', description: '规则、数据源与通知配置', icon: Settings },
];

export default function Home() {
  const [activeTab, setActiveTab] = React.useState<NavValue>('overview');
  const activeMeta =
    NAV_ITEMS.find((n) => n.value === activeTab) ?? NAV_ITEMS[0];
  const ActiveIcon = activeMeta.icon;

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background flex flex-col">
        {/* ============ App Header — sticky, glass ============ */}
        <header className="sticky top-0 z-40 glass border-b border-border/40">
          <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
            {/* Brand */}
            <div className="flex items-center gap-2.5">
              <div className="relative flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-soft">
                <BarChart3 className="size-4 text-white" />
                <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/20" />
              </div>
              <div className="flex flex-col leading-none">
                <span className="text-sm font-bold tracking-tight">ETF 定投助手</span>
                <span className="text-[10px] text-muted-foreground/80 font-medium tracking-wide">
                  V5.0 资金调拨辅助系统
                </span>
              </div>
            </div>

            {/* Right cluster — theme toggle */}
            <ThemeToggle />
          </div>
        </header>

        {/* ============ 移动端水平导航（md:hidden，紧贴 header 下方）============ */}
        <nav
          aria-label="主导航"
          className="md:hidden sticky top-14 z-30 glass border-b border-border/40"
        >
          <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto no-scrollbar">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setActiveTab(item.value)}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all duration-200',
                    isActive
                      ? 'bg-emerald-600 text-white shadow-soft'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  ].join(' ')}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* ============ Sidebar + Main ============ */}
        <div className="flex-1 flex">
          {/* Sidebar — 桌面端固定左侧导航 */}
          <aside className="hidden md:flex sticky top-14 h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col glass border-r border-border/40">
            <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 py-4">
              <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                导航
              </div>
              <div className="space-y-1">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setActiveTab(item.value)}
                      className={[
                        'group relative flex w-full items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-sm transition-all duration-200',
                        isActive
                          ? 'border-l-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold'
                          : 'border-l-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      ].join(' ')}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            {/* Sidebar 底部 — 版本号 + 规则引擎在线状态 */}
            <div className="border-t border-border/40 px-4 py-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>规则引擎在线</span>
              </div>
              <div className="text-[10px] text-muted-foreground/60 font-mono">
                v5.0.0
              </div>
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">
            <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-10 py-6">
              {/* Hero — 每次切视图 key 变化触发淡入 */}
              <FadeInUp key={activeTab} className="mb-6">
                {/* 面包屑 */}
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/70 mb-2">
                  <span>Dashboard</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="text-foreground/80">{activeMeta.label}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <ActiveIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
                  <h1 className="text-2xl font-bold tracking-tight">
                    {activeMeta.label}
                  </h1>
                </div>
                <p className="text-sm text-muted-foreground mt-1.5">
                  {activeMeta.description}
                </p>
              </FadeInUp>

              {/* Tabs — forceMount 保留三视图状态，TabsList 用 sr-only 隐藏 */}
              <Tabs
                value={activeTab}
                onValueChange={(v) => setActiveTab(v as NavValue)}
                className="space-y-0"
              >
                <TabsList className="sr-only">
                  <TabsTrigger value="overview">总览</TabsTrigger>
                  <TabsTrigger value="trends">趋势</TabsTrigger>
                  <TabsTrigger value="settings">设置</TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                  <OverviewTab />
                </TabsContent>
                <TabsContent value="trends">
                  <TrendsTab />
                </TabsContent>
                <TabsContent value="settings">
                  <SettingsTab />
                </TabsContent>
              </Tabs>
            </div>
          </main>
        </div>

        {/* ============ Footer — sticky bottom ============ */}
        <Separator />
        <footer className="mt-auto bg-card/30 backdrop-blur-sm">
          <div className="px-4 sm:px-6 lg:px-8 py-3">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
              <span>
                ETF Autopilot V5.0 · 不构成投资建议
              </span>
              <span className="hidden sm:inline font-mono">
                Prisma · Recharts · z-ai
              </span>
            </div>
          </div>
        </footer>
      </div>
    </QueryClientProvider>
  );
}