import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V5.0 投资收益追踪 — 转发到 data-service 3031
// GET /api/portfolio?type=performance → 代理到 /api/portfolio/performance
// GET /api/portfolio?type=history     → 代理到 /api/portfolio/performance/history
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'performance';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        totalInvested: 0,
        totalValue: 0,
        totalReturn: 0,
        totalReturnPct: 0,
        annualReturn: 0,
        vsBenchmark: 0,
        history: [],
        message: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 200 }
    );
  }

  let path = '/api/portfolio/performance';
  if (type === 'history') {
    path = '/api/portfolio/performance/history';
  }

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return NextResponse.json(
        {
          totalInvested: 0,
          totalValue: 0,
          totalReturn: 0,
          totalReturnPct: 0,
          annualReturn: 0,
          vsBenchmark: 0,
          history: [],
          message: `upstream ${response.status}`,
        },
        { status: 200 }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('portfolio GET proxy error:', error);
    return NextResponse.json(
      {
        totalInvested: 0,
        totalValue: 0,
        totalReturn: 0,
        totalReturnPct: 0,
        annualReturn: 0,
        vsBenchmark: 0,
        history: [],
        message: 'fetch failed',
      },
      { status: 200 }
    );
  }
}
