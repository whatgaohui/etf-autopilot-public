import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/rule - Get all rules
export async function GET() {
  try {
    const rules = await db.ruleConfig.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return NextResponse.json(rules);
  } catch (error) {
    console.error('Failed to fetch rules:', error);
    return NextResponse.json(
      { error: 'Failed to fetch rules' },
      { status: 500 }
    );
  }
}

interface RuleCreateBody {
  name: string;
  type: string;
  triggerCondition: string;
  thresholdValue: number;
  thresholdValueMax?: number | null;
  applicableScope: string;
  applicableCodes?: string | null;
  reason: string;
  isEnabled?: boolean;
  sortOrder?: number;
}

interface RuleUpdateBody {
  id: string;
  name?: string;
  type?: string;
  triggerCondition?: string;
  thresholdValue?: number;
  thresholdValueMax?: number | null;
  applicableScope?: string;
  applicableCodes?: string | null;
  reason?: string;
  isEnabled?: boolean;
  sortOrder?: number;
}

// POST /api/rule - Create a new rule
export async function POST(request: NextRequest) {
  try {
    const body: RuleCreateBody = await request.json();

    if (!body.name || !body.type || !body.triggerCondition || body.thresholdValue === undefined) {
      return NextResponse.json(
        { error: 'name, type, triggerCondition, and thresholdValue are required' },
        { status: 400 }
      );
    }

    const rule = await db.ruleConfig.create({
      data: {
        name: body.name,
        type: body.type,
        triggerCondition: body.triggerCondition,
        thresholdValue: body.thresholdValue,
        thresholdValueMax: body.thresholdValueMax ?? null,
        applicableScope: body.applicableScope || 'all',
        applicableCodes: body.applicableCodes ?? null,
        reason: body.reason || '',
        isEnabled: body.isEnabled ?? true,
        sortOrder: body.sortOrder ?? 0,
      },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error('Failed to create rule:', error);
    return NextResponse.json(
      { error: 'Failed to create rule' },
      { status: 500 }
    );
  }
}

// PUT /api/rule - Update a rule (single)
export async function PUT(request: NextRequest) {
  try {
    const body: RuleUpdateBody = await request.json();

    if (!body.id) {
      return NextResponse.json(
        { error: 'Rule id is required' },
        { status: 400 }
      );
    }

    const existing = await db.ruleConfig.findUnique({
      where: { id: body.id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Rule not found' },
        { status: 404 }
      );
    }

    const rule = await db.ruleConfig.update({
      where: { id: body.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.triggerCondition !== undefined && { triggerCondition: body.triggerCondition }),
        ...(body.thresholdValue !== undefined && { thresholdValue: body.thresholdValue }),
        ...(body.thresholdValueMax !== undefined && { thresholdValueMax: body.thresholdValueMax }),
        ...(body.applicableScope !== undefined && { applicableScope: body.applicableScope }),
        ...(body.applicableCodes !== undefined && { applicableCodes: body.applicableCodes }),
        ...(body.reason !== undefined && { reason: body.reason }),
        ...(body.isEnabled !== undefined && { isEnabled: body.isEnabled }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
    });

    return NextResponse.json(rule);
  } catch (error) {
    console.error('Failed to update rule:', error);
    return NextResponse.json(
      { error: 'Failed to update rule' },
      { status: 500 }
    );
  }
}

// DELETE /api/rule?id=xxx - Delete a rule
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Rule id is required' },
        { status: 400 }
      );
    }

    const existing = await db.ruleConfig.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Rule not found' },
        { status: 404 }
      );
    }

    await db.ruleConfig.delete({
      where: { id },
    });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Failed to delete rule:', error);
    return NextResponse.json(
      { error: 'Failed to delete rule' },
      { status: 500 }
    );
  }
}
