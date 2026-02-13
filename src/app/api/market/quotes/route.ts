import { NextRequest, NextResponse } from 'next/server';
import { getQuotes } from '@/lib/providers/tradier';
import type { Quote } from '@/types/market';

export const maxDuration = 30;

/** Batch quote endpoint: /api/market/quotes?symbols=SPY,QQQ,AAPL,...
 *  Handles any number of symbols by batching 40 at a time to Tradier. */
export async function GET(request: NextRequest) {
  const symbolsParam = request.nextUrl.searchParams.get('symbols');
  if (!symbolsParam) {
    return NextResponse.json({ error: 'symbols parameter required' }, { status: 400 });
  }

  const tickers = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) {
    return NextResponse.json({ error: 'no valid symbols' }, { status: 400 });
  }

  const allQuotes: Quote[] = [];
  const BATCH_SIZE = 40;

  // Batch to Tradier in chunks of 40
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await getQuotes(batch);
      allQuotes.push(...quotes);
    } catch {
      // Continue with remaining batches on error
    }
  }

  return NextResponse.json(allQuotes);
}
