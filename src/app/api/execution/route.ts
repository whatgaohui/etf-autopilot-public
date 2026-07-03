import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V5.0 执行确认 — 转发到 data-service 3031
// GET  /api/execution?type=history → 代理到 /api/execution/history
// POST /api/execution               → 代理到 /api/execution/confirm (body 透传)
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'history';
  const limit = request.nextUrl.searchParams.get('limit') || '20';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        history: [],
        message: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 200 }
    );
  }

  let path = '/api/execution/history';
  if (type === 'history') {
    path = `/api/execution/history?limit=${encodeURIComponent(limit)}`;
  }

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { history: [], message: `upstream ${response.status}` },
        { status: 200 }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('execution GET proxy error:', error);
    return NextResponse.json(
      { history: [], message: 'fetch failed' },
      { status: 200 }
    );
  }
}

export async function POST(request: NextRequest) {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        success: false,
        error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const response = await fetch(`${PYTHON_SERVICE}/api/execution/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('execution POST proxy error:', error);
    return NextResponse.json(
      { success: false, error: '执行确认请求失败，数据服务可能未启动' },
      { status: 500 }
    );
  }
}
