import { NextRequest, NextResponse } from 'next/server';
import { getQuote } from '@/lib/providers/tradier';
import { getPreviousClose } from '@/lib/providers/polygon';
import type { Quote } from '@/types/market';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol parameter required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    const quote = await getQuote(ticker);
    return NextResponse.json(quote);
  } catch {

    // Fallback: build a basic quote from Polygon previous close
    try {
      const prev = await getPreviousClose(ticker);
      if (prev) {
        const fallbackQuote: Quote = {
          symbol: ticker,
          last: prev.c,
          change: prev.c - prev.o,
          changePct: prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0,
          open: prev.o,
          high: prev.h,
          low: prev.l,
          close: prev.c,
          prevClose: prev.o, // best approximation from prev-day bar
          volume: prev.v,
          avgVolume: 0,
          bid: 0,
          ask: 0,
          bidSize: 0,
          askSize: 0,
          timestamp: Date.now(),
        };
        return NextResponse.json(fallbackQuote);
      }
    } catch { /* Polygon also failed */ }

    return NextResponse.json({ error: 'Quote unavailable' }, { status: 500 });
  }
}
