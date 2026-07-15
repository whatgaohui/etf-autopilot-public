import type {
  EtfConfig,
  HoldingsResponse,
  OcrResult,
  CachedSummaryResponse,
  AdviceResponse,
} from './types';

const BASE_URL = '/api';

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error((errorBody as { error?: string }).error || `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ETF Config
export async function getEtfConfigs(): Promise<EtfConfig[]> {
  return request<EtfConfig[]>('/etf');
}

export async function updateEtfConfigs(
  configs: { code: string; targetRatio?: number; isBlacklisted?: boolean; isInvestmentTarget?: boolean }[]
): Promise<EtfConfig[]> {
  return request<EtfConfig[]>('/etf', {
    method: 'PUT',
    body: JSON.stringify(configs),
  });
}

// Holdings
export async function getHoldings(): Promise<HoldingsResponse> {
  return request<HoldingsResponse>('/holding');
}

export async function saveHoldings(
  holdings: { etfCode: string; etfName: string; shares: number; costPrice: number; marketValue: number; source?: string; ocrConfidence?: number; isManualCorrected?: boolean }[],
  snapshotDate: string
): Promise<HoldingsResponse> {
  return request<HoldingsResponse>('/holding', {
    method: 'POST',
    body: JSON.stringify({ holdings, snapshotDate }),
  });
}

// OCR
export async function uploadOcrImage(file: File): Promise<{ holdings: OcrResult[] }> {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch(`${BASE_URL}/ocr`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: 'OCR failed' }));
    throw new Error((errorBody as { error?: string }).error || `HTTP ${res.status}`);
  }

  return res.json() as Promise<{ holdings: OcrResult[] }>;
}

// Market Data
export async function getMarketData(type: string = 'summary'): Promise<CachedSummaryResponse> {
  return request<CachedSummaryResponse>(`/data?type=${type}`);
}

// V4.1 §10.9 / S2-T4: 熔断降级链路结果（单条 ETF 单指标）
export interface FallbackDetail {
  code: string;
  metric: string;
  source: string;                // 实际采用的源（akshare/tushare/efinance/cache:xxx）
  source_fallback: boolean;      // 是否触发了源降级（主源失败）
  stale: boolean;                // 是否使用了过期缓存
  blocked: boolean;              // 是否完全阻断
  single_source_warning: boolean;// 单源场景标记
  reason: string;                // 状态原因说明
}

// V4.1 §10.9 / S2-T4: 刷新响应中的降级链路摘要
export interface FallbackSummary {
  total: number;                  // 总指标数
  fallback_count: number;         // 触发降级的次数
  stale_count: number;            // 使用缓存（未阻断）的次数
  blocked_count: number;          // 完全阻断的次数
  single_source_count: number;    // 单源场景次数
  source_conflict_count: number;  // 主备源冲突次数
  details: FallbackDetail[];      // 每条指标的降级详情
}

// V4.1 §10.9: 完整的 RefreshResponse（含质量评分 + 交叉校验 + 降级链路三套摘要）
export interface RefreshResponse {
  success: boolean;
  message: string;
  updated_codes: string[];
  qualitySummary?: {
    total_metrics: number;
    excellent: number;
    usable: number;
    suspicious: number;
    unavailable: number;
    avg_score: number;
    allow_buy_suggestion: boolean;
    allow_rebalance_suggestion: boolean;
  } | null;
  crossCheckSummary?: {
    total: number;
    passed: number;
    inconsistent: number;
    failed: number;
    source_conflict: number;
  } | null;
  fallbackSummary?: FallbackSummary | null;
}

export async function refreshMarketData(): Promise<RefreshResponse> {
  // V4.2 P4: 后端 refresh 可能要1-3分钟(6 ETF × 多指标 × 多源), 加200秒超时
  const res = await fetch(`${BASE_URL}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(200000),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: '刷新失败' }));
    throw new Error((errorBody as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<RefreshResponse>;
}

// Advice
export async function generateAdvice(): Promise<AdviceResponse> {
  // V5.0: advice 需要调规则引擎+LLM,最长120秒
  const res = await fetch(`${BASE_URL}/advice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: '生成建议失败' }));
    throw new Error((errorBody as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<AdviceResponse>;
}

// V4 Data Source (PRD§9.3)
export interface DataSourceInfo {
  name: string;
  role: string;
  status: string;
  lastFetch: string;
  lastSuccess: string;
  description: string;
}

export interface DataSourceStatus {
  sources: DataSourceInfo[];
  lastDataUpdate: string;
  trackedCount: number;
  cacheRows: number;
}

export interface ThresholdInfo {
  key: string;
  label: string;
  threshold_type: string;   // pct | pp
  max_diff: number;
  max_diff_pct: number | null;
  max_diff_pp: number | null;
  unit: string;
}

export interface ThresholdsResponse {
  thresholds: ThresholdInfo[];
  note: string;
}

export interface ConnectivityResult {
  source: string;
  connected: boolean;
  latencyMs: number;
  message: string;
}

export async function getDataSourceStatus(): Promise<DataSourceStatus> {
  return request<DataSourceStatus>('/data-source?type=status');
}

export async function getThresholds(): Promise<ThresholdsResponse> {
  return request<ThresholdsResponse>('/data-source?type=thresholds');
}

export async function testDataSources(): Promise<ConnectivityResult[]> {
  return request<ConnectivityResult[]>('/data-source', { method: 'POST' });
}

// ─── V4 §4 数据源管理（字段级主备源 + 交叉校验 + 数据血缘）──────────────────

export interface AdapterInfo {
  name: string;
  display_name: string;
  role: string;            // primary | backup | reference
  description: string;
  sub_sources: string;
  needs_token: boolean;
  available: boolean;
  status: string;          // active | unconfigured | planned
}

export interface FieldSourceConfig {
  field: string;           // valuation | premium | nav | dividend | price
  field_label: string;
  primary_sources: string[];
  backup_sources: string[];
  forced_source: string | null;
  available_adapters: string[];
  adapter_status: Record<string, AdapterInfo>;
}

export interface CrossCheckRecord {
  fetch_time: string;
  field: string;
  code: string;
  primary_source: string;
  backup_source: string;
  primary_value: number | null;
  backup_value: number | null;
  diff_abs: number | null;
  diff_pct: number | null;
  diff_pp: number | null;
  threshold_type: string;   // pct | pp
  threshold_max: number;
  in_tolerance: number;     // 0 | 1
  quality_status: string;   // passed | source_inconsistent | primary_failed | backup_failed | both_failed | no_backup
  trade_date: string;
  notes: string;
}

export interface CrossCheckStats {
  total: number;
  passed: number;
  inconsistent: number;
  primary_failed: number;
  backup_failed: number;
  both_failed: number;
  last_check_time: string;
  pass_rate: number;
}

export interface DataLineage {
  found: boolean;
  message?: string;
  code?: string;
  data_type?: string;
  date?: string;
  raw_value?: string | null;
  clean_value?: number | null;
  source?: string;
  source_api?: string;
  is_valid?: boolean;
  abnormal_reason?: string;
  sample_days?: number;
  percentile_window?: string;
  percentile?: number | null;
  trade_date?: string;
  fetch_time?: string;
  data_json?: string;
}

// 获取所有适配器概览（V4 §4.2）
export async function getSourcesOverview(): Promise<{ sources: AdapterInfo[] }> {
  return request('/data-source?type=sources');
}

// 获取字段级主备源配置（V4 §4.3）
export async function getFieldConfigs(): Promise<{ fields: FieldSourceConfig[] }> {
  return request('/data-source?type=fields');
}

// 修改字段主备源配置
export async function updateFieldConfig(
  field: string, primary: string[], backup: string[]
): Promise<{ success: boolean; fields: FieldSourceConfig[] }> {
  return request('/data-source', {
    method: 'PUT',
    body: JSON.stringify({ field, primary_sources: primary, backup_sources: backup }),
  });
}

// 强制切源（source=null 清除强制）
export async function forceSwitchSource(
  field: string, source: string | null
): Promise<{ success: boolean; field: string; forced_source: string | null; fields: FieldSourceConfig[] }> {
  return request('/data-source?action=switch', {
    method: 'POST',
    body: JSON.stringify({ field, source }),
  });
}

// 交叉校验历史 + 统计（V4 §4.4）
export async function getCrossCheckHistory(
  opts?: { limit?: number; field?: string; code?: string; stats?: boolean }
): Promise<{ stats?: CrossCheckStats; records: CrossCheckRecord[] }> {
  const params = new URLSearchParams({ type: 'cross-check' });
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.field) params.set('field', opts.field);
  if (opts?.code) params.set('code', opts.code);
  if (opts?.stats) params.set('stats', 'true');
  return request(`/data-source?${params.toString()}`);
}

// 立即对某 ETF 执行交叉校验
export async function runCrossCheck(
  etfCode: string, dataTypes: string[] = ['valuation', 'premium', 'nav']
): Promise<{ etf_code: string; results: CrossCheckRecord[] }> {
  return request('/data-source?action=cross-check/run', {
    method: 'POST',
    body: JSON.stringify({ etf_code: etfCode, data_types: dataTypes }),
  });
}

// 数据血缘查询（V4 §4.5）
export async function getDataLineage(code: string, dataType: string): Promise<DataLineage> {
  const params = new URLSearchParams({ type: 'lineage', code, data_type: dataType });
  return request(`/data-source?${params.toString()}`);
}

// ─── V4.1 §10.8 数据质量评分 ───────────────────────────────────────────────────

export interface QualityScoreItem {
  id: number;
  code: string;
  trade_date: string | null;
  metric_type: string;
  quality_score: number;
  quality_status: 'excellent' | 'usable' | 'suspicious' | 'unavailable';
  freshness_score: number;
  consistency_score: number;
  completeness_score: number;
  abnormal_score: number;
  source_health_score: number;
  can_use_for_rule: boolean;
  can_use_for_strong_rule: boolean;
  reason: string;
  created_at: string;
}

export interface QualitySummary {
  total_metrics: number;
  excellent: number;
  usable: number;
  suspicious: number;
  unavailable: number;
  avg_score: number;
  can_use_for_rule_count: number;
  can_use_for_strong_rule_count: number;
  overall_status: 'excellent' | 'usable' | 'suspicious' | 'unavailable';
  allow_buy_suggestion: boolean;
  allow_rebalance_suggestion: boolean;
  items: QualityScoreItem[];
  // V5.0 E2 数据质量门禁 5 态计数（旧 API 可能不返回）
  gate_status_counts?: {
    valid: number;
    degraded: number;
    stale: number;
    conflict: number;
    missing: number;
  };
}

export interface FetchLogItem {
  request_id: string;
  source_id: string;
  metric_type: string;
  code: string;
  start_date: string | null;
  end_date: string | null;
  status: 'success' | 'error' | 'skipped' | 'no_data' | string;
  row_count: number;
  latency_ms: number;
  error_message: string | null;
  fetch_time: string;
}

// S5-T5: 数据源注册表合并项（含 capabilities + last_status）
export interface DataSourceCapability {
  metric_type: string;
  is_primary: boolean;
  is_backup: boolean;
  is_validator: boolean;
  asset_scope: string;
}

export interface DataSourceLastStatus {
  last_fetch_time?: string;
  last_success_time?: string;
  status?: string;
  error_message?: string;
  latency_ms?: number;
}

export interface DataSourceRegistryItem {
  id: string;
  name: string;
  role: string;                  // primary | backup | reference | validator
  description: string;
  sub_sources: string;
  needs_token: boolean;
  priority: number;
  rate_limit_per_min: number;
  has_token: boolean;
  supported_metrics: string[];
  is_enabled: boolean;
  homepage: string;
  capabilities: DataSourceCapability[];
  last_status: DataSourceLastStatus;
}

// 获取全量数据质量摘要（V4.1 §12.1: GET /api/data-quality/summary）
export async function getQualitySummary(): Promise<QualitySummary> {
  return request<QualitySummary>(`/data-quality?type=summary`);
}

// 获取单只 ETF 的所有指标质量评分（V4.1 §12.1: GET /api/data-quality/{code}）
export async function getQualityByCode(code: string): Promise<{
  code: string;
  items: QualityScoreItem[];
  avg_score: number;
  metric_count: number;
}> {
  const params = new URLSearchParams({ type: 'by-code', code });
  return request(`/data-quality?${params.toString()}`);
}

// 获取数据质量日志（V4.1 §12.1: GET /api/data-quality/logs）
export async function getQualityLogs(
  limit: number = 100,
  status?: 'excellent' | 'usable' | 'suspicious' | 'unavailable'
): Promise<{ logs: QualityScoreItem[] }> {
  const params = new URLSearchParams({ type: 'logs', limit: String(limit) });
  if (status) params.set('status', status);
  return request(`/data-quality?${params.toString()}`);
}

// 获取主备源冲突列表（V4.1 §12.1: GET /api/data-quality/conflicts）
export async function getQualityConflicts(limit: number = 50): Promise<{
  conflicts: QualityScoreItem[];
}> {
  const params = new URLSearchParams({ type: 'conflicts', limit: String(limit) });
  return request(`/data-quality?${params.toString()}`);
}

// 获取数据拉取日志（V4.1 §13.9: data_fetch_log 表）
// 注意：S5-T4 后端端点为 GET /api/data-source/fetch-logs（从 data-quality 路径迁移过来）
export async function getFetchLogs(
  opts: { limit?: number; status?: 'success' | 'error' | 'skipped' | 'no_data'; sourceId?: string; metricType?: string } = {}
): Promise<{ logs: FetchLogItem[]; total: number }> {
  const params = new URLSearchParams({ type: 'fetch-logs' });
  const limit = opts.limit ?? 100;
  params.set('limit', String(limit));
  if (opts.status) params.set('status', opts.status);
  if (opts.sourceId) params.set('source_id', opts.sourceId);
  if (opts.metricType) params.set('metric_type', opts.metricType);
  return request(`/data-source?${params.toString()}`);
}

// V4 Calculation Log (历史建议回溯, 策略书§11 / §10.3)
export interface CalculationLogItem {
  id: number;
  calculationId: string;
  engineVersion: string;
  holdingSnapshotId: string;
  marketDataSnapshotTime: string;
  rulesConfigVersion: string;
  totalBudget: number;
  totalAllocated: number;
  totalRebalanced: number;
  totalUnallocated: number;
  cashDestination: string;
  aiCheckResult: string;
  rulesHitSummary: Array<{ code: string; ruleType: string; ruleName: string; effect: string }> | null;
  dataQualitySummary: Array<{ code: string; qualityStatus: string; isStale: boolean; staleLevel: string; canCalculate: boolean }> | null;
  sourceComparison: { primary: string; backup: string; crossValidated: boolean } | null;
  createdAt: string;
}

export async function getCalculationLogs(limit: number = 20): Promise<{ logs: CalculationLogItem[]; count: number }> {
  return request<{ logs: CalculationLogItem[]; count: number }>(`/calculation-log?limit=${limit}`);
}

// V4 策略书§10.1: 组合最大回撤监控
export interface PortfolioMetrics {
  maxDrawdown: number;
  maxDrawdownPct: number;
  currentValue: number;
  peakValue: number;
  troughValue: number;
  peakTime: string;
  troughTime: string;
  history: Array<{ calculationId: string; investedAssetValue: number; timestamp: string }>;
  message: string;
}

export async function getPortfolioMetrics(): Promise<PortfolioMetrics> {
  return request<PortfolioMetrics>('/portfolio-metrics');
}

// 汇率监控（文档范围外增强）
export interface ForexData {
  rate: number | null;
  date: string;
  history: Array<{ date: string; value: number }>;
  source: string;
  message: string;
}

export async function getForex(): Promise<ForexData> {
  const res = await fetch('/api/data?type=forex');
  if (!res.ok) throw new Error('Failed to fetch forex');
  return res.json();
}

// ─── V4.1 S5-T3/T5/T6/T11: 数据源注册表 + 启用/停用 + Token + 阈值 ────────────

// S5-T5: 获取数据源注册表（含 capabilities + last_status + has_token）
export async function getDataSourceRegistry(): Promise<{ sources: DataSourceRegistryItem[] }> {
  return request('/data-source?type=registry');
}

// S5-T3: 启用数据源
export async function enableDataSource(id: string): Promise<{ success: boolean; id: string; is_enabled: boolean }> {
  return request(`/data-source?action=enable&id=${encodeURIComponent(id)}`, {
    method: 'POST',
  });
}

// S5-T3: 停用数据源
export async function disableDataSource(id: string): Promise<{ success: boolean; id: string; is_enabled: boolean }> {
  return request(`/data-source?action=disable&id=${encodeURIComponent(id)}`, {
    method: 'POST',
  });
}

// S5-T11: 设置数据源 token（加密存储）
export async function setDataSourceToken(id: string, token: string): Promise<{ success: boolean; id: string; has_token: boolean }> {
  return request(`/data-source?action=token&id=${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

// S5-T6: 修改双源校验阈值
export async function updateThreshold(key: string, maxDiff: number): Promise<ThresholdsResponse> {
  return request<ThresholdsResponse>(`/data-source?action=thresholds`, {
    method: 'PUT',
    body: JSON.stringify({ key, max_diff: maxDiff }),
  });
}

// ─── V4.2 PRD§11 宏观温度计 ───────────────────────────────────────────────────

export interface MacroMetricItem {
  metric_type: string;
  name: string;
  current_value: number | null;
  unit: string;
  weekly_change: number | null;
  monthly_change: number | null;
  trade_date: string | null;
  source: string | null;
  quality_status: string;
  affects: string;
  updated_at: string | null;
  // V5.1 新增分类
  category?: string;
  category_label?: string;
}

export interface MacroTemperatureResponse {
  items: MacroMetricItem[];
  updated_at: string;
  // V5.1 新增分类列表
  categories?: Array<{ key: string; label: string }>;
}

export interface MacroPrompt {
  prompt_id: string;
  metric_type: string;
  metric_name: string;
  trigger_type: string;
  current_value: number;
  weekly_change: number;
  threshold: number;
  severity: 'normal' | 'strong';
  prompt_text: string;
  affects: string;
}

export interface MacroPromptsResponse {
  prompts: MacroPrompt[];
  summary: string;
  has_alert: boolean;
}

export interface MacroConfigItem {
  id: string;
  metric_type: string;
  trigger_name: string;
  threshold_value: number;
  threshold_unit: string;
  severity: string;
  enabled: number;
  display_text: string;
  updated_at: string;
}

export async function getMacroTemperature(): Promise<MacroTemperatureResponse> {
  return request<MacroTemperatureResponse>('/macro?type=temperature');
}

export async function getMacroPrompts(): Promise<MacroPromptsResponse> {
  return request<MacroPromptsResponse>('/macro?type=prompts');
}

export async function getMacroHistory(
  metricType: string,
  days: number = 90
): Promise<{
  metric_type: string;
  days: number;
  history: Array<{ date: string; value: number | null; source: string }>;
}> {
  return request(
    `/macro?type=history&metric_type=${encodeURIComponent(metricType)}&days=${days}`
  );
}

export async function refreshMacro(): Promise<{
  success: boolean;
  message: string;
  results: Record<string, number | null>;
}> {
  return request('/macro', { method: 'POST' });
}

export async function getMacroConfig(): Promise<{ configs: MacroConfigItem[] }> {
  return request('/macro?type=config');
}

export async function updateMacroConfig(
  id: string,
  thresholdValue?: number,
  enabled?: boolean
): Promise<{ success: boolean }> {
  return request('/macro', {
    method: 'PUT',
    body: JSON.stringify({ id, threshold_value: thresholdValue, enabled }),
  });
}

// V4.2 P5-C: 重新计算质量评分
// 后端代理：POST /api/data-quality → data-service POST /api/data-quality/recompute
// 基于现有缓存数据重算（约5秒，不重新拉数）
export async function recomputeQuality(): Promise<{
  success: boolean;
  total_metrics: number;
  avg_score: number;
  allow_buy_suggestion: boolean;
  allow_rebalance_suggestion: boolean;
}> {
  return request('/data-quality', { method: 'POST' });
}

// ─── V4.2 P6 后台管理 ───────────────────────────────────────────────────
export interface DbTableInfo {
  name: string;
  rows: number;
  last_update: string;
}
export interface DbStats {
  business: { tables: DbTableInfo[]; file_size: number };
  market: { tables: DbTableInfo[]; file_size: number };
}
export interface TableData {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
  error?: string;
}

export async function getDbStats(): Promise<DbStats> {
  return request<DbStats>('/admin?type=db-stats');
}
export async function getTableData(
  db: string,
  table: string,
  limit = 100
): Promise<TableData> {
  return request<TableData>(
    `/admin?type=table-data&db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&limit=${limit}`
  );
}
export async function clearTable(
  db: string,
  table: string
): Promise<{ success: boolean; table?: string; deleted_rows?: number; error?: string }> {
  return request('/admin', {
    method: 'POST',
    body: JSON.stringify({ action: 'clear-table', db, table, confirm: true }),
  });
}
export async function resetCache(): Promise<{
  success: boolean;
  cleared: Array<{ table: string; deleted?: number; error?: string }>;
}> {
  return request('/admin', {
    method: 'POST',
    body: JSON.stringify({ action: 'reset-cache' }),
  });
}
export async function exportBusinessData(): Promise<{
  data: Record<string, unknown>;
  exported_at: string;
}> {
  return request('/admin?type=export-business');
}
export async function getServiceStatus(): Promise<Record<string, unknown>> {
  return request('/admin?type=service-status');
}

// ─── V5.0 回测验证 ───────────────────────────────────────────────────────────

export interface BacktestEquityPoint {
  date: string;
  value: number;
}

export interface BacktestStrategyStats {
  equityCurve: BacktestEquityPoint[];
  annualReturn: number;
  maxDrawdown: number;
  totalReturn: number;
}

export interface BacktestStrategyFullStats extends BacktestStrategyStats {
  sharpe: number;
}

export interface BacktestResult {
  strategy: BacktestStrategyFullStats;
  dca: BacktestStrategyStats;
  buyhold: BacktestStrategyStats;
  weeklyRecords: number;
  startDate: string;
  endDate: string;
}

export async function runBacktest(params: {
  startDate: string;
  initialCapital: number;
  weeklyBudget: number;
}): Promise<BacktestResult> {
  return request<BacktestResult>('/backtest', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface BacktestHistoryItem {
  calculationId: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  weeklyBudget: number;
  weeklyRecords: number;
  strategyAnnualReturn: number;
  strategyMaxDrawdown: number;
  dcaAnnualReturn: number;
  buyholdAnnualReturn: number;
  createdAt: string;
}

export async function getBacktestHistory(
  limit = 20
): Promise<{ history: BacktestHistoryItem[] }> {
  return request<{ history: BacktestHistoryItem[] }>(
    `/backtest?type=history&limit=${limit}`
  );
}

// ─── V5.0 执行确认 ───────────────────────────────────────────────────────────

export type ExecutionStatus = 'executed' | 'skipped' | 'partial';

export interface ExecutionConfirmItem {
  etfCode: string;
  plannedAmount: number;
  actualAmount: number;
  status: ExecutionStatus;
}

export async function confirmExecution(
  calculationId: string,
  items: ExecutionConfirmItem[]
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/execution', {
    method: 'POST',
    body: JSON.stringify({ calculationId, items }),
  });
}

export interface ExecutionHistoryItem {
  calculationId: string;
  date: string;
  planned: number;
  actual: number;
  deviation: number;
  items: Array<{
    etfCode: string;
    plannedAmount: number;
    actualAmount: number;
    status: ExecutionStatus;
  }>;
}

export async function getExecutionHistory(
  limit = 20
): Promise<{ history: ExecutionHistoryItem[] }> {
  return request<{ history: ExecutionHistoryItem[] }>(
    `/execution?type=history&limit=${limit}`
  );
}

// ─── V5.0 投资收益追踪 ───────────────────────────────────────────────────────

export interface PortfolioPerformancePoint {
  date: string;
  invested: number;
  value: number;
  returnPct: number;
}

export interface PortfolioPerformance {
  totalInvested: number;
  totalValue: number;
  totalReturn: number;
  totalReturnPct: number;
  annualReturn: number;
  vsBenchmark: number;
  history: PortfolioPerformancePoint[];
}

export async function getPortfolioPerformance(): Promise<PortfolioPerformance> {
  return request<PortfolioPerformance>('/portfolio?type=performance');
}

export async function getPortfolioPerformanceHistory(): Promise<{
  history: PortfolioPerformancePoint[];
}> {
  return request('/portfolio?type=history');
}

// ─── V5.0 策略版本 ───
export interface StrategyVersion {
  id: string;
  version: string;
  status: 'draft' | 'active' | 'retired';
  parameters: Record<string, unknown>;
  doc_ref?: string;
  effective_at?: string;
  created_reason?: string;
  confirmed_by?: string;
  created_at?: string;
}

export async function getStrategyVersions(): Promise<{ versions: StrategyVersion[] }> {
  return request('/strategy?type=versions');
}

export async function getActiveStrategyVersion(): Promise<StrategyVersion> {
  return request('/strategy?type=active');
}

export async function activateStrategyVersion(id: string): Promise<{ success: boolean }> {
  return request(`/strategy?action=activate&id=${encodeURIComponent(id)}`, { method: 'POST' });
}

// ─── V5.0 E3 现金账本 ───
export interface CashAccount {
  account_type: string;
  balance: number;
  counts_as_equity_base: boolean;
  description: string;
  flow_count: number;
}
export interface ConservationCheck {
  total_check: boolean;
  total_balance: number;
  account_checks: Array<{
    account: string; opening: number; inflow: number; outflow: number;
    expected_closing: number; actual_closing: number; pass: boolean;
  }>;
}
export interface LedgerEntry {
  cash_ledger_id: string; cash_account_type: string; source_event: string;
  source_etf: string; amount: number; created_at: string; status: string;
  transfer_id: string; entry_type: string;
}
export async function getCashAccounts(): Promise<{ accounts: CashAccount[] }> {
  return request('/cash?type=accounts');
}
export async function getCashLedger(limit = 50): Promise<{ entries: LedgerEntry[] }> {
  return request(`/cash?type=ledger&limit=${limit}`);
}
export async function checkConservation(): Promise<ConservationCheck> {
  return request('/cash?type=conservation');
}

// ─── V5.0 E5 释放计划 ───
export interface ReleasePlan {
  id: string; plan_type: string; account_id: string; state: string;
  weeks_total: number; weeks_remaining: number; balance: number;
  weekly_amount: number; target_etf: string; created_at: string; updated_at: string;
}
export async function getReleasePlans(): Promise<{ plans: ReleasePlan[] }> {
  return request('/release-plans?type=all');
}
export async function pauseReleasePlan(id: string): Promise<{ success: boolean }> {
  return request(`/release-plans?action=pause&id=${id}`, { method: 'POST' });
}
export async function resumeReleasePlan(id: string): Promise<{ success: boolean }> {
  return request(`/release-plans?action=resume&id=${id}`, { method: 'POST' });
}
