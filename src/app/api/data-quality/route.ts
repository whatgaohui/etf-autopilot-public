import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V4.2 P5-C: POST /api/data-quality — 代理到 data-service 的 /api/data-quality/recompute
// 用于"重新计算质量评分"按钮（约5秒，不重新拉数，只基于现有缓存重算）
export async function POST() {
  try {
    const isUp = await ensureDataServiceRunning();
    if (!isUp) {
      return NextResponse.json(
        { success: false, error: 'data-service unavailable' },
        { status: 503 }
      );
    }
    const resp = await fetch(`${PYTHON_SERVICE}/api/data-quality/recompute`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      return NextResponse.json(
        { success: false, error: `data-service returned ${resp.status}` },
        { status: 502 }
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('data-quality POST (recompute) error:', e);
    return NextResponse.json(
      { success: false, error: 'Failed to recompute quality scores' },
      { status: 500 }
    );
  }
}

// GET /api/data-quality?type=... — 转发到 data-service data-quality 路由
// type 支持: summary | by-code | logs | conflicts | fetch-logs
// 额外 query 参数透传（limit/status/code/source_id）
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'summary';

    // 构建 data-service 端点 + 透传 query
    const passthrough = new URLSearchParams();
    ['limit', 'status', 'source_id'].forEach((k) => {
      const v = searchParams.get(k);
      if (v) passthrough.set(k, v);
    });
    const code = searchParams.get('code');
    const qs = passthrough.toString();

    let endpoint: string;
    switch (type) {
      case 'by-code':
        if (!code) {
          return NextResponse.json({ error: 'code is required for by-code type' }, { status: 400 });
        }
        endpoint = `/api/data-quality/${code}`;
        break;
      case 'logs':
        endpoint = `/api/data-quality/logs/list${qs ? '?' + qs : ''}`;
        break;
      case 'conflicts':
        endpoint = `/api/data-quality/conflicts/list${qs ? '?' + qs : ''}`;
        break;
      case 'fetch-logs':
        endpoint = `/api/data-quality/fetch-logs/list${qs ? '?' + qs : ''}`;
        break;
      case 'summary':
      default:
        endpoint = '/api/data-quality/summary';
        break;
    }

    const resp = await fetch(`${PYTHON_SERVICE}${endpoint}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `data-service returned ${resp.status}` },
        { status: 502 }
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('data-quality GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch data quality info' }, { status: 500 });
  }
}
