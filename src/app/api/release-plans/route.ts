import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/release-plans?type=all|active|...&state=...&id=... — 转发到 data-service release router
// 行为:
//   - type=active (或 ?active=true)  → GET /api/release-plans/active
//   - id=xxx                         → GET /api/release-plans/{id}
//   - state=releasing|paused|idle    → GET /api/release-plans?state=xxx
//   - 其他/all                       → GET /api/release-plans
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'all';
    const activeFlag = searchParams.get('active');
    const state = searchParams.get('state') || '';
    const id = searchParams.get('id') || '';

    let endpoint: string;
    if (id) {
      endpoint = `/api/release-plans/${encodeURIComponent(id)}`;
    } else if (type === 'active' || activeFlag === 'true') {
      endpoint = '/api/release-plans/active';
    } else if (state) {
      endpoint = `/api/release-plans?state=${encodeURIComponent(state)}`;
    } else {
      endpoint = '/api/release-plans';
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
    console.error('release-plans GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch release plans' }, { status: 500 });
  }
}

// POST /api/release-plans?action=create|start|pause|resume|complete|weekly&id=xxx
// - create:   POST /api/release-plans                       (body: planType/accountId/balance/targetEtf/weeks)
// - start:    POST /api/release-plans/{id}/start
// - pause:    POST /api/release-plans/{id}/pause            (body 可选: {reason})
// - resume:   POST /api/release-plans/{id}/resume
// - complete: POST /api/release-plans/{id}/complete
// - weekly:   POST /api/release-plans/{id}/weekly           (body: strategyWeeklyBudget/targetRatio/equityAssetBase/currentEtfValue)
// body 透传 (JSON, 无 body 时传空对象)
export async function POST(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'create';
    const id = searchParams.get('id') || '';

    let endpoint: string;
    switch (action) {
      case 'start':
        if (!id) return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        endpoint = `/api/release-plans/${encodeURIComponent(id)}/start`;
        break;
      case 'pause':
        if (!id) return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        endpoint = `/api/release-plans/${encodeURIComponent(id)}/pause`;
        break;
      case 'resume':
        if (!id) return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        endpoint = `/api/release-plans/${encodeURIComponent(id)}/resume`;
        break;
      case 'complete':
        if (!id) return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        endpoint = `/api/release-plans/${encodeURIComponent(id)}/complete`;
        break;
      case 'weekly':
        if (!id) return NextResponse.json({ error: 'Missing id param' }, { status: 400 });
        endpoint = `/api/release-plans/${encodeURIComponent(id)}/weekly`;
        break;
      case 'create':
      default:
        endpoint = '/api/release-plans';
        break;
    }

    let bodyText = '';
    try {
      bodyText = await request.text();
    } catch {
      bodyText = '';
    }
    if (!bodyText) bodyText = '{}';

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
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
    console.error('release-plans POST error:', e);
    return NextResponse.json({ error: 'Failed to perform release-plan action' }, { status: 500 });
  }
}
