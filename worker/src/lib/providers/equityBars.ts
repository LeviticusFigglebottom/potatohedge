/**
 * Shared equity history fetcher — tries Tradier first (included with Options plan,
 * no Stocks Basic add-on needed), falls back to Polygon if Tradier fails.
 * Returns bars in a unified format: { o, h, l, c, v, t } (chronological, oldest first).
 */

import { getEquityHistory } from './polygon.js';
import { getHistory } from './tradier.js';

export interface EquityBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number; // ms timestamp
}

/**
 * Fetch daily equity bars with automatic fallback.
 * @param ticker - Stock symbol
 * @param days - How many days of history to request (default 400)
 * @returns Array of bars, chronological (oldest first)
 */
export async function fetchEquityBars(
  ticker: string,
  days: number = 400
): Promise<EquityBar[]> {
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  // Try Tradier first (included with Options plan — no extra subscription needed)
  try {
    const ohlcv = await getHistory(ticker, '1D', from, to);
    if (ohlcv.length > 10) {
      return ohlcv.map(b => ({
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
        t: b.time * 1000,
      }));
    }
  } catch {
    // Tradier failed — fall back to Polygon
  }

  // Fallback: Polygon daily history
  try {
    const bars = await getEquityHistory(ticker, 1, 'day', from, to);
    if (bars.length > 0) {
      return bars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: b.t }));
    }
  } catch {
    // Both providers failed
  }

  return [];
}
