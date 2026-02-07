import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/providers/tradier';
import { getEquityHistory } from '@/lib/providers/polygon';
import type { Interval, OHLCV } from '@/types/market';

/**
 * Sanitize outlier wicks that distort chart auto-scale.
 * Flash crashes (e.g. SPY briefly hitting $69 on a wick) are real data
 * but make the chart unreadable. We detect and clamp extreme wicks
 * while preserving legitimate volatile moves.
 *
 * Logic: for each bar, compare its high/low to a local median of closes.
 * If a wick extends more than 40% from the local median and is far outside
 * the local price range, clamp it to a reasonable multiple of local ATR.
 */
function sanitizeBars(bars: OHLCV[]): OHLCV[] {
  if (bars.length < 10) return bars;

  const WINDOW = 5; // look at ±5 neighbors
  const WICK_THRESHOLD = 0.30; // 30% deviation from local median = suspicious

  return bars.map((bar, i) => {
    // Get local window of closes
    const start = Math.max(0, i - WINDOW);
    const end = Math.min(bars.length, i + WINDOW + 1);
    const localCloses = bars.slice(start, end).map(b => b.close).sort((a, b) => a - b);
    const median = localCloses[Math.floor(localCloses.length / 2)];

    if (median <= 0) return bar;

    // Local high/low range for "normal" wicks
    const localHighs = bars.slice(start, end).map(b => b.high);
    const localLows = bars.slice(start, end).map(b => b.low);
    const localMax = Math.max(...localHighs);
    const localMin = Math.min(...localLows);
    const localRange = localMax - localMin;
    // Allow wicks up to 3x the local range beyond the local extremes
    const clampBuffer = Math.max(localRange * 3, median * 0.05);

    let { low, high } = bar;

    // Check if the low wick is an extreme outlier
    if ((median - low) / median > WICK_THRESHOLD) {
      // Wick is >30% below median — check if any neighbor is also this low
      const neighborLows = bars.slice(start, end)
        .filter((_, j) => j + start !== i)
        .map(b => b.low);
      const nearestNeighborLow = Math.min(...neighborLows);

      // If no neighbor is anywhere near this low, it's an outlier wick
      if ((nearestNeighborLow - low) / nearestNeighborLow > 0.15) {
        low = Math.max(low, localMin - clampBuffer);
        // Ensure low doesn't go below body
        low = Math.min(low, Math.min(bar.open, bar.close));
      }
    }

    // Check if the high wick is an extreme outlier (same logic, inverted)
    if ((high - median) / median > WICK_THRESHOLD) {
      const neighborHighs = bars.slice(start, end)
        .filter((_, j) => j + start !== i)
        .map(b => b.high);
      const nearestNeighborHigh = Math.max(...neighborHighs);

      if ((high - nearestNeighborHigh) / nearestNeighborHigh > 0.15) {
        high = Math.min(high, localMax + clampBuffer);
        high = Math.max(high, Math.max(bar.open, bar.close));
      }
    }

    if (low === bar.low && high === bar.high) return bar;
    return { ...bar, low, high };
  });
}

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
      // Polygon for intraday — much longer history than Tradier's 5-day limit
      const history = await getPolygonIntraday(ticker, interval);
      return NextResponse.json(sanitizeBars(history));
    } else {
      // Use Polygon for daily/weekly too — 2+ year lookback vs Tradier's ~1 year
      try {
        const history = await getPolygonDaily(ticker, interval);
        if (history.length > 10) return NextResponse.json(sanitizeBars(history));
      } catch { /* fall through to Tradier */ }

      // Fallback to Tradier
      const history = await getHistory(ticker, interval);
      return NextResponse.json(sanitizeBars(history));
    }
  } catch (error) {
    // Fallback: try the other provider
    try {
      const history = await getHistory(ticker, interval);
      return NextResponse.json(sanitizeBars(history));
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
    '1min': { mult: 1, span: 'minute', days: 7 },
    '5min': { mult: 5, span: 'minute', days: 30 },
    '15min': { mult: 15, span: 'minute', days: 60 },
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

async function getPolygonDaily(
  ticker: string,
  interval: Interval
): Promise<OHLCV[]> {
  const config: Record<string, { mult: number; span: 'day' | 'week' | 'month'; days: number }> = {
    '1D': { mult: 1, span: 'day', days: 750 },     // ~2+ years
    '1W': { mult: 1, span: 'week', days: 1825 },    // ~5 years
    '1M': { mult: 1, span: 'month', days: 3650 },   // ~10 years
  };

  const { mult, span, days } = config[interval] || config['1D'];
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
    time: Math.floor(bar.t / 1000),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));
}
