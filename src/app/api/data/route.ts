import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

const validTypes = ['valuation', 'premium', 'nav', 'dividend', 'kline', 'market-index', 'summary', 'forex'];

// GET /api/data?type=valuation|premium|nav|dividend|kline|market-index|summary - Proxy to Python service
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'summary';

  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type parameter. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 }
    );
  }

  // Lazy-start the Python data-service if it's not running.
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    // Service unavailable — return an empty payload so the frontend can render
    // empty states instead of crashing. This keeps the Trends page usable even
    // when the Python service can't start (e.g. missing deps in sandbox).
    const emptyPayload = type === 'summary' ? { items: [], lastUpdated: '' } : [];
    return NextResponse.json(emptyPayload, { status: 200 });
  }

  try {
    const response = await fetch(`${PYTHON_SERVICE}/api/cached/${type}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Return empty payload on non-OK so frontend renders empty state
      const emptyPayload = type === 'summary' ? { items: [], lastUpdated: '' } : [];
      return NextResponse.json(emptyPayload, { status: 200 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to fetch data from data service:', error);
    const emptyPayload = type === 'summary' ? { items: [], lastUpdated: '' } : [];
    return NextResponse.json(emptyPayload, { status: 200 });
  }
}

// POST /api/data - Trigger data refresh
export async function POST() {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      { error: '数据服务未启动，请稍后重试' },
      { status: 503 }
    );
  }

  try {
    // V4.1 S2-T4: refresh 现在通过 fetch_with_fallback 链路，可能尝试 3 个源 + 缓存，
    // 单次刷新最长 ~3 分钟（6 ETF × 4 指标 × 3 源 × 15s 超时）
    const response = await fetch(`${PYTHON_SERVICE}/api/refresh`, {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Data service returned status ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to refresh data:', error);
    return NextResponse.json(
      { error: 'Failed to refresh data from data service' },
      { status: 500 }
    );
  }
}
