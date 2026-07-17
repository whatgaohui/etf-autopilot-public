# Task 5: ETF Comparison View + Enhanced Banner + Time Range Selector

## Status: COMPLETED

## Changes Made

### File Modified
- `src/components/trends-tab.tsx`

### A. ETF Comparison Table (New Section)
- Added `EtfComparisonTable` component (lines ~1095-1234)
- Placed after Data Lineage, before closing `</div>`
- 9-column table using shadcn/ui `Table` components
- Columns: ETF, 类别, 目标比例, 当前市值, 实际比例, 偏离, 最新净值, 估值状态, 质量分
- Budget utilization indicator (Progress bar) in card header
- Footer with total market value, timestamp, deviation legend
- Color coding: deviation (3 tiers), valuation (3 tiers), quality (3 tiers)
- Responsive: table has `overflow-x-auto` from shadcn/ui Table container

### B. Enhanced ETF Info Banner
- Added category badge next to ETF code
- Added quality score mini badge (colored)
- Added trend indicator with ArrowUp/ArrowDown + % change
- Vertical separators between groups (hidden on mobile)
- Uses IIFE pattern `{currentConfig && (() => { ... })()}` to compute derived values

### C. Time Range Selector
- Added `TimeRangeSelector` component (lines ~318-344) - pill buttons for 7/30/90 days
- Added `timeRange` state in main component (default: 30)
- `priceData` now uses `timeRange` as dependency
- Chart title dynamic: `{range}日价格走势`
- Selector rendered above chart with label "时间范围"

### Imports Added
- `Table, TableHeader, TableBody, TableHead, TableRow, TableCell` from `@/components/ui/table`
- `Progress` from `@/components/ui/progress`
- `ArrowUp, ArrowDown, TableProperties` from `lucide-react`
- (LineChart, Line from recharts already added by previous agent)

## Verification
- ✅ `bun run lint` — 0 errors
- ✅ Dev server running, all API routes returning 200
- ✅ No indigo/blue colors used
- ✅ Emerald/teal primary palette maintained
- ✅ Font mono for numbers, text-xs/text-[10px] for compact display