import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 15;

import {
  placeSingleOrder,
  buildOCCSymbol,
  type SingleLegOrder,
} from '@/lib/providers/tradierPaper';

/**
 * POST /api/paper/trade — Place a paper trade.
 *
 * Body for single-leg:
 * {
 *   type: 'single',
 *   symbol: 'SPY',
 *   expiration: '2025-02-14',
 *   optionType: 'C' | 'P',
 *   strike: 605,
 *   side: 'buy_to_open',
 *   quantity: 1,
 *   orderType: 'market' | 'limit',
 *   limitPrice?: 3.50,
 *   duration?: 'day' | 'gtc',
 *   // Metadata for tracking
 *   thesis?: string,
 *   targetPrice?: number,
 *   stopPrice?: number,
 * }
 *
 * Body for spread (multileg):
 * {
 *   type: 'spread',
 *   symbol: 'SPY',
 *   orderType: 'debit' | 'credit' | 'even' | 'market',
 *   netPrice?: 1.50,
 *   duration?: 'day' | 'gtc',
 *   legs: [
 *     { expiration: '2025-02-14', optionType: 'C', strike: 600, side: 'buy_to_open', quantity: 1 },
 *     { expiration: '2025-02-14', optionType: 'C', strike: 610, side: 'sell_to_open', quantity: 1 },
 *   ],
 *   thesis?: string,
 *   targetPrice?: number,
 *   stopPrice?: number,
 * }
 */
export async function POST(request: NextRequest) {
  if (!process.env.TRADIER_SANDBOX_KEY) {
    return NextResponse.json({ error: 'Paper trading not configured — set TRADIER_SANDBOX_KEY' }, { status: 501 });
  }

  try {
    const body = await request.json();

    if (body.type === 'single') {
      const { symbol, expiration, optionType, strike, side, quantity, orderType, limitPrice, duration } = body;

      if (!symbol || !expiration || !optionType || !strike || !side) {
        return NextResponse.json({ error: 'Missing required fields: symbol, expiration, optionType, strike, side' }, { status: 400 });
      }

      const occSymbol = buildOCCSymbol(symbol, expiration, optionType, strike);

      const order: SingleLegOrder = {
        symbol,
        optionSymbol: occSymbol,
        side,
        quantity: quantity || 1,
        type: orderType || 'market',
        price: limitPrice,
        duration: duration || 'day',
      };

      const result = await placeSingleOrder(order);

      return NextResponse.json({
        success: true,
        orderId: result.id,
        status: result.status,
        occSymbol,
        order: {
          symbol,
          expiration,
          optionType,
          strike,
          side,
          quantity: quantity || 1,
          type: orderType || 'market',
        },
        metadata: {
          thesis: body.thesis || null,
          targetPrice: body.targetPrice || null,
          stopPrice: body.stopPrice || null,
        },
      });
    } else if (body.type === 'spread') {
      const { symbol, duration, legs } = body;

      if (!symbol || !legs || !Array.isArray(legs) || legs.length < 2) {
        return NextResponse.json({ error: 'Missing required fields: symbol, legs (array of 2+ legs)' }, { status: 400 });
      }

      // Build OCC symbols for each leg
      const builtLegs = legs.map((leg: { expiration: string; optionType: 'C' | 'P'; strike: number; side: string; quantity?: number }) => ({
        optionSymbol: buildOCCSymbol(symbol, leg.expiration, leg.optionType, leg.strike),
        side: leg.side as 'buy_to_open' | 'sell_to_open',
        quantity: leg.quantity || 1,
      }));

      // Tradier sandbox multileg orders almost never fill — they return 'ok' (accepted)
      // or 'pending' but the order never transitions to 'filled'. This is a known sandbox
      // limitation, especially with 4-leg iron condors.
      //
      // Strategy: ALWAYS decompose into individual single-leg market orders.
      // Single-leg market orders fill instantly and reliably on the sandbox.
      const legResults: { id: number; status: string; optionSymbol: string }[] = [];
      for (const leg of builtLegs) {
        const legResult = await placeSingleOrder({
          symbol,
          optionSymbol: leg.optionSymbol,
          side: leg.side,
          quantity: leg.quantity,
          type: 'market',
          duration: (duration || 'day') as 'day' | 'gtc',
        });
        legResults.push({ ...legResult, optionSymbol: leg.optionSymbol });
      }
      const result = {
        id: legResults[0].id,
        status: `${legResults.length} legs filled individually`,
      };

      return NextResponse.json({
        success: true,
        orderId: result.id,
        status: result.status,
        legCount: legResults.length,
        legOrderIds: legResults.map(r => r.id),
        legs: legs.map((leg: { expiration: string; optionType: 'C' | 'P'; strike: number; side: string }) => ({
          ...leg,
          occSymbol: buildOCCSymbol(symbol, leg.expiration, leg.optionType, leg.strike),
        })),
        metadata: {
          thesis: body.thesis || null,
          targetPrice: body.targetPrice || null,
          stopPrice: body.stopPrice || null,
        },
      });
    } else {
      return NextResponse.json({ error: 'Invalid type — must be "single" or "spread"' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[paper/trade] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
