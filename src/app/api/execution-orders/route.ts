import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { fenToYuan, sharesX10000ToActual } from "@/lib/types";
import type { OrderStatus, ExecutionMode, OrderSide } from "@/lib/types";

export const runtime = "nodejs";

// ─── Order Status State Machine ───────────────────────────────

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["calculating", "blocked", "ready_for_review", "cancelled"],
  calculating: ["ready_for_review", "blocked", "expired", "cancelled"],
  blocked: ["calculating", "ready_for_review", "cancelled"],
  ready_for_review: ["confirmed", "rejected", "expired", "cancelled"],
  confirmed: ["partially_executed", "executed", "cancelled", "expired"],
  rejected: [],
  expired: [],
  partially_executed: ["executed", "cancelled"],
  executed: ["reconciled"],
  cancelled: [],
  reconciled: [],
};

// ─── Zod Schemas ───────────────────────────────────────────────

const createOrderSchema = z.object({
  calculationId: z.string().min(1),
  snapshotId: z.string().optional(),
  etfCode: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  plannedAmountFen: z.number().int().default(0),
  plannedShares: z.number().int().default(0),
  executionMode: z.enum(["immediate", "staged", "wait_pullback", "base_only"]).default("immediate"),
});

const updateOrderStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "draft", "calculating", "blocked", "ready_for_review",
    "confirmed", "rejected", "expired", "partially_executed",
    "executed", "cancelled", "reconciled",
  ]),
  rejectReason: z.string().optional(),
});

// ─── Helper: format order for response ────────────────────────

function formatOrder(order: {
  id: string;
  calculationId: string;
  snapshotId: string | null;
  etfCode: string;
  side: OrderSide;
  plannedAmountFen: number;
  plannedShares: number;
  executionMode: ExecutionMode;
  status: OrderStatus;
  rejectReason: string | null;
  actualAmountFen: number | null;
  actualShares: number | null;
  createdAt: Date;
  updatedAt: Date;
  fills?: {
    id: string;
    orderId: string;
    priceFen: number;
    shares: number;
    amountFen: number;
    feeFen: number;
    executedAt: Date;
    idempotencyKey: string;
    createdAt: Date;
  }[];
}) {
  return {
    id: order.id,
    calculationId: order.calculationId,
    snapshotId: order.snapshotId,
    etfCode: order.etfCode,
    side: order.side,
    plannedAmountFen: order.plannedAmountFen,
    plannedAmountYuan: fenToYuan(order.plannedAmountFen),
    plannedShares: order.plannedShares,
    plannedSharesActual: sharesX10000ToActual(order.plannedShares),
    executionMode: order.executionMode,
    status: order.status,
    rejectReason: order.rejectReason,
    actualAmountFen: order.actualAmountFen,
    actualAmountYuan: fenToYuan(order.actualAmountFen),
    actualShares: order.actualShares,
    actualSharesActual: sharesX10000ToActual(order.actualShares),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    fills: (order.fills ?? []).map((f) => ({
      id: f.id,
      orderId: f.orderId,
      priceFen: f.priceFen,
      shares: f.shares,
      sharesActual: sharesX10000ToActual(f.shares),
      amountFen: f.amountFen,
      amountYuan: fenToYuan(f.amountFen),
      feeFen: f.feeFen,
      feeYuan: fenToYuan(f.feeFen),
      executedAt: f.executedAt.toISOString(),
      idempotencyKey: f.idempotencyKey,
      createdAt: f.createdAt.toISOString(),
    })),
  };
}

// ─── GET: List execution orders with fills ────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") as OrderStatus | null;
    const calculationId = searchParams.get("calculationId");

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (calculationId) where.calculationId = calculationId;

    const orders = await db.executionOrder.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      include: {
        fills: {
          orderBy: { executedAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = orders.map(formatOrder);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/execution-orders] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch execution orders" },
      { status: 500 },
    );
  }
}

// ─── POST: Create new execution order ─────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createOrderSchema.safeParse(body);

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

    const { calculationId, snapshotId, etfCode, side, plannedAmountFen, plannedShares, executionMode } =
      parsed.data;

    const order = await db.executionOrder.create({
      data: {
        calculationId,
        snapshotId,
        etfCode,
        side,
        plannedAmountFen,
        plannedShares,
        executionMode,
        status: "draft",
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: formatOrder({ ...order, fills: [] }),
        message: "Execution order created successfully",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/execution-orders] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create execution order" },
      { status: 500 },
    );
  }
}

// ─── PUT: Update execution order status ───────────────────────

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updateOrderStatusSchema.safeParse(body);

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

    const { id, status, rejectReason } = parsed.data;

    // Fetch current order
    const current = await db.executionOrder.findUnique({ where: { id } });

    if (!current) {
      return NextResponse.json(
        { success: false, error: "Execution order not found" },
        { status: 404 },
      );
    }

    // Validate state machine transition
    const allowedTransitions = VALID_TRANSITIONS[current.status as OrderStatus] ?? [];
    if (!allowedTransitions.includes(status as OrderStatus)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid transition from "${current.status}" to "${status}". Allowed: [${allowedTransitions.join(", ")}]`,
        },
        { status: 409 },
      );
    }

    // Validate rejectReason is provided for rejected status
    if (status === "rejected" && !rejectReason) {
      return NextResponse.json(
        { success: false, error: "rejectReason is required when rejecting an order" },
        { status: 400 },
      );
    }

    const updateData: Record<string, unknown> = { status };
    if (rejectReason) updateData.rejectReason = rejectReason;

    const updated = await db.executionOrder.update({
      where: { id },
      data: updateData,
      include: { fills: { orderBy: { executedAt: "asc" } } },
    });

    return NextResponse.json({
      success: true,
      data: formatOrder(updated),
      message: `Order status updated to "${status}"`,
    });
  } catch (error) {
    console.error("[PUT /api/execution-orders] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update execution order" },
      { status: 500 },
    );
  }
}