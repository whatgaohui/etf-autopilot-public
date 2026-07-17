import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { fenToYuan } from "@/lib/types";
import type { ReleasePlanState, ReleasePlanType } from "@/lib/types";

export const runtime = "nodejs";

// ─── Release Plan State Machine ───────────────────────────────

const VALID_PLAN_TRANSITIONS: Record<ReleasePlanState, ReleasePlanState[]> = {
  idle: ["releasing", "completed"],
  releasing: ["paused", "completed"],
  paused: ["releasing", "completed"],
  completed: [],
};

// ─── Zod Schemas ───────────────────────────────────────────────

const createPlanSchema = z.object({
  planType: z.enum(["qdii_premium", "rebalance_reserve"]),
  accountId: z.string().min(1),
  weeksTotal: z.number().int().min(1).default(8),
  weeksRemaining: z.number().int().min(0).default(8),
  balanceFen: z.number().int().default(0),
  weeklyAmountFen: z.number().int().default(0),
  targetEtf: z.string().optional(),
});

const updatePlanStateSchema = z.object({
  id: z.string().min(1),
  state: z.enum(["idle", "releasing", "paused", "completed"]),
  pausedReason: z.string().optional(),
  // Optional field updates
  weeksRemaining: z.number().int().min(0).optional(),
  balanceFen: z.number().int().min(0).optional(),
  weeklyAmountFen: z.number().int().min(0).optional(),
});

// ─── GET: List all release plans ──────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get("state") as ReleasePlanState | null;
    const planType = searchParams.get("type") as ReleasePlanType | null;

    const where: Record<string, unknown> = {};
    if (state) where.state = state;
    if (planType) where.planType = planType;

    const plans = await db.releasePlan.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { createdAt: "desc" },
    });

    const result = plans.map((plan) => ({
      id: plan.id,
      planType: plan.planType,
      accountId: plan.accountId,
      state: plan.state,
      weeksTotal: plan.weeksTotal,
      weeksRemaining: plan.weeksRemaining,
      balanceFen: plan.balanceFen,
      balanceYuan: fenToYuan(plan.balanceFen),
      weeklyAmountFen: plan.weeklyAmountFen,
      weeklyAmountYuan: fenToYuan(plan.weeklyAmountFen),
      targetEtf: plan.targetEtf,
      pausedReason: plan.pausedReason,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    }));

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/release-plans] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch release plans" },
      { status: 500 },
    );
  }
}

// ─── POST: Create release plan ────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createPlanSchema.safeParse(body);

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

    const {
      planType,
      accountId,
      weeksTotal,
      weeksRemaining,
      balanceFen,
      weeklyAmountFen,
      targetEtf,
    } = parsed.data;

    const plan = await db.releasePlan.create({
      data: {
        planType,
        accountId,
        weeksTotal,
        weeksRemaining,
        balanceFen,
        weeklyAmountFen,
        targetEtf,
        state: "idle",
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...plan,
          balanceYuan: fenToYuan(plan.balanceFen),
          weeklyAmountYuan: fenToYuan(plan.weeklyAmountFen),
          createdAt: plan.createdAt.toISOString(),
          updatedAt: plan.updatedAt.toISOString(),
        },
        message: "Release plan created successfully",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/release-plans] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create release plan" },
      { status: 500 },
    );
  }
}

// ─── PUT: Update release plan state ───────────────────────────

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updatePlanStateSchema.safeParse(body);

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

    const { id, state, pausedReason, weeksRemaining, balanceFen, weeklyAmountFen } =
      parsed.data;

    // Fetch current plan
    const current = await db.releasePlan.findUnique({ where: { id } });

    if (!current) {
      return NextResponse.json(
        { success: false, error: "Release plan not found" },
        { status: 404 },
      );
    }

    // Validate state machine transition
    const allowedTransitions = VALID_PLAN_TRANSITIONS[current.state as ReleasePlanState] ?? [];
    if (!allowedTransitions.includes(state as ReleasePlanState)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid transition from "${current.state}" to "${state}". Allowed: [${allowedTransitions.join(", ")}]`,
        },
        { status: 409 },
      );
    }

    // Validate pausedReason when pausing
    if (state === "paused" && !pausedReason) {
      return NextResponse.json(
        { success: false, error: "pausedReason is required when pausing a release plan" },
        { status: 400 },
      );
    }

    const updateData: Record<string, unknown> = { state };
    if (pausedReason !== undefined) updateData.pausedReason = pausedReason;
    if (weeksRemaining !== undefined) updateData.weeksRemaining = weeksRemaining;
    if (balanceFen !== undefined) updateData.balanceFen = balanceFen;
    if (weeklyAmountFen !== undefined) updateData.weeklyAmountFen = weeklyAmountFen;

    const updated = await db.releasePlan.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...updated,
        balanceYuan: fenToYuan(updated.balanceFen),
        weeklyAmountYuan: fenToYuan(updated.weeklyAmountFen),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
      message: `Release plan state updated to "${state}"`,
    });
  } catch (error) {
    console.error("[PUT /api/release-plans] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update release plan" },
      { status: 500 },
    );
  }
}