import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/strategy?type=... — 转发到 data-service strategy router
// type 支持: versions | active
//   - versions → GET /api/strategy/versions
//   - active   → GET /api/strategy/versions/active
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'versions';

    let endpoint: string;
    switch (type) {
      case 'active':
        endpoint = '/api/strategy/versions/active';
        break;
      case 'versions':
      default:
        endpoint = '/api/strategy/versions';
        break;
    }

    const resp = await fetch(`${PYTHON_SERVICE}${endpoint}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return NextResponse.json(
        { error: `data-service returned ${resp.status}`, detail: text },
        { status: resp.status === 404 ? 404 : 502 }
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('strategy GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch strategy info' }, { status: 500 });
  }
}

// POST /api/strategy?action=...&id=... — 转发多种 POST 操作
// action 支持:
//   - create (默认)       → POST /api/strategy/versions (创建新策略版本)
//   - activate&id=xxx     → POST /api/strategy/versions/{id}/activate
//   - snapshot            → POST /api/strategy/snapshot (冻结计算输入快照)
// body 透传 (JSON)
export async function POST(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'create';
    const id = searchParams.get('id') || '';

    let endpoint: string;
    switch (action) {
      case 'activate':
        if (!id) {
          return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        }
        endpoint = `/api/strategy/versions/${encodeURIComponent(id)}/activate`;
        break;
      case 'snapshot':
        endpoint = '/api/strategy/snapshot';
        break;
      case 'create':
      default:
        endpoint = '/api/strategy/versions';
        break;
    }

    const body = await request.text();
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    };

    const resp = await fetch(`${PYTHON_SERVICE}${endpoint}`, init);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return NextResponse.json(
        { error: `data-service returned ${resp.status}`, detail: text },
        { status: 502 }
      );
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('strategy POST error:', e);
    return NextResponse.json({ error: 'Failed to perform strategy action' }, { status: 500 });
  }
}
