import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fenToYuan } from "@/lib/types";

export const runtime = "nodejs";

// ─── GET: List calculation logs (newest first) ────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") ?? "20", 10);

    const logs = await db.calculationLog.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
    });

    const result = logs.map((log) => ({
      id: log.id,
      calculationId: log.calculationId,
      strategyVersion: log.strategyVersion,
      engineVersion: log.engineVersion,
      inputsHash: log.inputsHash,
      eabFen: log.eabFen,
      eabYuan: fenToYuan(log.eabFen),
      budgetFen: log.budgetFen,
      budgetYuan: fenToYuan(log.budgetFen),
      totalAllocatedFen: log.totalAllocatedFen,
      totalAllocatedYuan: fenToYuan(log.totalAllocatedFen),
      totalRebalancedFen: log.totalRebalancedFen,
      totalRebalancedYuan: fenToYuan(log.totalRebalancedFen),
      totalUnallocatedFen: log.totalUnallocatedFen,
      totalUnallocatedYuan: fenToYuan(log.totalUnallocatedFen),
      cashDestination: log.cashDestination,
      rulesHitSummary: log.rulesHitSummary ? JSON.parse(log.rulesHitSummary) : null,
      dataQualitySummary: log.dataQualitySummary ? JSON.parse(log.dataQualitySummary) : null,
      resultsJson: log.resultsJson ? JSON.parse(log.resultsJson) : null,
      aiExplanationResult: log.aiExplanationResult,
      inputJson: log.inputJson ? JSON.parse(log.inputJson) : null,
      createdAt: log.createdAt.toISOString(),
    }));

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/calculation-logs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch calculation logs" },
      { status: 500 },
    );
  }
}