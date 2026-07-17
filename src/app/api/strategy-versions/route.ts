import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const createStrategyVersionSchema = z.object({
  version: z.string().min(1).max(20),
  parameters: z.record(z.unknown()),
  createdReason: z.string().optional(),
  docRef: z.string().optional(),
});

// ─── GET: List all strategy versions ──────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "true";

    const versions = await db.strategyVersion.findMany({
      where: activeOnly ? { status: "active" } : undefined,
      orderBy: { createdAt: "desc" },
    });

    const result = versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      parameters: JSON.parse(v.parameters),
      docRef: v.docRef,
      effectiveAt: v.effectiveAt?.toISOString() ?? null,
      createdReason: v.createdReason,
      confirmedBy: v.confirmedBy,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/strategy-versions] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch strategy versions" },
      { status: 500 },
    );
  }
}

// ─── POST: Create new strategy version (status=draft) ─────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createStrategyVersionSchema.safeParse(body);

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

    const { version, parameters, createdReason, docRef } = parsed.data;

    // Check uniqueness
    const existing = await db.strategyVersion.findUnique({
      where: { version },
    });
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Strategy version "${version}" already exists` },
        { status: 409 },
      );
    }

    const sv = await db.strategyVersion.create({
      data: {
        version,
        status: "draft",
        parameters: JSON.stringify(parameters),
        createdReason,
        docRef,
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...sv,
          parameters: JSON.parse(sv.parameters),
          effectiveAt: sv.effectiveAt?.toISOString() ?? null,
        },
        message: "Strategy version created as draft",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/strategy-versions] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create strategy version" },
      { status: 500 },
    );
  }
}