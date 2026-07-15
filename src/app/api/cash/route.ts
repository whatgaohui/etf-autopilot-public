import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// GET /api/cash?type=...&limit=... — 转发到 data-service cash router
// type 支持:
//   - accounts     → GET /api/cash/accounts
//   - ledger       → GET /api/cash/ledger?limit=...
//   - transfers    → GET /api/cash/transfers?limit=...
//   - conservation → GET /api/cash/conservation
export async function GET(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'accounts';
    const limit = searchParams.get('limit') || '50';

    let endpoint: string;
    switch (type) {
      case 'ledger':
        endpoint = `/api/cash/ledger?limit=${encodeURIComponent(limit)}`;
        break;
      case 'transfers':
        endpoint = `/api/cash/transfers?limit=${encodeURIComponent(limit)}`;
        break;
      case 'conservation':
        endpoint = '/api/cash/conservation';
        break;
      case 'accounts':
      default:
        endpoint = '/api/cash/accounts';
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
    console.error('cash GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch cash info' }, { status: 500 });
  }
}

// POST /api/cash?action=transfer|reverse — 转发到 data-service cash router
// body 透传 (JSON)
export async function POST(request: Request) {
  try {
    await ensureDataServiceRunning();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'transfer';

    let endpoint: string;
    switch (action) {
      case 'reverse':
        endpoint = '/api/cash/reverse';
        break;
      case 'transfer':
      default:
        endpoint = '/api/cash/transfer';
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
    console.error('cash POST error:', e);
    return NextResponse.json({ error: 'Failed to perform cash action' }, { status: 500 });
  }
}
