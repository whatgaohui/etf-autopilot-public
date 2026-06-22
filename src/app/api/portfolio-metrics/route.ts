import { NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

export async function GET() {
  try {
    await ensureDataServiceRunning();
    const resp = await fetch(`${PYTHON_SERVICE}/api/portfolio-metrics`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return NextResponse.json({ error: `data-service returned ${resp.status}` }, { status: 502 });
    }
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    console.error('portfolio-metrics GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch portfolio metrics' }, { status: 500 });
  }
}
