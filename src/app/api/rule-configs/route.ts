import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { bpsToPercent } from "@/lib/types";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const updateRuleSchema = z.object({
  id: z.string().min(1),
  ruleValue: z.string(),
  isEnabled: z.boolean().optional(),
  description: z.string().optional(),
  thresholdValue: z.number().int().optional(),
  thresholdValueMax: z.number().int().nullable().optional(),
  applicableCodes: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  effect: z.string().nullable().optional(),
  displayText: z.string().nullable().optional(),
});

// ─── GET: List rule configs ───────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const group = searchParams.get("group");

    const rules = await db.ruleConfig.findMany({
      where: group ? { ruleGroup: group } : undefined,
      orderBy: [{ ruleGroup: "asc" }, { priority: "asc" }],
    });

    const result = rules.map((rule) => ({
      id: rule.id,
      ruleGroup: rule.ruleGroup,
      ruleName: rule.ruleName,
      ruleValue: rule.ruleValue,
      description: rule.description,
      ruleType: rule.ruleType,
      triggerCondition: rule.triggerCondition,
      thresholdValue: rule.thresholdValue,
      thresholdValueBps: bpsToPercent(rule.thresholdValue),
      thresholdValueMax: rule.thresholdValueMax,
      applicableScope: rule.applicableScope,
      applicableCodes: rule.applicableCodes,
      conditionMetric: rule.conditionMetric,
      percentileWindow: rule.percentileWindow,
      operator: rule.operator,
      priority: rule.priority,
      isEnabled: rule.isEnabled,
      sortOrder: rule.sortOrder,
      effect: rule.effect,
      displayText: rule.displayText,
      strategyDocRef: rule.strategyDocRef,
    }));

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/rule-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch rule configs" },
      { status: 500 },
    );
  }
}

// ─── PUT: Update rule config value ────────────────────────────

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updateRuleSchema.safeParse(body);

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

    const rule = await db.ruleConfig.findUnique({ where: { id } });
    if (!rule) {
      return NextResponse.json(
        { success: false, error: "Rule config not found" },
        { status: 404 },
      );
    }

    const updated = await db.ruleConfig.update({
      where: { id },
      data,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...updated,
        thresholdValueBps: bpsToPercent(updated.thresholdValue),
      },
      message: "Rule config updated successfully",
    });
  } catch (error) {
    console.error("[PUT /api/rule-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update rule config" },
      { status: 500 },
    );
  }
}