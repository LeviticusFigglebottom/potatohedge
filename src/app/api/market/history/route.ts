import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/providers/tradier';
import { getEquityHistory } from '@/lib/providers/polygon';
import type { Interval, OHLCV } from '@/types/market';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const interval = (request.nextUrl.searchParams.get('interval') || '1D') as Interval;

  if (!symbol) {
    return NextResponse.json({ error: 'symbol parameter required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    const isIntraday = ['1min', '5min', '15min'].includes(interval);

    if (isIntraday) {
      // Use Polygon for intraday — gives much more history than Tradier's 5-day limit
      const history = await getPolygonIntraday(ticker, interval);
      return NextResponse.json(history);
    } else {
      // Use Tradier for daily/weekly/monthly (reliable, no extra cost)
      const history = await getHistory(ticker, interval);
      return NextResponse.json(history);
    }
  } catch (error) {
    // Fallback: try the other provider
    try {
      const history = await getHistory(ticker, interval);
      return NextResponse.json(history);
    } catch {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }
}

async function getPolygonIntraday(
  ticker: string,
  interval: Interval
): Promise<OHLCV[]> {
  // Map interval to Polygon multiplier/timespan
  const config: Record<string, { mult: number; span: 'minute' | 'hour'; days: number }> = {
    '1min': { mult: 1, span: 'minute', days: 5 },
    '5min': { mult: 5, span: 'minute', days: 14 },
    '15min': { mult: 15, span: 'minute', days: 21 },
  };

  const { mult, span, days } = config[interval] || config['5min'];
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const bars = await getEquityHistory(
    ticker,
    mult,
    span,
    from.toISOString().split('T')[0],
    to.toISOString().split('T')[0]
  );

  return bars.map(bar => ({
    time: Math.floor(bar.t / 1000), // Polygon timestamps are ms
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));
}
