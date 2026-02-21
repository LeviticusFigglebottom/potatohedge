import { NextRequest, NextResponse } from 'next/server';
import { getHistory, getQuote } from '@/lib/providers/tradier';
import { getEquityHistory } from '@/lib/providers/polygon';
import type { Interval, OHLCV } from '@/types/market';

export const maxDuration = 15;

/**
 * Format a Date as YYYY-MM-DD in US Eastern timezone.
 * Serverless runs in UTC; using ET ensures we request the correct market date.
 */
function toEasternDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Sanitize outlier wicks that distort chart auto-scale.
 * Flash crashes (e.g. SPY briefly hitting $69 on a wick) are real data
 * but make the chart unreadable.
 *
 * KEY FIX: compute local stats from NEIGHBORS ONLY (excluding current bar),
 * so an outlier bar can't pollute its own reference frame.
 * If a wick extends >25% from the neighbor median and no neighbor confirms,
 * clamp the wick to the candle body (open/close).
 */
function sanitizeBars(bars: OHLCV[]): OHLCV[] {
  if (bars.length < 10) return bars;

  const WINDOW = 5;
  const WICK_THRESHOLD = 0.25;

  return bars.map((bar, i) => {
    // NEIGHBORS only — exclude current bar so outlier can't skew its own stats
    const start = Math.max(0, i - WINDOW);
    const end = Math.min(bars.length, i + WINDOW + 1);
    const neighbors: OHLCV[] = [];
    for (let j = start; j < end; j++) {
      if (j !== i) neighbors.push(bars[j]);
    }
    if (neighbors.length < 3) return bar;

    const neighborCloses = neighbors.map(b => b.close).sort((a, b) => a - b);
    const median = neighborCloses[Math.floor(neighborCloses.length / 2)];
    if (median <= 0) return bar;

    let { low, high } = bar;
    const bodyLow = Math.min(bar.open, bar.close);
    const bodyHigh = Math.max(bar.open, bar.close);

    // Check if the low wick is an extreme outlier
    if ((median - low) / median > WICK_THRESHOLD) {
      const nearestNeighborLow = Math.min(...neighbors.map(b => b.low));
      // If no neighbor has a low anywhere near this extreme, it's an outlier
      if (nearestNeighborLow > 0 && (nearestNeighborLow - low) / nearestNeighborLow > 0.15) {
        // Clamp to candle body — removes the outlier wick
        low = bodyLow;
      }
    }

    // Check if the high wick is an extreme outlier
    if ((high - median) / median > WICK_THRESHOLD) {
      const nearestNeighborHigh = Math.max(...neighbors.map(b => b.high));
      if (nearestNeighborHigh > 0 && (high - nearestNeighborHigh) / nearestNeighborHigh > 0.15) {
        high = bodyHigh;
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

  const headers = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

  try {
    const isIntraday = ['1min', '5min', '15min'].includes(interval);

    if (isIntraday) {
      // Polygon for intraday — much longer history than Tradier's 5-day limit
      const history = await getPolygonIntraday(ticker, interval);
      return NextResponse.json(sanitizeBars(history), { headers });
    } else {
      // Try Tradier first for daily/weekly/monthly (no Stocks Basic add-on needed)
      try {
        let history = await getTradierDaily(ticker, interval);
        if (interval === '1D' && history.length > 0) {
          history = await appendTodayBar(ticker, history);
        }
        if (history.length > 10) return NextResponse.json(sanitizeBars(history), { headers });
      } catch { /* fall through to Polygon */ }

      // Fallback to Polygon
      try {
        let history = await getPolygonDaily(ticker, interval);
        if (interval === '1D' && history.length > 0) {
          history = await appendTodayBar(ticker, history);
        }
        if (history.length > 10) return NextResponse.json(sanitizeBars(history), { headers });
      } catch { /* fall through to final Tradier fallback */ }

      // Last resort
      const history = await getHistory(ticker, interval);
      return NextResponse.json(sanitizeBars(history), { headers });
    }
  } catch (error) {
    // Fallback: try the other provider
    try {
      const history = await getHistory(ticker, interval);
      return NextResponse.json(sanitizeBars(history), { headers });
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
    toEasternDate(from),
    toEasternDate(to)
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
    toEasternDate(from),
    toEasternDate(to)
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

async function getTradierDaily(
  ticker: string,
  interval: Interval
): Promise<OHLCV[]> {
  const tradierInterval = interval === '1W' ? '1W' : interval === '1M' ? '1M' : '1D';
  const daysBack = interval === '1M' ? 3650 : interval === '1W' ? 1825 : 750;
  const from = toEasternDate(new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000));
  const to = toEasternDate(new Date());

  return getHistory(ticker, tradierInterval as Interval, from, to);
}

/**
 * Append a synthetic bar for today from the live Tradier quote.
 * This ensures the chart shows current-day price action even though
 * Polygon's daily bar won't be finalized until after market close.
 */
async function appendTodayBar(ticker: string, bars: OHLCV[]): Promise<OHLCV[]> {
  try {
    const lastBar = bars[bars.length - 1];
    const lastBarDate = new Date(lastBar.time * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const todayET = toEasternDate(new Date());

    if (lastBarDate >= todayET) return bars; // Already have today's bar

    const quote = await getQuote(ticker);
    if (!quote.last || quote.last <= 0 || !quote.open || quote.open <= 0) return bars;

    // Create today's bar from quote data
    const todayMidnight = new Date(todayET + 'T00:00:00-05:00').getTime() / 1000;
    bars.push({
      time: todayMidnight,
      open: quote.open,
      high: quote.high || Math.max(quote.open, quote.last),
      low: quote.low || Math.min(quote.open, quote.last),
      close: quote.last,
      volume: quote.volume || 0,
    });
  } catch { /* Ignore — just show bars without today */ }
  return bars;
}
