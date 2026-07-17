import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { fenToYuan, sharesX10000ToActual } from "@/lib/types";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const createFillSchema = z.object({
  orderId: z.string().min(1),
  priceFen: z.number().int(),
  sharesX10000: z.number().int(),
  amountFen: z.number().int(),
  feeFen: z.number().int().default(0),
  idempotencyKey: z.string().min(1),
  executedAt: z.string().datetime().optional(),
});

// ─── POST: Record execution fill (idempotent) ─────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createFillSchema.safeParse(body);

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

    const { orderId, priceFen, sharesX10000, amountFen, feeFen, idempotencyKey, executedAt } =
      parsed.data;

    // Check order exists
    const order = await db.executionOrder.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json(
        { success: false, error: "Execution order not found" },
        { status: 404 },
      );
    }

    // Idempotency check: return existing fill if key exists
    const existingFill = await db.executionFill.findUnique({
      where: { idempotencyKey },
    });

    if (existingFill) {
      return NextResponse.json({
        success: true,
        data: {
          ...existingFill,
          sharesActual: sharesX10000ToActual(existingFill.shares),
          amountYuan: fenToYuan(existingFill.amountFen),
          feeYuan: fenToYuan(existingFill.feeFen),
          executedAt: existingFill.executedAt.toISOString(),
          createdAt: existingFill.createdAt.toISOString(),
        },
        message: "Fill already recorded (idempotent)",
      });
    }

    // Create the fill
    const fill = await db.executionFill.create({
      data: {
        orderId,
        priceFen,
        shares: sharesX10000,
        amountFen,
        feeFen,
        idempotencyKey,
        executedAt: executedAt ? new Date(executedAt) : new Date(),
      },
    });

    // Update order's actual amounts (sum of all fills)
    const allFills = await db.executionFill.findMany({ where: { orderId } });
    const totalActualAmountFen = allFills.reduce((sum, f) => sum + f.amountFen, 0);
    const totalActualShares = allFills.reduce((sum, f) => sum + f.shares, 0);

    await db.executionOrder.update({
      where: { id: orderId },
      data: {
        actualAmountFen: totalActualAmountFen,
        actualShares: totalActualShares,
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...fill,
          sharesActual: sharesX10000ToActual(fill.shares),
          amountYuan: fenToYuan(fill.amountFen),
          feeYuan: fenToYuan(fill.feeFen),
          executedAt: fill.executedAt.toISOString(),
          createdAt: fill.createdAt.toISOString(),
        },
        message: "Fill recorded successfully",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/execution-fills] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to record execution fill" },
      { status: 500 },
    );
  }
}