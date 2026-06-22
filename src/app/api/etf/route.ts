import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/etf - Get all ETF configs
export async function GET() {
  try {
    const configs = await db.etfConfig.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return NextResponse.json(configs);
  } catch (error) {
    console.error('Failed to fetch ETF configs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch ETF configs' },
      { status: 500 }
    );
  }
}

interface EtfUpdateItem {
  code: string;
  targetRatio?: number;
  isBlacklisted?: boolean;
  isInvestmentTarget?: boolean;
}

// PUT /api/etf - Update ETF target ratios (batch)
export async function PUT(request: NextRequest) {
  try {
    const items: EtfUpdateItem[] = await request.json();

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'Request body must be a non-empty array' },
        { status: 400 }
      );
    }

    const results = await db.$transaction(
      items.map((item) =>
        db.etfConfig.update({
          where: { code: item.code },
          data: {
            ...(item.targetRatio !== undefined && { targetRatio: item.targetRatio }),
            ...(item.isBlacklisted !== undefined && { isBlacklisted: item.isBlacklisted }),
            ...(item.isInvestmentTarget !== undefined && {
              isInvestmentTarget: item.isInvestmentTarget,
            }),
          },
        })
      )
    );

    return NextResponse.json(results);
  } catch (error) {
    console.error('Failed to update ETF configs:', error);
    return NextResponse.json(
      { error: 'Failed to update ETF configs' },
      { status: 500 }
    );
  }
}
