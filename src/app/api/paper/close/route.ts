import { NextRequest, NextResponse } from 'next/server';
import { closePosition, parseOCCSymbol } from '@/lib/providers/tradierPaper';

/**
 * POST /api/paper/close — Close an open position.
 * Body: { symbol: 'SPY260211C00700000', quantity: 1, orderType?: 'market'|'limit', limitPrice?: 3.50 }
 */
export async function POST(request: NextRequest) {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured' }, { status: 501 });
  }

  try {
    const body = await request.json();
    const { symbol, quantity, orderType, limitPrice } = body;

    if (!symbol || !quantity) {
      return NextResponse.json({ error: 'Missing required fields: symbol, quantity' }, { status: 400 });
    }

    const parsed = parseOCCSymbol(symbol);
    const underlying = parsed?.underlying || symbol.replace(/\d.*/, '');

    const result = await closePosition(
      underlying,
      symbol,
      quantity,
      orderType || 'market',
      limitPrice,
    );

    return NextResponse.json({
      success: true,
      orderId: result.id,
      status: result.status,
      symbol,
      quantity,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[paper/close] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
