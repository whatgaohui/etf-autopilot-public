import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Codes that are excluded from investment ratio calculation
// 华宝添益 (511990) = cash reserve, 黄金ETF (518880) = family allocation
// These are included in total assets but excluded from the ratio denominator
// so that the 6 investment ETFs' ratios sum to 100% for target comparison.
const NON_INVESTMENT_CODES = new Set(['511990', '518880']);

// GET /api/holding - Get latest holding snapshot
export async function GET() {
  try {
    // Find the most recent snapshot date
    const latestSnapshot = await db.holdingSnapshot.findFirst({
      orderBy: { snapshotDate: 'desc' },
    });

    if (!latestSnapshot) {
      return NextResponse.json({ snapshotDate: null, holdings: [], totalAssets: 0, investmentAssets: 0 });
    }

    // Get all holdings for that date
    const holdings = await db.holdingSnapshot.findMany({
      where: {
        snapshotDate: latestSnapshot.snapshotDate,
      },
      orderBy: { marketValue: 'desc' },
    });

    const totalAssets = holdings.reduce((sum, h) => sum + h.marketValue, 0);

    // Calculate investment-only total (excluding 华宝添益 and 黄金)
    const investmentAssets = holdings
      .filter((h) => !NON_INVESTMENT_CODES.has(h.etfCode))
      .reduce((sum, h) => sum + h.marketValue, 0);

    // Recalculate currentRatio based on investment-only total for investment targets
    // This ensures ratios sum to 100% and can be compared with target ratios
    const recalculatedHoldings = holdings.map((h) => {
      if (NON_INVESTMENT_CODES.has(h.etfCode)) {
        // Non-investment items keep ratio based on total assets
        return { ...h, currentRatio: totalAssets > 0 ? (h.marketValue / totalAssets) * 100 : 0 };
      }
      // Investment items use investment-only total as denominator
      return { ...h, currentRatio: investmentAssets > 0 ? (h.marketValue / investmentAssets) * 100 : 0 };
    });

    // V4 策略书§10.3: 持仓异常变化检测（本周市值较上周变化超30%提醒）
    const previousSnapshot = await db.holdingSnapshot.findFirst({
      where: { snapshotDate: { lt: latestSnapshot.snapshotDate } },
      orderBy: { snapshotDate: 'desc' },
    });

    let abnormalChanges: Array<{ etfCode: string; etfName: string; previousValue: number; currentValue: number; changePct: number }> = [];
    if (previousSnapshot) {
      const previousHoldings = await db.holdingSnapshot.findMany({
        where: { snapshotDate: previousSnapshot.snapshotDate },
      });
      const prevMap = new Map(previousHoldings.map(h => [h.etfCode, h]));

      for (const h of recalculatedHoldings) {
        const prev = prevMap.get(h.etfCode);
        if (prev && prev.marketValue > 0) {
          const changePct = Math.abs((h.marketValue - prev.marketValue) / prev.marketValue * 100);
          if (changePct > 30) {
            abnormalChanges.push({
              etfCode: h.etfCode,
              etfName: h.etfName,
              previousValue: prev.marketValue,
              currentValue: h.marketValue,
              changePct: parseFloat(changePct.toFixed(1)),
            });
          }
        }
      }
    }

    return NextResponse.json({
      snapshotDate: latestSnapshot.snapshotDate,
      totalAssets,
      investmentAssets,
      holdings: recalculatedHoldings,
      abnormalChanges,
      hasPreviousSnapshot: !!previousSnapshot,
    });
  } catch (error) {
    console.error('Failed to fetch holding snapshot:', error);
    return NextResponse.json(
      { error: 'Failed to fetch holding snapshot' },
      { status: 500 }
    );
  }
}

interface HoldingInput {
  etfCode: string;
  etfName: string;
  shares: number;
  costPrice: number;
  marketValue: number;
  // V4 PRD§12.2: 数据来源
  source?: string; // 'ocr' | 'manual'
  ocrConfidence?: number;
  isManualCorrected?: boolean;
}

interface HoldingPostBody {
  holdings: HoldingInput[];
  snapshotDate: string;
}

// POST /api/holding - Save a new holding snapshot (REPLACE mode: deletes existing data for same date)
export async function POST(request: NextRequest) {
  try {
    const body: HoldingPostBody = await request.json();
    let { holdings, snapshotDate } = body;

    if (!holdings || !Array.isArray(holdings) || holdings.length === 0) {
      return NextResponse.json(
        { error: 'holdings must be a non-empty array' },
        { status: 400 }
      );
    }

    if (!snapshotDate) {
      return NextResponse.json(
        { error: 'snapshotDate is required' },
        { status: 400 }
      );
    }

    // Merge holdings by etfCode (sum marketValue, shares; keep last name/costPrice)
    const mergedMap = new Map<string, HoldingInput>();
    for (const h of holdings) {
      const existing = mergedMap.get(h.etfCode);
      if (existing) {
        existing.marketValue += h.marketValue;
        existing.shares += h.shares;
        // Keep the name from the latest entry
        if (h.etfName) existing.etfName = h.etfName;
      } else {
        mergedMap.set(h.etfCode, { ...h });
      }
    }
    holdings = Array.from(mergedMap.values());

    // Calculate total assets (all holdings including cash and gold)
    const totalAssets = holdings.reduce((sum, h) => sum + h.marketValue, 0);

    if (totalAssets <= 0) {
      return NextResponse.json(
        { error: 'Total assets must be positive' },
        { status: 400 }
      );
    }

    // Calculate investment-only total (excluding 华宝添益 511990 and 黄金ETF 518880)
    // This is used as the denominator for currentRatio so that the 6 investment ETFs
    // ratios sum to 100% and can be directly compared with target ratios.
    const investmentAssets = holdings
      .filter((h) => !NON_INVESTMENT_CODES.has(h.etfCode))
      .reduce((sum, h) => sum + h.marketValue, 0);

    const parsedDate = new Date(snapshotDate);

    // Use transaction: delete existing holdings for same date, then create new ones
    const created = await db.$transaction(async (tx) => {
      // Delete all existing holdings for the same snapshot date
      await tx.holdingSnapshot.deleteMany({
        where: { snapshotDate: parsedDate },
      });

      // Create new holdings
      return Promise.all(
        holdings.map((h) => {
          // Investment targets use investmentAssets as denominator
          // Non-investment items (cash/gold) use totalAssets as denominator
          const denominator = NON_INVESTMENT_CODES.has(h.etfCode) ? totalAssets : investmentAssets;
          return tx.holdingSnapshot.create({
            data: {
              snapshotDate: parsedDate,
              etfCode: h.etfCode,
              etfName: h.etfName,
              shares: h.shares,
              costPrice: h.costPrice,
              marketValue: h.marketValue,
              currentRatio: denominator > 0 ? (h.marketValue / denominator) * 100 : 0,
              // V4 PRD§12.2: 数据来源与校准标记
              source: h.source || 'manual',
              ocrConfidence: h.ocrConfidence ?? null,
              isManualCorrected: h.isManualCorrected ?? false,
            },
          });
        })
      );
    });

    return NextResponse.json({
      snapshotDate: parsedDate,
      totalAssets,
      investmentAssets,
      count: created.length,
      holdings: created,
    });
  } catch (error) {
    console.error('Failed to save holding snapshot:', error);
    return NextResponse.json(
      { error: 'Failed to save holding snapshot' },
      { status: 500 }
    );
  }
}
