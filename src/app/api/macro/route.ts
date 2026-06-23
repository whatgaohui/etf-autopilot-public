import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/macro?type=temperature|prompts|history|research|config
// POST /api/macro (refresh)
// PUT /api/macro (update config)
// V4.2 PRD§11 宏观温度计 — 转发到 data-service 3031
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'temperature';
  const metricType = request.nextUrl.searchParams.get('metric_type') || '';
  const days = request.nextUrl.searchParams.get('days') || '90';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { items: [], message: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动' },
      { status: 200 }
    );
  }

  let path = '';
  if (type === 'temperature') path = '/api/macro/temperature';
  else if (type === 'prompts') path = '/api/macro/prompts';
  else if (type === 'history')
    path = `/api/macro/history?metric_type=${encodeURIComponent(metricType)}&days=${days}`;
  else if (type === 'research') path = '/api/macro/research';
  else if (type === 'config') path = '/api/macro/config';
  else path = '/api/macro/temperature';

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { items: [], message: `upstream ${response.status}` },
        { status: 200 }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('macro GET proxy error:', error);
    return NextResponse.json(
      { items: [], message: 'fetch failed' },
      { status: 200 }
    );
  }
}

export async function POST() {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { success: false, error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动' },
      { status: 503 }
    );
  }
  try {
    const response = await fetch(`${PYTHON_SERVICE}/api/macro/refresh`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('macro POST proxy error:', error);
    return NextResponse.json(
      { success: false, error: 'refresh failed' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { success: false, error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动' },
      { status: 503 }
    );
  }
  try {
    const body = await request.json();
    const response = await fetch(`${PYTHON_SERVICE}/api/macro/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('macro PUT proxy error:', error);
    return NextResponse.json(
      { success: false, error: 'update failed' },
      { status: 500 }
    );
  }
}
