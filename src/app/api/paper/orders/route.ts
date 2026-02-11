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

    const enriched = orders.map(o => ({
      ...o,
      parsed: o.option_symbol ? parseOCCSymbol(o.option_symbol) : null,
      legs: o.leg?.map(l => ({
        ...l,
        parsed: l.option_symbol ? parseOCCSymbol(l.option_symbol) : null,
      })),
    }));

    return NextResponse.json({ orders: enriched });
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
