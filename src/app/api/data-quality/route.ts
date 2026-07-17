import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { QualityStatus } from "@/lib/types";

export const runtime = "nodejs";

// ─── GET: Data quality summary ────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const etfCode = searchParams.get("etfCode");

    if (etfCode) {
      // Per-ETF quality details
      const logs = await db.dataQualityLog.findMany({
        where: { etfCode },
        orderBy: { createdAt: "desc" },
      });

      const result = logs.map((log) => ({
        id: log.id,
        etfCode: log.etfCode,
        metricName: log.metricName,
        qualityStatus: log.qualityStatus,
        score: log.score,
        freshnessScore: log.freshnessScore,
        consistencyScore: log.consistencyScore,
        completenessScore: log.completenessScore,
        abnormalScore: log.abnormalScore,
        sourceHealthScore: log.sourceHealthScore,
        canUseForRule: log.canUseForRule,
        canUseForStrongRule: log.canUseForStrongRule,
        reason: log.reason,
        createdAt: log.createdAt.toISOString(),
      }));

      return NextResponse.json({ success: true, data: result });
    }

    // Summary: counts by quality_status across all ETFs
    const allLogs = await db.dataQualityLog.findMany({
      select: { qualityStatus: true, etfCode: true },
    });

    const byStatus: Record<string, number> = {
      valid: 0,
      degraded: 0,
      stale: 0,
      conflict: 0,
      missing: 0,
    };

    for (const log of allLogs) {
      byStatus[log.qualityStatus] = (byStatus[log.qualityStatus] ?? 0) + 1;
    }

    // Also get unique ETF count and latest per-ETF summary
    const uniqueEtfs = new Set(allLogs.map((l) => l.etfCode));
    const latestPerEtf = await db.dataQualityLog.groupBy({
      by: ["etfCode"],
      _max: { createdAt: true, score: true },
    });

    return NextResponse.json({
      success: true,
      data: {
        total: allLogs.length,
        uniqueEtfCount: uniqueEtfs.size,
        byStatus,
        latestPerEtf: latestPerEtf.map((e) => ({
          etfCode: e.etfCode,
          latestAt: e._max.createdAt?.toISOString() ?? null,
          maxScore: e._max.score,
        })),
      },
    });
  } catch (error) {
    console.error("[GET /api/data-quality] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch data quality" },
      { status: 500 },
    );
  }
}