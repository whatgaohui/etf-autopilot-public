import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/data-source?type=... — 转发到 data-service
// type 支持: status | thresholds | sources | registry | fields | cross-check | lineage | fetch-logs
// 额外 query 参数透传（limit/field/code/stats/code/data_type/status/source_id/metric_type）
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'status';

    // 构建 data-service 端点 + 透传 query
    const passthrough = new URLSearchParams();
    ['limit', 'field', 'code', 'stats', 'data_type', 'status', 'source_id', 'metric_type'].forEach(k => {
      const v = searchParams.get(k);
      if (v) passthrough.set(k, v);
    });
    const qs = passthrough.toString();

    let endpoint: string;
    switch (type) {
      case 'thresholds':
        endpoint = '/api/data-source/thresholds';
        break;
      case 'sources':
        endpoint = '/api/data-source/sources';
        break;
      case 'registry':
        endpoint = '/api/data-source/registry';
        break;
      case 'fields':
        endpoint = '/api/data-source/fields';
        break;
      case 'cross-check':
        endpoint = `/api/data-source/cross-check${qs ? '?' + qs : ''}`;
        break;
      case 'lineage':
        endpoint = `/api/data-source/lineage${qs ? '?' + qs : ''}`;
        break;
      case 'fetch-logs':
        endpoint = `/api/data-source/fetch-logs${qs ? '?' + qs : ''}`;
        break;
      case 'status':
      default:
        endpoint = '/api/data-source/status';
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
    console.error('data-source GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch data source info' }, { status: 500 });
  }
}

// POST /api/data-source?action=...&id=... — 转发多种 POST 操作
// action 支持: test | switch | cross-check/run | enable | disable | token
// body 透传（test 无 body）
export async function POST(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'test';
    const id = searchParams.get('id') || '';

    let endpoint: string;
    switch (action) {
      case 'switch':
        endpoint = '/api/data-source/switch';
        break;
      case 'cross-check/run':
        endpoint = '/api/data-source/cross-check/run';
        break;
      case 'enable':
        if (!id) {
          return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        }
        endpoint = `/api/data-source/${encodeURIComponent(id)}/enable`;
        break;
      case 'disable':
        if (!id) {
          return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        }
        endpoint = `/api/data-source/${encodeURIComponent(id)}/disable`;
        break;
      case 'token':
        if (!id) {
          return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        }
        endpoint = `/api/data-source/${encodeURIComponent(id)}/token`;
        break;
      case 'test':
      default:
        endpoint = '/api/data-source/test';
        break;
    }

    // test/enable/disable 无 body，其他读 body
    const init: RequestInit = {
      method: 'POST',
      signal: AbortSignal.timeout(action === 'test' ? 30000 : 120000),
    };
    if (action !== 'test' && action !== 'enable' && action !== 'disable') {
      const body = await request.text();
      init.headers = { 'Content-Type': 'application/json' };
      init.body = body;
    }

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
    console.error('data-source POST error:', e);
    return NextResponse.json({ error: 'Failed to perform data source action' }, { status: 500 });
  }
}

// PUT /api/data-source?action=... — 修改字段配置 or 阈值
// action 支持: fields (默认) | thresholds
// body 透传
export async function PUT(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'fields';
    const body = await request.text();

    let endpoint: string;
    switch (action) {
      case 'thresholds':
        endpoint = '/api/data-source/thresholds';
        break;
      case 'fields':
      default:
        endpoint = '/api/data-source/fields';
        break;
    }

    const resp = await fetch(`${PYTHON_SERVICE}${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });

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
    console.error('data-source PUT error:', e);
    return NextResponse.json({ error: 'Failed to update data source config' }, { status: 500 });
  }
}
