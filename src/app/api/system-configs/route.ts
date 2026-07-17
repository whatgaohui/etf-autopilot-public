import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { SystemConfigMap } from "@/lib/types";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const updateConfigSchema = z.object({
  configKey: z.string().min(1),
  configValue: z.string(),
  description: z.string().optional(),
});

// ─── GET: List all system configs as key-value map ────────────

export async function GET() {
  try {
    const configs = await db.systemConfig.findMany({
      orderBy: { configKey: "asc" },
    });

    const kvMap: SystemConfigMap = {};
    for (const config of configs) {
      kvMap[config.configKey] = config.configValue;
    }

    return NextResponse.json({ success: true, data: kvMap });
  } catch (error) {
    console.error("[GET /api/system-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch system configs" },
      { status: 500 },
    );
  }
}

// ─── PUT: Update system config (upsert) ───────────────────────

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = updateConfigSchema.safeParse(body);

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

    const { configKey, configValue, description } = parsed.data;

    const config = await db.systemConfig.upsert({
      where: { configKey },
      update: { configValue, ...(description !== undefined ? { description } : {}) },
      create: { configKey, configValue, description },
    });

    return NextResponse.json({
      success: true,
      data: config,
      message: "System config updated successfully",
    });
  } catch (error) {
    console.error("[PUT /api/system-configs] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update system config" },
      { status: 500 },
    );
  }
}