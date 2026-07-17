import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { fenToYuan, bpsToPercent, sharesX10000ToActual } from "@/lib/types";

export const runtime = "nodejs";

// ─── Zod Schemas ───────────────────────────────────────────────

const createEtfConfigSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(1).max(100),
  category: z.string().min(1),
  targetRatioBps: z.number().int().min(0).max(1000000).default(0),
  isBlacklisted: z.boolean().default(false),
  isInvestmentTarget: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  assetClass: z.string().default("domestic"),
  role: z.string().default("core"),
});

const updateEtfConfigSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1).max(10).optional(),
  name: z.string().min(1).max(100).optional(),
  category: z.string().min(1).optional(),
  targetRatioBps: z.number().int().min(0).max(1000000).optional(),
  isBlacklisted: z.boolean().optional(),
  isInvestmentTarget: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  assetClass: z.string().optional(),
  role: z.string().optional(),
});

// ─── GET: List all ETF configs with latest holding snapshot ───

export async function GET() {
  try {
    // Get all ETF configs
    const configs = await db.etfConfig.findMany({
      orderBy: { sortOrder: "asc" },
    });

    // Get latest snapshot per etfCode
    // Group by etfCode and pick the most recent
    const allSnapshots = await db.holdingSnapshot.findMany({
      orderBy: { snapshotDate: "desc" },
    });

    const latestSnapshotsByEtf = new Map<string, (typeof allSnapshots)[0]>();
    for (const snap of allSnapshots) {
      if (!latestSnapshotsByEtf.has(snap.etfCode)) {
        latestSnapshotsByEtf.set(snap.etfCode, snap);
      }
    }

    const result = configs.map((config) => {
      const snap = latestSnapshotsByEtf.get(config.code) ?? null;
      return {
        id: config.id,
        code: config.code,
        name: config.name,
        category: config.category,
        targetRatioBps: config.targetRatioBps,
        targetRatioPercent: bpsToPercent(config.targetRatioBps),
        isBlacklisted: config.isBlacklisted,
        isInvestmentTarget: config.isInvestmentTarget,
        sortOrder: config.sortOrder,
        assetClass: config.assetClass,
        role: config.role,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
        latestSnapshot: snap
          ? {
              id: snap.id,
              snapshotDate: snap.snapshotDate.toISOString(),
              shares: snap.shares,
              sharesActual: sharesX10000ToActual(snap.shares),
              costPer10k: snap.costPer10k,
              marketValueFen: snap.marketValueFen,
              marketValueYuan: fenToYuan(snap.marketValueFen),
              currentRatioBps: snap.currentRatioBps,
              currentRatioPercent: bpsToPercent(snap.currentRatioBps),
              source: snap.source,
              ocrConfidence: snap.ocrConfidence,
              isManualCorrected: snap.isManualCorrected,
            }
          : null,
      };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/etf-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch ETF configs" },
      { status: 500 },
    );
  }
}

// ─── POST: Create new ETF config ──────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createEtfConfigSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { code, name, category, targetRatioBps, isBlacklisted, isInvestmentTarget, sortOrder, assetClass, role } =
      parsed.data;

    // Check uniqueness
    const existing = await db.etfConfig.findUnique({ where: { code } });
    if (existing) {
      return NextResponse.json(
        { success: false, error: `ETF config with code "${code}" already exists` },
        { status: 409 },
      );
    }

    const config = await db.etfConfig.create({
      data: {
        code,
        name,
        category,
        targetRatioBps,
        isBlacklisted,
        isInvestmentTarget,
        sortOrder,
        assetClass,
        role,
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: { ...config, targetRatioPercent: bpsToPercent(config.targetRatioBps) },
        message: "ETF config created successfully",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/etf-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create ETF config" },
      { status: 500 },
    );
  }
}

// ─── PUT: Update ETF config ───────────────────────────────────

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updateEtfConfigSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { id, ...data } = parsed.data;

    const config = await db.etfConfig.update({
      where: { id },
      data,
    });

    return NextResponse.json({
      success: true,
      data: { ...config, targetRatioPercent: bpsToPercent(config.targetRatioBps) },
      message: "ETF config updated successfully",
    });
  } catch (error) {
    console.error("[PUT /api/etf-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update ETF config" },
      { status: 500 },
    );
  }
}

// ─── DELETE: Delete ETF config (only if no holdings) ──────────

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing required query param: id" },
        { status: 400 },
      );
    }

    // Check if any holdings exist for this ETF
    const holdingCount = await db.holdingSnapshot.count({
      where: { etfCode: id },
    });

    // Also check by ETF config code
    const config = await db.etfConfig.findUnique({ where: { id } });
    if (!config) {
      return NextResponse.json(
        { success: false, error: "ETF config not found" },
        { status: 404 },
      );
    }

    const holdingCountByCode = await db.holdingSnapshot.count({
      where: { etfCode: config.code },
    });

    if (holdingCountByCode > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete ETF config "${config.code}": ${holdingCountByCode} holding snapshot(s) exist`,
        },
        { status: 409 },
      );
    }

    await db.etfConfig.delete({ where: { id } });

    return NextResponse.json({
      success: true,
      message: "ETF config deleted successfully",
    });
  } catch (error) {
    console.error("[DELETE /api/etf-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete ETF config" },
      { status: 500 },
    );
  }
}