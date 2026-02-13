import { NextRequest, NextResponse } from 'next/server';
import { getQuotes } from '@/lib/providers/tradier';

export const maxDuration = 15;

/** Batch quote endpoint: /api/market/quotes?symbols=SPY,QQQ,AAPL */
export async function GET(request: NextRequest) {
  const symbolsParam = request.nextUrl.searchParams.get('symbols');
  if (!symbolsParam) {
    return NextResponse.json({ error: 'symbols parameter required' }, { status: 400 });
  }

  const tickers = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) {
    return NextResponse.json({ error: 'no valid symbols' }, { status: 400 });
  }

  // Cap at 50 symbols per request
  const batch = tickers.slice(0, 50);

  try {
    const quotes = await getQuotes(batch);
    return NextResponse.json(quotes);
  } catch {
    return NextResponse.json({ error: 'Quotes unavailable' }, { status: 500 });
  }
}
