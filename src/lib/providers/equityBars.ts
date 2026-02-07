/**
 * Shared equity history fetcher — tries Polygon first (longer lookback),
 * falls back to Tradier if Polygon returns empty or fails.
 * Returns bars in a unified format: { o, h, l, c, v, t } (chronological, oldest first).
 */

import { getEquityHistory } from '@/lib/providers/polygon';
import { getHistory } from '@/lib/providers/tradier';

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

  // Try Polygon first (better lookback)
  try {
    const bars = await getEquityHistory(ticker, 1, 'day', from, to);
    if (bars.length > 10) {
      console.log(`[equityBars] ${ticker}: Polygon returned ${bars.length} daily bars`);
      return bars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: b.t }));
    }
    console.warn(`[equityBars] ${ticker}: Polygon returned only ${bars.length} bars, falling back to Tradier`);
  } catch (err) {
    console.warn(`[equityBars] ${ticker}: Polygon failed (${err instanceof Error ? err.message : 'unknown'}), falling back to Tradier`);
  }

  // Fallback: Tradier daily history
  try {
    const ohlcv = await getHistory(ticker, '1D', from, to);
    if (ohlcv.length > 0) {
      console.log(`[equityBars] ${ticker}: Tradier fallback returned ${ohlcv.length} daily bars`);
      return ohlcv.map(b => ({
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
        t: b.time * 1000,
      }));
    }
    console.warn(`[equityBars] ${ticker}: Tradier returned 0 bars`);
  } catch (err) {
    console.error(`[equityBars] ${ticker}: Both providers failed. Tradier error: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  return [];
}
