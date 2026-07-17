import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fenToYuan } from "@/lib/types";

export const runtime = "nodejs";

// ─── GET: Single calculation log with full details ────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const log = await db.calculationLog.findUnique({
      where: { id },
    });

    if (!log) {
      return NextResponse.json(
        { success: false, error: "Calculation log not found" },
        { status: 404 },
      );
    }

    const result = {
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
    };

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/calculation-logs/:id] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch calculation log" },
      { status: 500 },
    );
  }
}