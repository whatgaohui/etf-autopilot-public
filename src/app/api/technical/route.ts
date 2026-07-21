import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V5.0 Sprint3 E6: 技术执行分类器 — 转发到 data-service 3031
// GET /api/technical?type=classify&code=xxx → 代理到 /api/technical/classify?code=xxx
// GET /api/technical?type=all             → 代理到 /api/technical/classify/all
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'all';
  const code = request.nextUrl.searchParams.get('code') || '';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        items: {},
        message: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 200 }
    );
  }

  let path = '/api/technical/classify/all';
  if (type === 'classify') {
    if (!code) {
      return NextResponse.json(
        { error: '缺少 code 参数' },
        { status: 400 }
      );
    }
    path = `/api/technical/classify?code=${encodeURIComponent(code)}`;
  } else if (type === 'all') {
    path = '/api/technical/classify/all';
  } else {
    return NextResponse.json(
      { error: `Invalid type parameter. Must be one of: classify, all` },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { items: {}, message: `upstream ${response.status}` },
        { status: 200 }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('technical GET proxy error:', error);
    return NextResponse.json(
      { items: {}, message: 'fetch failed' },
      { status: 200 }
    );
  }
}
