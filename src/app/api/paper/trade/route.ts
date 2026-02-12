import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 15;

import {
  placeSingleOrder,
  placeMultiLegOrder,
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
      const { symbol, orderType, netPrice, duration, legs } = body;

      if (!symbol || !legs || !Array.isArray(legs) || legs.length < 2) {
        return NextResponse.json({ error: 'Missing required fields: symbol, legs (array of 2+ legs)' }, { status: 400 });
      }

      // Build OCC symbols for each leg
      const builtLegs = legs.map((leg: { expiration: string; optionType: 'C' | 'P'; strike: number; side: string; quantity?: number }) => ({
        optionSymbol: buildOCCSymbol(symbol, leg.expiration, leg.optionType, leg.strike),
        side: leg.side as 'buy_to_open' | 'sell_to_open',
        quantity: leg.quantity || 1,
      }));

      // For paper trading: try multileg market order first.
      // If explicit netPrice provided with debit/credit type, use that.
      // Otherwise always use market type — no price resolution needed for sandbox.
      const resolvedType = (netPrice != null && orderType && orderType !== 'market')
        ? orderType as 'debit' | 'credit' | 'even'
        : 'market' as const;

      let result: { id: number; status: string };
      let usedFallback = false;

      try {
        result = await placeMultiLegOrder({
          symbol,
          type: resolvedType,
          price: netPrice != null ? netPrice : undefined,
          duration: (duration || 'day') as 'day' | 'gtc',
          legs: builtLegs,
        });

        // Tradier sandbox multileg orders often land as 'pending' and never fill.
        // If the order is pending, cancel it and fall through to single-leg fallback.
        if (result.status === 'pending' || result.status === 'open') {
          try {
            const { cancelOrder } = await import('@/lib/providers/tradierPaper');
            await cancelOrder(result.id);
          } catch { /* best effort cancel */ }
          throw new Error('Multileg order pending — using single-leg fallback');
        }
      } catch {
        // Multileg failed or pending — decompose into individual single-leg market orders.
        // This is the most reliable approach for sandbox.
        usedFallback = true;
        const legResults: { id: number; status: string }[] = [];
        for (const leg of builtLegs) {
          const legResult = await placeSingleOrder({
            symbol,
            optionSymbol: leg.optionSymbol,
            side: leg.side,
            quantity: leg.quantity,
            type: 'market',
            duration: 'day',
          });
          legResults.push(legResult);
        }
        result = { id: legResults[0].id, status: `${legResults.length} legs filled individually` };
      }

      return NextResponse.json({
        success: true,
        orderId: result.id,
        status: result.status,
        usedFallback,
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
