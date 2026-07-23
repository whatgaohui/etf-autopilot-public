import { NextRequest, NextResponse } from 'next/server';
import { ensureDataServiceRunning } from '@/lib/data-service';

const PYTHON_SERVICE = 'http://127.0.0.1:3031';

// V5.0 执行确认 — 转发到 data-service 3031
//
// GET /api/execution?type=history                     → 代理到 /api/execution/history
// GET /api/execution?type=orders&calculationId=xxx    → 代理到 /api/execution/orders?calculationId=xxx
// GET /api/execution?type=orders-status&calculationId=xxx → 代理到 /api/execution/orders/status?calculationId=xxx
// GET /api/execution?type=fills&calculationId=xxx&orderId=xxx → 代理到 /api/execution/fills
// GET /api/execution?type=reconciliation&calculationId=xxx → 代理到 /api/execution/reconciliation
//
// POST /api/execution                                  → 代理到 /api/execution/confirm (body 透传)
// POST /api/execution?action=orders-create             → 代理到 /api/execution/orders/create
// POST /api/execution?action=orders-confirm            → 代理到 /api/execution/orders/confirm
// POST /api/execution?action=orders-fill               → 代理到 /api/execution/orders/fill
// POST /api/execution?action=orders-cancel             → 代理到 /api/execution/orders/cancel
// POST /api/execution?action=orders-expire             → 代理到 /api/execution/orders/expire
export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type') || 'history';
  const limit = request.nextUrl.searchParams.get('limit') || '20';
  const calculationId = request.nextUrl.searchParams.get('calculationId') || '';
  const orderId = request.nextUrl.searchParams.get('orderId') || '';

  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        history: [],
        items: [],
        message: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 200 }
    );
  }

  let path = '/api/execution/history';
  if (type === 'history') {
    path = `/api/execution/history?limit=${encodeURIComponent(limit)}`;
  } else if (type === 'orders') {
    const qs = calculationId
      ? `?calculationId=${encodeURIComponent(calculationId)}`
      : '';
    path = `/api/execution/orders${qs}`;
  } else if (type === 'orders-status') {
    const qs = calculationId
      ? `?calculationId=${encodeURIComponent(calculationId)}`
      : '';
    path = `/api/execution/orders/status${qs}`;
  } else if (type === 'fills') {
    // V5.0 Sprint4 E8: 成交记录查询
    const params = new URLSearchParams();
    if (calculationId) params.set('calculationId', calculationId);
    if (orderId) params.set('orderId', orderId);
    if (limit) params.set('limit', limit);
    const qs = params.toString();
    path = `/api/execution/fills${qs ? `?${qs}` : ''}`;
  } else if (type === 'reconciliation') {
    // V5.0 Sprint4 E8: 计划 vs 实际对账
    const qs = calculationId
      ? `?calculationId=${encodeURIComponent(calculationId)}`
      : '';
    path = `/api/execution/reconciliation${qs}`;
  } else {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: history, orders, orders-status, fills, reconciliation` },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const emptyPayload =
        type === 'orders' ? { items: [], total: 0 } :
        type === 'orders-status' ? {
          total: 0, pending: 0, confirmed: 0, rejected: 0,
          executed: 0, partiallyExecuted: 0, cancelled: 0, expired: 0,
          totalPlanned: 0, totalConfirmed: 0,
        } :
        type === 'fills' ? { items: [], total: 0 } :
        type === 'reconciliation' ? {
          items: [], total: 0,
          summary: { totalPlanned: 0, totalActual: 0, totalDeviation: 0, totalDeviationPct: 0 },
        } :
        { history: [] };
      return NextResponse.json(
        { ...emptyPayload, message: `upstream ${response.status}` },
        { status: 200 }
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('execution GET proxy error:', error);
    const emptyPayload =
      type === 'orders' ? { items: [], total: 0 } :
      type === 'orders-status' ? {
        total: 0, pending: 0, confirmed: 0, rejected: 0,
        executed: 0, partiallyExecuted: 0, cancelled: 0, expired: 0,
        totalPlanned: 0, totalConfirmed: 0,
      } :
      type === 'fills' ? { items: [], total: 0 } :
      type === 'reconciliation' ? {
        items: [], total: 0,
        summary: { totalPlanned: 0, totalActual: 0, totalDeviation: 0, totalDeviationPct: 0 },
      } :
      { history: [] };
    return NextResponse.json(
      { ...emptyPayload, message: 'fetch failed' },
      { status: 200 }
    );
  }
}

export async function POST(request: NextRequest) {
  const isUp = await ensureDataServiceRunning();
  if (!isUp) {
    return NextResponse.json(
      {
        success: false,
        error: '数据服务未启动，请在设置页后台管理查看服务状态，或运行 ./start.sh 启动',
      },
      { status: 503 }
    );
  }

  try {
    const body = await request.json();
    const action = request.nextUrl.searchParams.get('action') || 'confirm';

    let path = '/api/execution/confirm';
    if (action === 'confirm') {
      path = '/api/execution/confirm';
    } else if (action === 'orders-create') {
      path = '/api/execution/orders/create';
    } else if (action === 'orders-confirm') {
      path = '/api/execution/orders/confirm';
    } else if (action === 'orders-fill') {
      // V5.0 Sprint4 E8: 成交回填
      path = '/api/execution/orders/fill';
    } else if (action === 'orders-cancel') {
      // V5.0 Sprint4 E8: 撤销订单
      path = '/api/execution/orders/cancel';
    } else if (action === 'orders-expire') {
      // V5.0 Sprint4 E8: 过期清理(无 body 也透传)
      path = '/api/execution/orders/expire';
    } else {
      return NextResponse.json(
        { success: false, error: `Invalid action. Must be one of: confirm, orders-create, orders-confirm, orders-fill, orders-cancel, orders-expire` },
        { status: 400 }
      );
    }

    const response = await fetch(`${PYTHON_SERVICE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('execution POST proxy error:', error);
    return NextResponse.json(
      { success: false, error: '执行确认请求失败，数据服务可能未启动' },
      { status: 500 }
    );
  }
}
