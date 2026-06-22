import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/system - Get all system configs
export async function GET() {
  try {
    const configs = await db.systemConfig.findMany();
    return NextResponse.json(configs);
  } catch (error) {
    console.error('Failed to fetch system configs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch system configs' },
      { status: 500 }
    );
  }
}

interface SystemUpdateBody {
  key: string;
  value: string;
}

// PUT /api/system - Update a system config
export async function PUT(request: NextRequest) {
  try {
    const body: SystemUpdateBody = await request.json();

    if (!body.key || body.value === undefined) {
      return NextResponse.json(
        { error: 'key and value are required' },
        { status: 400 }
      );
    }

    const existing = await db.systemConfig.findUnique({
      where: { key: body.key },
    });

    let config;
    if (existing) {
      config = await db.systemConfig.update({
        where: { key: body.key },
        data: { value: body.value },
      });
    } else {
      config = await db.systemConfig.create({
        data: {
          key: body.key,
          value: body.value,
        },
      });
    }

    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to update system config:', error);
    return NextResponse.json(
      { error: 'Failed to update system config' },
      { status: 500 }
    );
  }
}
