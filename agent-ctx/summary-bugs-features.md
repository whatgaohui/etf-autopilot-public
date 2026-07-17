# ETF Autopilot V5 — Bug Fixes & New Features Worklog

## Date: 2025-07-11

---

## BUG 1: Settings ETF list shows "暂无 ETF 配置" ✅ FIXED

### Root Cause
The Settings page `EtfConfigSection` and the Overview page both used `useQuery` with the **same query key** `['etf-configs']`, but their `queryFn` returned **different data shapes**:
- **Overview**: `queryFn` unwrapped the response → returned `EtfConfigWithSnapshot[]`
- **Settings**: `queryFn` returned the full `ApiResponse<EtfConfigWithSnapshot[]>` wrapper

Since the Overview tab mounts first (it's the first `TabsContent` with `forceMount`), its `queryFn` "wins" as the shared query's fetcher. The cached data is the unwrapped array. When Settings reads `cachedData?.data`, it gets `undefined` (arrays have no `.data` property), resulting in an empty list.

### Fix
1. Changed Settings' ETF query to match Overview's pattern (unwrap in queryFn)
2. Added `staleTime: 0` to force fresh data
3. Added `configs ?? []` safety for initial render when `data` is `undefined`
4. Renamed `configs` to `configsList` where needed for clarity

### Files Changed
- `src/components/settings-tab.tsx` — `EtfConfigSection` useQuery (lines ~493-507)

---

## BUG 2: Settings EAB preview shows ¥0.00 for all accounts ✅ FIXED

### Root Cause
Same query key collision as BUG 1. The `WeeklyBudgetSection` and `CashAccountSection` both used `['cash-accounts']` as query key with different `queryFn` shapes than the Overview's query. Result: `cashRes?.data` was `undefined` → `accounts` was `[]` → all EAB values were 0.

Additionally, the EAB calculation had two bugs:
1. `investEquity` and `unallocatedCash` were **duplicates** (both read `weekly_unallocated_cash`)
2. `committed` (weekly_contribution_committed) was **missing** from the `totalEAB` sum

### Fix
1. Changed both Settings cash account queries to unwrap the response
2. Added `staleTime: 0`
3. Removed duplicate `investEquity` field
4. Added `committed` to the total EAB sum
5. Added "本周承诺注资" row to the EAB preview display

### Files Changed
- `src/components/settings-tab.tsx` — `WeeklyBudgetSection` (lines ~731-743, ~814-834), `CashAccountSection` (lines ~1064-1073)

---

## NEW FEATURE 1: History Log Card in Overview ✅ IMPLEMENTED

### Description
Added a "历史计算记录" card with `Clock` icon between Cash Flow and Release Plans sections.

### Features
- Fetches from `/api/calculation-logs?limit=5`
- Each log shows: calculationId, strategy version, engine version, date, EAB, budget, total allocated, total unallocated
- Clickable rows expand via `Collapsible` to show details
- Expanded view: inputsHash (mono text, truncated to 64 chars), rebalanced amount, cash destination
- Uses `FadeInUp` animation for each item (staggered)
- Proper loading skeleton and error states
- Responsive layout

### Files Changed
- `src/components/overview-tab.tsx` — Added `CalculationHistoryCard` and `CalcHistoryItem` components, imports for `Clock`, `ChevronDown`, `Collapsible`, `FadeInUp`, `CalculationLogDisplay`, `useState`

---

## NEW FEATURE 2: Enhanced Execution Order Cards ✅ IMPLEMENTED

### Description
Enhanced each execution order card in the Weekly Execution Summary section.

### Changes
1. **Colored left border (4px)**: emerald for executed, amber for confirmed/partially_executed, red for blocked, gray for others
2. **Execution mode Badge**: Shows "立即执行"/"分批执行"/"等待回撤"/"仅基础仓" as an outline badge next to the ETF name
3. **Pulse animation**: `animate-pulse` on `ready_for_review` items
4. **Blocked danger style**: Red-tinted background (`bg-red-50/50 dark:bg-red-950/20`), red border, `XCircle` icon, red text
5. **Executed checkmark**: `CheckCircle2` icon in emerald for executed items

### Files Changed
- `src/components/overview-tab.tsx` — Enhanced `WeeklyExecutionSummary` order card rendering (lines ~950-1052), added `CheckCircle2`, `XCircle` imports

---

## NEW FEATURE 3: Dark Mode QA ✅ VERIFIED

### Verification
- Light mode: All cards render correctly, text readable, footer visible
- Dark mode: Toggled via theme button, all cards look good, text colors readable, footer visible
- New calculation history card works in both modes
- Enhanced execution order cards display correctly in both modes
- Settings audit section works in dark mode
- Footer confirmed visible: "ETF Autopilot V5.0 · 不构成投资建议"

---

## NEW FEATURE 4: Calculation History Audit in Settings ✅ IMPLEMENTED

### Description
Added "历史计算审计" AccordionItem after "系统配置" in the Settings tab.

### Features
- Fetches from `/api/calculation-logs?limit=10` (separate query key `['calculation-logs-audit', 10]`)
- Each row shows: date, calculationId (truncated), strategy version, engine version, EAB, budget, total allocated, total unallocated
- Expandable rows via `Collapsible` with chevron rotation animation
- Expanded view shows:
  - **Inputs Hash**: Full hash in `<code>` block
  - **Cash Destination**:的资金去向
  - **Rules Hit Summary**: JSON in `<pre>` block (max-h-40 scrollable)
  - **Data Quality Summary**: JSON in `<pre>` block (max-h-40 scrollable)
- Max height 500px with scrollable container
- Loading skeleton, empty state

### Files Changed
- `src/components/settings-tab.tsx` — Added `CalculationAuditSection` and `CalcAuditRow` components, new AccordionItem, added `Clock`, `ChevronDown`, `CalculationLogDisplay` imports

---

## Lint
All changes pass `bun run lint` with zero errors/warnings.
