import { NextResponse } from 'next/server';
import { getOrders, cancelOrder, getPositions, closePosition, parseOCCSymbol } from '@/lib/providers/tradierPaper';

export const maxDuration = 30;

/**
 * POST /api/paper/reset — Nuclear reset of paper trading account.
 * 1. Cancel all open/pending orders
 * 2. Close all open positions at market
 * Returns summary of actions taken.
 */
export async function POST() {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured' }, { status: 501 });
  }

  const results = {
    ordersCancelled: 0,
    ordersFailedCancel: 0,
    positionsClosed: 0,
    positionsFailedClose: 0,
    details: [] as string[],
  };

  try {
    // 1. Cancel all open/pending orders
    const orders = await getOrders();
    const openOrders = orders.filter(o =>
      o.status === 'pending' || o.status === 'open' || o.status === 'partially_filled'
    );

    for (const o of openOrders) {
      try {
        await cancelOrder(o.id);
        results.ordersCancelled++;
        results.details.push(`Cancelled order ${o.id} (${o.option_symbol || o.symbol})`);
      } catch (e) {
        results.ordersFailedCancel++;
        results.details.push(`Failed to cancel order ${o.id}: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }

    // 2. Close all open positions at market
    const positions = await getPositions();

    for (const p of positions) {
      if (p.quantity === 0) continue;
      try {
        const parsed = parseOCCSymbol(p.symbol);
        const underlying = parsed?.underlying || p.symbol.replace(/\d.*/, '');
        await closePosition(underlying, p.symbol, p.quantity, 'market');
        results.positionsClosed++;
        results.details.push(`Closed ${p.quantity > 0 ? 'long' : 'short'} ${Math.abs(p.quantity)}x ${p.symbol}`);
      } catch (e) {
        results.positionsFailedClose++;
        results.details.push(`Failed to close ${p.symbol}: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }

    return NextResponse.json({
      ok: true,
      ...results,
      message: `Cancelled ${results.ordersCancelled} orders, closed ${results.positionsClosed} positions`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message, ...results }, { status: 500 });
  }
}
