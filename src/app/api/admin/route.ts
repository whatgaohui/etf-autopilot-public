import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V4.2 PRD§16: 后台管理 API 代理 → data-service /api/admin/*
// GET  type=db-stats|table-data|export-business|service-status
// POST action=clear-table|reset-cache
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'db-stats';
  const db = request.nextUrl.searchParams.get('db') || '';
  const table = request.nextUrl.searchParams.get('table') || '';
  const limit = request.nextUrl.searchParams.get('limit') || '100';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动' },
      { status: 503 }
    );
  }

  let path = '';
  if (type === 'db-stats') path = '/api/admin/db-stats';
  else if (type === 'table-data')
    path = `/api/admin/table-data?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&limit=${limit}`;
  else if (type === 'export-business') path = '/api/admin/export-business';
  else if (type === 'service-status') path = '/api/admin/service-status';
  else path = '/api/admin/db-stats';

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('admin GET error:', error);
    return NextResponse.json(
      { error: 'admin request failed' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动' },
      { status: 503 }
    );
  }
  try {
    const body = await request.json();
    const action = body.action || 'clear-table';
    let path = '';
    if (action === 'clear-table') path = '/api/admin/clear-table';
    else if (action === 'reset-cache') path = '/api/admin/reset-cache';
    else path = '/api/admin/clear-table';

    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('admin POST error:', error);
    return NextResponse.json(
      { error: 'admin POST failed' },
      { status: 500 }
    );
  }
}
