import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/providers/tradier';

export const maxDuration = 15;

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';

/**
 * Module-level state for "polygon key is present but tier is deactivated".
 * Once we observe an auth/quota failure, we skip Polygon for 15 minutes
 * before retrying — avoids hammering a deactivated key while still letting
 * a re-subscription become visible automatically without a redeploy.
 */
let polygonDeactivatedUntil = 0;
const POLYGON_BACKOFF_MS = 15 * 60 * 1000;

function markPolygonDeactivated() {
  polygonDeactivatedUntil = Date.now() + POLYGON_BACKOFF_MS;
}

function isPolygonAvailable(): boolean {
  return POLYGON_API_KEY.length > 0 && Date.now() >= polygonDeactivatedUntil;
}

/**
 * Polygon's bar shape, which the AVWAP client (src/lib/avwap.ts:Bar)
 * consumes directly. `t` is unix milliseconds, OHLCV are obvious, `vw`
 * is the bar's volume-weighted price (optional — Tradier doesn't expose it).
 */
interface PolygonBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

/**
 * Fetch with retry on 429 (rate limit) responses.
 * Polygon Options Starter allows 5 req/min — the main dashboard may
 * exhaust the budget before AVWAP requests fire.
 */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 429 && attempt < retries) {
      // Exponential backoff: 2s, 4s, 8s
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      continue;
    }
    return response;
  }
  // Should never reach here, but satisfy TypeScript
  throw new Error('Retry exhausted');
}

/**
 * Map AVWAP UI's (multiplier, timespan) tuple to Tradier's Interval format
 * and (when multiplier doesn't fit Tradier) a post-fetch aggregation factor.
 *
 * AVWAP UI presets (src/components/avwap/AVWAPTab.tsx:31-35):
 *   5m  → multiplier=5,  timespan=minute
 *   15m → multiplier=15, timespan=minute
 *   1H  → multiplier=1,  timespan=hour
 *   4H  → multiplier=4,  timespan=hour    (aggregate 4× from 1h bars)
 *   1D  → multiplier=1,  timespan=day
 */
type TradierInterval = '1min' | '5min' | '15min' | '1h' | '1D' | '1W' | '1M';

function tradierMapping(
  multiplier: number,
  timespan: string,
): { interval: TradierInterval; aggregate: number } | null {
  if (timespan === 'minute' && multiplier === 5) return { interval: '5min', aggregate: 1 };
  if (timespan === 'minute' && multiplier === 15) return { interval: '15min', aggregate: 1 };
  if (timespan === 'hour' && multiplier === 1) return { interval: '1h', aggregate: 1 };
  if (timespan === 'hour' && multiplier === 4) return { interval: '1h', aggregate: 4 };
  if (timespan === 'day' && multiplier === 1) return { interval: '1D', aggregate: 1 };
  return null;
}

/** Aggregate N base bars into one (for 4H ← 4×1H, etc.). */
function aggregateBars(bars: PolygonBar[], n: number): PolygonBar[] {
  if (n <= 1) return bars;
  const out: PolygonBar[] = [];
  for (let i = 0; i < bars.length; i += n) {
    const chunk = bars.slice(i, i + n);
    if (chunk.length === 0) continue;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((b) => b.h)),
      l: Math.min(...chunk.map((b) => b.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((a, b) => a + b.v, 0),
    });
  }
  return out;
}

/**
 * Fallback: fetch bars from Tradier and convert to Polygon's bar shape.
 *
 * Tradier intraday history is shallower than Polygon's, and the exact limit
 * varies by tier and resolution (typically ~40 calendar days for minute
 * bars, ~90 for daily). When the requested `from` predates Tradier's limit,
 * the API returns HTTP 400 with a body like
 *   "Invalid parameter, start: must be on or after YYYY-MM-DD HH:MM:SS"
 * — we parse that date out and retry once with the clamped start. The
 * caller learns about the truncation via the returned `clampedFrom` field
 * (so the UI can surface a "data clipped" banner).
 */
interface TradierBarsResult {
  bars: PolygonBar[];
  clampedFrom?: string;
}

async function fetchTradierBars(
  ticker: string,
  multiplier: number,
  timespan: string,
  from: string,
  to: string,
): Promise<TradierBarsResult> {
  const mapping = tradierMapping(multiplier, timespan);
  if (!mapping) {
    throw new Error(`Tradier fallback does not support ${multiplier} ${timespan} bars`);
  }

  const tryFetch = async (startDate: string): Promise<PolygonBar[]> => {
    const ohlcv = await getHistory(ticker, mapping.interval, startDate, to);
    return ohlcv.map((b) => ({
      t: b.time * 1000,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
    }));
  };

  let baseBars: PolygonBar[];
  let clampedFrom: string | undefined;
  try {
    baseBars = await tryFetch(from);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Tradier sends back: "must be on or after 2026-02-27 00:00:00"
    const match = msg.match(/on or after (\d{4}-\d{2}-\d{2})/);
    if (!match) throw err;
    clampedFrom = match[1];
    baseBars = await tryFetch(clampedFrom);
  }

  return { bars: aggregateBars(baseBars, mapping.aggregate), clampedFrom };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const ticker = searchParams.get('ticker');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const timespan = searchParams.get('timespan') || 'hour';
  const multiplierStr = searchParams.get('multiplier') || '1';
  const multiplier = parseInt(multiplierStr, 10);

  if (!ticker || !from || !to) {
    return NextResponse.json({ error: 'ticker, from, and to are required' }, { status: 400 });
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return NextResponse.json({ error: 'multiplier must be a positive integer' }, { status: 400 });
  }

  const upperTicker = ticker.toUpperCase();

  // ── Try Polygon first if available ──────────────────────────────────
  if (isPolygonAvailable()) {
    try {
      let allBars: PolygonBar[] = [];
      let url: string | null = `https://api.polygon.io/v2/aggs/ticker/${upperTicker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;

      while (url) {
        const response: Response = await fetchWithRetry(url);

        // Auth / quota failures → mark Polygon deactivated, fall through to Tradier
        if (response.status === 401 || response.status === 403 || response.status === 429) {
          markPolygonDeactivated();
          break;
        }

        if (!response.ok) {
          // Other Polygon errors — return as-is (don't poison the deactivation cache)
          const errMsg = await parsePolygonError(response);
          return NextResponse.json({ error: errMsg }, { status: response.status });
        }
        const data = await response.json();
        if (data.results) allBars = allBars.concat(data.results);
        url = data.next_url ? `${data.next_url}&apiKey=${POLYGON_API_KEY}` : null;
      }

      // Polygon delivered bars → return them
      if (allBars.length > 0) {
        return NextResponse.json({ bars: allBars, ticker: upperTicker, source: 'polygon' });
      }
      // Else fall through to Tradier (covers the "marked deactivated mid-loop" path
      // and the "Polygon returned 200 but empty" edge case)
    } catch (err) {
      // Network/timeout errors → don't deactivate; just try Tradier this request
      console.error('[avwap] Polygon fetch failed, falling back to Tradier:', err);
    }
  }

  // ── Tradier fallback ────────────────────────────────────────────────
  try {
    const { bars, clampedFrom } = await fetchTradierBars(upperTicker, multiplier, timespan, from, to);
    return NextResponse.json({
      bars,
      ticker: upperTicker,
      source: 'tradier',
      ...(clampedFrom ? { clampedFrom, requestedFrom: from } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `AVWAP data unavailable from both Polygon and Tradier: ${message}` },
      { status: 500 },
    );
  }
}

async function parsePolygonError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const data = JSON.parse(text);
    if (data.error) return data.error;
    if (data.message) return data.message;
    return `Polygon API error (${response.status})`;
  } catch {
    return `Polygon API error (${response.status})`;
  }
}
