import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/calculation-log?limit=20 — 历史建议回溯列表
// GET /api/calculation-log?id=xxx — 单条详情
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const limit = searchParams.get('limit') || '20';

    const endpoint = id
      ? `/api/calculation-log/${id}`
      : `/api/calculation-log?limit=${limit}`;

    const resp = await fetch(`${PYTHON_SERVICE}${endpoint}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `data-service returned ${resp.status}` },
        { status: resp.status }
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('calculation-log GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch calculation logs' }, { status: 500 });
  }
}
