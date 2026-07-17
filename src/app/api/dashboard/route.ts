import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fenToYuan, bpsToPercent } from "@/lib/types";
import type { CashAccountType, OrderStatus, ReleasePlanState, QualityStatus } from "@/lib/types";

export const runtime = "nodejs";

// ─── GET: Dashboard aggregation endpoint ──────────────────────

export async function GET() {
  try {
    // 1. Active strategy version
    const activeStrategy = await db.strategyVersion.findFirst({
      where: { status: "active" },
    });

    const activeStrategyDisplay = activeStrategy
      ? {
          id: activeStrategy.id,
          version: activeStrategy.version,
          status: activeStrategy.status,
          parameters: JSON.parse(activeStrategy.parameters),
          docRef: activeStrategy.docRef,
          effectiveAt: activeStrategy.effectiveAt?.toISOString() ?? null,
          createdReason: activeStrategy.createdReason,
          confirmedBy: activeStrategy.confirmedBy,
          createdAt: activeStrategy.createdAt.toISOString(),
          updatedAt: activeStrategy.updatedAt.toISOString(),
        }
      : null;

    // 2. Total portfolio value (sum of all latest holdings' market value)
    const allSnapshots = await db.holdingSnapshot.findMany({
      orderBy: { snapshotDate: "desc" },
    });

    // Get latest snapshot per etfCode
    const latestSnapshots = new Map<string, (typeof allSnapshots)[0]>();
    for (const snap of allSnapshots) {
      if (!latestSnapshots.has(snap.etfCode)) {
        latestSnapshots.set(snap.etfCode, snap);
      }
    }

    let totalPortfolioValueFen = 0;
    for (const snap of latestSnapshots.values()) {
      totalPortfolioValueFen += snap.marketValueFen;
    }

    // 3. Cash totals
    const cashAccounts = await db.cashSubaccount.findMany();
    const cashByType: Partial<Record<CashAccountType, number>> = {};
    let totalCashFen = 0;

    for (const acc of cashAccounts) {
      const yuan = fenToYuan(acc.balanceFen) ?? 0;
      cashByType[acc.accountType as CashAccountType] = yuan;
      totalCashFen += acc.balanceFen;
    }

    // 4. Latest calculation summary
    const latestCalc = await db.calculationLog.findFirst({
      orderBy: { createdAt: "desc" },
    });

    const latestCalcDisplay = latestCalc
      ? {
          id: latestCalc.id,
          calculationId: latestCalc.calculationId,
          strategyVersion: latestCalc.strategyVersion,
          engineVersion: latestCalc.engineVersion,
          eabYuan: fenToYuan(latestCalc.eabFen),
          budgetYuan: fenToYuan(latestCalc.budgetFen),
          totalAllocatedYuan: fenToYuan(latestCalc.totalAllocatedFen),
          totalRebalancedYuan: fenToYuan(latestCalc.totalRebalancedFen),
          totalUnallocatedYuan: fenToYuan(latestCalc.totalUnallocatedFen),
          cashDestination: latestCalc.cashDestination,
          createdAt: latestCalc.createdAt.toISOString(),
        }
      : null;

    // 5. Active execution orders count by status
    const orders = await db.executionOrder.findMany({
      where: {
        status: {
          in: [
            "draft", "calculating", "blocked", "ready_for_review",
            "confirmed", "partially_executed",
          ],
        },
      },
    });

    const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
    for (const order of orders) {
      const s = order.status as OrderStatus;
      ordersByStatus[s] = (ordersByStatus[s] ?? 0) + 1;
    }

    // 6. Data quality summary
    const qualityLogs = await db.dataQualityLog.findMany({
      select: { qualityStatus: true },
    });

    const qualityByStatus: Partial<Record<QualityStatus, number>> = {
      valid: 0,
      degraded: 0,
      stale: 0,
      conflict: 0,
      missing: 0,
    };
    for (const log of qualityLogs) {
      const s = log.qualityStatus as QualityStatus;
      qualityByStatus[s] = (qualityByStatus[s] ?? 0) + 1;
    }

    // 7. Release plans status summary
    const releasePlans = await db.releasePlan.findMany();
    const plansByState: Partial<Record<ReleasePlanState, number>> = {};
    for (const plan of releasePlans) {
      const s = plan.state as ReleasePlanState;
      plansByState[s] = (plansByState[s] ?? 0) + 1;
    }

    const result = {
      activeStrategy: activeStrategyDisplay,
      totalPortfolioValueYuan: fenToYuan(totalPortfolioValueFen),
      cashTotals: {
        totalYuan: fenToYuan(totalCashFen),
        byAccountType: cashByType,
      },
      latestCalculation: latestCalcDisplay,
      executionOrdersByStatus: ordersByStatus,
      dataQualitySummary: {
        total: qualityLogs.length,
        byStatus: qualityByStatus,
      },
      releasePlansByState: plansByState,
    };

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/dashboard] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch dashboard data" },
      { status: 500 },
    );
  }
}