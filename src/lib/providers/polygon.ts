/**
 * Polygon.io Data Provider (Options Starter tier)
 *
 * Provides:
 * - Full options snapshot (all contracts for a ticker)
 * - Historical equity OHLCV (for HV computation / IV rank)
 * - Options trade data (for flow detection later)
 */

const BASE = 'https://api.polygon.io';

/** Hard timeout for every Polygon API call to prevent serverless function hangs */
const FETCH_TIMEOUT = 8000;

function apiKey(): string {
  return process.env.POLYGON_API_KEY || '';
}

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set('apiKey', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v) u.searchParams.set(k, v);
  }
  return u.toString();
}

// ─── Options Snapshot ──────────────────────────────────────

export interface PolygonOptionSnapshot {
  break_even_price: number;
  day: {
    change: number; change_percent: number; close: number;
    high: number; low: number; open: number; volume: number; vwap: number;
  };
  details: {
    contract_type: string; exercise_style: string;
    expiration_date: string; shares_per_contract: number;
    strike_price: number; ticker: string;
  };
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  implied_volatility: number;
  open_interest: number;
  underlying_asset: {
    change_to_break_even: number; last_updated: number;
    price: number; ticker: string; timeframe: string;
  };
}

export async function getOptionsSnapshot(
  ticker: string
): Promise<PolygonOptionSnapshot[]> {
  const allResults: PolygonOptionSnapshot[] = [];
  const firstUrl = buildUrl(
    `/v3/snapshot/options/${ticker.toUpperCase()}`,
    { limit: '250' }
  );

  // First request
  const firstRes: Response = await fetch(firstUrl, {
    next: { revalidate: 15 },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!firstRes.ok)
    throw new Error(`Polygon snapshot error: ${firstRes.status}`);
  const firstData = await firstRes.json();
  if (firstData.results) allResults.push(...firstData.results);

  // Pagination
  let cursor: string | undefined = firstData.next_url;
  while (cursor && allResults.length < 5000) {
    const pageUrl = `${cursor}&apiKey=${apiKey()}`;
    const pageRes: Response = await fetch(pageUrl, {
      next: { revalidate: 15 },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!pageRes.ok) break;
    const pageData = await pageRes.json();
    if (pageData.results) allResults.push(...pageData.results);
    cursor = pageData.next_url;
  }

  return allResults;
}

// ─── Historical Equity Bars ────────────────────────────────

export interface PolygonBar {
  o: number; h: number; l: number; c: number;
  v: number; t: number; vw: number; n: number;
}

export async function getEquityHistory(
  ticker: string,
  multiplier: number,
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month',
  from: string,
  to: string
): Promise<PolygonBar[]> {
  const u = buildUrl(
    `/v2/aggs/ticker/${ticker.toUpperCase()}/range/${multiplier}/${timespan}/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: '50000' }
  );
  const res: Response = await fetch(u, { next: { revalidate: 60 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Polygon history error: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// ─── Previous Close ────────────────────────────────────────

export async function getPreviousClose(
  ticker: string
): Promise<PolygonBar | null> {
  const u = buildUrl(`/v2/aggs/ticker/${ticker.toUpperCase()}/prev`);
  const res: Response = await fetch(u, { next: { revalidate: 60 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0] || null;
}
