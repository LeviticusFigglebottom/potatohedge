import { NextRequest, NextResponse } from 'next/server';
import { getOrders, cancelOrder, parseOCCSymbol } from '@/lib/providers/tradierPaper';

export const maxDuration = 15;

/**
 * GET /api/paper/orders — Get all orders with parsed OCC symbols.
 */
export async function GET() {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured' }, { status: 501 });
  }

  try {
    const orders = await getOrders();

    // Auto-cancel stale pending/open orders older than 5 minutes
    // These are typically from multileg orders that Tradier sandbox never fills
    const now = Date.now();
    const cancelledIds: number[] = [];
    for (const o of orders) {
      if (o.status === 'pending' || o.status === 'open') {
        const createdAt = o.create_date ? new Date(o.create_date).getTime() : 0;
        if (createdAt > 0 && now - createdAt > 5 * 60 * 1000) {
          try {
            await cancelOrder(o.id);
            cancelledIds.push(o.id);
          } catch { /* best effort */ }
        }
      }
    }

    // Filter out cancelled orders from the response
    const activeOrders = orders.filter(o => !cancelledIds.includes(o.id));

    const enriched = activeOrders.map(o => ({
      ...o,
      parsed: o.option_symbol ? parseOCCSymbol(o.option_symbol) : null,
      legs: o.leg?.map(l => ({
        ...l,
        parsed: l.option_symbol ? parseOCCSymbol(l.option_symbol) : null,
      })),
    }));

    return NextResponse.json({
      orders: enriched,
      ...(cancelledIds.length > 0 ? { autoCancelled: cancelledIds.length } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/paper/orders?id=123 — Cancel an order.
 */
export async function DELETE(request: NextRequest) {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured' }, { status: 501 });
  }

  const orderId = request.nextUrl.searchParams.get('id');
  if (!orderId) {
    return NextResponse.json({ error: 'id parameter required' }, { status: 400 });
  }

  try {
    await cancelOrder(parseInt(orderId, 10));
    return NextResponse.json({ success: true, orderId: parseInt(orderId, 10) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
