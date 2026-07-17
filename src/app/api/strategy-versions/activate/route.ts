import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const activateSchema = z.object({
  id: z.string().min(1),
});

// Valid state transitions for activation:
// Only draft → active is allowed

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = activateSchema.safeParse(body);

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

    const { id } = parsed.data;

    // Fetch the target strategy version
    const target = await db.strategyVersion.findUnique({ where: { id } });

    if (!target) {
      return NextResponse.json(
        { success: false, error: "Strategy version not found" },
        { status: 404 },
      );
    }

    if (target.status !== "draft") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot activate strategy version in "${target.status}" state. Only "draft" versions can be activated.`,
        },
        { status: 409 },
      );
    }

    // Validate target ratios sum to 100% (1000000 bps)
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(target.parameters);
    } catch {
      return NextResponse.json(
        { success: false, error: "Strategy parameters JSON is malformed" },
        { status: 400 },
      );
    }

    const targetRatios = parameters.target_ratios as Record<string, number> | undefined;
    if (targetRatios) {
      const totalBps = Object.values(targetRatios).reduce((sum, v) => sum + v, 0);
      if (totalBps !== 1000000) {
        return NextResponse.json(
          {
            success: false,
            error: `Target ratios must sum to 100% (1000000 bps). Current sum: ${(totalBps / 10000).toFixed(2)}% (${totalBps} bps)`,
          },
          { status: 400 },
        );
      }
    }

    // Use a transaction: retire all active versions, then activate this one
    await db.$transaction(async (tx) => {
      // Retire all currently active versions
      await tx.strategyVersion.updateMany({
        where: { status: "active" },
        data: { status: "retired" },
      });

      // Activate the target version
      await tx.strategyVersion.update({
        where: { id },
        data: {
          status: "active",
          effectiveAt: new Date(),
        },
      });
    });

    // Return the activated version
    const activated = await db.strategyVersion.findUnique({ where: { id } });

    return NextResponse.json({
      success: true,
      data: {
        ...activated,
        parameters: JSON.parse(activated!.parameters),
        effectiveAt: activated!.effectiveAt?.toISOString() ?? null,
      },
      message: "Strategy version activated successfully",
    });
  } catch (error) {
    console.error("[POST /api/strategy-versions/activate] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to activate strategy version" },
      { status: 500 },
    );
  }
}